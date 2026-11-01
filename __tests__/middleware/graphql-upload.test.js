import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { EventEmitter } from "events";
import {
  graphqlUploadMiddleware,
  waitForFullUpload,
} from "../../src/middlewares/graphql-upload.js";

let server;
let baseUrl;
const unhandled = vi.fn();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(graphqlUploadMiddleware({ maxFileSize: 20, maxFiles: 1 }));
  app.post("/graphql", async (req, res) => {
    if (req.body?.variables?.echo) {
      return res.json({ variables: req.body.variables });
    }
    const upload = await req.body?.variables?.file?.promise;
    if (req.body?.variables?.lire) {
      // État du tampon au moment où le résolveur reçoit le fichier, puis contenu lu
      const finiALaRemise = upload.capacitor.writableFinished;
      let contenu = "";
      try {
        for await (const chunk of upload.createReadStream()) contenu += chunk;
      } catch (error) {
        return res.json({ finiALaRemise, erreur: error.message });
      }
      return res.json({ finiALaRemise, contenu });
    }
    res.json({ ok: true, filename: upload?.filename ?? null });
  });
  // Ce qui n'est pas traité par le middleware tombe ici (handler par défaut)
  app.use((err, req, res, _next) => {
    unhandled(err);
    res.status(500).end();
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/graphql`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("graphqlUploadMiddleware", () => {
  it("répond 400 en JSON à un multipart sans « operations » (scanner)", async () => {
    const form = new FormData();
    form.append("username", "admin");
    const res = await fetch(baseUrl, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors[0].message).toMatch(/operations/);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("répond 413 quand il y a trop de fichiers", async () => {
    const form = new FormData();
    form.append(
      "operations",
      JSON.stringify({
        query: "mutation($a: Upload!, $b: Upload!) { up(a: $a, b: $b) }",
        variables: { a: null, b: null },
      }),
    );
    form.append(
      "map",
      JSON.stringify({ 0: ["variables.a"], 1: ["variables.b"] }),
    );
    form.append("0", new Blob(["a"]), "a.txt");
    form.append("1", new Blob(["b"]), "b.txt");
    const res = await fetch(baseUrl, { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect((await res.json()).errors[0].message).toMatch(/max file uploads/);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("laisse passer un upload valide", async () => {
    const form = new FormData();
    form.append(
      "operations",
      JSON.stringify({
        query: "mutation($file: Upload!) { up(file: $file) }",
        variables: { file: null },
      }),
    );
    form.append("map", JSON.stringify({ 0: ["variables.file"] }));
    form.append("0", new Blob(["ok"]), "petit.txt");
    const res = await fetch(baseUrl, { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, filename: "petit.txt" });
  });

  it("ignore les requêtes qui ne sont pas multipart", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    expect(res.status).toBe(200);
  });

  it("retire les clés « $ » des variables d'un multipart, comme pour un corps JSON", async () => {
    const form = new FormData();
    form.append(
      "operations",
      JSON.stringify({
        query: "mutation($input: X!) { up(input: $input) }",
        variables: {
          echo: true,
          input: {
            rules: [{ field: "name", value: { $regex: "^(a|aa)+$" } }],
            customFields: [{ fieldId: "f", value: { $gt: "" } }],
          },
        },
      }),
    );
    form.append("map", JSON.stringify({}));
    const res = await fetch(baseUrl, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const { variables } = await res.json();
    expect(variables.input.rules[0].value).toEqual({});
    expect(variables.input.customFields[0].value).toEqual({});
    expect(JSON.stringify(variables)).not.toContain("$");
  });

  it("ne remet le fichier au résolveur qu'une fois entièrement reçu", async () => {
    const limite = "----limite";
    const debut =
      `--${limite}\r\nContent-Disposition: form-data; name="operations"\r\n\r\n` +
      JSON.stringify({
        query: "mutation($file: Upload!) { up(file: $file) }",
        variables: { file: null, lire: true },
      }) +
      `\r\n--${limite}\r\nContent-Disposition: form-data; name="map"\r\n\r\n` +
      JSON.stringify({ 0: ["variables.file"] }) +
      `\r\n--${limite}\r\nContent-Disposition: form-data; name="0"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 debut`;
    const fin = ` fin\r\n--${limite}--\r\n`;
    const encodeur = new TextEncoder();
    // La fin du fichier arrive 150 ms après le début : sans attente, le
    // résolveur recevrait le fichier avant qu'il soit complet.
    const corps = new ReadableStream({
      async start(controller) {
        controller.enqueue(encodeur.encode(debut));
        await new Promise((r) => setTimeout(r, 150));
        controller.enqueue(encodeur.encode(fin));
        controller.close();
      },
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${limite}` },
      body: corps,
      duplex: "half",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      finiALaRemise: true,
      contenu: "%PDF-1.4 debut fin",
    });
  });

  it("un fichier trop gros est remis sans attente infinie, sa lecture lève l'erreur de taille", async () => {
    const form = new FormData();
    form.append(
      "operations",
      JSON.stringify({
        query: "mutation($file: Upload!) { up(file: $file) }",
        variables: { file: null, lire: true },
      }),
    );
    form.append("map", JSON.stringify({ 0: ["variables.file"] }));
    form.append("0", new Blob(["x".repeat(100)]), "gros.pdf");
    const res = await fetch(baseUrl, { method: "POST", body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).erreur).toMatch(/byte size limit/);
  });
});

describe("waitForFullUpload", () => {
  const tampon = (fini = false) =>
    Object.assign(new EventEmitter(), {
      writableFinished: fini,
      destroyed: false,
    });

  it("rend tout de suite un fichier déjà entièrement écrit", async () => {
    const file = { capacitor: tampon(true) };
    await expect(waitForFullUpload(file)).resolves.toBe(file);
  });

  it("attend la fin de l'écriture, puis rend le fichier", async () => {
    const file = { capacitor: tampon() };
    let rendu = false;
    const attente = waitForFullUpload(file).then(() => {
      rendu = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(rendu).toBe(false);
    file.capacitor.emit("finish");
    await attente;
    expect(rendu).toBe(true);
    expect(file.capacitor.listenerCount("finish")).toBe(0);
    expect(file.capacitor.listenerCount("close")).toBe(0);
    expect(file.capacitor.listenerCount("error")).toBe(0);
  });

  it("rend le fichier si son tampon est détruit (fichier refusé, requête coupée)", async () => {
    const file = { capacitor: tampon() };
    const attente = waitForFullUpload(file);
    file.capacitor.emit("close");
    await expect(attente).resolves.toBe(file);
  });
});
