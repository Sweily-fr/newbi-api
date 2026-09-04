import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  findPurchaseInvoiceDuplicates,
  supplierNamesMatch,
} from "../../src/utils/purchaseInvoiceDuplicates.js";

const orgId = buildOrganizationId();
const workspaceId = orgId.toString();
const userId = buildUserId();

const insertPI = (overrides = {}) =>
  PurchaseInvoice.collection.insertOne({
    workspaceId: orgId,
    createdBy: userId,
    supplierName: "Hostinger",
    invoiceNumber: "HOST-2026-0721",
    issueDate: new Date("2026-07-21T00:00:00.000Z"),
    amountTTC: 30.98,
    amountHT: 25.82,
    amountTVA: 5.16,
    vatRate: 20,
    status: "TO_PAY",
    files: [],
    linkedTransactionIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("supplierNamesMatch", () => {
  it("compare de façon tolérante (casse, ponctuation, inclusion)", () => {
    expect(supplierNamesMatch("Qonto", "QONTO SAS")).toBe(true);
    expect(supplierNamesMatch("Hostinger", "hostinger international")).toBe(
      true,
    );
    expect(supplierNamesMatch("OVH", "Hostinger")).toBe(false);
    expect(supplierNamesMatch("ab", "ab")).toBe(false);
  });
});

describe("findPurchaseInvoiceDuplicates", () => {
  it("trouve une facture au même numéro chez le même fournisseur", async () => {
    const { insertedId } = await insertPI();
    const dups = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: "HOSTINGER INTERNATIONAL",
      invoiceNumber: "host-2026-0721",
      amountTTC: 999,
    });
    expect(dups.map((d) => d._id.toString())).toEqual([insertedId.toString()]);
  });

  it("un même numéro chez un autre fournisseur avec un autre montant n'est pas un doublon", async () => {
    await insertPI({ invoiceNumber: "2026-001", supplierName: "OVH" });
    const dups = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: "Hostinger",
      invoiceNumber: "2026-001",
      amountTTC: 500,
    });
    expect(dups).toHaveLength(0);
  });

  it("trouve une facture sans numéro par fournisseur + montant + date proche", async () => {
    const { insertedId } = await insertPI({ invoiceNumber: null });
    const dups = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: "Hostinger",
      amountTTC: 30.98,
      issueDate: new Date("2026-07-24T00:00:00.000Z"),
    });
    expect(dups.map((d) => d._id.toString())).toEqual([insertedId.toString()]);
  });

  it("une dépense récurrente au même montant un mois plus tard n'est pas un doublon", async () => {
    await insertPI({ invoiceNumber: null });
    const dups = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: "Hostinger",
      amountTTC: 30.98,
      issueDate: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(dups).toHaveLength(0);
  });

  it("ignore les factures archivées, celles d'un autre workspace et excludeId", async () => {
    await insertPI({ status: "ARCHIVED" });
    await insertPI({ workspaceId: buildOrganizationId() });
    const { insertedId } = await insertPI();
    const dups = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: "Hostinger",
      invoiceNumber: "HOST-2026-0721",
      excludeId: insertedId,
    });
    expect(dups).toHaveLength(0);
  });

  it("sert en premier les factures listées dans preferIds", async () => {
    const a = await insertPI({
      invoiceNumber: null,
      issueDate: new Date("2026-07-22T00:00:00.000Z"),
    });
    const b = await insertPI({
      invoiceNumber: null,
      issueDate: new Date("2026-07-20T00:00:00.000Z"),
    });
    const dups = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: "Hostinger",
      amountTTC: 30.98,
      issueDate: new Date("2026-07-21T00:00:00.000Z"),
      preferIds: [b.insertedId],
    });
    expect(dups[0]._id.toString()).toBe(b.insertedId.toString());
    expect(dups[1]._id.toString()).toBe(a.insertedId.toString());
    expect(mongoose.isValidObjectId(dups[0]._id)).toBe(true);
  });
});
