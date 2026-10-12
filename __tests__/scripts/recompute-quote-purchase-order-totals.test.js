import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import {
  DOCUMENT_TOTAL_FIELDS,
  recomputeQuotePurchaseOrderTotals,
} from "../../scripts/recompute-quote-purchase-order-totals.js";
import { readBackup, restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const silent = () => {};
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "devis-bc-totaux-"));
const UPDATED_AT = new Date("2026-09-20T10:00:00.000Z");

// Totaux enregistrés par l'ancien pre-save : port ignoré (100 HT, 20 TVA)
const OLD_TOTALS = {
  totalHT: 100,
  totalVAT: 20,
  totalTTC: 120,
  finalTotalHT: 100,
  finalTotalVAT: 20,
  finalTotalTTC: 120,
  discountAmount: 0,
};

let sequence = 0;

/**
 * Enregistre un document par le vrai pre-save (totaux justes, renvoyés),
 * puis remet en base les anciens totaux et une date de modification fixe.
 */
const insertDocument = async (
  Model,
  overrides = {},
  oldTotals = OLD_TOTALS,
) => {
  sequence += 1;
  const doc = new Model({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "D-202609-",
    number: String(sequence).padStart(4, "0"),
    status: "DRAFT",
    items: [
      {
        description: "Prestation",
        quantity: 1,
        unitPrice: 100,
        vatRate: 20,
        discount: 0,
        discountType: "PERCENTAGE",
      },
    ],
    shipping: { billShipping: true, shippingAmountHT: 10, shippingVatRate: 20 },
    ...overrides,
  });
  // Les hooks pre-save tournent, la validation métier n'est pas l'objet ici
  await doc.save({ validateBeforeSave: false });
  const expected = Object.fromEntries(
    DOCUMENT_TOTAL_FIELDS.map((field) => [field, doc[field]]),
  );
  await Model.collection.updateOne(
    { _id: doc._id },
    { $set: { ...oldTotals, updatedAt: UPDATED_AT } },
  );
  return { id: doc._id, expected };
};

const stored = (Model, id) => Model.collection.findOne({ _id: id });
const run = (options = {}) =>
  recomputeQuotePurchaseOrderTotals({ log: silent, backupDir, ...options });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearMongo();
});

