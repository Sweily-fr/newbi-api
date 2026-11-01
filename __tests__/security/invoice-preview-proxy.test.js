/**
 * Proxy d'aperçu PDF (POST /api/invoice-preview-pdf) : chaque appel lance
 * un rendu par le navigateur du site, avec le secret interne.
 *
 * - couleurs de l'apparence contrôlées avant tout appel au site ;
 * - au plus 30 aperçus par minute et par utilisateur.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: "u1" }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  validateJWT: (req, res, next) => {
    req.user = auth.user;
    next();
  },
}));
const site = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node-fetch", () => ({
  default: async () => {
    site.calls += 1;
    return {
      ok: true,
      buffer: async () => Buffer.from("%PDF-1.4"),
      text: async () => "",
    };
  },
}));

import express from "express";
import invoicePreviewPdfRoutes from "../../src/routes/invoicePreviewPdf.js";

let server;
let baseUrl;

const preview = (appearance, user = "u1") => {
  auth.user = user;
  return fetch(`${baseUrl}/api/invoice-preview-pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invoiceData: {
        items: [{ description: "x", quantity: 1, unitPrice: 1 }],
        client: { name: "Client" },
        appearance,
      },
    }),
  });
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", invoicePreviewPdfRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("POST /api/invoice-preview-pdf", () => {
  it("une couleur qui n'est pas une couleur est refusée sans appel au site", async () => {
    const before = site.calls;
    const res = await preview(
      { headerBgColor: "red;background:url(https://exemple.test/x.png)" },
      "u-couleur",
    );
    expect(res.status).toBe(400);
    expect(site.calls).toBe(before);
  });

  it("des couleurs hexadécimales sont transmises", async () => {
    const before = site.calls;
    const res = await preview({ headerBgColor: "#5B50FF" }, "u-hex");
    expect(res.status).toBe(200);
    expect(site.calls).toBe(before + 1);
  });

  it("au-delà de 30 aperçus par minute, 429 sans appel au site", async () => {
    const statuses = [];
    for (let i = 0; i < 30; i++) {
      statuses.push((await preview({}, "u-rafale")).status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
    const before = site.calls;
    const res = await preview({}, "u-rafale");
    expect(res.status).toBe(429);
    expect(site.calls).toBe(before);
    // Un autre utilisateur n'est pas touché
    expect((await preview({}, "u-autre")).status).toBe(200);
  });
});
