/**
 * Analytiques et Vue d'ensemble : un rôle qui ne voit que ces pages lit les
 * indicateurs agrégés, jamais le détail des pages qu'il ne voit pas
 * (factures en retard avec numéro, client et montant ; chiffre d'affaires
 * par client ; ventes par produit). Même règle que le détail d'un mois de
 * la Prévision.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Invoice from "../../src/models/Invoice.js";
import "../../src/models/PurchaseInvoice.js";
import "../../src/models/Quote.js";
import "../../src/models/CreditNote.js";
import "../../src/models/ImportedInvoice.js";
import "../../src/models/Transaction.js";
import "../../src/models/Client.js";
import financialAnalyticsResolvers from "../../src/resolvers/financialAnalytics.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const ROLE = "role_pilotage_seul";
const ws = () => String(workspaceId);

async function grantActions(actions) {
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne(
      { organizationId: workspaceId, role: ROLE },
      { $set: { actions } },
    );
  invalidateOrganizationRoles();
  invalidateOrgCache();
}

const analytics = (userId = member) =>
  financialAnalyticsResolvers.Query.financialAnalytics(
    null,
    { workspaceId: ws(), startDate: "2020-01-01", endDate: "2030-12-31" },
    buildContext({ userId, organizationId: ws() }),
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: ROLE,
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Pilotage seul",
    permission: "{}",
    actions: {},
    createdAt: new Date(),
  });
  const clientId = new mongoose.Types.ObjectId();
  const invoice = (n, status, extra = {}) => ({
    workspaceId: new mongoose.Types.ObjectId(ws()),
    prefix: "F-2026",
    number: String(n),
    status,
    issueDate: new Date("2026-03-10T10:00:00Z"),
    dueDate: new Date("2026-04-10T10:00:00Z"),
    client: { id: String(clientId), name: "Société Confidentielle" },
    items: [
      {
        description: "Audit stratégique",
        quantity: 1,
        unitPrice: 1000,
        vatRate: 20,
      },
    ],
    totalHT: 1000,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalTTC: 1200,
    ...extra,
  });
  await Invoice.collection.insertMany([
    invoice(1, "PENDING"),
    invoice(2, "COMPLETED", { paymentDate: new Date("2026-03-20T10:00:00Z") }),
  ]);
  invalidateOrganizationRoles();
  invalidateOrgCache();
});

const detailVisible = (r) => ({
  overdue: r.collection.overdueInvoices.length,
  clients: r.revenueByClient.length,
  topClients: r.topClients.length,
  clientMonthly: r.revenueByClientMonthly.length,
  products: r.revenueByProduct.length,
});

describe("financialAnalytics : détail selon les pages visibles", () => {
  it("le propriétaire voit tout le détail", async () => {
    const r = await analytics(owner);
    expect(detailVisible(r)).toMatchObject({
      overdue: 1,
      clients: 1,
      topClients: 1,
    });
    expect(r.revenueByProduct.length).toBeGreaterThan(0);
  });

  for (const [label, actions] of [
    ["Vue d'ensemble seule", { overview: ["view"] }],
    ["Analytiques seules", { analytics: ["view"] }],
  ]) {
    it(`${label} : indicateurs agrégés lisibles, aucun détail de factures, clients ni produits`, async () => {
      await grantActions(actions);
      const r = await analytics();
      expect(r.kpi.invoiceCount).toBe(2);
      expect(r.kpi.overdueCount).toBe(1);
      expect(detailVisible(r)).toEqual({
        overdue: 0,
        clients: 0,
        topClients: 0,
        clientMonthly: 0,
        products: 0,
      });
      expect(JSON.stringify(r)).not.toContain("Société Confidentielle");
      expect(JSON.stringify(r)).not.toContain("Audit stratégique");
    });
  }

  it("Analytiques avec Factures clients, Clients et Catalogue : le détail revient", async () => {
    await grantActions({
      analytics: ["view"],
      invoices: ["view"],
      clients: ["view"],
      products: ["view"],
    });
    const r = await analytics();
    expect(detailVisible(r)).toMatchObject({
      overdue: 1,
      clients: 1,
      topClients: 1,
    });
    expect(r.revenueByProduct.length).toBeGreaterThan(0);
  });
});
