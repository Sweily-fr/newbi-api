import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import Transaction from "../../src/models/Transaction.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";

// Filtre de compte de l'accueil : le sélecteur envoie l'identifiant Newbi du
// compte, les transactions portent celui de la banque (fromAccount =
// externalId). Les encaissements du compte choisi restaient à 0.

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = () => organizationId.toString();
const accountId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await AccountBanking.collection.insertOne({
    _id: accountId,
    externalId: "banque-compte-1",
    provider: "bridge",
    name: "Compte courant",
    status: "active",
    balance: 12500,
    workspaceId: ws(),
  });
  const now = new Date();
  const tx = (n, amount, extra = {}) => ({
    externalId: `tx-${n}`,
    provider: "bridge",
    type: amount > 0 ? "credit" : "debit",
    status: "completed",
    amount,
    description: `Transaction ${n}`,
    fromAccount: "banque-compte-1",
    workspaceId: ws(),
    date: now,
    deletedAt: null,
    ...extra,
  });
  await Transaction.collection.insertMany([
    tx(1, 450),
    tx(2, -35.5),
    // Autre compte et espèces : hors du compte choisi
    tx(3, 999, { fromAccount: "autre-compte" }),
    tx(4, 50, { provider: "manual", fromAccount: null }),
  ]);
});

const summary = (account) =>
  dashboardAggregationResolvers.Query.dashboardSummary(
    null,
    { workspaceId: ws(), accountId: account },
    buildContext({ userId, organizationId }),
  );

describe("dashboardSummary : filtre par compte bancaire", () => {
  it("compte choisi par son identifiant Newbi : ses encaissements et décaissements", async () => {
    const result = await summary(accountId.toString());
    expect(result.totalIncome).toBe(450);
    expect(result.totalExpenses).toBe(35.5);
    expect(result.bankBalance).toBe(12500);
  });

  it("compte choisi par l'identifiant de la banque : même résultat, sans erreur", async () => {
    const result = await summary("banque-compte-1");
    expect(result.totalIncome).toBe(450);
    expect(result.totalExpenses).toBe(35.5);
    expect(result.bankBalance).toBe(12500);
  });

  it("tous les comptes : espèces comprises", async () => {
    const result = await summary(null);
    expect(result.totalIncome).toBe(1499);
    expect(result.bankBalance).toBe(12550);
  });
});
