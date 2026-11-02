/**
 * Accueil, Vue d'ensemble, Analytiques : solde, encaissements,
 * décaissements, courbe et camemberts.
 *   - une opération annulée par la banque (Bridge l'enregistre « cancelled »)
 *     ou un paiement échoué n'a pas déplacé d'argent : elle ne compte nulle
 *     part, comme dans les Analytiques et la Prévision ;
 *   - seul le solde des comptes actifs (ceux de la liste des comptes et de la
 *     Prévision) compte : un compte inactif, fermé ou déconnecté n'y est plus.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import Transaction from "../../src/models/Transaction.js";
import "../../src/models/Invoice.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = () => organizationId.toString();
const ctx = () => buildContext({ userId, organizationId });
const { Query } = dashboardAggregationResolvers;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

const today = () => {
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0);
  return d;
};

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await AccountBanking.collection.insertMany([
    {
      externalId: "compte-actif",
      provider: "bridge",
      name: "Compte courant",
      status: "active",
      balance: 12500,
      workspaceId: ws(),
    },
    {
      externalId: "compte-inactif",
      provider: "bridge",
      name: "Ancien compte",
      status: "inactive",
      balance: 1000,
      workspaceId: ws(),
    },
    {
      externalId: "compte-ferme",
      provider: "bridge",
      name: "Compte fermé",
      status: "closed",
      balance: 700,
      workspaceId: ws(),
    },
  ]);
  const tx = (n, amount, extra = {}) => ({
    externalId: `tx-${n}`,
    provider: "bridge",
    type: amount > 0 ? "credit" : "debit",
    status: "completed",
    amount,
    description: `Transaction ${n}`,
    fromAccount: "compte-actif",
    workspaceId: ws(),
    date: today(),
    deletedAt: null,
    ...extra,
  });
  await Transaction.collection.insertMany([
    tx(1, 450),
    tx(2, -35.5, { expenseCategory: "SOFTWARE" }),
    // Pré-autorisation annulée par la banque, paiement échoué
    tx(3, -500, { status: "cancelled", expenseCategory: "SOFTWARE" }),
    tx(4, 800, { status: "cancelled" }),
    tx(5, -60, { status: "failed" }),
    // Espèces
    tx(6, 50, { provider: "manual", fromAccount: null }),
    tx(7, 20, { provider: "manual", fromAccount: null, status: "cancelled" }),
  ]);
});

describe("Opérations annulées ou échouées", () => {
  it("dashboardSummary : ni dans les encaissements, ni dans les décaissements, ni dans les espèces", async () => {
    const r = await Query.dashboardSummary(null, { workspaceId: ws() }, ctx());
    expect(r.totalIncome).toBe(500);
    expect(r.totalExpenses).toBe(35.5);
    expect(r.bankBalance).toBe(12550);
  });

  it("dashboardTreasuryChart : ni dans les totaux, ni dans les points du jour", async () => {
    const r = await Query.dashboardTreasuryChart(
      null,
      { workspaceId: ws(), period: { preset: "30d" } },
      ctx(),
    );
    expect(r.totalIncome).toBe(500);
    expect(r.totalExpenses).toBe(35.5);
    const point = r.dataPoints.find(
      (p) => p.date === today().toISOString().slice(0, 10),
    );
    expect(point).toMatchObject({ income: 500, expenses: 35.5 });
  });

  it("dashboardCategoryAggregation : absentes des camemberts", async () => {
    const sorties = await Query.dashboardCategoryAggregation(
      null,
      { workspaceId: ws(), type: "expense", period: { preset: "30d" } },
      ctx(),
    );
    expect(sorties.total).toBe(35.5);
    expect(sorties.transactionCount).toBe(1);
    const entrees = await Query.dashboardCategoryAggregation(
      null,
      { workspaceId: ws(), type: "income", period: { preset: "30d" } },
      ctx(),
    );
    expect(entrees.total).toBe(500);
  });
});

describe("Comptes non actifs", () => {
  it("le solde ne compte que les comptes actifs (et les espèces)", async () => {
    const r = await Query.dashboardSummary(null, { workspaceId: ws() }, ctx());
    expect(r.bankBalance).toBe(12550);
  });

  it("la courbe part du même solde", async () => {
    const r = await Query.dashboardTreasuryChart(
      null,
      { workspaceId: ws(), period: { preset: "cumul-month" } },
      ctx(),
    );
    expect(r.endBalance).toBe(12550);
  });

  it("les mouvements d'un compte inactif ne décalent pas la courbe", async () => {
    await Transaction.collection.insertOne({
      externalId: "tx-inactif",
      provider: "bridge",
      type: "credit",
      status: "completed",
      amount: 300,
      description: "Virement sur l'ancien compte",
      fromAccount: "compte-inactif",
      workspaceId: ws(),
      date: today(),
      deletedAt: null,
    });
    const r = await Query.dashboardTreasuryChart(
      null,
      { workspaceId: ws(), period: { preset: "30d" } },
      ctx(),
    );
    expect(r.totalIncome).toBe(500);
  });
});
