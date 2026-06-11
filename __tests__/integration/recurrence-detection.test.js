import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import DetectedRecurrence from "../../src/models/DetectedRecurrence.js";
// Real implementation — must import, not re-implement.
import {
  detectForSource,
  normalizeBankLabel,
} from "../../src/cron/recurringInvoiceDetectionCron.js";

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

const workspaceId = new mongoose.Types.ObjectId();

// 15th of the month, n months before the current one.
const monthsAgo = (n) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - n, 15);
};

const insertTransaction = (data) =>
  Transaction.collection.insertOne({
    // Transaction stores workspaceId as a String (not ObjectId).
    workspaceId: String(workspaceId),
    status: "completed",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  });

const insertPurchaseInvoice = (data) =>
  PurchaseInvoice.collection.insertOne({
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  });

describe("normalizeBankLabel", () => {
  it("produces a stable key despite changing references and month names", () => {
    expect(normalizeBankLabel("PRLV SEPA NETFLIX.COM 123456789")).toBe(
      normalizeBankLabel("PRLV SEPA NETFLIX.COM 987654321"),
    );
    expect(normalizeBankLabel("VIR SEPA LOYER BUREAU JUIN 2026")).toBe(
      normalizeBankLabel("VIR SEPA LOYER BUREAU JUILLET 2026"),
    );
  });
});

describe("detectForSource TRANSACTION (real Mongo)", () => {
  it("detects an expense recurrence from 3 consecutive months of bank debits", async () => {
    for (let i = 2; i >= 0; i--) {
      await insertTransaction({
        description: `PRLV SEPA NETFLIX.COM 10000${i}`,
        amount: -15.99,
        date: monthsAgo(i),
        expenseCategory: "SUBSCRIPTIONS",
      });
    }

    await detectForSource(workspaceId, "TRANSACTION");

    const recs = await DetectedRecurrence.find({ workspaceId }).lean();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      source: "TRANSACTION",
      type: "EXPENSE",
      category: "SUBSCRIPTIONS",
      partyKey: "netflix-com",
      isActive: true,
      isMuted: false,
      consecutiveMonths: 3,
    });
    expect(recs[0].averageAmount).toBe(16); // arrondi de la médiane 15.99
  });

  it("detects an income recurrence from recurring credits", async () => {
    for (let i = 2; i >= 0; i--) {
      await insertTransaction({
        description: "VIR SEPA CLIENT RETAINER ACME",
        amount: 1200,
        date: monthsAgo(i),
      });
    }

    await detectForSource(workspaceId, "TRANSACTION");

    const recs = await DetectedRecurrence.find({ workspaceId }).lean();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      source: "TRANSACTION",
      type: "INCOME",
      category: "OTHER_INCOME",
      isActive: true,
    });
    expect(recs[0].averageAmount).toBe(1200);
  });

  it("ignores streaks whose amounts vary beyond ±20% of the median", async () => {
    const amounts = [-100, -300, -50];
    for (let i = 2; i >= 0; i--) {
      await insertTransaction({
        description: "CB FOURNISSEUR IRREGULIER",
        amount: amounts[i],
        date: monthsAgo(i),
        expenseCategory: "SERVICES",
      });
    }

    await detectForSource(workspaceId, "TRANSACTION");

    expect(await DetectedRecurrence.countDocuments({ workspaceId })).toBe(0);
  });

  it("ignores non-consecutive months", async () => {
    for (const i of [0, 2, 4]) {
      await insertTransaction({
        description: "CB ABONNEMENT BIMESTRIEL",
        amount: -30,
        date: monthsAgo(i),
        expenseCategory: "SUBSCRIPTIONS",
      });
    }

    await detectForSource(workspaceId, "TRANSACTION");

    expect(await DetectedRecurrence.countDocuments({ workspaceId })).toBe(0);
  });

  it("skips transactions already covered by an active invoice-based recurrence", async () => {
    // Récurrence facture d'achat active pour le même tiers.
    await DetectedRecurrence.create({
      workspaceId,
      source: "PURCHASE_INVOICE",
      type: "EXPENSE",
      partyKey: normalizeBankLabel("PRLV OVH SAS 555"),
      partyName: "OVH SAS",
      category: "SOFTWARE",
      averageAmount: 50,
      lastSeenMonth: "2026-05",
      consecutiveMonths: 3,
      isActive: true,
    });
    for (let i = 2; i >= 0; i--) {
      await insertTransaction({
        description: `PRLV OVH SAS 55${i}`,
        amount: -49.9,
        date: monthsAgo(i),
        expenseCategory: "SOFTWARE",
      });
    }

    await detectForSource(workspaceId, "TRANSACTION");

    const recs = await DetectedRecurrence.find({
      workspaceId,
      source: "TRANSACTION",
    }).lean();
    expect(recs).toHaveLength(0);
  });

  it("does not pick up transactions from another workspace", async () => {
    for (let i = 2; i >= 0; i--) {
      await insertTransaction({
        workspaceId: String(new mongoose.Types.ObjectId()),
        description: "PRLV SEPA SPOTIFY",
        amount: -9.99,
        date: monthsAgo(i),
        expenseCategory: "SUBSCRIPTIONS",
      });
    }

    await detectForSource(workspaceId, "TRANSACTION");

    expect(await DetectedRecurrence.countDocuments({ workspaceId })).toBe(0);
  });
});

describe("detectForSource PURCHASE_INVOICE (régression)", () => {
  it("still detects a supplier recurrence from 3 consecutive monthly invoices", async () => {
    for (let i = 2; i >= 0; i--) {
      await insertPurchaseInvoice({
        supplierName: "Régie Immobilière",
        category: "RENT",
        amountTTC: 1000,
        issueDate: monthsAgo(i),
      });
    }

    await detectForSource(workspaceId, "PURCHASE_INVOICE");

    const recs = await DetectedRecurrence.find({ workspaceId }).lean();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      source: "PURCHASE_INVOICE",
      type: "EXPENSE",
      category: "RENT",
      partyKey: "regie-immobiliere",
      isActive: true,
    });
    expect(recs[0].averageAmount).toBe(1000);
  });
});
