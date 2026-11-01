/**
 * Annexes PDF des documents (GET /document-annexes/:workspaceId/:fileId).
 *
 * Une annexe accompagne une facture, un devis ou un bon de commande : elle
 * est servie aux membres de l'espace qui voient l'une de ces pages, pas à
 * un rôle qui n'en voit aucune, ni à un autre client.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    validateJWT: (req, res, next) => {
      if (!auth.user) return res.status(401).json({ error: "Non authentifié" });
      req.user = String(auth.user);
      return next();
    },
  };
});
const r2 = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    getDocumentAnnexBuffer: async () => {
      r2.reads += 1;
      return Buffer.from("%PDF-1.4 annexe");
    },
  },
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { MODULES } from "../../src/config/rolePermissions.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import documentAnnexRoutes from "../../src/routes/documentAnnex.js";

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const quotesOnly = buildUserId(); // « Voir » des devis seulement
const noDocuments = buildUserId(); // « Voir » partout sauf factures, devis, BC
const outsider = buildUserId(); // membre d'un autre espace
const ROLE_QUOTES = `role_${"d".repeat(24)}`;
const ROLE_NO_DOCS = `role_${"e".repeat(24)}`;
const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.pdf";

let server;
let baseUrl;

const fetchAnnex = (userId, ws = workspaceId) => {
  auth.user = userId;
  return fetch(`${baseUrl}/document-annexes/${ws}/${FILE}`);
};

const insertRole = (role, actions) =>
  mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role,
    name: role,
    actions,
    permission: "{}",
  });

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/document-annexes", documentAnnexRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  r2.reads = 0;
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: quotesOnly,
    organizationId: workspaceId,
    role: ROLE_QUOTES,
  });
  await seedOrgMembership({
    userId: noDocuments,
    organizationId: workspaceId,
    role: ROLE_NO_DOCS,
  });
  await seedOrgMembership({ userId: outsider, organizationId: otherWorkspace });
  await insertRole(
    ROLE_QUOTES,
    Object.fromEntries(
      MODULES.map((m) => [m.key, m.key === "quotes" ? ["view"] : []]),
    ),
  );
  const documentPages = ["invoices", "quotes", "purchaseOrders"];
  await insertRole(
    ROLE_NO_DOCS,
    Object.fromEntries(
      MODULES.map((m) => [
        m.key,
        documentPages.includes(m.key) ? [] : ["view"],
      ]),
    ),
  );
});

describe("GET /document-annexes", () => {
  it("propriétaire : l'annexe est servie", async () => {
    const res = await fetchAnnex(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("rôle qui voit les devis : l'annexe est servie", async () => {
    expect((await fetchAnnex(quotesOnly)).status).toBe(200);
  });

  it("rôle qui ne voit ni factures, ni devis, ni bons de commande : 403", async () => {
    const res = await fetchAnnex(noDocuments);
    expect(res.status).toBe(403);
    expect(r2.reads).toBe(0);
  });

  it("membre d'un autre espace : 403", async () => {
    expect((await fetchAnnex(outsider)).status).toBe(403);
    expect(r2.reads).toBe(0);
  });

  it("espace qui n'est pas un identifiant : refusé", async () => {
    const res = await fetchAnnex(owner, "pas-un-espace");
    expect([400, 403]).toContain(res.status);
    expect(r2.reads).toBe(0);
  });
});
