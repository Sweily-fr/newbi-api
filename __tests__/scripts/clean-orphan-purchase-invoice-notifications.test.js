import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  cleanOrphanNotifications,
  organizationSiren,
  restoreNotifications,
} from "../../scripts/clean-orphan-purchase-invoice-notifications.js";

const userId = buildUserId();
const sweily = buildOrganizationId();
const indivision = buildOrganizationId();
const silent = () => {};
// Sauvegardes écrites hors du dépôt
const backupDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "orphan-invoice-notifications-"),
);

const db = () => mongoose.connection.db;

const insertInvoice = async (workspaceId) => {
  const { insertedId } = await db()
    .collection("purchaseinvoices")
    .insertOne({
      workspaceId,
      superPdpInvoiceId: "sp-1",
      supplierName: "Qonto SA",
    });
  return insertedId;
};

const insertNotification = async (
  workspaceId,
  purchaseInvoiceId,
  extra = {},
) => {
  const { insertedId } = await db()
    .collection("notifications")
    .insertOne({
      userId,
      workspaceId,
      type: "PURCHASE_INVOICE_RECEIVED",
      title: "Nouvelle facture reçue",
      message: "Qonto SA vous a transmis la facture FAC-202609188545",
      data: purchaseInvoiceId
        ? { purchaseInvoiceId: String(purchaseInvoiceId) }
        : {},
      createdAt: new Date("2026-09-01T15:00:00Z"),
      ...extra,
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

describe("organizationSiren", () => {
  it("lit le SIREN depuis le SIRET de l'organisation", () => {
    expect(organizationSiren({ siret: "123 456 789 00019" })).toBe("123456789");
  });
  it("renvoie null sans SIREN exploitable", () => {
    expect(organizationSiren({ companyInfo: {} })).toBeNull();
    expect(organizationSiren(null)).toBeNull();
  });
});

describe("cleanOrphanNotifications", () => {
  it("supprime les notifications dont la facture a disparu ou est d'un autre espace", async () => {
    const ownInvoice = await insertInvoice(indivision);
    const sweilyInvoice = await insertInvoice(sweily);
    const kept = await insertNotification(indivision, ownInvoice);
    const otherWorkspace = await insertNotification(indivision, sweilyInvoice);
    const deletedInvoice = await insertNotification(
      indivision,
      new mongoose.Types.ObjectId(),
    );
    const withoutInvoice = await insertNotification(indivision, null);

    const preview = await cleanOrphanNotifications({ log: silent, backupDir });
    expect(preview).toMatchObject({
      scanned: 4,
      orphans: 2,
      noInvoiceId: 1,
      deleted: 0,
    });
    expect(await db().collection("notifications").countDocuments()).toBe(4);

    const stats = await cleanOrphanNotifications({
      apply: true,
      log: silent,
      backupDir,
    });
    expect(stats.deleted).toBe(2);
    const remaining = await db()
      .collection("notifications")
      .find({}, { projection: { _id: 1 } })
      .toArray();
    expect(remaining.map((n) => String(n._id)).sort()).toEqual(
      [kept, withoutInvoice].map(String).sort(),
    );

    // Sauvegarde écrite, puis retour arrière
    expect(fs.existsSync(stats.backupFile)).toBe(true);
    const restored = await restoreNotifications(stats.backupFile, {
      apply: true,
      log: silent,
    });
    expect(restored).toMatchObject({ entries: 2, restored: 2, present: 0 });
    const back = await db()
      .collection("notifications")
      .find({ _id: { $in: [otherWorkspace, deletedInvoice] } })
      .toArray();
    expect(back).toHaveLength(2);
    expect(back[0].createdAt).toBeInstanceOf(Date);
  });

  it("ne touche à rien sans orphelin et signale les espaces sans SIREN", async () => {
    await db()
      .collection("organization")
      .insertMany([
        { _id: sweily, name: "Sweily", siret: "98157654900011" },
        { _id: indivision, name: "Indivision", companyInfo: {} },
      ]);
    await insertNotification(sweily, await insertInvoice(sweily));
    await insertInvoice(indivision);

    const stats = await cleanOrphanNotifications({
      apply: true,
      log: silent,
      backupDir,
    });
    expect(stats).toMatchObject({
      orphans: 0,
      deleted: 0,
      suspectWorkspaces: 1,
      backupFile: null,
    });
    expect(await db().collection("notifications").countDocuments()).toBe(1);
  });

  it("limite l'examen à un espace avec --workspace", async () => {
    await insertNotification(sweily, new mongoose.Types.ObjectId());
    await insertNotification(indivision, new mongoose.Types.ObjectId());

    const stats = await cleanOrphanNotifications({
      apply: true,
      workspaceId: String(indivision),
      log: silent,
      backupDir,
    });
    expect(stats.deleted).toBe(1);
    expect(
      await db()
        .collection("notifications")
        .countDocuments({ workspaceId: sweily }),
    ).toBe(1);
  });
});
