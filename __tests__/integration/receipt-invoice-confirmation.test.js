import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
// Implémentation réelle : à importer, pas à ré-écrire.
import { confirmReceiptInvoiceProposal } from "../../src/services/transactionReceiptOcrService.js";

/**
 * Confirmation d'une facture d'achat proposée depuis un justificatif.
 *
 * L'analyse ne crée plus rien toute seule : elle dépose une proposition sur
 * le justificatif, l'utilisateur confirme (CREATE), rattache à une facture
 * existante (ATTACH) ou renonce (SKIP). Le cas qui motivait ce changement :
 * une facture jugée « déjà existante » à tort (numéro mal lu par l'OCR)
 * faisait disparaître la facture sans que l'utilisateur en soit averti.
 */

const workspaceId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

let seq = 0;

const makeProposalValues = (overrides = {}) => ({
  supplierName: "Canva Pty. Ltd.",
  invoiceNumber: "04892-13770360",
  issueDate: new Date("2026-05-25"),
  dueDate: null,
  amountHT: 9.99,
  amountTVA: 2,
  vatRate: 20,
  amountTTC: 11.99,
  currency: "EUR",
  category: "SUBSCRIPTIONS",
  subcategory: "subscriptions",
  paymentMethod: "CREDIT_CARD",
  ...overrides,
});

