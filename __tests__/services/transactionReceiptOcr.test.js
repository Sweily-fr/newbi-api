import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const processFromBase64 = vi.fn();
const toInvoiceFormat = vi.fn();
vi.mock("../../src/services/claudeVisionOcrService.js", () => ({
  default: {
    processFromBase64: (...a) => processFromBase64(...a),
    toInvoiceFormat: (...a) => toInvoiceFormat(...a),
  },
}));

const processDocumentFromUrl = vi.fn();
vi.mock("../../src/services/hybridOcrService.js", () => ({
  default: {
    processDocumentFromUrl: (...a) => processDocumentFromUrl(...a),
  },
}));

const analyzeDocument = vi.fn();
vi.mock("../../src/services/mistralIntelligentAnalysisService.js", () => ({
  default: {
    analyzeDocument: (...a) => analyzeDocument(...a),
  },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Supplier from "../../src/models/Supplier.js";
import transactionReceiptOcrService from "../../src/services/transactionReceiptOcrService.js";

const workspaceId = buildOrganizationId().toString();
const userId = buildUserId().toString();

let externalIdCounter = 0;

async function createExpenseTransaction(overrides = {}) {
  externalIdCounter += 1;
  return Transaction.create({
    externalId: `tx-ocr-${externalIdCounter}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -120.5,
    currency: "EUR",
    description: "CB AMAZON EU SARL",
    workspaceId,
    date: new Date("2026-07-20T00:00:00.000Z"),
    receiptFiles: [
      {
        url: "https://receipts.newbi.fr/receipt-1.pdf",
        key: "receipts/receipt-1.pdf",
        filename: "receipt-1.pdf",
        mimetype: "application/pdf",
        size: 1234,
        uploadedBy: userId,
      },
    ],
    ...overrides,
  });
}

function mockClaudeSuccess() {
  processFromBase64.mockResolvedValue({
    success: true,
    extractedText: "FACTURE Amazon EU SARL ...",
    data: {},
  });
  toInvoiceFormat.mockReturnValue({
    transaction_data: {
      document_number: "INV-2026-042",
      transaction_date: "18/07/2026",
      due_date: null,
      vendor_name: "Amazon EU SARL",
      amount: 120.5,
      amount_ht: 100.42,
      tax_amount: 20.08,
      tax_rate: 20,
      currency: "EUR",
      category: "OFFICE_SUPPLIES",
      payment_method: "card",
    },
    extracted_fields: {
      vendor_address: "38 avenue John F. Kennedy, Luxembourg",
      vendor_vat_number: "LU26375245",
      totals: { total_ht: 100.42, total_tax: 20.08, total_ttc: 120.5 },
    },
    document_analysis: { confidence: 0.95 },
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
  processFromBase64.mockReset();
  toInvoiceFormat.mockReset();
  processDocumentFromUrl.mockReset();
  analyzeDocument.mockReset();
});

describe("transactionReceiptOcrService.processReceiptsForTransaction", () => {
  it("crée une facture d'achat depuis le justificatif d'une dépense (OCR Claude)", async () => {
    mockClaudeSuccess();
    const tx = await createExpenseTransaction();

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: {
          "receipts/receipt-1.pdf": Buffer.from("fake-pdf"),
        },
      });

    expect(invoices).toHaveLength(1);
    const invoice = await PurchaseInvoice.findById(invoices[0]._id);

    expect(invoice.supplierName).toBe("Amazon EU SARL");
    expect(invoice.invoiceNumber).toBe("INV-2026-042");
    expect(invoice.amountTTC).toBe(120.5);
    expect(invoice.amountHT).toBe(100.42);
    expect(invoice.amountTVA).toBe(20.08);
    expect(invoice.vatRate).toBe(20);
    expect(invoice.category).toBe("OFFICE_SUPPLIES");
    expect(invoice.paymentMethod).toBe("CREDIT_CARD");
    expect(invoice.status).toBe("PAID");
    expect(invoice.source).toBe("OCR");
    expect(invoice.isReconciled).toBe(true);
    expect(invoice.linkedTransactionIds.map(String)).toContain(
      tx._id.toString(),
    );
    expect(invoice.issueDate.toISOString()).toBe("2026-07-18T00:00:00.000Z");
    expect(invoice.files).toHaveLength(1);
    expect(invoice.files[0].url).toBe(
      "https://receipts.newbi.fr/receipt-1.pdf",
    );
    expect(invoice.files[0].ocrProcessed).toBe(true);
    expect(invoice.ocrMetadata.supplierVatNumber).toBe("LU26375245");
    expect(invoice.ocrMetadata.confidenceScore).toBe(0.95);

    // Fournisseur auto-créé
    const supplier = await Supplier.findOne({ name: "Amazon EU SARL" });
    expect(supplier).not.toBeNull();
    expect(invoice.supplierId.toString()).toBe(supplier._id.toString());

    // Transaction liée et rapprochée
    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.linkedPurchaseInvoiceIds.map(String)).toContain(
      invoice._id.toString(),
    );
    expect(updatedTx.reconciliationStatus).toBe("matched");
    expect(updatedTx.receiptFiles[0].ocrProcessed).toBe(true);
    expect(updatedTx.receiptFiles[0].purchaseInvoiceId.toString()).toBe(
      invoice._id.toString(),
    );
  });

  it("justificatif en devise étrangère : la facture prend le débit bancaire converti (EUR) et garde le montant d'origine", async () => {
    mockClaudeSuccess();
    toInvoiceFormat.mockReturnValue({
      transaction_data: {
        document_number: "MDB-2026-08",
        transaction_date: "02/08/2026",
        vendor_name: "MongoDB Inc",
        amount: 10.59,
        amount_ht: 10.59,
        tax_amount: 0,
        tax_rate: 0,
        currency: "USD",
        category: "SOFTWARE",
        payment_method: "card",
      },
      extracted_fields: {
        totals: { total_ht: 10.59, total_tax: 0, total_ttc: 10.59 },
      },
      document_analysis: { confidence: 0.9 },
    });
    const tx = await createExpenseTransaction({
      amount: -9.25,
      currency: "EUR",
      description: "CB MONGODB",
      date: new Date("2026-08-02T00:00:00.000Z"),
    });

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });

    expect(invoices).toHaveLength(1);
    const invoice = await PurchaseInvoice.findById(invoices[0]._id);
    expect(invoice.currency).toBe("EUR");
    expect(invoice.amountTTC).toBe(9.25);
    expect(invoice.amountHT).toBe(9.25);
    expect(invoice.amountTVA).toBe(0);
    expect(invoice.vatRate).toBe(0);
    // Montant lu sur le justificatif conservé pour information
    expect(invoice.ocrMetadata.amountTTC).toBe(10.59);
    expect(invoice.ocrMetadata.currency).toBe("USD");
    expect(invoice.notes).toContain("10.59 USD");
    expect(invoice.notes).toContain("9.25 EUR");
  });

  it("justificatif en devise étrangère déposé sur une seconde transaction : rattaché à la facture existante (montant converti)", async () => {
    const ocrUsd = () =>
      toInvoiceFormat.mockReturnValue({
        transaction_data: {
          document_number: "MDB-2026-08",
          transaction_date: "02/08/2026",
          vendor_name: "MongoDB Inc",
          amount: 10.59,
          amount_ht: 10.59,
          tax_amount: 0,
          tax_rate: 0,
          currency: "USD",
          category: "SOFTWARE",
          payment_method: "card",
        },
        extracted_fields: {
          totals: { total_ht: 10.59, total_tax: 0, total_ttc: 10.59 },
        },
        document_analysis: { confidence: 0.9 },
      });
    mockClaudeSuccess();
    ocrUsd();
    const tx1 = await createExpenseTransaction({
      amount: -9.25,
      description: "CB MONGODB",
    });
    await transactionReceiptOcrService.processReceiptsForTransaction({
      transactionId: tx1._id.toString(),
      workspaceId,
      userId,
      buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
    });

    mockClaudeSuccess();
    ocrUsd();
    const tx2 = await createExpenseTransaction({
      amount: -9.25,
      description: "CB MONGODB",
      receiptFiles: [
        {
          url: "https://receipts.newbi.fr/receipt-2.pdf",
          key: "receipts/receipt-2.pdf",
          filename: "receipt-2.pdf",
          mimetype: "application/pdf",
          size: 1234,
          uploadedBy: userId,
        },
      ],
    });
    await transactionReceiptOcrService.processReceiptsForTransaction({
      transactionId: tx2._id.toString(),
      workspaceId,
      userId,
      buffersByKey: { "receipts/receipt-2.pdf": Buffer.from("fake-pdf") },
    });

    const all = await PurchaseInvoice.find({ workspaceId });
    expect(all).toHaveLength(1);
    expect(all[0].amountTTC).toBe(9.25);
    expect(all[0].linkedTransactionIds.map(String)).toEqual(
      expect.arrayContaining([tx1._id.toString(), tx2._id.toString()]),
    );
  });

  it("moteurs IA indisponibles : Tesseract + regex pré-remplissent la facture, marquée « partial »", async () => {
    processFromBase64.mockRejectedValue(
      new Error("ANTHROPIC_API_KEY manquante"),
    );
    processDocumentFromUrl.mockResolvedValue({
      success: true,
      provider: "tesseract",
      extractionQuality: "partial",
      extractedText:
        "Northwind Digital LLC INVOICE ... Balance due (USD) $3,577.78",
      transaction_data: {
        vendor_name: "Northwind Digital LLC",
        amount: 3577.78,
        amount_ht: 3847,
        tax_amount: 310.78,
        tax_rate: 8.25,
        transaction_date: "2026-03-04",
        due_date: "2026-04-03",
        document_number: "INV-2026-0042",
        currency: "USD",
        category: "OTHER",
        payment_method: "",
      },
      extracted_fields: {
        totals: { total_ht: 3847, total_tax: 310.78, total_ttc: 3577.78 },
      },
    });
    // Analyse Mistral en quota : analyse de secours (success false)
    analyzeDocument.mockResolvedValue({
      success: false,
      degraded: true,
      extractionQuality: "partial",
      transaction_data: { vendor_name: "Fournisseur inconnu", amount: 0 },
      extracted_fields: {},
    });
    const tx = await createExpenseTransaction({
      amount: -3470.12,
      description: "CB NORTHWIND DIGITAL",
    });

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake") },
      });

    expect(invoices).toHaveLength(1);
    const invoice = await PurchaseInvoice.findById(invoices[0]._id);
    expect(invoice.supplierName).toBe("Northwind Digital LLC");
    expect(invoice.invoiceNumber).toBe("INV-2026-0042");
    // Combiné au correctif devise : justificatif en USD sur un compte EUR,
    // la facture porte le débit bancaire converti et garde le montant lu
    expect(invoice.amountTTC).toBe(3470.12);
    expect(invoice.currency).toBe("EUR");
    expect(invoice.ocrMetadata.amountTTC).toBe(3577.78);
    expect(invoice.ocrMetadata.currency).toBe("USD");
    expect(invoice.vatRate).toBe(8.25);
    expect(invoice.ocrMetadata.provider).toBe("tesseract");
    expect(invoice.ocrMetadata.extractionQuality).toBe("partial");
    expect(invoice.files[0].ocrProcessed).toBe(true);
  });

  it("OCR totalement impossible : facture depuis la transaction, marquée « none »", async () => {
    processFromBase64.mockRejectedValue(
      new Error("ANTHROPIC_API_KEY manquante"),
    );
    processDocumentFromUrl.mockResolvedValue({
      success: false,
      error: "Tous les OCR ont échoué",
      provider: "none",
    });
    const tx = await createExpenseTransaction({ amount: -42 });

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake") },
      });

    expect(invoices).toHaveLength(1);
    const invoice = await PurchaseInvoice.findById(invoices[0]._id);
    expect(invoice.amountTTC).toBe(42);
    expect(invoice.ocrMetadata.extractionQuality).toBe("none");
    expect(invoice.files[0].ocrProcessed).toBe(false);
  });

  it("OCR Claude réussi : facture marquée « full » avec le moteur", async () => {
    mockClaudeSuccess();
    const tx = await createExpenseTransaction();
    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });
    const invoice = await PurchaseInvoice.findById(invoices[0]._id);
    expect(invoice.ocrMetadata.provider).toBe("claude-vision");
    expect(invoice.ocrMetadata.extractionQuality).toBe("full");
  });

  it("ignore les transactions qui ne sont pas des dépenses", async () => {
    const tx = await createExpenseTransaction({ type: "credit", amount: 250 });

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
      });

    expect(invoices).toHaveLength(0);
    expect(await PurchaseInvoice.countDocuments()).toBe(0);
    expect(processFromBase64).not.toHaveBeenCalled();
    expect(processDocumentFromUrl).not.toHaveBeenCalled();
  });

  it("ignore les transactions au statut ignored (choix utilisateur respecté)", async () => {
    const tx = await createExpenseTransaction({
      reconciliationStatus: "ignored",
    });

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
      });

    expect(invoices).toHaveLength(0);
    expect(await PurchaseInvoice.countDocuments()).toBe(0);
    const unchanged = await Transaction.findById(tx._id);
    expect(unchanged.reconciliationStatus).toBe("ignored");
  });

  it("rattache le justificatif à une facture d'achat existante (même numéro) au lieu de créer un doublon", async () => {
    mockClaudeSuccess();
    // Facture saisie à la main avant le dépôt du justificatif sur la transaction
    const existing = await PurchaseInvoice.create({
      workspaceId,
      createdBy: userId,
      supplierName: "Amazon EU SARL",
      invoiceNumber: "INV-2026-042",
      issueDate: new Date("2026-07-18T00:00:00.000Z"),
      amountHT: 100.42,
      amountTVA: 20.08,
      vatRate: 20,
      amountTTC: 120.5,
      status: "TO_PAY",
    });
    const tx = await createExpenseTransaction();

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });

    expect(invoices).toHaveLength(1);
    expect(invoices[0]._id.toString()).toBe(existing._id.toString());
    expect(await PurchaseInvoice.countDocuments()).toBe(1);

    const updated = await PurchaseInvoice.findById(existing._id);
    expect(updated.status).toBe("PAID");
    expect(updated.isReconciled).toBe(true);
    expect(updated.linkedTransactionIds.map(String)).toContain(
      tx._id.toString(),
    );
    expect(updated.files).toHaveLength(1);
    expect(updated.files[0].path).toBe("receipts/receipt-1.pdf");

    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.reconciliationStatus).toBe("matched");
    expect(updatedTx.linkedPurchaseInvoiceIds.map(String)).toEqual([
      existing._id.toString(),
    ]);
    expect(updatedTx.receiptFiles[0].purchaseInvoiceId.toString()).toBe(
      existing._id.toString(),
    );
  });

  it("une même facture déposée sur deux transactions ne donne qu'une facture d'achat (relevé mensuel)", async () => {
    mockClaudeSuccess();
    const tx1 = await createExpenseTransaction({ amount: -120.5 });
    const tx2 = await createExpenseTransaction({
      amount: -30,
      receiptFiles: [
        {
          url: "https://receipts.newbi.fr/receipt-2.pdf",
          key: "receipts/receipt-2.pdf",
          filename: "receipt-2.pdf",
          mimetype: "application/pdf",
          size: 1234,
          uploadedBy: userId,
        },
      ],
    });

    const first =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx1._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });
    const second =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx2._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-2.pdf": Buffer.from("fake-pdf") },
      });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]._id.toString()).toBe(first[0]._id.toString());
    expect(await PurchaseInvoice.countDocuments()).toBe(1);

    const invoice = await PurchaseInvoice.findById(first[0]._id);
    expect(invoice.linkedTransactionIds.map(String).sort()).toEqual(
      [tx1._id.toString(), tx2._id.toString()].sort(),
    );
    const updatedTx2 = await Transaction.findById(tx2._id);
    expect(updatedTx2.reconciliationStatus).toBe("matched");
    expect(updatedTx2.linkedPurchaseInvoiceIds.map(String)).toEqual([
      invoice._id.toString(),
    ]);
  });

  it("crée une seconde facture d'achat si le justificatif est différent (plusieurs justificatifs par transaction)", async () => {
    mockClaudeSuccess();
    const tx = await createExpenseTransaction({ amount: -180 });

    const first =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });
    expect(first).toHaveLength(1);

    // Second justificatif : autre fournisseur, autre numéro
    toInvoiceFormat.mockReturnValue({
      transaction_data: {
        document_number: "SFR-2026-0099",
        transaction_date: "18/07/2026",
        vendor_name: "SFR Business",
        amount: 59.5,
        currency: "EUR",
        category: "TELECOMMUNICATIONS",
      },
      extracted_fields: { totals: { total_ttc: 59.5 } },
      document_analysis: { confidence: 0.9 },
    });
    await Transaction.updateOne(
      { _id: tx._id },
      {
        $push: {
          receiptFiles: {
            url: "https://receipts.newbi.fr/receipt-2.pdf",
            key: "receipts/receipt-2.pdf",
            filename: "receipt-2.pdf",
            mimetype: "application/pdf",
            size: 999,
            uploadedBy: userId,
          },
        },
      },
    );

    const second =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-2.pdf": Buffer.from("fake-pdf") },
      });

    expect(second).toHaveLength(1);
    expect(second[0]._id.toString()).not.toBe(first[0]._id.toString());
    expect(await PurchaseInvoice.countDocuments()).toBe(2);

    const updatedTx = await Transaction.findById(tx._id);
    expect(updatedTx.linkedPurchaseInvoiceIds.map(String).sort()).toEqual(
      [first[0]._id.toString(), second[0]._id.toString()].sort(),
    );
    expect(updatedTx.receiptFiles[1].purchaseInvoiceId.toString()).toBe(
      second[0]._id.toString(),
    );
  });

  it("OCR en échec sur une transaction déjà rapprochée : rattache le fichier à la facture liée, sans facture fallback", async () => {
    processFromBase64.mockRejectedValue(new Error("Claude indisponible"));
    processDocumentFromUrl.mockResolvedValue({ success: false });
    const existing = await PurchaseInvoice.create({
      workspaceId,
      createdBy: userId,
      supplierName: "Qonto",
      invoiceNumber: "QONTO-2026-07",
      issueDate: new Date("2026-07-31T00:00:00.000Z"),
      amountHT: 100,
      amountTVA: 20,
      vatRate: 20,
      amountTTC: 120,
      status: "PAID",
      isReconciled: true,
    });
    const tx = await createExpenseTransaction({
      linkedPurchaseInvoiceIds: [existing._id],
      reconciliationStatus: "matched",
    });
    await PurchaseInvoice.updateOne(
      { _id: existing._id },
      { $addToSet: { linkedTransactionIds: tx._id } },
    );

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });

    expect(invoices).toHaveLength(1);
    expect(invoices[0]._id.toString()).toBe(existing._id.toString());
    expect(await PurchaseInvoice.countDocuments()).toBe(1);
    const updated = await PurchaseInvoice.findById(existing._id);
    expect(updated.files).toHaveLength(1);
    expect(updated.files[0].ocrProcessed).toBe(false);
  });

  it("ne retraite pas un justificatif déjà traité (idempotence)", async () => {
    mockClaudeSuccess();
    const tx = await createExpenseTransaction();
    const params = {
      transactionId: tx._id.toString(),
      workspaceId,
      userId,
      buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
    };

    const first =
      await transactionReceiptOcrService.processReceiptsForTransaction(params);
    expect(first).toHaveLength(1);

    const second =
      await transactionReceiptOcrService.processReceiptsForTransaction(params);
    expect(second).toHaveLength(0);
    expect(await PurchaseInvoice.countDocuments()).toBe(1);
  });

  it("crée la facture avec les données de la transaction si l'OCR échoue", async () => {
    processFromBase64.mockRejectedValue(new Error("Claude indisponible"));
    processDocumentFromUrl.mockResolvedValue({
      success: false,
      error: "OCR hybride échoué",
    });
    const tx = await createExpenseTransaction();

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
        buffersByKey: { "receipts/receipt-1.pdf": Buffer.from("fake-pdf") },
      });

    expect(invoices).toHaveLength(1);
    const invoice = await PurchaseInvoice.findById(invoices[0]._id);
    expect(invoice.supplierName).toBe("CB AMAZON EU SARL");
    expect(invoice.amountTTC).toBe(120.5);
    expect(invoice.status).toBe("PAID");
    expect(invoice.source).toBe("OCR");
    expect(invoice.files[0].ocrProcessed).toBe(false);
  });

  it("utilise le fallback hybride (URL) quand aucun buffer n'est fourni", async () => {
    processDocumentFromUrl.mockResolvedValue({
      success: true,
      provider: "mistral-ocr",
      extractedText: "Facture SFR ...",
    });
    analyzeDocument.mockResolvedValue({
      transaction_data: {
        vendor_name: "SFR Business",
        amount: 45.99,
        currency: "EUR",
        category: "TELECOMMUNICATIONS",
      },
      extracted_fields: {},
    });
    const tx = await createExpenseTransaction();

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
      });

    expect(processDocumentFromUrl).toHaveBeenCalledWith(
      "https://receipts.newbi.fr/receipt-1.pdf",
      "receipt-1.pdf",
      "application/pdf",
      workspaceId,
    );
    expect(analyzeDocument).toHaveBeenCalled();
    expect(invoices).toHaveLength(1);
    expect(invoices[0].supplierName).toBe("SFR Business");
    expect(invoices[0].amountTTC).toBe(45.99);
    expect(invoices[0].category).toBe("TELECOMMUNICATIONS");
  });
});

describe("transactionReceiptOcrService.isExpenseTransaction", () => {
  it("détecte une dépense par montant négatif ou type debit", () => {
    expect(
      transactionReceiptOcrService.isExpenseTransaction({
        amount: -10,
        type: "payment",
      }),
    ).toBe(true);
    expect(
      transactionReceiptOcrService.isExpenseTransaction({
        amount: 10,
        type: "debit",
      }),
    ).toBe(true);
    expect(
      transactionReceiptOcrService.isExpenseTransaction({
        amount: 10,
        type: "credit",
      }),
    ).toBe(false);
  });
});

describe("transactionReceiptOcrService.resolveReceiptAmounts", () => {
  const { resolveReceiptAmounts } = transactionReceiptOcrService;
  const tx = { amount: -9.25, currency: "EUR" };

  it("garde les montants OCR quand la devise est celle du compte", () => {
    const r = resolveReceiptAmounts({
      transaction: tx,
      financial: {
        transaction_data: {
          amount: 120.5,
          amount_ht: 100.42,
          tax_amount: 20.08,
          tax_rate: 20,
          currency: "eur",
        },
      },
    });
    expect(r).toMatchObject({
      amountTTC: 120.5,
      amountHT: 100.42,
      amountTVA: 20.08,
      vatRate: 20,
      currency: "EUR",
      conversion: null,
    });
  });

  it("garde les montants OCR quand l'OCR ne donne pas de devise", () => {
    const r = resolveReceiptAmounts({
      transaction: tx,
      financial: {
        transaction_data: { amount: 10.59, amount_ht: 8.83, tax_amount: 1.76 },
      },
    });
    expect(r.amountTTC).toBe(10.59);
    expect(r.currency).toBe("EUR");
    expect(r.conversion).toBeNull();
  });

  it("devise étrangère (symbole $) : débit bancaire retenu, HT et TVA au prorata", () => {
    const r = resolveReceiptAmounts({
      transaction: { amount: -100, currency: "EUR" },
      financial: {
        transaction_data: {
          amount: 120,
          amount_ht: 100,
          tax_amount: 20,
          tax_rate: 20,
          currency: "$",
        },
      },
    });
    expect(r).toEqual({
      amountTTC: 100,
      amountHT: 83.33,
      amountTVA: 16.67,
      vatRate: 20,
      currency: "EUR",
      conversion: { originalAmountTTC: 120, originalCurrency: "USD" },
    });
  });

  it("devise étrangère sans montant bancaire exploitable : montants OCR conservés dans leur devise", () => {
    const r = resolveReceiptAmounts({
      transaction: { amount: 0, currency: "EUR" },
      financial: { transaction_data: { amount: 10.59, currency: "USD" } },
    });
    expect(r.amountTTC).toBe(10.59);
    expect(r.currency).toBe("USD");
    expect(r.conversion).toBeNull();
  });

  it("OCR en échec : montant de la transaction dans sa devise", () => {
    const r = resolveReceiptAmounts({ transaction: tx, financial: null });
    expect(r.amountTTC).toBe(9.25);
    expect(r.currency).toBe("EUR");
    expect(r.vatRate).toBe(20);
  });
});
