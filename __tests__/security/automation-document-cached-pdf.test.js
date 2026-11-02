/**
 * Automatisations de documents : un PDF transmis par le navigateur ne sert
 * qu'à la copie d'un brouillon dans les documents partagés. Il ne remplace
 * jamais le PDF en cache du document (servi par le bouton des e-mails, joint
 * aux envois sans PDF et transmis aux intégrations comptables), et un
 * document finalisé est copié depuis son PDF serveur (archive légale, puis
 * cache).
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

const r2 = vi.hoisted(() => ({ uploads: [], copies: [], archiveReads: [] }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    sharedDocumentsBucketName: "shared-docs",
    documentBuckets: { quote: "quotes" },
    uploadImage: async (buffer, fileName) => {
      r2.uploads.push({ buffer: Buffer.from(buffer), fileName });
      return { key: `upload-${r2.uploads.length}`, url: "https://r2.test/u" };
    },
    copyToSharedDocuments: async (key, bucket) => {
      r2.copies.push({ key, bucket });
      return { key: `copie-${r2.copies.length}`, url: "https://r2.test/c" };
    },
    getInvoiceObjectBuffer: async (key) => {
      r2.archiveReads.push(key);
      return Buffer.from("%PDF-1.7 archive legale");
    },
    getDocumentObjectBuffer: async (docType, key) => {
      r2.archiveReads.push(key);
      return Buffer.from("%PDF-1.7 archive devis");
    },
    deleteImage: async () => {},
  },
}));
vi.mock("../../src/resolvers/sharedDocument.js", () => ({
  publishSharedDocsChanged: () => {},
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import DocumentAutomation from "../../src/models/DocumentAutomation.js";
import documentAutomationService from "../../src/services/documentAutomationService.js";
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";
import emailTrackingRoutes from "../../src/routes/emailTracking.js";

const { Mutation } = documentAutomationResolvers;
const { ObjectId } = mongoose.Types;

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const accountant = buildUserId();
const archivist = buildUserId(); // rôle personnalisé : documents partagés + factures en lecture
const folderId = new ObjectId();
const ws = () => String(workspaceId);
const clientPdfText = "%PDF-1.4 fourni par le navigateur";
const clientPdf = Buffer.from(clientPdfText).toString("base64");
const ORIGINAL_CACHE = { key: "cle-origine", url: "https://r2.test/origine" };

async function seedAutomation(triggerType) {
  const _id = new ObjectId();
  await DocumentAutomation.collection.insertOne({
    _id,
    workspaceId,
    name: "Classement",
    triggerType,
    isActive: true,
    createdBy: owner,
    actionConfig: { targetFolderId: folderId },
  });
  return String(_id);
}

async function seedInvoice(fields = {}) {
  const _id = new ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId,
    number: "000001",
    prefix: "F-2026-",
    status: "PENDING",
    cachedPdf: { ...ORIGINAL_CACHE },
    ...fields,
  });
  return String(_id);
}

const run = (automationId, documentId, documentType, pdfBase64) =>
  documentAutomationService.processAutomationDocumentWithPDF(
    automationId,
    ws(),
    documentId,
    documentType,
    pdfBase64,
    owner,
  );

const cacheOf = async (Model, id) =>
  (await Model.collection.findOne({ _id: new ObjectId(id) })).cachedPdf;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  r2.uploads.length = 0;
  r2.copies.length = 0;
  r2.archiveReads.length = 0;
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: accountant,
    organizationId: workspaceId,
    role: "accountant",
  });
  await seedOrgMembership({
    userId: archivist,
    organizationId: workspaceId,
    role: "role_archiviste",
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: "role_archiviste",
    name: "Archiviste",
    permission: "{}",
    actions: {
      sharedDocuments: ["view", "create", "edit"],
      invoices: ["view"],
      quotes: ["view"],
    },
    createdAt: new Date(),
  });
  await SharedFolder.collection.insertOne({
    _id: folderId,
    workspaceId,
    name: "Classement",
    trashedAt: null,
    createdBy: owner,
  });
});

describe("processAutomationDocumentWithPDF : PDF en cache", () => {
  it("copie l'archive légale d'une facture émise et ignore le PDF transmis", async () => {
    const automationId = await seedAutomation("INVOICE_SENT");
    const invoiceId = await seedInvoice({ archivedPdfKey: "archive-f1" });

    const result = await run(automationId, invoiceId, "invoice", clientPdf);

    expect(result.success).toBe(true);
    expect(r2.archiveReads).toEqual(["archive-f1"]);
    expect(r2.uploads).toHaveLength(1);
    expect(r2.uploads[0].buffer.toString()).toBe("%PDF-1.7 archive legale");
    expect(await cacheOf(Invoice, invoiceId)).toMatchObject(ORIGINAL_CACHE);
  });

  it("sans archive, copie le PDF en cache d'une facture émise sans le remplacer", async () => {
    const automationId = await seedAutomation("INVOICE_SENT");
    const invoiceId = await seedInvoice();

    const result = await run(automationId, invoiceId, "invoice", clientPdf);

    expect(result.success).toBe(true);
    expect(r2.uploads).toHaveLength(0);
    expect(r2.copies).toEqual([{ key: "cle-origine", bucket: "shared-docs" }]);
    expect(await cacheOf(Invoice, invoiceId)).toMatchObject(ORIGINAL_CACHE);
  });

  it("devis accepté : archive copiée, PDF en cache inchangé", async () => {
    const automationId = await seedAutomation("QUOTE_ACCEPTED");
    const quoteId = new ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId,
      number: "000004",
      status: "COMPLETED",
      archivedPdfKey: "archive-d4",
      cachedPdf: { ...ORIGINAL_CACHE },
    });

    await run(automationId, String(quoteId), "quote", clientPdf);

    expect(r2.archiveReads).toEqual(["archive-d4"]);
    expect(r2.uploads[0].buffer.toString()).toBe("%PDF-1.7 archive devis");
    expect(await cacheOf(Quote, String(quoteId))).toMatchObject(ORIGINAL_CACHE);
  });

  it("brouillon : le PDF transmis est copié mais jamais mis en cache", async () => {
    const automationId = await seedAutomation("INVOICE_DRAFT");
    const invoiceId = await seedInvoice({ status: "DRAFT" });

    const result = await run(automationId, invoiceId, "invoice", clientPdf);

    expect(result.success).toBe(true);
    expect(r2.uploads).toHaveLength(1);
    expect(r2.uploads[0].buffer.toString()).toBe(clientPdfText);
    // Laisse aux tâches en arrière-plan le temps d'écrire si elles le faisaient
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await cacheOf(Invoice, invoiceId)).toMatchObject(ORIGINAL_CACHE);
  });

  it("brouillon : refuse un fichier transmis qui n'est pas un PDF", async () => {
    const automationId = await seedAutomation("INVOICE_DRAFT");
    const invoiceId = await seedInvoice({ status: "DRAFT" });

    await expect(
      run(
        automationId,
        invoiceId,
        "invoice",
        Buffer.from("<html>pas un pdf</html>").toString("base64"),
      ),
    ).rejects.toThrow("n'est pas un PDF");
    expect(r2.uploads).toHaveLength(0);
  });

  it("refuse un type de document différent de celui du déclencheur", async () => {
    const automationId = await seedAutomation("INVOICE_SENT");
    const invoiceId = await seedInvoice();

    await expect(
      run(automationId, invoiceId, "quote", clientPdf),
    ).rejects.toThrow("ne correspond pas au déclencheur");
    expect(r2.uploads).toHaveLength(0);
    expect(r2.copies).toHaveLength(0);
  });
});

describe("processAutomationDocument : rôles sans droit d'envoi des factures", () => {
  const callAs = (userId, args) =>
    Mutation.processAutomationDocument(
      null,
      { workspaceId: ws(), ...args },
      buildContext({ userId, organizationId: ws() }),
      { fieldName: "processAutomationDocument" },
    );

  for (const [label, userId] of [
    ["Comptable", accountant],
    [
      "rôle personnalisé (documents partagés : modifier, factures : voir)",
      archivist,
    ],
  ]) {
    it(`${label} : le PDF en cache d'une facture émise reste inchangé`, async () => {
      const automationId = await seedAutomation("INVOICE_SENT");
      const invoiceId = await seedInvoice({ archivedPdfKey: "archive-f1" });

      const result = await callAs(userId, {
        automationId,
        documentId: invoiceId,
        documentType: "invoice",
        pdfBase64: clientPdf,
      });

      expect(result.success).toBe(true);
      expect(
        r2.uploads.every((u) => u.buffer.toString() !== clientPdfText),
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await cacheOf(Invoice, invoiceId)).toMatchObject(ORIGINAL_CACHE);
    });
  }

  it("refuse un type de document qui ne correspond pas au déclencheur", async () => {
    const automationId = await seedAutomation("INVOICE_SENT");
    const invoiceId = await seedInvoice();

    await expect(
      callAs(accountant, {
        automationId,
        documentId: invoiceId,
        documentType: "creditNote",
        pdfBase64: clientPdf,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await cacheOf(Invoice, invoiceId)).toMatchObject(ORIGINAL_CACHE);
  });
});

describe("bouton « Voir le document » des e-mails après le passage d'un Comptable", () => {
  const TOKEN = "f".repeat(64);
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use("/tracking", emailTrackingRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  const comptable = (args) =>
    Mutation.processAutomationDocument(
      null,
      { workspaceId: ws(), ...args },
      buildContext({ userId: accountant, organizationId: ws() }),
      { fieldName: "processAutomationDocument" },
    );

  const tracking = {
    emailTracking: {
      trackingToken: TOKEN,
      emailSentAt: new Date(),
      emailOpenCount: 0,
      emailClickCount: 0,
    },
  };

  it("facture archivée : le lien sert l'archive légale, jamais le PDF transmis", async () => {
    const automationId = await seedAutomation("INVOICE_SENT");
    const invoiceId = await seedInvoice({
      archivedPdfKey: "archive-f1",
      ...tracking,
    });
    await comptable({
      automationId,
      documentId: invoiceId,
      documentType: "invoice",
      pdfBase64: clientPdf,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${baseUrl}/tracking/click/${TOKEN}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).toBe("%PDF-1.7 archive legale");
    expect(body).not.toContain(clientPdfText);
  });

  it("facture sans archive : le lien mène toujours au PDF en cache d'origine", async () => {
    const automationId = await seedAutomation("INVOICE_SENT");
    const invoiceId = await seedInvoice({ ...tracking });
    await comptable({
      automationId,
      documentId: invoiceId,
      documentType: "invoice",
      pdfBase64: clientPdf,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${baseUrl}/tracking/click/${TOKEN}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(ORIGINAL_CACHE.url);
  });
});