describe("recomputeQuotePurchaseOrderTotals", () => {
  it("n'écrit rien sans --apply et liste le document avec avant / après", async () => {
    const { id } = await insertDocument(Quote);
    const lines = [];

    const result = await run({ log: (line) => lines.push(line) });

    expect(result.quote).toMatchObject({ scanned: 1, toFix: 1, updated: 0 });
    expect(result.backupFile).toBeNull();
    expect((await stored(Quote, id)).finalTotalTTC).toBe(120);
    const line = lines.find((l) => l.includes("Devis D-202609-"));
    expect(line).toContain("TTC 120.00 → 132.00");
    expect(line).toContain("[port facturé]");
  });

  it("aligne devis et bons de commande sur le pre-save actuel, sans toucher updatedAt", async () => {
    const quote = await insertDocument(Quote);
    const order = await insertDocument(PurchaseOrder, { prefix: "BC-202609-" });

    const result = await run({ apply: true });

    expect(result.quote.updated).toBe(1);
    expect(result.purchaseOrder.updated).toBe(1);
    for (const [Model, { id, expected }] of [
      [Quote, quote],
      [PurchaseOrder, order],
    ]) {
      const doc = await stored(Model, id);
      // Mêmes valeurs que le pre-save (port compris : 132 TTC)
      expect(doc).toMatchObject(expected);
      expect(doc.finalTotalTTC).toBe(132);
      expect(doc.updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());
    }

    const backup = readBackup(result.backupFile);
    expect(backup.entries).toHaveLength(2);
    expect(backup.entries[0].before).toEqual(OLD_TOTALS);
  });

  it("liste un document finalisé sans le corriger, sauf avec --include-finalized", async () => {
    const pending = await insertDocument(Quote, {
      status: "PENDING",
      archivedPdfKey: "quotes/x/2026/09/devis.pdf",
      archivedPdfSource: "NEWBI",
    });
    const confirmed = await insertDocument(PurchaseOrder, {
      prefix: "BC-202609-",
      status: "CONFIRMED",
    });
    const lines = [];

    const preview = await run({
      apply: true,
      log: (line) => lines.push(line),
    });

    expect(preview.quote).toMatchObject({ finalizedSkipped: 1, updated: 0 });
    expect(preview.purchaseOrder).toMatchObject({
      finalizedSkipped: 1,
      updated: 0,
    });
    expect((await stored(Quote, pending.id)).finalTotalTTC).toBe(120);
    const quoteLine = lines.find((l) => l.startsWith("  ⏸ Devis"));
    expect(quoteLine).toContain("PENDING, PDF archivé");
    expect(quoteLine).toContain("--include-finalized");

    const result = await run({ apply: true, includeFinalized: true });

    expect(result.quote.updated).toBe(1);
    expect(result.purchaseOrder.updated).toBe(1);
    expect(await stored(Quote, pending.id)).toMatchObject(pending.expected);
    expect(await stored(PurchaseOrder, confirmed.id)).toMatchObject(
      confirmed.expected,
    );
  });

  it("plafonne une remise fixe supérieure au HT des articles", async () => {
    const { id, expected } = await insertDocument(
      Quote,
      { discount: 150, discountType: "FIXED", shipping: undefined },
      // Ancien pre-save : remise non plafonnée
      {
        totalHT: 100,
        totalVAT: 20,
        totalTTC: 120,
        finalTotalHT: 0,
        finalTotalVAT: 0,
        finalTotalTTC: 0,
        discountAmount: 150,
      },
    );

    await run({ apply: true });

    const doc = await stored(Quote, id);
    expect(doc.discountAmount).toBe(100);
    expect(doc).toMatchObject(expected);
  });

  it("ignore un document sans article (le pre-save ne calcule rien)", async () => {
    const { id } = await insertDocument(Quote, { items: [] });

    const result = await run({ apply: true });

    expect(result.quote).toMatchObject({ withoutItems: 1, toFix: 0 });
    expect((await stored(Quote, id)).finalTotalTTC).toBe(120);
  });

  it("est idempotent et respecte --type et --workspace", async () => {
    const mine = await insertDocument(Quote);
    const other = await insertDocument(Quote, {
      workspaceId: buildOrganizationId(),
    });
    const order = await insertDocument(PurchaseOrder, { prefix: "BC-" });

    const first = await run({
      apply: true,
      types: ["quote"],
      workspaceId: organizationId.toString(),
    });
    const second = await run({
      apply: true,
      types: ["quote"],
      workspaceId: organizationId.toString(),
    });

    expect(first.quote.updated).toBe(1);
    expect(first.purchaseOrder).toBeUndefined();
    expect(second.quote).toMatchObject({ unchanged: 1, toFix: 0 });
    expect(second.backupFile).toBeNull();
    expect((await stored(Quote, mine.id)).finalTotalTTC).toBe(132);
    expect((await stored(Quote, other.id)).finalTotalTTC).toBe(120);
    expect((await stored(PurchaseOrder, order.id)).finalTotalTTC).toBe(120);
  });

  it("le retour arrière remet les anciens totaux, sauf document modifié depuis", async () => {
    const kept = await insertDocument(Quote);
    const editedSince = await insertDocument(PurchaseOrder, { prefix: "BC-" });
    const { backupFile } = await run({ apply: true });
    // Bon de commande réenregistré dans l'appli après le script
    await PurchaseOrder.collection.updateOne(
      { _id: editedSince.id },
      { $set: { finalTotalTTC: 264 } },
    );

    const restored = await restoreBackup(backupFile, {
      apply: true,
      log: silent,
    });

    expect(restored).toMatchObject({ restored: 1, skipped: 1 });
    const quote = await stored(Quote, kept.id);
    expect(quote).toMatchObject(OLD_TOTALS);
    expect(quote.updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());
    expect((await stored(PurchaseOrder, editedSince.id)).finalTotalTTC).toBe(
      264,
    );
  });
});
