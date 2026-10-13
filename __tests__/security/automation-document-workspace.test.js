/**
 * Automatisations de documents : le document traité doit appartenir à
 * l'espace de l'automatisation.
 *
 * processAutomationDocument vérifiait que l'automatisation était à
 * l'appelant, puis chargeait le document par son seul id. Un membre de A
 * copiait ainsi dans ses documents partagés la facture, le devis ou le
 * justificatif de B, et, en fournissant pdfBase64, remplaçait le PDF en
 * cache de la facture de B (repris ensuite par les e-mails et les
 * intégrations comptables).
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

const upload = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    uploadImage: async () => {
      upload.calls += 1;
      return { key: "nouvelle-cle", url: "https://r2.test/nouvelle-cle" };
    },
  },
}));
vi.mock("../../src/resolvers/sharedDocument.js", () => ({
  publishSharedDocsChanged: () => {},
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import DocumentAutomation from "../../src/models/DocumentAutomation.js";
import documentAutomationService, {
  cacheDocumentPdf,
} from "../../src/services/documentAutomationService.js";

const { ObjectId } = mongoose.Types;
const wsA = buildOrganizationId();
const wsB = buildOrganizationId();
const userA = buildUserId();
const pdf = Buffer.from("%PDF-1.4 pirate").toString("base64");

async function seedAutomation(workspaceId) {
  const _id = new ObjectId();
  await DocumentAutomation.collection.insertOne({
    _id,
    workspaceId,
    name: "Copie",
    triggerType: "INVOICE_SENT",
    isActive: true,
    actionConfig: { targetFolderId: new ObjectId() },
  });
  return _id;
}

async function seedInvoice(workspaceId) {
  const _id = new ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId,
    number: "F-001",
    status: "PENDING",
    cachedPdf: { key: "cle-origine", url: "https://r2.test/cle-origine" },
  });
  return _id;
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  upload.calls = 0;
});

describe("processAutomationDocumentWithPDF", () => {
  it("refuse un document d'un autre espace et ne touche pas à son PDF", async () => {
    const automationA = await seedAutomation(wsA);
    const invoiceB = await seedInvoice(wsB);

    await expect(
      documentAutomationService.processAutomationDocumentWithPDF(
        automationA.toString(),
        wsA.toString(),
        invoiceB.toString(),
        "invoice",
        pdf,
        userA,
      ),
    ).rejects.toThrow("Document non trouvé");

    const after = await Invoice.collection.findOne({ _id: invoiceB });
    expect(after.cachedPdf.key).toBe("cle-origine");
    expect(upload.calls).toBe(0);
  });

  it("refuse l'automatisation d'un autre espace", async () => {
    const automationB = await seedAutomation(wsB);
    const invoiceA = await seedInvoice(wsA);

    await expect(
      documentAutomationService.processAutomationDocumentWithPDF(
        automationB.toString(),
        wsA.toString(),
        invoiceA.toString(),
        "invoice",
        pdf,
        userA,
      ),
    ).rejects.toThrow("Automatisation non trouvée");
  });
});

describe("cacheDocumentPdf", () => {
  it("ne remplace pas le PDF en cache d'un document d'un autre espace", async () => {
    const invoiceB = await seedInvoice(wsB);

    await cacheDocumentPdf(
      invoiceB.toString(),
      "invoice",
      Buffer.from("x"),
      wsA.toString(),
    );

    const after = await Invoice.collection.findOne({ _id: invoiceB });
    expect(after.cachedPdf.key).toBe("cle-origine");
  });

  it("met bien à jour le PDF en cache d'un document de l'espace", async () => {
    const invoiceA = await seedInvoice(wsA);

    await cacheDocumentPdf(
      invoiceA.toString(),
      "invoice",
      Buffer.from("x"),
      wsA.toString(),
    );

    const after = await Invoice.collection.findOne({ _id: invoiceA });
    expect(after.cachedPdf.key).toBe("nouvelle-cle");
  });
});
