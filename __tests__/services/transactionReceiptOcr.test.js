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

  it("ne crée pas de doublon si la transaction est déjà rapprochée à une facture d'achat", async () => {
    const existingInvoiceId = buildOrganizationId();
    const tx = await createExpenseTransaction({
      linkedPurchaseInvoiceIds: [existingInvoiceId],
    });

    const invoices =
      await transactionReceiptOcrService.processReceiptsForTransaction({
        transactionId: tx._id.toString(),
        workspaceId,
        userId,
      });

    expect(invoices).toHaveLength(0);
    expect(await PurchaseInvoice.countDocuments()).toBe(0);
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
