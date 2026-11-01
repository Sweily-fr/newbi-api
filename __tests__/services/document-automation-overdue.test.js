/**
 * Automatisations « Factures en retard » et « Factures d'achat en retard » :
 * le lancement manuel (« Lancer ») et le compteur voient les mêmes documents
 * que le cron de 8 h, c'est-à-dire aussi les documents en attente dont
 * l'échéance est passée (le statut OVERDUE n'est posé qu'à la modification).
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

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: async () => {} },
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

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import documentAutomationService from "../../src/services/documentAutomationService.js";

const workspaceId = new mongoose.Types.ObjectId();
const DAY = 86400000;
const ago = (n) => new Date(Date.now() - n * DAY);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

const automation = (triggerType) => ({
  _id: new mongoose.Types.ObjectId(),
  workspaceId,
  triggerType,
  actionConfig: {},
});

const ids = (docs) => docs.map((d) => d.documentId).sort();

describe("automatisations « en retard » alignées sur le cron", () => {
  it("factures : OVERDUE et PENDING échues, pas les PENDING à venir ni payées", async () => {
    const insert = (number, status, dueDate) =>
      Invoice.collection.insertOne({
        workspaceId,
        number,
        prefix: "F",
        status,
        dueDate,
        issueDate: ago(40),
        finalTotalTTC: 100,
      });
    const echue = await insert("1", "PENDING", ago(3));
    const statut = await insert("2", "OVERDUE", ago(10));
    await insert("3", "PENDING", ago(-5));
    await insert("4", "COMPLETED", ago(3));
    await insert("5", "DRAFT", ago(3));

    const a = automation("INVOICE_OVERDUE");
    const docs = await documentAutomationService.getDocumentsForAutomation(
      a,
      workspaceId,
    );
    expect(ids(docs)).toEqual(
      [String(echue.insertedId), String(statut.insertedId)].sort(),
    );
    expect(await documentAutomationService.countDocumentsForAutomation(a)).toBe(
      2,
    );
    expect(
      await documentAutomationService.countExistingDocuments(a, workspaceId),
    ).toBe(2);
  });

  it("factures d'achat : OVERDUE et à payer échues, pas les payées", async () => {
    const insert = (status, dueDate) =>
      PurchaseInvoice.collection.insertOne({
        workspaceId,
        supplierName: "Fournisseur",
        status,
        dueDate,
        issueDate: ago(40),
        amountTTC: 60,
      });
    const echue = await insert("TO_PAY", ago(2));
    const statut = await insert("OVERDUE", ago(8));
    await insert("TO_PAY", ago(-4));
    await insert("PAID", ago(2));

    const a = automation("PURCHASE_INVOICE_OVERDUE");
    const docs = await documentAutomationService.getDocumentsForAutomation(
      a,
      workspaceId,
    );
    expect(ids(docs)).toEqual(
      [String(echue.insertedId), String(statut.insertedId)].sort(),
    );
    expect(await documentAutomationService.countDocumentsForAutomation(a)).toBe(
      2,
    );
  });
});
