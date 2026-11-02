/**
 * Prévision : un devis signé ni facturé ni annulé reste attendu après son
 * mois d'émission. Il est reporté sur le mois courant (tableau, KPI « Devis
 * signés » et détail du mois courant) ; facturé ou annulé, il disparaît.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import "../../src/models/Invoice.js";
import "../../src/models/PurchaseInvoice.js";
import "../../src/models/Quote.js";
import "../../src/models/Transaction.js";
import "../../src/models/AccountBanking.js";
import resolvers, {
  signedQuoteForecastMonth,
} from "../../src/resolvers/treasuryForecast.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });
const { Query } = resolvers;

const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

async function insertQuotes(quotes) {
  await mongoose
    .model("Quote")
    .collection.insertMany(
      quotes.map((q) => ({
        workspaceId: new mongoose.Types.ObjectId(organizationId),
        prefix: "D",
        client: { name: "Client" },
        convertedToInvoice: null,
        ...q,
      })),
    );
}

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

describe("Mois d'un devis signé dans la prévision", () => {
  it("mois d'émission s'il est à venir, mois courant s'il est passé", () => {
    expect(signedQuoteForecastMonth(new Date(2026, 6, 10), "2026-11")).toBe(
      "2026-11",
    );
    expect(signedQuoteForecastMonth(new Date(2026, 10, 2), "2026-11")).toBe(
      "2026-11",
    );
    expect(signedQuoteForecastMonth(new Date(2027, 1, 3), "2026-11")).toBe(
      "2027-02",
    );
  });
});

describe("Devis signé non facturé d'un mois passé", () => {
  it("reporté sur le mois courant, compté dans le KPI, listé dans le détail du mois", async () => {
    const now = new Date();
    const fourMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 4, 12);
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 5);
    await insertQuotes([
      // Avant la plage affichée : toujours attendu
      {
        number: "001",
        status: "COMPLETED",
        issueDate: fourMonthsAgo,
        finalTotalTTC: 1200,
      },
      {
        number: "002",
        status: "COMPLETED",
        issueDate: twoMonthsAgo,
        finalTotalTTC: 300,
      },
      // Facturé, annulé, en attente : jamais attendus
      {
        number: "003",
        status: "COMPLETED",
        issueDate: twoMonthsAgo,
        finalTotalTTC: 5000,
        convertedToInvoice: new mongoose.Types.ObjectId(),
      },
      {
        number: "004",
        status: "CANCELED",
        issueDate: twoMonthsAgo,
        finalTotalTTC: 7000,
      },
      {
        number: "005",
        status: "PENDING",
        issueDate: twoMonthsAgo,
        finalTotalTTC: 9000,
      },
    ]);

    const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 3, 1);
    const data = await Query.treasuryForecastData(
      null,
      { startDate: `${monthKey(start)}-01`, endDate: `${monthKey(end)}-01` },
      ctx(),
    );

    expect(data.kpi.signedQuotes).toBe(1500);
    const salesForecast = (month) =>
      data.months
        .find((m) => m.month === month)
        .categoryBreakdown.filter(
          (c) => c.type === "INCOME" && c.category === "SALES",
        )
        .reduce((sum, c) => sum + c.forecastAmount, 0);
    expect(salesForecast(monthKey(now))).toBe(1500);
    // Le mois d'émission passé n'en compte pas (pas de double comptage)
    expect(salesForecast(monthKey(twoMonthsAgo))).toBe(0);

    const details = await Query.forecastMonthDetails(
      null,
      { month: monthKey(now) },
      ctx(),
    );
    expect(details.signedQuotes.map((q) => q.number).sort()).toEqual([
      "D-001",
      "D-002",
    ]);
  });
});
