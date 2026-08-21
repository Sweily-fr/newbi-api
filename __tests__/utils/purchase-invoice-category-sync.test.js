import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  PI_TO_EXPENSE_CATEGORY,
  syncLinkedTransactionCategories,
} from "../../src/utils/purchaseInvoiceCategorySync.js";

const workspaceId = buildOrganizationId().toString();

let counter = 0;

async function createTx(overrides = {}) {
  counter += 1;
  return Transaction.create({
    externalId: `tx-cat-sync-${counter}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -50,
    currency: "EUR",
    description: "Dépense test",
    workspaceId,
    date: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  });
}

describe("PI_TO_EXPENSE_CATEGORY", () => {
  it("couvre toute l'enum PurchaseInvoice et ne produit que des expenseCategory valides", () => {
    const piCategories = Object.values(
      PurchaseInvoice.PURCHASE_INVOICE_CATEGORY,
    );
    const expenseEnum = Transaction.schema.path("expenseCategory").enumValues;

    for (const cat of piCategories) {
      expect(
        PI_TO_EXPENSE_CATEGORY[cat],
        `mapping manquant pour ${cat}`,
      ).toBeDefined();
      expect(expenseEnum).toContain(PI_TO_EXPENSE_CATEGORY[cat]);
    }
    // Pas d'entrée orpheline (valeur retirée de l'enum facture)
    for (const key of Object.keys(PI_TO_EXPENSE_CATEGORY)) {
      expect(piCategories).toContain(key);
    }
  });
});

describe("syncLinkedTransactionCategories", () => {
  beforeAll(async () => {
    await startMongo();
  });

  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
  });

  it("aligne category/expenseCategory des transactions liées et verrouille contre les syncs Bridge", async () => {
    const tx = await createTx({
      category: "parking",
      expenseCategory: "TRAVEL",
    });

    await syncLinkedTransactionCategories({
      category: "SERVICES",
      workspaceId,
      transactionIds: [tx._id.toString()],
    });

    const updated = await Transaction.findById(tx._id);
    expect(updated.category).toBe("SERVICES");
    expect(updated.expenseCategory).toBe("SERVICES");
    expect(updated.categoryIsManual).toBe(true);
  });

  it("ne propage pas OTHER (fallback OCR) sur une catégorie existante", async () => {
    const tx = await createTx({
      category: "parking",
      expenseCategory: "TRAVEL",
    });

    await syncLinkedTransactionCategories({
      category: "OTHER",
      workspaceId,
      transactionIds: [tx._id.toString()],
    });

    const updated = await Transaction.findById(tx._id);
    expect(updated.category).toBe("parking");
    expect(updated.expenseCategory).toBe("TRAVEL");
    expect(updated.categoryIsManual).toBe(false);
  });

  it("ne touche pas aux transactions d'un autre workspace", async () => {
    const tx = await createTx({
      workspaceId: buildOrganizationId().toString(),
      category: "parking",
    });

    await syncLinkedTransactionCategories({
      category: "SERVICES",
      workspaceId,
      transactionIds: [tx._id.toString()],
    });

    const updated = await Transaction.findById(tx._id);
    expect(updated.category).toBe("parking");
  });
});
