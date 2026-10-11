import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  backfillPurchaseInvoiceOcrMetadata,
  ocrMetadataFromFiles,
} from "../../scripts/backfill-purchase-invoice-ocr-metadata.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const silent = () => {};

// JSON brut de l'analyse OCR envoyé par le desktop (processDocumentOcr)
const RAW_OCR = {
  transaction_data: {
    vendor_name: "Figma Inc",
    document_number: "INV-2026-42",
    transaction_date: "2026-09-15",
    amount: 120,
    amount_ht: 100,
    tax_amount: 20,
    tax_rate: 20,
    currency: "USD",
  },
  extracted_fields: { vendor_siret: "12345678901234" },
  document_analysis: { confidence: 0.92 },
};

const file = (ocrData, name = "justificatif.pdf") => ({
  _id: new mongoose.Types.ObjectId(),
  filename: name,
  originalFilename: name,
  mimetype: "application/pdf",
  path: `ocr/${name}`,
  size: 1234,
  url: `https://test.r2.dev/${name}`,
  ocrProcessed: true,
  ocrData,
});

const insert = async (overrides = {}) => {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    supplierName: "Figma",
    invoiceNumber: "INV-2026-42",
    issueDate: new Date("2026-09-15"),
    amountTTC: 110.5,
    currency: "EUR",
    status: "TO_PAY",
    files: [file(RAW_OCR)],
    ocrMetadata: {},
    createdAt: new Date("2026-09-15"),
    updatedAt: new Date("2026-09-15"),
    ...overrides,
  });
  return insertedId;
};

const stored = (id) => PurchaseInvoice.collection.findOne({ _id: id });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

describe("ocrMetadataFromFiles", () => {
  it("fusionne les justificatifs dans l'ordre, le plus récent l'emporte", () => {
    const metadata = ocrMetadataFromFiles([
      file(RAW_OCR),
      file(null, "sans-ocr.pdf"),
      file(
        JSON.stringify({ supplierName: "Figma Ireland", amountTTC: 130 }),
        "second.pdf",
      ),
    ]);

    expect(metadata.supplierName).toBe("Figma Ireland");
    expect(metadata.amountTTC).toBe(130);
    // Champs lus seulement sur le premier justificatif conservés
    expect(metadata.currency).toBe("USD");
    expect(metadata.supplierSiret).toBe("12345678901234");
  });
});

describe("backfillPurchaseInvoiceOcrMetadata", () => {
  it("n'écrit rien sans --apply (aperçu par défaut)", async () => {
    const id = await insert();

    const stats = await backfillPurchaseInvoiceOcrMetadata({ log: silent });

    expect(stats).toEqual({
      scanned: 1,
      fillable: 1,
      updated: 0,
      unreadable: 0,
    });
    expect((await stored(id)).ocrMetadata).toEqual({});
  });

  it("remplit ocrMetadata depuis le JSON OCR brut des justificatifs", async () => {
    const id = await insert({
      // Champs posés par d'autres flux, à conserver
      ocrMetadata: { provider: "claude-vision" },
    });

    const stats = await backfillPurchaseInvoiceOcrMetadata({
      apply: true,
      log: silent,
    });

    expect(stats.updated).toBe(1);
    const invoice = await stored(id);
    expect(invoice.ocrMetadata).toMatchObject({
      provider: "claude-vision",
      supplierName: "Figma Inc",
      invoiceNumber: "INV-2026-42",
      amountTTC: 120,
      currency: "USD",
      amountHT: 100,
      amountTVA: 20,
      vatRate: 20,
      supplierSiret: "12345678901234",
      confidenceScore: 0.92,
    });
    expect(invoice.ocrMetadata.invoiceDate.toISOString().slice(0, 10)).toBe(
      "2026-09-15",
    );
    // Rattrapage technique : la date de modification ne bouge pas
    expect(invoice.updatedAt.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("ne touche pas une facture qui a déjà des métadonnées OCR", async () => {
    const id = await insert({
      ocrMetadata: { amountTTC: 99, currency: "GBP" },
    });

    const stats = await backfillPurchaseInvoiceOcrMetadata({
      apply: true,
      log: silent,
    });

    expect(stats.scanned).toBe(0);
    expect((await stored(id)).ocrMetadata).toEqual({
      amountTTC: 99,
      currency: "GBP",
    });
  });

  it("traite ocrMetadata absent ou nul et l'ancienne forme en chaîne", async () => {
    const missing = await insert({ ocrMetadata: undefined });
    const nul = await insert({
      ocrMetadata: null,
      files: [
        file(
          JSON.stringify({
            supplierName: "Acme",
            amountTTC: 60,
            currency: "GBP",
          }),
        ),
      ],
    });

    await backfillPurchaseInvoiceOcrMetadata({ apply: true, log: silent });

    expect((await stored(missing)).ocrMetadata.amountTTC).toBe(120);
    expect((await stored(nul)).ocrMetadata).toMatchObject({
      supplierName: "Acme",
      amountTTC: 60,
      currency: "GBP",
    });
  });

  it("ignore les factures sans données OCR et compte les illisibles", async () => {
    const noOcr = await insert({ files: [file(null)] });
    const noFile = await insert({ files: [] });
    const unreadable = await insert({ files: [file("pas du JSON")] });

    const stats = await backfillPurchaseInvoiceOcrMetadata({
      apply: true,
      log: silent,
    });

    expect(stats).toEqual({
      scanned: 1,
      fillable: 0,
      updated: 0,
      unreadable: 1,
    });
    for (const id of [noOcr, noFile, unreadable]) {
      expect((await stored(id)).ocrMetadata).toEqual({});
    }
  });

  it("est idempotent : une seconde exécution ne trouve plus rien", async () => {
    await insert();
    await insert({ invoiceNumber: "INV-2026-43" });

    const first = await backfillPurchaseInvoiceOcrMetadata({
      apply: true,
      log: silent,
    });
    const second = await backfillPurchaseInvoiceOcrMetadata({
      apply: true,
      log: silent,
    });

    expect(first.updated).toBe(2);
    expect(second).toEqual({
      scanned: 0,
      fillable: 0,
      updated: 0,
      unreadable: 0,
    });
  });

  it("se limite à une organisation avec workspaceId", async () => {
    const mine = await insert();
    const other = await insert({ workspaceId: buildOrganizationId() });

    await backfillPurchaseInvoiceOcrMetadata({
      apply: true,
      workspaceId: organizationId.toString(),
      log: silent,
    });

    expect((await stored(mine)).ocrMetadata.amountTTC).toBe(120);
    expect((await stored(other)).ocrMetadata).toEqual({});
  });
});
