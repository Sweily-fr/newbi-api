/**
 * Proxy d'aperçu PDF (POST /api/invoice-preview-pdf) : chaque appel lance
 * un rendu par le navigateur du site, avec le secret interne.
 *
 * - membre de l'espace avec « Voir » sur les factures ;
 * - corps borné (données d'un document, pas des fichiers) ;
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
const WS = "6a0000000000000000000001";
const OTHER_WS = "6a0000000000000000000002";
vi.mock("../../src/utils/workspace-membership.js", () => ({
  userHasWorkspaceLevel: async (_user, workspaceId, moduleKey, level) =>
    workspaceId === "6a0000000000000000000001" &&
    moduleKey === "invoices" &&
    level === "read",
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
import invoicePreviewPdfRoutes, {
  PREVIEW_BODY_LIMIT,
} from "../../src/routes/invoicePreviewPdf.js";

let server;
let baseUrl;

const preview = (appearance, user = "u1", workspaceId = WS) => {
  auth.user = user;
  return fetch(`${baseUrl}/api/invoice-preview-pdf`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(workspaceId ? { "x-organization-id": workspaceId } : {}),
    },
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
  // Même montage que src/server.js
  app.use(
    "/api/invoice-preview-pdf",
    express.json({ limit: PREVIEW_BODY_LIMIT }),
  );
  app.use(express.json({ limit: "100mb" }));
  app.use("/api", invoicePreviewPdfRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("POST /api/invoice-preview-pdf", () => {
  it("sans espace, ou espace sans « Voir » sur les factures : 403 sans appel au site", async () => {
    const before = site.calls;
    expect((await preview({}, "u-sans-espace", null)).status).toBe(403);
    expect((await preview({}, "u-autre-espace", OTHER_WS)).status).toBe(403);
    expect((await preview({}, "u-id-invalide", "pas-un-id")).status).toBe(403);
    expect(site.calls).toBe(before);
  });

  it("corps de plus de 5 Mo : refusé (413) sans appel au site", async () => {
    const before = site.calls;
    auth.user = "u-gros";
    const res = await fetch(`${baseUrl}/api/invoice-preview-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-organization-id": WS },
      body: JSON.stringify({
        invoiceData: { notes: "x".repeat(6 * 1024 * 1024) },
      }),
    });
    expect(res.status).toBe(413);
    expect(site.calls).toBe(before);
  });

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
