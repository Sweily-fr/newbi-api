/**
 * Confirmation d'une facture d'achat proposée depuis un justificatif :
 * deux confirmations simultanées (double clic, deux onglets, app mobile)
 * ne créent qu'une facture ; une confirmation suspendue (facture
 * ressemblante) laisse la proposition de nouveau confirmable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import { confirmReceiptInvoiceProposal } from "../../src/services/transactionReceiptOcrService.js";

const workspaceId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
let seq = 0;

const values = (overrides = {}) => ({
  supplierName: "Fournisseur Double Clic",
  invoiceNumber: "DBL-169",
  issueDate: new Date("2026-10-20"),
  amountHT: 27.75,
  amountTVA: 5.55,
  vatRate: 20,
  amountTTC: 33.3,
  currency: "EUR",
  ...overrides,
});

const transactionAvecProposition = async ({ confirmingAt = null, ...v } = {}) =>
  Transaction.create({
    externalId: `tx-concurrence-${++seq}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -33.3,
    currency: "EUR",
    workspaceId: workspaceId.toString(),
    userId,
    date: new Date("2026-10-20"),
    description: "CB DOUBLE CLIC",
    receiptFiles: [
      {
        url: "https://r2.example/ws/double-clic.pdf",
        key: "ws/double-clic.pdf",
        filename: "double-clic.pdf",
        mimetype: "application/pdf",
        size: 1000,
        ocrProcessed: true,
        ocrProposal: {
          values: values(v),
          meta: {
            ocrSucceeded: true,
            ocrMetadata: { extractionQuality: "full" },
          },
          proposedAt: new Date(),
          confirmingAt,
        },
      },
    ],
  });

const confirmer = (tx, action = "CREATE") =>
  confirmReceiptInvoiceProposal({
    transactionId: tx._id,
    workspaceId: workspaceId.toString(),
    userId,
    fileId: tx.receiptFiles[0]._id,
    action,
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

describe("Confirmations simultanées d'une facture proposée", () => {
  it("deux CREATE en même temps : une seule facture, la seconde demande est refusée", async () => {
    const tx = await transactionAvecProposition();
    const resultats = await Promise.allSettled([confirmer(tx), confirmer(tx)]);
    expect(
      await PurchaseInvoice.countDocuments({ invoiceNumber: "DBL-169" }),
    ).toBe(1);
    const refus = resultats.filter((r) => r.status === "rejected");
    expect(refus).toHaveLength(1);
    expect(refus[0].reason.message).toMatch(/déjà en cours d'enregistrement/);
    const apres = await Transaction.findById(tx._id);
    expect(apres.linkedPurchaseInvoiceIds).toHaveLength(1);
    expect(apres.receiptFiles[0].ocrProposal).toBeNull();
  });

  it("CREATE suspendu par une facture ressemblante : la proposition reste confirmable", async () => {
    await PurchaseInvoice.create({
      supplierName: "Fournisseur Double Clic",
      invoiceNumber: "DBL-169",
      issueDate: new Date("2026-10-19"),
      amountHT: 27.75,
      amountTVA: 5.55,
      amountTTC: 33.3,
      currency: "EUR",
      status: "TO_PAY",
      workspaceId,
      createdBy: userId,
    });
    const tx = await transactionAvecProposition();
    const { duplicate } = await confirmer(tx);
    expect(duplicate).toBeTruthy();
    const apres = await Transaction.findById(tx._id);
    expect(apres.receiptFiles[0].ocrProposal.confirmingAt).toBeNull();
    expect(
      await PurchaseInvoice.countDocuments({ invoiceNumber: "DBL-169" }),
    ).toBe(1);
  });

  it("confirmation interrompue depuis plus de deux minutes : reprise possible", async () => {
    const tx = await transactionAvecProposition({
      confirmingAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const { invoice } = await confirmer(tx);
    expect(invoice).toBeTruthy();
  });

  it("confirmation en cours depuis quelques secondes : seconde demande refusée", async () => {
    const tx = await transactionAvecProposition({ confirmingAt: new Date() });
    await expect(confirmer(tx)).rejects.toThrow(
      /déjà en cours d'enregistrement/,
    );
    expect(await PurchaseInvoice.countDocuments({})).toBe(0);
  });
});
