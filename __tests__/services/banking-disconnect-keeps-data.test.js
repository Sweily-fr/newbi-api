/**
 * Déconnecter une banque conserve les transactions et tout ce qui s'y
 * rattache (justificatifs, catégories, notes, statut ignoré, rapprochements).
 * Les comptes passent en « déconnecté » : ils sortent des soldes et de la
 * courbe de trésorerie. À la reconnexion, une transaction importée reprend
 * la transaction conservée équivalente au lieu de créer un doublon.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

const auth = vi.hoisted(() => ({ user: null }));
const bridge = vi.hoisted(() => ({ deletedItems: [] }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, betterAuthJWTMiddleware: async () => auth.user };
});
vi.mock("../../src/services/banking/index.js", () => ({
  bankingService: {
    initialize: async () => {},
    currentProvider: {
      deleteBridgeItem: async (itemId) => {
        bridge.deletedItems.push(String(itemId));
      },
    },
  },
}));
vi.mock("../../src/services/banking/BankingCacheService.js", () => ({
  bankingCacheService: { invalidateAll: async () => {} },
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import Transaction from "../../src/models/Transaction.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import bankingConnectRoutes from "../../src/routes/banking-connect.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";
import { createKeptTransactionAdopter } from "../../src/services/banking/keptTransactions.js";

const { ObjectId } = mongoose.Types;
const workspaceId = buildOrganizationId();
const ws = String(workspaceId);
const owner = buildUserId();
const IBAN = "FR7630006000011234567890189";

let server;
let baseUrl;

const disconnect = (body) =>
  fetch(`${baseUrl}/banking-connect/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-id": ws },
    body: JSON.stringify(body),
  });

const account = (_id, externalId, extra = {}) => ({
  _id,
  externalId,
  provider: "bridge",
  name: "Compte courant",
  type: "checking",
  status: "active",
  balance: 1000,
  currency: "EUR",
  iban: IBAN,
  workspaceId: ws,
  raw: { item_id: 42, id: Number(externalId) },
  ...extra,
});

const accountA = new ObjectId();
const invoiceId = new ObjectId();
const purchaseInvoiceId = new ObjectId();
let receiptTx;
let ignoredTx;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/banking-connect", bankingConnectRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  bridge.deletedItems.length = 0;
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  auth.user = { _id: owner, id: String(owner), email: "owner@test.fr" };

  await AccountBanking.collection.insertMany([
    account(accountA, "1001"),
    account(new ObjectId(), "1002", { iban: "FR7600000000000000000000002" }),
  ]);
  receiptTx = new ObjectId();
  ignoredTx = new ObjectId();
  await Transaction.collection.insertMany([
    {
      _id: receiptTx,
      externalId: "tx-1",
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -120,
      currency: "EUR",
      description: "FOURNISSEUR",
      reference: "PRLV FOURNISSEUR 123",
      date: new Date("2026-10-10T00:00:00.000Z"),
      fromAccount: "1001",
      workspaceId: ws,
      category: "SOFTWARE",
      categoryIsManual: true,
      metadata: { notes: "Abonnement annuel" },
      receiptFiles: [{ url: "https://r2.test/recu.pdf", key: "recu.pdf" }],
      linkedPurchaseInvoiceIds: [purchaseInvoiceId],
      reconciliationStatus: "matched",
      deletedAt: null,
    },
    {
      _id: ignoredTx,
      externalId: "tx-2",
      provider: "bridge",
      type: "credit",
      status: "completed",
      amount: 500,
      currency: "EUR",
      description: "VIR CLIENT",
      date: new Date("2026-10-12T00:00:00.000Z"),
      fromAccount: "1001",
      workspaceId: ws,
      linkedInvoiceIds: [invoiceId],
      reconciliationStatus: "matched",
      deletedAt: null,
    },
  ]);
  await Invoice.collection.insertOne({
    _id: invoiceId,
    workspaceId,
    status: "COMPLETED",
    linkedTransactionIds: [ignoredTx],
  });
  await PurchaseInvoice.collection.insertOne({
    _id: purchaseInvoiceId,
    workspaceId,
    isReconciled: true,
    linkedTransactionIds: [receiptTx],
  });
});

describe("POST /banking-connect/disconnect", () => {
  it("un compte (et sa connexion) : comptes déconnectés, transactions et liens conservés", async () => {
    const response = await disconnect({ accountId: String(accountA) });
    expect(response.status).toBe(200);
    expect(bridge.deletedItems).toEqual(["42"]);

    const accounts = await AccountBanking.collection
      .find({ workspaceId: ws })
      .toArray();
    expect(accounts).toHaveLength(2);
    for (const a of accounts) {
      expect(a.status).toBe("disconnected");
      expect(a.disconnectedAt).toBeInstanceOf(Date);
    }

    const kept = await Transaction.collection.findOne({ _id: receiptTx });
    expect(kept.receiptFiles).toHaveLength(1);
    expect(kept.category).toBe("SOFTWARE");
    expect(kept.metadata.notes).toBe("Abonnement annuel");
    expect(kept.linkedPurchaseInvoiceIds.map(String)).toEqual([
      String(purchaseInvoiceId),
    ]);
    expect(await Transaction.countDocuments({ workspaceId: ws })).toBe(2);
    expect(
      (await Invoice.collection.findOne({ _id: invoiceId }))
        .linkedTransactionIds,
    ).toHaveLength(1);
    expect(
      (await PurchaseInvoice.collection.findOne({ _id: purchaseInvoiceId }))
        .isReconciled,
    ).toBe(true);
  });

  it("tout déconnecter : aucune transaction supprimée", async () => {
    const response = await disconnect({ provider: "bridge" });
    expect(response.status).toBe(200);
    expect(await Transaction.countDocuments({ workspaceId: ws })).toBe(2);
    expect(
      await AccountBanking.countDocuments({
        workspaceId: ws,
        status: "disconnected",
      }),
    ).toBe(2);
  });
});

describe("trésorerie après déconnexion", () => {
  it("le solde d'un compte déconnecté n'est plus compté", async () => {
    await disconnect({ accountId: String(accountA) });
    const summary = await dashboardAggregationResolvers.Query.dashboardSummary(
      null,
      { workspaceId: ws },
      buildContext({ userId: owner, organizationId: workspaceId }),
    );
    expect(summary.bankBalance).toBe(0);
  });

  it("la courbe de trésorerie écarte les transactions d'un compte déconnecté", async () => {
    const chart = () =>
      dashboardAggregationResolvers.Query.dashboardTreasuryChart(
        null,
        {
          workspaceId: ws,
          period: { startDate: "2026-10-01", endDate: "2026-10-31" },
        },
        buildContext({ userId: owner, organizationId: workspaceId }),
      );
    expect((await chart()).totalIncome).toBe(500);

    await disconnect({ accountId: String(accountA) });

    const after = await chart();
    expect(after.totalIncome).toBe(0);
    expect(after.totalExpenses).toBe(0);
  });
});

describe("reconnexion : reprise des transactions conservées", () => {
  it("une transaction importée reprend la transaction conservée équivalente", async () => {
    await disconnect({ accountId: String(accountA) });
    // Nouvelle connexion : nouveau compte (même IBAN), nouveaux identifiants
    await AccountBanking.collection.insertOne(
      account(new ObjectId(), "2001", { raw: { item_id: 77 } }),
    );
    const adopt = createKeptTransactionAdopter({
      workspaceId: ws,
      provider: "bridge",
    });

    const adopted = await adopt({
      externalId: "tx-new-1",
      fromAccount: "2001",
      amount: -120,
      currency: "EUR",
      reference: "PRLV FOURNISSEUR 123",
      date: new Date("2026-10-10T00:00:00.000Z"),
    });

    expect(String(adopted._id)).toBe(String(receiptTx));
    const stored = await Transaction.collection.findOne({ _id: receiptTx });
    expect(stored.externalId).toBe("tx-new-1");
    expect(stored.fromAccount).toBe("2001");
    expect(stored.receiptFiles).toHaveLength(1);

    // Une transaction déjà reprise ne l'est pas deux fois ; un autre jour
    // ou un autre montant ne reprend rien
    expect(
      await adopt({
        externalId: "tx-new-2",
        fromAccount: "2001",
        amount: -120,
        currency: "EUR",
        date: new Date("2026-10-10T00:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      await adopt({
        externalId: "tx-new-3",
        fromAccount: "2001",
        amount: 500,
        currency: "EUR",
        date: new Date("2026-10-13T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("aucune reprise depuis un compte encore connecté ou d'un autre IBAN", async () => {
    await AccountBanking.collection.insertOne(
      account(new ObjectId(), "3001", {
        iban: "FR7600000000000000000000002",
      }),
    );
    const adopt = createKeptTransactionAdopter({
      workspaceId: ws,
      provider: "bridge",
    });

    expect(
      await adopt({
        externalId: "tx-new-4",
        fromAccount: "3001",
        amount: -120,
        currency: "EUR",
        date: new Date("2026-10-10T00:00:00.000Z"),
      }),
    ).toBeNull();
    expect(
      (await Transaction.collection.findOne({ _id: receiptTx })).externalId,
    ).toBe("tx-1");
  });
});
