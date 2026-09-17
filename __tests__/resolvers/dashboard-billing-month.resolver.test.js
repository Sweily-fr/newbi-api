import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

const ctx = () => buildContext({ userId, organizationId });

const query = () =>
  dashboardAggregationResolvers.Query.dashboardBillingMonth(
    null,
    { workspaceId: organizationId.toString() },
    ctx(),
  );

// Jour au milieu du mois courant (aucune ambiguïté de fuseau)
const now = new Date();
const thisMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15),
);
const lastMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15),
);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);

const insertInvoice = (overrides = {}) =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    status: "PENDING",
    issueDate: thisMonth,
    finalTotalHT: 100,
    finalTotalTTC: 120,
    ...overrides,
  });

const insertImported = (overrides = {}) =>
  ImportedInvoice.collection.insertOne({
    workspaceId: organizationId,
    importedBy: userId,
    status: "VALIDATED",
    invoiceDate: thisMonth,
    totalTTC: 500,
    ...overrides,
  });

const insertPurchase = (overrides = {}) =>
  PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    status: "TO_PAY",
    issueDate: thisMonth,
    amountTTC: 60,
    ...overrides,
  });

describe("dashboardBillingMonth", () => {
  it("renvoie des zéros et le mois courant sans aucune facture", async () => {
    const r = await query();
    expect(r.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.sales).toEqual({
      total: 0,
      count: 0,
      pending: 0,
      pendingCount: 0,
      overdue: 0,
      overdueCount: 0,
    });
    expect(r.purchases.total).toBe(0);
  });

  it("ventes : TTC du mois, en cours retards inclus, en retard = échéance dépassée", async () => {
    await insertInvoice({ status: "COMPLETED", dueDate: daysAgo(10) }); // payée
    await insertInvoice({ dueDate: daysAhead(10) }); // en cours
    await insertInvoice({ dueDate: daysAgo(3) }); // en retard
    await insertInvoice({ status: "OVERDUE" }); // en retard (statut)
    await insertInvoice({ status: "DRAFT" }); // ignorée
    await insertInvoice({ issueDate: lastMonth, dueDate: daysAgo(3) }); // mois précédent
    await insertInvoice({ dueDate: null }); // en cours, sans échéance : pas en retard

    const { sales } = await query();
    expect(sales.total).toBe(600);
    expect(sales.count).toBe(5);
    expect(sales.pending).toBe(480);
    expect(sales.pendingCount).toBe(4);
    expect(sales.overdue).toBe(240);
    expect(sales.overdueCount).toBe(2);
  });

  it("ventes : les importées validées comptent dans le total mais ni en cours ni en retard", async () => {
    await insertImported();
    await insertImported({ status: "COMPLETED", totalTTC: 300 });
    await insertImported({ status: "REJECTED", totalTTC: 999 });
    await insertImported({ invoiceDate: lastMonth, totalTTC: 999 });

    const { sales } = await query();
    expect(sales.total).toBe(800);
    expect(sales.count).toBe(2);
    expect(sales.pending).toBe(0);
    expect(sales.overdue).toBe(0);
  });

  it("achats : total du mois, à payer = TO_PAY + OVERDUE, sans échéance ≠ en retard", async () => {
    await insertPurchase({ status: "PAID" });
    await insertPurchase({ status: "TO_PROCESS" });
    await insertPurchase(); // TO_PAY sans échéance : à payer, pas en retard
    await insertPurchase({ dueDate: daysAgo(2) }); // TO_PAY échue
    await insertPurchase({ status: "OVERDUE", amountTTC: 40 });
    await insertPurchase({ issueDate: lastMonth, status: "OVERDUE" });

    const { purchases } = await query();
    expect(purchases.total).toBe(280);
    expect(purchases.count).toBe(5);
    expect(purchases.pending).toBe(160);
    expect(purchases.pendingCount).toBe(3);
    expect(purchases.overdue).toBe(100);
    expect(purchases.overdueCount).toBe(2);
  });
});
