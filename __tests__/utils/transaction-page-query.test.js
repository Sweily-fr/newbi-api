import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import Transaction from "../../src/models/Transaction.js";
import {
  buildBaseQuery,
  buildTabPredicate,
  buildPageQuery,
} from "../../src/utils/transaction-page-query.js";

const workspaceId = buildOrganizationId().toString();
const NOW = new Date("2026-07-27T12:00:00.000Z");

let counter = 0;

async function createTx(overrides = {}) {
  counter += 1;
  return Transaction.create({
    externalId: `tx-page-${counter}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -50,
    currency: "EUR",
    description: "Dépense test",
    workspaceId,
    date: new Date("2026-07-20T00:00:00.000Z"),
    ...overrides,
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
});

describe("buildTabPredicate", () => {
  it("TO_RECONCILE : entrées d'argent non rapprochées sans justificatif", async () => {
    const match = await createTx({ amount: 100, type: "credit" });
    // Exclues : rapprochée, avec justificatif, avec facture liée, dépense
    await createTx({
      amount: 100,
      type: "credit",
      reconciliationStatus: "matched",
    });
    await createTx({
      amount: 100,
      type: "credit",
      receiptFiles: [
        {
          url: "https://r/r.pdf",
          key: "r.pdf",
          filename: "r.pdf",
          mimetype: "application/pdf",
          size: 1,
        },
      ],
    });
    await createTx({
      amount: 100,
      type: "credit",
      linkedInvoiceIds: [buildOrganizationId()],
    });
    await createTx({ amount: -100 });

    const query = buildPageQuery(workspaceId, {}, "TO_RECONCILE", NOW);
    const found = await Transaction.find(query);
    expect(found.map((t) => t.externalId)).toEqual([match.externalId]);
  });

  it("MISSING_RECEIPT : dépenses bancaires sans justificatif ni facture", async () => {
    const match = await createTx({ amount: -80 });
    await createTx({ amount: -80, provider: "manual" });
    await createTx({ amount: 80, type: "credit" });
    await createTx({
      amount: -80,
      linkedPurchaseInvoiceIds: [buildOrganizationId()],
    });

    const query = buildPageQuery(workspaceId, {}, "MISSING_RECEIPT", NOW);
    const found = await Transaction.find(query);
    expect(found.map((t) => t.externalId)).toEqual([match.externalId]);
  });

  it("LAST_MONTH : borne au mois glissant", () => {
    const predicate = buildTabPredicate("LAST_MONTH", NOW);
    expect(predicate.date.$gte.getTime()).toBe(new Date(2026, 5, 27).getTime());
  });
});

describe("buildBaseQuery", () => {
  it("recherche texte + montant signé", async () => {
    const byDesc = await createTx({
      description: "CB CARREFOUR PARIS",
      amount: -12.34,
    });
    const byAmount = await createTx({ amount: -49.99, description: "Autre" });
    await createTx({ description: "SNCF", amount: -120 });

    const q1 = buildBaseQuery(workspaceId, { search: "carrefour" });
    expect((await Transaction.find(q1)).map((t) => t.externalId)).toEqual([
      byDesc.externalId,
    ]);

    // "49,99" (format FR) doit trouver la dépense -49.99
    const q2 = buildBaseQuery(workspaceId, { search: "49,99" });
    expect((await Transaction.find(q2)).map((t) => t.externalId)).toEqual([
      byAmount.externalId,
    ]);
  });

  it("filtre source MANUAL/BANK et catégorie", async () => {
    const manual = await createTx({ provider: "manual" });
    const bank = await createTx({ expenseCategory: "MEALS" });

    const qManual = buildBaseQuery(workspaceId, { source: "MANUAL" });
    expect((await Transaction.find(qManual)).map((t) => t.externalId)).toEqual([
      manual.externalId,
    ]);

    const qCat = buildBaseQuery(workspaceId, { category: "MEALS" });
    expect((await Transaction.find(qCat)).map((t) => t.externalId)).toEqual([
      bank.externalId,
    ]);
  });

  it("combine recherche et catégorie sans écraser le $or de catégorie", async () => {
    const match = await createTx({
      expenseCategory: "MEALS",
      description: "RESTAURANT LYON",
    });
    await createTx({ expenseCategory: "MEALS", description: "AUTRE REPAS" });
    await createTx({ description: "RESTAURANT LYON" });

    const query = buildBaseQuery(workspaceId, {
      search: "restaurant",
      category: "MEALS",
    });
    const found = await Transaction.find(query);
    expect(found.map((t) => t.externalId)).toEqual([match.externalId]);
  });
});

describe("buildPageQuery — conflits base/onglet", () => {
  it("combine un filtre de montant avec l'onglet TO_RECONCILE via $and", async () => {
    await createTx({ amount: 100, type: "credit" });
    const big = await createTx({ amount: 500, type: "credit" });

    const query = buildPageQuery(
      workspaceId,
      { minAmount: 200 },
      "TO_RECONCILE",
      NOW,
    );
    const found = await Transaction.find(query);
    expect(found.map((t) => t.externalId)).toEqual([big.externalId]);
  });
});
