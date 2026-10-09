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
            ocrMetadata: {
              provider: "claude-vision",
              extractionQuality: "full",
            },
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

  describe("justificatif à plusieurs taux de TVA", () => {
    // Note de restaurant : plats à 10 %, boissons alcoolisées à 20 %
    const multiRateValues = () =>
      makeProposalValues({
        supplierName: "Brasserie du Port",
        amountHT: 115.36,
        amountTVA: 15.07,
        vatRate: 10,
        amountTTC: 130.43,
        vatBreakdown: [
          { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
          { rate: 10, baseHT: 80, amountTVA: 8 },
        ],
      });

    it("CREATE garde le détail par taux proposé", async () => {
      const tx = await makeTransactionWithProposal({
        values: multiRateValues(),
      });
      const { invoice } = await confirmReceiptInvoiceProposal({
        transactionId: tx._id,
        workspaceId: workspaceId.toString(),
        userId,
        fileId: tx.receiptFiles[0]._id,
        action: "CREATE",
      });

      const saved = await PurchaseInvoice.findById(invoice._id).lean();
      expect(saved.vatBreakdown).toEqual([
        { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
        { rate: 10, baseHT: 80, amountTVA: 8 },
      ]);
      expect(saved.amountTVA).toBe(15.07);
      expect(saved.amountHT).toBe(115.36);
      expect(saved.vatRate).toBe(10);
    });

    it("CREATE avec un détail corrigé : HT / TVA / taux recalculés depuis les lignes", async () => {
      const tx = await makeTransactionWithProposal({
        values: multiRateValues(),
      });
      const { invoice } = await confirmReceiptInvoiceProposal({
        transactionId: tx._id,
        workspaceId: workspaceId.toString(),
        userId,
        fileId: tx.receiptFiles[0]._id,
        action: "CREATE",
        values: {
          vatBreakdown: [
            { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
            { rate: 10, baseHT: 70, amountTVA: 7 },
            { rate: 5.5, baseHT: 10, amountTVA: 0.55 },
          ],
        },
      });

      const saved = await PurchaseInvoice.findById(invoice._id).lean();
      expect(saved.vatBreakdown).toHaveLength(3);
      expect(saved.amountTVA).toBe(14.62);
      expect(saved.amountHT).toBe(115.36);
      expect(saved.vatRate).toBe(10);
    });

    it("CREATE avec une TVA ramenée à un seul taux : le détail lu est abandonné", async () => {
      const tx = await makeTransactionWithProposal({
        values: multiRateValues(),
      });
      const { invoice } = await confirmReceiptInvoiceProposal({
        transactionId: tx._id,
        workspaceId: workspaceId.toString(),
        userId,
        fileId: tx.receiptFiles[0]._id,
        action: "CREATE",
        values: { vatRate: 20, amountTVA: 21.74, amountHT: 108.69 },
      });

      const saved = await PurchaseInvoice.findById(invoice._id).lean();
      expect(saved.vatBreakdown).toEqual([]);
      expect(saved.vatRate).toBe(20);
      expect(saved.amountTVA).toBe(21.74);
    });
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
    expect(fresh.receiptFiles[0].purchaseInvoiceId).toBeFalsy();
    // La proposition est mise de côté, pas perdue
    expect(fresh.receiptFiles[0].ocrProposal).toBeTruthy();
    expect(fresh.receiptFiles[0].ocrProposal.dismissedAt).toBeInstanceOf(Date);
  });

  it("une facture mise de côté peut encore être créée plus tard", async () => {
    const tx = await makeTransactionWithProposal();
    const fileId = tx.receiptFiles[0]._id;

    await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId,
      action: "SKIP",
    });

    const { invoice } = await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId,
      action: "CREATE",
    });

    expect(invoice).toBeTruthy();
    expect(invoice.invoiceNumber).toBe("04892-13770360");

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.linkedPurchaseInvoiceIds.map(String)).toContain(
      invoice._id.toString(),
    );
    expect(fresh.receiptFiles[0].ocrProposal).toBeFalsy();
  });

  it("refuse une confirmation sans proposition", async () => {
    const tx = await makeTransactionWithProposal();
    await confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[0]._id,
      action: "CREATE",
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

/**
 * La facture ressemblante n'était cherchée qu'à l'analyse, parmi les factures
 * déjà enregistrées : deux copies du même document (photo + PDF, ou même
 * facture déposée sur deux transactions) analysées avant toute confirmation
 * ne se voyaient pas, et les confirmer créait deux factures. CREATE refait la
 * recherche ; une facture que l'utilisateur n'a pas vue suspend la création.
 */
describe("confirmReceiptInvoiceProposal : facture ressemblante apparue depuis l'analyse", () => {
  const confirm = (tx, extra, fileIndex = 0) =>
    confirmReceiptInvoiceProposal({
      transactionId: tx._id,
      workspaceId: workspaceId.toString(),
      userId,
      fileId: tx.receiptFiles[fileIndex]._id,
      ...extra,
    });

  it("CREATE suspendu : rien n'est créé, la proposition pointe la facture apparue", async () => {
    const tx = await makeTransactionWithProposal();
    // Enregistrée après l'analyse (autre copie confirmée, saisie manuelle…)
    const appeared = await makeInvoice({
      invoiceNumber: "04892-13770360",
      issueDate: "2026-05-25",
    });

    const result = await confirm(tx, {
      action: "CREATE",
      acknowledgedDuplicateId: null,
    });

    expect(result.invoice).toBeNull();
    expect(result.duplicate.invoice._id.toString()).toBe(
      appeared._id.toString(),
    );
    expect(result.duplicate.reason).toBe("NUMBER");
    expect(await PurchaseInvoice.countDocuments({})).toBe(1);

    const fresh = await Transaction.findById(tx._id);
    const proposal = fresh.receiptFiles[0].ocrProposal;
    expect(String(proposal.duplicateInvoiceId)).toBe(appeared._id.toString());
    expect(proposal.duplicateReason).toBe("NUMBER");
    expect(fresh.receiptFiles[0].purchaseInvoiceId).toBeFalsy();
    expect(fresh.linkedPurchaseInvoiceIds).toHaveLength(0);
  });

  it("« Créer quand même » après avoir vu la facture ressemblante : créée", async () => {
    const tx = await makeTransactionWithProposal();
    const appeared = await makeInvoice({
      invoiceNumber: "04892-13770360",
      issueDate: "2026-05-25",
    });

    const result = await confirm(tx, {
      action: "CREATE",
      acknowledgedDuplicateId: appeared._id.toString(),
    });

    expect(result.duplicate).toBeUndefined();
    expect(result.invoice._id.toString()).not.toBe(appeared._id.toString());
    expect(await PurchaseInvoice.countDocuments({})).toBe(2);
  });

  it("client sans acknowledgedDuplicateId : la facture enregistrée sur la proposition vaut pour vue", async () => {
    const existing = await makeInvoice({
      invoiceNumber: "04892-13770360",
      issueDate: "2026-05-25",
    });
    const shown = await makeTransactionWithProposal({
      duplicateInvoiceId: existing._id,
      duplicateReason: "NUMBER",
    });
    const created = await confirm(shown, { action: "CREATE" });
    expect(created.invoice).toBeTruthy();

    // Proposition sans facture ressemblante enregistrée : suspendue
    const unseen = await makeTransactionWithProposal();
    const held = await confirm(unseen, { action: "CREATE" });
    expect(held.invoice).toBeNull();
    expect(held.duplicate).toBeTruthy();
  });

  it("même facture déposée sur deux transactions avant toute confirmation : la seconde est suspendue", async () => {
    const july = await makeTransactionWithProposal();
    const august = await makeTransactionWithProposal();

    const first = await confirm(july, {
      action: "CREATE",
      acknowledgedDuplicateId: null,
    });
    expect(first.invoice).toBeTruthy();

    const held = await confirm(august, {
      action: "CREATE",
      acknowledgedDuplicateId: null,
    });
    expect(held.invoice).toBeNull();
    expect(held.duplicate.invoice._id.toString()).toBe(
      first.invoice._id.toString(),
    );
    expect(held.duplicate.reason).toBe("NUMBER");
    // Facture déjà soldée par le débit de juillet : rattacher y déposerait le
    // fichier sans justifier la dépense d'août
    expect(held.duplicate.linkTransaction).toBe(false);
    expect(await PurchaseInvoice.countDocuments({})).toBe(1);
  });

  it("deux copies illisibles d'une même dépense : la seconde propose la facture déjà liée", async () => {
    const unreadable = () => ({
      values: makeProposalValues({
        supplierName: "Canva*",
        invoiceNumber: null,
        category: "OTHER",
      }),
      meta: {
        ocrSucceeded: false,
        conversionNote: "",
        ocrMetadata: { provider: "none", extractionQuality: "none" },
      },
      duplicateInvoiceId: null,
      duplicateReason: null,
      duplicateLinkTransaction: true,
      proposedAt: new Date(),
    });
    const file = (name) => ({
      url: `https://r2.example/ws/${name}`,
      key: `ws/${name}`,
      filename: name,
      mimetype: "image/jpeg",
      size: 1000,
      ocrProcessed: true,
      ocrProposal: unreadable(),
    });
    const tx = await Transaction.create({
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
      receiptFiles: [file("photo-1.jpg"), file("photo-2.jpg")],
    });

    const first = await confirm(tx, {
      action: "CREATE",
      acknowledgedDuplicateId: null,
    });
    expect(first.invoice).toBeTruthy();

    const held = await confirm(
      tx,
      { action: "CREATE", acknowledgedDuplicateId: null },
      1,
    );
    expect(held.invoice).toBeNull();
    expect(held.duplicate.invoice._id.toString()).toBe(
      first.invoice._id.toString(),
    );
    expect(held.duplicate.reason).toBe("LINKED");
    expect(await PurchaseInvoice.countDocuments({})).toBe(1);
  });
});
