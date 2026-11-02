/**
 * Routes REST des PDF et fichiers de documents : « Voir » de la page exigé.
 *
 * Les routes /invoices/:id/document-pdf, /documents/:docType/:id/document-pdf
 * et /documents/imported/:docType/:id/file ne vérifiaient que l'appartenance
 * à l'espace : un rôle sans les factures ouvrait le PDF d'une facture dont il
 * connaissait l'id (exposé par exemple par les factures rapprochées d'une
 * transaction).
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

// Utilisateur de la requête (session simulée)
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
vi.mock("../../src/services/cloudflareService.js", () => ({ default: {} }));
vi.mock("../../src/services/superPdpService.js", () => ({ default: {} }));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { MODULES } from "../../src/config/rolePermissions.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import Transaction from "../../src/models/Transaction.js";
import invoiceDocumentPdfRoutes from "../../src/routes/invoiceDocumentPdf.js";
import documentPdfRoutes from "../../src/routes/documentPdf.js";
import importedDocumentFileRoutes from "../../src/routes/importedDocumentFile.js";

const workspaceId = buildOrganizationId();
const restricted = buildUserId(); // « Voir » partout sauf factures, devis, transactions
const viewer = buildUserId(); // « Membre »
const outsider = buildUserId(); // hors de l'espace
const ROLE = `role_${"c".repeat(24)}`;
const invoiceId = new mongoose.Types.ObjectId();
const quoteId = new mongoose.Types.ObjectId();
const transactionId = new mongoose.Types.ObjectId();

let server;
let baseUrl;

const ROUTES = {
  "PDF de facture": () => `/invoices/${invoiceId}/document-pdf`,
  "PDF de devis": () => `/documents/quote/${quoteId}/document-pdf`,
  "justificatif de transaction": () =>
    `/documents/imported/transaction/${transactionId}/file`,
};

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/invoices", invoiceDocumentPdfRoutes);
  app.use("/documents", documentPdfRoutes);
  app.use("/documents", importedDocumentFileRoutes);
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
  await seedOrgMembership({
    userId: restricted,
    organizationId: workspaceId,
    role: ROLE,
  });
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
  const actions = Object.fromEntries(MODULES.map((m) => [m.key, ["view"]]));
  actions.invoices = [];
  actions.quotes = [];
  actions.banking = [];
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Sans ventes ni banque",
    actions,
    permission: "{}",
  });
  // Documents sans fichier archivé : une fois les droits passés, 404
  await Invoice.collection.insertOne({
    _id: invoiceId,
    workspaceId,
    status: "PENDING",
    number: "F-001",
  });
  await Quote.collection.insertOne({
    _id: quoteId,
    workspaceId,
    status: "PENDING",
    number: "D-001",
  });
  await Transaction.collection.insertOne({
    _id: transactionId,
    workspaceId: String(workspaceId),
    amount: -10,
    receiptFiles: [],
  });
});

describe("Routes REST des PDF et fichiers de documents", () => {
  for (const [name, path] of Object.entries(ROUTES)) {
    it(`${name} : refusé sans « Voir » de la page, permis au Membre`, async () => {
      auth.user = restricted;
      expect((await fetch(`${baseUrl}${path()}`)).status).toBe(403);
      auth.user = outsider;
      expect((await fetch(`${baseUrl}${path()}`)).status).toBe(403);
      auth.user = viewer;
      expect((await fetch(`${baseUrl}${path()}`)).status).toBe(404);
    });
  }
});

describe("Routes REST des PDF : identifiant malformé", () => {
  for (const path of [
    "/invoices/abc/document-pdf",
    "/documents/creditNote/abc/document-pdf",
    "/documents/quote/pas-un-identifiant/document-pdf",
  ]) {
    it(`${path} : 404 « introuvable », pas une erreur serveur`, async () => {
      auth.user = viewer;
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/introuvable/i);
    });
  }
});
