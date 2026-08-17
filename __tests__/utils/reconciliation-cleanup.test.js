import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  detachPurchaseInvoicesFromTransactions,
  detachTransactionsFromDocuments,
  repointTransactionReferences,
} from "../../src/utils/reconciliation-cleanup.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

let counter = 0;

async function createTransaction(overrides = {}) {
  counter += 1;
  return Transaction.create({
    externalId: `tx-cleanup-${counter}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -50,
    currency: "EUR",
    description: "Dépense test",
    workspaceId: workspaceId.toString(),
    date: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  });
}

async function createPurchaseInvoice(overrides = {}) {
  return PurchaseInvoice.create({
    supplierName: "Fournisseur Test",
    issueDate: new Date("2026-07-01T00:00:00.000Z"),
    amountTTC: 50,
    currency: "EUR",
    workspaceId,
    createdBy: userId,
    ...overrides,
  });
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("detachPurchaseInvoicesFromTransactions", () => {
  it("retire le lien, nettoie receiptFiles.purchaseInvoiceId et repasse la transaction en unmatched", async () => {
    const invoice = await createPurchaseInvoice();
    const tx = await createTransaction({
      linkedPurchaseInvoiceIds: [invoice._id],
      reconciliationStatus: "matched",
      reconciliationDate: new Date(),
      receiptFiles: [
        {
          url: "https://receipts.newbi.fr/r.pdf",
          key: "r.pdf",
          filename: "r.pdf",
          mimetype: "application/pdf",
          size: 100,
          ocrProcessed: true,
          purchaseInvoiceId: invoice._id,
        },
      ],
    });

    await detachPurchaseInvoicesFromTransactions(
      [invoice._id],
      workspaceId.toString(),
    );

    const updated = await Transaction.findById(tx._id);
    expect(updated.linkedPurchaseInvoiceIds).toHaveLength(0);
    expect(updated.reconciliationStatus).toBe("unmatched");
    expect(updated.reconciliationDate).toBeNull();
    expect(updated.receiptFiles[0].purchaseInvoiceId).toBeNull();
    // Le fichier reste marqué traité : suppression volontaire, pas de
    // recréation automatique
    expect(updated.receiptFiles[0].ocrProcessed).toBe(true);
  });

  it("garde le statut matched si la transaction reste liée à une facture de vente", async () => {
    const invoice = await createPurchaseInvoice();
    const tx = await createTransaction({
      linkedPurchaseInvoiceIds: [invoice._id],
      linkedInvoiceIds: [buildOrganizationId()],
      reconciliationStatus: "matched",
    });

    await detachPurchaseInvoicesFromTransactions(
      [invoice._id],
      workspaceId.toString(),
    );

    const updated = await Transaction.findById(tx._id);
    expect(updated.linkedPurchaseInvoiceIds).toHaveLength(0);
    expect(updated.reconciliationStatus).toBe("matched");
  });
});

describe("detachTransactionsFromDocuments", () => {
  it("retire la transaction des documents et ne remet isReconciled à false que si plus aucun lien", async () => {
    const tx1 = await createTransaction();
    const tx2 = await createTransaction();

    const invoiceBoth = await createPurchaseInvoice({
      linkedTransactionIds: [tx1._id, tx2._id],
      isReconciled: true,
    });
    const invoiceOnly1 = await createPurchaseInvoice({
      linkedTransactionIds: [tx1._id],
      isReconciled: true,
    });

    await detachTransactionsFromDocuments([tx1._id], workspaceId.toString());

    const both = await PurchaseInvoice.findById(invoiceBoth._id);
    expect(both.linkedTransactionIds.map(String)).toEqual([String(tx2._id)]);
    expect(both.isReconciled).toBe(true);

    const only1 = await PurchaseInvoice.findById(invoiceOnly1._id);
    expect(only1.linkedTransactionIds).toHaveLength(0);
    expect(only1.isReconciled).toBe(false);
  });
});

describe("repointTransactionReferences", () => {
  it("repointe les références des factures d'achat vers la nouvelle transaction", async () => {
    const oldTx = await createTransaction({ provider: "manual" });
    const newTx = await createTransaction();

    const invoice = await createPurchaseInvoice({
      linkedTransactionIds: [oldTx._id],
      isReconciled: true,
    });

    await repointTransactionReferences(oldTx._id, newTx._id);

    const updated = await PurchaseInvoice.findById(invoice._id);
    expect(updated.linkedTransactionIds.map(String)).toEqual([
      String(newTx._id),
    ]);
    expect(updated.isReconciled).toBe(true);
  });
});
