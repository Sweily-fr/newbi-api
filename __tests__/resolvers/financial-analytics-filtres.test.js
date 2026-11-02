/**
 * Filtres de financialAnalytics (utilisés par l'application mobile) :
 * clientIds avec un identifiant importé (UUID Qonto) ou une chaîne
 * quelconque sans erreur technique, client d'un autre espace sans donnée,
 * statuts filtrés.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import "../../src/models/PurchaseInvoice.js";
import "../../src/models/Quote.js";
import "../../src/models/CreditNote.js";
import "../../src/models/ImportedInvoice.js";
import "../../src/models/Transaction.js";
import "../../src/models/Client.js";
import financialAnalyticsResolvers from "../../src/resolvers/financialAnalytics.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherWorkspace = new mongoose.Types.ObjectId();
const UUID = "8f14e45f-ceea-467a-9575-0d0d1f3b9c21";
const newbiClient = new mongoose.Types.ObjectId().toHexString();
const foreignClient = new mongoose.Types.ObjectId().toHexString();

const analytics = (args) =>
  financialAnalyticsResolvers.Query.financialAnalytics(
    null,
    {
      workspaceId: String(organizationId),
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      ...args,
    },
    buildContext({ userId, organizationId }),
  );

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
  const invoice = (n, workspaceId, clientId, status) => ({
    workspaceId,
    prefix: "F-2026",
    number: String(n),
    status,
    issueDate: new Date("2026-03-10T10:00:00Z"),
    dueDate: new Date("2026-04-10T10:00:00Z"),
    ...(status === "COMPLETED"
      ? { paymentDate: new Date("2026-03-20T10:00:00Z") }
      : {}),
    client: { id: clientId, name: `Client ${n}` },
    items: [],
    totalHT: 100 * n,
    totalTTC: 120 * n,
    finalTotalHT: 100 * n,
    finalTotalTTC: 120 * n,
  });
  const w = new mongoose.Types.ObjectId(String(organizationId));
  await Invoice.collection.insertMany([
    invoice(1, w, newbiClient, "PENDING"),
    invoice(2, w, newbiClient, "COMPLETED"),
    invoice(3, w, UUID, "PENDING"),
    invoice(4, otherWorkspace, foreignClient, "PENDING"),
  ]);
});

describe("financialAnalytics : filtres", () => {
  it("clientIds avec un UUID de client importé : répond, sans erreur technique", async () => {
    const r = await analytics({ clientIds: [UUID] });
    expect(r.kpi.invoiceCount).toBe(1);
  });

  it("clientIds avec une chaîne quelconque : aucune donnée, sans erreur", async () => {
    const r = await analytics({ clientIds: ["pas-un-identifiant"] });
    expect(r.kpi.invoiceCount).toBe(0);
  });

  it("client d'un autre espace : aucune donnée", async () => {
    const r = await analytics({ clientIds: [foreignClient] });
    expect(r.kpi.invoiceCount).toBe(0);
    expect(JSON.stringify(r)).not.toContain("Client 4");
  });

  it("client Newbi : ses seules factures", async () => {
    const r = await analytics({ clientIds: [newbiClient] });
    expect(r.kpi.invoiceCount).toBe(2);
  });

  it("status [PENDING] : seules les factures en attente", async () => {
    const r = await analytics({ status: ["PENDING"] });
    expect(r.statusBreakdown.map((s) => s.status)).toEqual(["PENDING"]);
    expect(r.statusBreakdown[0].count).toBe(2);
  });
});
