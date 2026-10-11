import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import CreditNote from "../../src/models/CreditNote.js";
import Invoice from "../../src/models/Invoice.js";
import { calculateCreditNoteTotals } from "../../src/resolvers/creditNote.js";
import { recomputeCreditNoteTotals } from "../../scripts/recompute-credit-note-totals.js";
import { readBackup, restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const silent = () => {};
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "avoirs-totaux-"));
const UPDATED_AT = new Date("2026-09-20T10:00:00.000Z");

// Facture : 100 € HT à 20 % + 10 € de port HT à 20 % = 132 € TTC
const insertInvoice = async (overrides = {}) => {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-202609-",
    number: "0001",
    status: "COMPLETED",
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
    isReverseCharge: false,
    finalTotalHT: 110,
    finalTotalVAT: 22,
    finalTotalTTC: 132,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  });
  return insertedId;
};

// Avoir total enregistré SANS le port (ancien calcul) : -120 € au lieu de -132 €
const insertCreditNote = async (invoiceId, overrides = {}) => {
  const { insertedId } = await CreditNote.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    originalInvoice: invoiceId,
    originalInvoiceNumber: "0001",
    prefix: "AV-202609-",
    number: "0001",
    creditType: "REFUND",
    status: "CREATED",
    items: [
      {
        description: "Prestation",
        quantity: 1,
        unitPrice: -100,
        vatRate: 20,
        discount: 0,
        discountType: "PERCENTAGE",
      },
    ],
    discount: 0,
    discountType: "FIXED",
    totalHT: -100,
    totalVAT: -20,
    totalTTC: -120,
    finalTotalHT: -100,
    finalTotalVAT: -20,
    finalTotalTTC: -120,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  });
  return insertedId;
};

const stored = (id) => CreditNote.collection.findOne({ _id: id });
const run = (options = {}) =>
  recomputeCreditNoteTotals({ log: silent, backupDir, ...options });

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

