import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  computeAmountFixes,
  repairPurchaseInvoiceNullAmounts,
} from "../../scripts/repair-purchase-invoice-null-amounts.js";
import { readBackup, restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const silent = () => {};
// Sauvegardes écrites hors du dépôt
const backupDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "repair-null-amounts-"),
);
const updatedAt = new Date("2026-10-15T14:38:18Z");

// Écrit en brut : le setter du modèle remplacerait les null
const insert = async (overrides = {}) => {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    supplierName: "Meta Platforms Ireland",
    issueDate: new Date("2024-07-17"),
    amountHT: 70,
    amountTVA: 15.7,
    vatRate: 22.43,
    amountTTC: 85.7,
    currency: "EUR",
    status: "PAID",
    files: [],
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  });
  return insertedId;
};

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

describe("computeAmountFixes", () => {
  it("TVA null : TTC - HT quand le HT est connu", () => {
    expect(
      computeAmountFixes({
        amountHT: 70,
        amountTVA: null,
        vatRate: 22.43,
        amountTTC: 85.7,
      }).fixes,
    ).toEqual({ amountTVA: 15.7 });
  });

  it("TVA null avec un HT à 0 : TVA à 0, rien d'inventé", () => {
    expect(
      computeAmountFixes({
        amountHT: 0,
        amountTVA: null,
        vatRate: 20,
        amountTTC: 85.7,
      }).fixes,
    ).toEqual({ amountTVA: 0 });
  });

  it("HT, TVA et taux null : facture sans TVA au montant du TTC", () => {
    expect(
      computeAmountFixes({
        amountHT: null,
        amountTVA: null,
        vatRate: null,
        amountTTC: 42.87,
      }).fixes,
    ).toEqual({ amountHT: 42.87, amountTVA: 0, vatRate: 0 });
  });

  it("taux null : déduit de la TVA et du HT, taux légal au centime", () => {
    expect(
      computeAmountFixes({
        amountHT: 100,
        amountTVA: 5.5,
        vatRate: null,
        amountTTC: 105.5,
      }).fixes,
    ).toEqual({ vatRate: 5.5 });
    // 1,67 / 8,33 = 20,05 % : le taux légal qui redonne la TVA l'emporte
    expect(
      computeAmountFixes({
        amountHT: 8.33,
        amountTVA: 1.67,
        vatRate: null,
        amountTTC: 10,
      }).fixes,
    ).toEqual({ vatRate: 20 });
  });

  it("taux null sans TVA : 0 %, plus « TVA 0 € à 20 % »", () => {
    expect(
      computeAmountFixes({ amountHT: 0, amountTVA: 0, amountTTC: 10 }).fixes,
    ).toEqual({ vatRate: 0 });
    expect(
      computeAmountFixes({
        amountHT: 0,
        amountTVA: null,
        vatRate: null,
        amountTTC: 85.7,
      }).fixes,
    ).toEqual({ amountTVA: 0, vatRate: 0 });
  });

  it("TTC null : HT + TVA s'ils sont enregistrés, sinon signalé", () => {
    expect(
      computeAmountFixes({
        amountHT: 100,
        amountTVA: 20,
        vatRate: 20,
        amountTTC: null,
      }),
    ).toEqual({ fixes: { amountTTC: 120 }, unresolved: [] });
    expect(
      computeAmountFixes({
        amountHT: 100,
        amountTVA: null,
        vatRate: 20,
        amountTTC: null,
      }),
    ).toEqual({ fixes: { amountTVA: 0 }, unresolved: ["amountTTC"] });
  });
});

describe("repairPurchaseInvoiceNullAmounts", () => {
  it("aperçu : liste sans rien écrire", async () => {
    const id = await insert({ amountTVA: null });
    const lines = [];

    const stats = await repairPurchaseInvoiceNullAmounts({
      log: (line) => lines.push(line),
      backupDir,
    });

    expect(stats).toMatchObject({ scanned: 1, fixable: 1, updated: 0 });
    expect(stats.backupFile).toBeNull();
    expect(lines.join("\n")).toMatch(/TVA absent → 15\.70/);
    const stored = await PurchaseInvoice.collection.findOne({ _id: id });
    expect(stored.amountTVA).toBeNull();
  });

  it("--apply : corrige les montants null, sauvegarde, updatedAt inchangé", async () => {
    const nullTva = await insert({ amountTVA: null });
    const missingAmounts = await insert({
      amountHT: undefined,
      amountTVA: undefined,
      vatRate: undefined,
      amountTTC: 42.87,
    });
    const healthy = await insert();

    const stats = await repairPurchaseInvoiceNullAmounts({
      apply: true,
      log: silent,
      backupDir,
    });

    expect(stats).toMatchObject({ scanned: 2, fixable: 2, updated: 2 });
    const first = await PurchaseInvoice.collection.findOne({ _id: nullTva });
    expect(first.amountTVA).toBe(15.7);
    expect(first.updatedAt).toEqual(updatedAt);
    const second = await PurchaseInvoice.collection.findOne({
      _id: missingAmounts,
    });
    expect(second).toMatchObject({ amountHT: 42.87, amountTVA: 0, vatRate: 0 });
    const untouched = await PurchaseInvoice.collection.findOne({
      _id: healthy,
    });
    expect(untouched.amountTVA).toBe(15.7);

    const backup = readBackup(stats.backupFile);
    expect(backup.entries).toHaveLength(2);
    expect(backup.entries[0].before).toEqual({ amountTVA: null });

    // Relancé : plus rien à faire
    const again = await repairPurchaseInvoiceNullAmounts({
      apply: true,
      log: silent,
      backupDir,
    });
    expect(again.scanned).toBe(0);
  });

  it("--restore remet les valeurs d'avant", async () => {
    const id = await insert({ amountTVA: null });
    const { backupFile } = await repairPurchaseInvoiceNullAmounts({
      apply: true,
      log: silent,
      backupDir,
    });

    const restored = await restoreBackup(backupFile, {
      apply: true,
      log: silent,
    });

    expect(restored.restored).toBe(1);
    const stored = await PurchaseInvoice.collection.findOne({ _id: id });
    expect(stored.amountTVA ?? null).toBeNull();
  });
});