const makeTransactionWithProposal = async ({
  values = makeProposalValues(),
  duplicateInvoiceId = null,
  duplicateReason = null,
  duplicateLinkTransaction = true,
} = {}) =>
  Transaction.create({
    externalId: `tx-${++seq}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -11.99,
    currency: "EUR",
    workspaceId: workspaceId.toString(),
    userId,
    date: new Date("2026-05-25"),
    description: "Canva*",
    receiptFiles: [
      {
        url: "https://r2.example/ws/canva-05.pdf",
        key: "ws/canva-05.pdf",
        filename: "Canva-invoice-04892-13770360.pdf",
        mimetype: "application/pdf",
        size: 601643,
        ocrProcessed: true,
        ocrProposal: {
          values,
          meta: {
            ocrSucceeded: true,
            conversionNote: "",
            ocrMetadata: { provider: "claude-vision", extractionQuality: "full" },
          },
          duplicateInvoiceId,
          duplicateReason,
          duplicateLinkTransaction,
          proposedAt: new Date(),
        },
      },
    ],
  });

const makeInvoice = async ({ invoiceNumber, amountTTC = 11.99, issueDate }) =>
  PurchaseInvoice.create({
    supplierName: "Canva Pty. Ltd.",
    invoiceNumber,
    issueDate: new Date(issueDate),
    amountHT: amountTTC,
    amountTVA: 0,
    amountTTC,
    currency: "EUR",
    status: "PAID",
    category: "SUBSCRIPTIONS",
    source: "OCR",
    workspaceId,
    createdBy: userId,
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

describe("confirmReceiptInvoiceProposal", () => {
  it("l'analyse seule ne crée aucune facture : la proposition attend la confirmation", async () => {
    await makeTransactionWithProposal();
    expect(await PurchaseInvoice.countDocuments({})).toBe(0);
  });

  it("CREATE enregistre les valeurs confirmées, corrections comprises", async () => {
    const tx = await makeTransactionWithProposal();
    const fileId = tx.receiptFiles[0]._id;

    const { invoice } = await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId,
      action: "CREATE",
      // L'utilisateur corrige un numéro mal lu
      values: { invoiceNumber: "04892-13770360-RECTIFIE" },
    });

    expect(invoice.invoiceNumber).toBe("04892-13770360-RECTIFIE");
    expect(invoice.amountTTC).toBe(11.99);
    expect(invoice.supplierName).toBe("Canva Pty. Ltd.");

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.linkedPurchaseInvoiceIds.map(String)).toContain(
      invoice._id.toString(),
    );
    expect(fresh.reconciliationStatus).toBe("matched");
    // Proposition consommée, fichier rattaché à la facture créée
    expect(fresh.receiptFiles[0].ocrProposal).toBeFalsy();
    expect(String(fresh.receiptFiles[0].purchaseInvoiceId)).toBe(
      invoice._id.toString(),
    );
  });

  it("CREATE crée bien la facture même quand une existante lui ressemble", async () => {
    // Le cas qui bloquait : numéro identique lu à tort sur deux factures
    // différentes, la seconde n'était jamais créée.
    const existing = await makeInvoice({
      invoiceNumber: "2006/112",
      issueDate: "2026-04-25",
    });
    const tx = await makeTransactionWithProposal({
      values: makeProposalValues({ invoiceNumber: "2006/112" }),
      duplicateInvoiceId: existing._id,
      duplicateReason: "NUMBER",
    });

    const { invoice } = await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[0]._id,
      action: "CREATE",
    });

    expect(invoice._id.toString()).not.toBe(existing._id.toString());
    expect(await PurchaseInvoice.countDocuments({})).toBe(2);
  });

  it("ATTACH rattache le justificatif à la facture existante sans en créer", async () => {
    const existing = await makeInvoice({
      invoiceNumber: "04892-13770360",
      issueDate: "2026-05-25",
    });
    const tx = await makeTransactionWithProposal({
      duplicateInvoiceId: existing._id,
      duplicateReason: "NUMBER",
    });

    const { invoice } = await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[0]._id,
      action: "ATTACH",
    });

    expect(invoice._id.toString()).toBe(existing._id.toString());
    expect(await PurchaseInvoice.countDocuments({})).toBe(1);
    expect(invoice.files).toHaveLength(1);
    expect(invoice.files[0].url).toBe("https://r2.example/ws/canva-05.pdf");

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.linkedPurchaseInvoiceIds.map(String)).toContain(
      existing._id.toString(),
    );
    expect(fresh.receiptFiles[0].ocrProposal).toBeFalsy();
  });

  it("ATTACH sur une facture déjà couverte dépose le fichier sans justifier la dépense", async () => {
    const existing = await makeInvoice({
      invoiceNumber: "04892-13770360",
      issueDate: "2026-05-25",
    });
    const tx = await makeTransactionWithProposal({
      duplicateInvoiceId: existing._id,
      duplicateReason: "NUMBER",
      duplicateLinkTransaction: false,
    });

    await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[0]._id,
      action: "ATTACH",
    });

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.linkedPurchaseInvoiceIds.map(String)).not.toContain(
      existing._id.toString(),
    );
    expect(fresh.reconciliationStatus).not.toBe("matched");
    // Le fichier garde la trace de la facture qui le porte
    expect(String(fresh.receiptFiles[0].purchaseInvoiceId)).toBe(
      existing._id.toString(),
    );
  });

  it("SKIP ne crée rien et laisse le justificatif sur la transaction", async () => {
    const tx = await makeTransactionWithProposal();

    const { invoice } = await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[0]._id,
      action: "SKIP",
    });

    expect(invoice).toBeNull();
    expect(await PurchaseInvoice.countDocuments({})).toBe(0);

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.receiptFiles).toHaveLength(1);
    expect(fresh.receiptFiles[0].ocrProposal).toBeFalsy();
    expect(fresh.receiptFiles[0].purchaseInvoiceId).toBeFalsy();
  });

  it("refuse une confirmation sans proposition en attente", async () => {
    const tx = await makeTransactionWithProposal();
    await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[0]._id,
      action: "SKIP",
    });

    await expect(
      confirmReceiptInvoiceProposal({
        transactionId: tx._id,
        workspaceId: workspaceId.toString(),
        userId,
        fileId: tx.receiptFiles[0]._id,
        action: "CREATE",
      }),
    ).rejects.toThrow(/en attente/i);
  });
});
