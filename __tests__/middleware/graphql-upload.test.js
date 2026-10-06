import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { graphqlUploadMiddleware } from "../../src/middlewares/graphql-upload.js";

let server;
let baseUrl;
const unhandled = vi.fn();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(graphqlUploadMiddleware({ maxFileSize: 10, maxFiles: 1 }));
  app.post("/graphql", async (req, res) => {
    const upload = await req.body?.variables?.file?.promise;
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
});