describe("recomputeCreditNoteTotals", () => {
  it("n'écrit rien sans --apply et liste l'avoir avec avant / après", async () => {
    const invoiceId = await insertInvoice();
    const id = await insertCreditNote(invoiceId);
    const lines = [];

    const stats = await run({ log: (line) => lines.push(line) });

    expect(stats).toMatchObject({
      scanned: 1,
      toFix: 1,
      updated: 0,
      backupFile: null,
    });
    expect((await stored(id)).finalTotalTTC).toBe(-120);
    const line = lines.find((l) => l.includes("AV-202609-0001"));
    expect(line).toContain("TTC -120.00 → -132.00");
    expect(line).toContain("port facturé");
  });

  it("recalcule les totaux comme l'API, sans toucher updatedAt", async () => {
    const invoiceId = await insertInvoice();
    const id = await insertCreditNote(invoiceId);

    const stats = await run({ apply: true });

    expect(stats.updated).toBe(1);
    const creditNote = await stored(id);
    const invoice = await Invoice.findById(invoiceId);
    const expected = calculateCreditNoteTotals(
      (await CreditNote.findById(id)).items,
      0,
      "FIXED",
      false,
      invoice.shipping,
    );
    expect(creditNote).toMatchObject(expected);
    expect(creditNote.finalTotalTTC).toBeCloseTo(-132, 2);
    expect(creditNote.finalTotalHT).toBeCloseTo(-110, 2);
    expect(creditNote.updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());

    // Sauvegarde : valeurs d'avant et d'après
    const backup = readBackup(stats.backupFile);
    expect(backup.entries).toHaveLength(1);
    expect(backup.entries[0].before.finalTotalTTC).toBe(-120);
    expect(backup.entries[0].after.finalTotalTTC).toBeCloseTo(-132, 2);
  });

  it("ne liste pas un avoir déjà juste (écart d'arrondi flottant compris)", async () => {
    const invoiceId = await insertInvoice();
    await insertCreditNote(invoiceId, {
      totalHT: -110,
      totalVAT: -22.000000000000004,
      totalTTC: -132,
      finalTotalHT: -110,
      finalTotalVAT: -22,
      finalTotalTTC: -132.00000000000003,
    });

    const stats = await run({ apply: true });

    expect(stats).toMatchObject({ scanned: 1, unchanged: 1, toFix: 0 });
    expect(stats.backupFile).toBeNull();
  });

  it("ne modifie jamais un avoir transmis en e-facturation, le liste à part", async () => {
    const invoiceId = await insertInvoice();
    const deposited = await insertCreditNote(invoiceId, {
      superPdpInvoiceId: "spdp-123",
    });
    const sent = await insertCreditNote(invoiceId, {
      number: "0002",
      eInvoiceStatus: "SENT_TO_RECIPIENT",
    });
    // Envoi refusé avant dépôt : pas transmis, corrigé
    const notSent = await insertCreditNote(invoiceId, {
      number: "0003",
      eInvoiceStatus: "ERROR",
    });
    const lines = [];

    const stats = await run({ apply: true, log: (line) => lines.push(line) });

    expect(stats).toMatchObject({ locked: 2, toFix: 1, updated: 1 });
    expect((await stored(deposited)).finalTotalTTC).toBe(-120);
    expect((await stored(sent)).finalTotalTTC).toBe(-120);
    expect((await stored(notSent)).finalTotalTTC).toBeCloseTo(-132, 2);
    expect(lines.filter((l) => l.includes("🔒"))).toHaveLength(2);
  });

  it("prend la remise globale sur les articles seulement, port non remisé", async () => {
    const invoiceId = await insertInvoice();
    const id = await insertCreditNote(invoiceId, {
      discount: 10,
      discountType: "PERCENTAGE",
    });

    await run({ apply: true });

    // 100 - 10 % = 90 HT + 10 de port = 100 HT ; TVA 18 + 2 = 20
    const creditNote = await stored(id);
    expect(creditNote.finalTotalHT).toBeCloseTo(-100, 2);
    expect(creditNote.finalTotalVAT).toBeCloseTo(-20, 2);
    expect(creditNote.finalTotalTTC).toBeCloseTo(-120, 2);
  });

  it("ignore un avoir sans facture d'origine", async () => {
    const id = await insertCreditNote(new mongoose.Types.ObjectId());

    const stats = await run({ apply: true });

    expect(stats).toMatchObject({ missingInvoice: 1, toFix: 0 });
    expect((await stored(id)).finalTotalTTC).toBe(-120);
  });

  it("signale une somme d'avoirs corrigée qui dépasse la facture", async () => {
    // TTC de la facture enregistré sans le port (ancien calcul)
    const invoiceId = await insertInvoice({ finalTotalTTC: 120 });
    await insertCreditNote(invoiceId);

    const stats = await run();

    expect(stats.overCredited).toBe(1);
  });

  it("est idempotent : une seconde exécution ne trouve plus rien", async () => {
    const invoiceId = await insertInvoice();
    await insertCreditNote(invoiceId);
    await insertCreditNote(invoiceId, { number: "0002" });

    const first = await run({ apply: true });
    const second = await run({ apply: true });

    expect(first.updated).toBe(2);
    expect(second).toMatchObject({ scanned: 2, unchanged: 2, toFix: 0 });
    expect(second.backupFile).toBeNull();
  });

  it("se limite à une organisation avec workspaceId", async () => {
    const otherOrg = buildOrganizationId();
    const invoiceId = await insertInvoice();
    const otherInvoice = await insertInvoice({ workspaceId: otherOrg });
    const mine = await insertCreditNote(invoiceId);
    const other = await insertCreditNote(otherInvoice, {
      workspaceId: otherOrg,
    });

    await run({ apply: true, workspaceId: organizationId.toString() });

    expect((await stored(mine)).finalTotalTTC).toBeCloseTo(-132, 2);
    expect((await stored(other)).finalTotalTTC).toBe(-120);
  });

  it("le retour arrière remet les totaux d'avant, sauf avoir modifié depuis", async () => {
    const invoiceId = await insertInvoice();
    const kept = await insertCreditNote(invoiceId);
    const editedSince = await insertCreditNote(invoiceId, { number: "0002" });
    const { backupFile } = await run({ apply: true });
    // Avoir modifié dans l'appli après le script
    await CreditNote.collection.updateOne(
      { _id: editedSince },
      { $set: { finalTotalTTC: -60 } },
    );

    const preview = await restoreBackup(backupFile, { log: silent });
    expect(preview).toMatchObject({ restorable: 1, skipped: 1 });
    expect((await stored(kept)).finalTotalTTC).toBeCloseTo(-132, 2);

    const restored = await restoreBackup(backupFile, {
      apply: true,
      log: silent,
    });

    expect(restored).toMatchObject({ restored: 1, skipped: 1 });
    const creditNote = await stored(kept);
    expect(creditNote).toMatchObject({
      totalHT: -100,
      totalVAT: -20,
      totalTTC: -120,
      finalTotalHT: -100,
      finalTotalVAT: -20,
      finalTotalTTC: -120,
    });
    expect(creditNote.updatedAt.toISOString()).toBe(UPDATED_AT.toISOString());
    expect((await stored(editedSince)).finalTotalTTC).toBe(-60);
  });
});
