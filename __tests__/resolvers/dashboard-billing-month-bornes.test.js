/**
 * Cadre « Facturation » de l'accueil aux bornes horaires : le mois est le
 * mois calendaire de Paris. Une facture émise le 1er à 00 h 30 (la veille en
 * UTC) ou le dernier jour à 23 h 30 compte dans le mois, y compris autour du
 * changement d'heure ; une échéance du jour n'est pas encore en retard.
 * Horloge simulée (Date seule, pour ne pas figer le pilote Mongo).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Invoice from "../../src/models/Invoice.js";
import "../../src/models/ImportedInvoice.js";
import "../../src/models/PurchaseInvoice.js";
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
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (iso) => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
};

const query = () =>
  dashboardAggregationResolvers.Query.dashboardBillingMonth(
    null,
    { workspaceId: organizationId.toString() },
    buildContext({ userId, organizationId }),
  );

const insertInvoice = (issueDate, overrides = {}) =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    status: "COMPLETED",
    issueDate: new Date(issueDate),
    finalTotalHT: 100,
    finalTotalTTC: 120,
    ...overrides,
  });

describe("dashboardBillingMonth aux bornes du mois (heure de Paris)", () => {
  it("mars (passage à l'heure d'été le 29) : 1er à 00 h 30 et 31 à 23 h 30 comptés, voisins exclus", async () => {
    // 1er mars 00 h 30 à Paris (UTC+1) = 28 février 23 h 30 UTC
    await insertInvoice("2026-02-28T23:30:00Z", { finalTotalTTC: 1 });
    // 31 mars 23 h 30 à Paris (UTC+2) = 31 mars 21 h 30 UTC
    await insertInvoice("2026-03-31T21:30:00Z", { finalTotalTTC: 10 });
    // 28 février 23 h 30 à Paris : février
    await insertInvoice("2026-02-28T22:30:00Z", { finalTotalTTC: 100 });
    // 1er avril 00 h 30 à Paris : avril
    await insertInvoice("2026-03-31T22:30:00Z", { finalTotalTTC: 1000 });

    // 1er mars 00 h 10 à Paris (encore février en UTC)
    at("2026-02-28T23:10:00Z");
    const debut = await query();
    expect(debut.month).toBe("2026-03");
    expect(debut.sales.total).toBe(11);

    // 31 mars 23 h 50 à Paris (déjà le 31 au soir en UTC)
    at("2026-03-31T21:50:00Z");
    const fin = await query();
    expect(fin.month).toBe("2026-03");
    expect(fin.sales.total).toBe(11);
  });

  it("octobre (retour à l'heure d'hiver le 25) : 31 à 23 h 30 compté", async () => {
    // 31 octobre 23 h 30 à Paris (UTC+1) = 31 octobre 22 h 30 UTC
    await insertInvoice("2026-10-31T22:30:00Z", { finalTotalTTC: 10 });
    // 1er octobre 00 h 30 à Paris (UTC+2) = 30 septembre 22 h 30 UTC
    await insertInvoice("2026-09-30T22:30:00Z", { finalTotalTTC: 1 });
    // 1er novembre 00 h 30 à Paris
    await insertInvoice("2026-10-31T23:30:00Z", { finalTotalTTC: 1000 });

    at("2026-10-31T22:45:00Z");
    const r = await query();
    expect(r.month).toBe("2026-10");
    expect(r.sales.total).toBe(11);
  });

  it("échéance du jour : pas encore en retard ; échéance de la veille : en retard", async () => {
    at("2026-03-15T10:00:00Z");
    // Minuit du 15 mars à Paris = 14 mars 23 h UTC
    await insertInvoice("2026-03-02T10:00:00Z", {
      status: "PENDING",
      dueDate: new Date("2026-03-14T23:00:00Z"),
    });
    await insertInvoice("2026-03-02T10:00:00Z", {
      status: "PENDING",
      dueDate: new Date("2026-03-13T23:00:00Z"),
      finalTotalTTC: 50,
    });

    const { sales } = await query();
    expect(sales.pendingCount).toBe(2);
    expect(sales.overdueCount).toBe(1);
    expect(sales.overdue).toBe(50);
  });
});
