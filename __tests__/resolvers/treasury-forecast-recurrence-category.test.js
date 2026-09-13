import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

import DetectedRecurrence from "../../src/models/DetectedRecurrence.js";
// Enregistre les modèles interrogés par treasuryForecastData via
// mongoose.model("…").
import "../../src/models/AccountBanking.js";
import "../../src/models/Invoice.js";
import "../../src/models/PurchaseInvoice.js";
import "../../src/models/Quote.js";
import "../../src/models/Transaction.js";
import resolvers, {
  recurrenceForecastCategory,
} from "../../src/resolvers/treasuryForecast.js";

// Ticket 13/09/2026 : les récurrences détectées tombaient dans « Autres
// dépenses » (catégorie OTHER des transactions) sans possibilité de les
// reclasser. La catégorie choisie (categoryOverride) prime à la projection.

const userId = buildUserId();
const organizationId = buildOrganizationId();
const wId = () => new mongoose.Types.ObjectId(organizationId);

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
const { Query, Mutation, DetectedRecurrence: RecurrenceType } = resolvers;

const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const addMonths = (d, n) => {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
};
const horizon = () => {
  const now = new Date();
  return { startMonth: monthKey(now), endMonth: monthKey(addMonths(now, 5)) };
};

const createRecurrence = (overrides = {}) =>
  DetectedRecurrence.create({
    workspaceId: wId(),
    source: "TRANSACTION",
    type: "EXPENSE",
    partyKey: "netflix-com",
    partyName: "PRLV SEPA NETFLIX.COM",
    category: "OTHER",
    averageAmount: 16,
    frequency: "MONTHLY",
    intervalDays: 30,
    occurrenceCount: 4,
    lastSeenDate: addMonths(new Date(), -1),
    lastSeenMonth: monthKey(addMonths(new Date(), -1)),
    consecutiveMonths: 4,
    isActive: true,
    isMuted: false,
    ...overrides,
  });

describe("recurrenceForecastCategory", () => {
  it("rabat la catégorie détectée sur l'enum ForecastCategory", () => {
    expect(
      recurrenceForecastCategory({ source: "TRANSACTION", type: "EXPENSE" }),
    ).toBe("OTHER_EXPENSE");
    expect(
      recurrenceForecastCategory({
        source: "TRANSACTION",
        type: "EXPENSE",
        category: "OTHER",
      }),
    ).toBe("OTHER_EXPENSE");
    expect(
      recurrenceForecastCategory({
        source: "TRANSACTION",
        type: "EXPENSE",
        category: "TRAVEL",
      }),
    ).toBe("TRANSPORT");
    expect(
      recurrenceForecastCategory({
        source: "PURCHASE_INVOICE",
        type: "EXPENSE",
        category: "SOFTWARE",
      }),
    ).toBe("SOFTWARE");
    expect(
      recurrenceForecastCategory({
        source: "TRANSACTION",
        type: "INCOME",
        category: "OTHER_INCOME",
      }),
    ).toBe("OTHER_INCOME");
    expect(
      recurrenceForecastCategory({ source: "INVOICE", type: "INCOME" }),
    ).toBe("SALES");
  });

  it("fait primer la catégorie choisie par l'utilisateur", () => {
    expect(
      recurrenceForecastCategory({
        source: "TRANSACTION",
        type: "EXPENSE",
        category: "OTHER",
        categoryOverride: "SUBSCRIPTIONS",
      }),
    ).toBe("SUBSCRIPTIONS");
  });
});

describe("setDetectedRecurrenceCategory", () => {
  it("reclasse la récurrence et la projette dans la nouvelle catégorie", async () => {
    const rec = await createRecurrence();

    const before = await Query.forecastOccurrences(null, horizon(), ctx());
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((o) => o.category === "OTHER_EXPENSE")).toBe(true);

    const updated = await Mutation.setDetectedRecurrenceCategory(
      null,
      { id: rec._id.toString(), category: "SUBSCRIPTIONS" },
      ctx(),
    );
    expect(updated.categoryOverride).toBe("SUBSCRIPTIONS");
    expect(updated.category).toBe("OTHER"); // identité intacte
    expect(RecurrenceType.forecastCategory(updated)).toBe("SUBSCRIPTIONS");

    const after = await Query.forecastOccurrences(null, horizon(), ctx());
    expect(after).toHaveLength(before.length);
    expect(after.every((o) => o.category === "SUBSCRIPTIONS")).toBe(true);

    // Le tableau agrégé suit aussi.
    const now = new Date();
    const data = await Query.treasuryForecastData(
      null,
      {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        endDate: new Date(
          now.getFullYear(),
          now.getMonth() + 3,
          0,
        ).toISOString(),
      },
      ctx(),
    );
    const subscriptions = data.months
      .flatMap((m) => m.categoryBreakdown)
      .filter((cb) => cb.category === "SUBSCRIPTIONS" && cb.type === "EXPENSE");
    expect(subscriptions.some((cb) => cb.forecastAmount >= 16)).toBe(true);
  });

  it("null revient à la catégorie détectée", async () => {
    const rec = await createRecurrence({ categoryOverride: "SUBSCRIPTIONS" });
    const updated = await Mutation.setDetectedRecurrenceCategory(
      null,
      { id: rec._id.toString(), category: null },
      ctx(),
    );
    expect(updated.categoryOverride ?? null).toBeNull();
    expect(RecurrenceType.forecastCategory(updated)).toBe("OTHER_EXPENSE");
  });

  it("refuse une catégorie de revenu sur une dépense (et inversement)", async () => {
    const expense = await createRecurrence();
    await expect(
      Mutation.setDetectedRecurrenceCategory(
        null,
        { id: expense._id.toString(), category: "SALES" },
        ctx(),
      ),
    ).rejects.toThrow(/catégorie de dépense/);

    const income = await createRecurrence({
      type: "INCOME",
      partyKey: "client-x",
      partyName: "VIR CLIENT X",
      category: "OTHER_INCOME",
    });
    await expect(
      Mutation.setDetectedRecurrenceCategory(
        null,
        { id: income._id.toString(), category: "RENT" },
        ctx(),
      ),
    ).rejects.toThrow(/catégorie de revenu/);
  });

  it("la catégorie est commune à tous les scénarios", async () => {
    const rec = await createRecurrence();
    const scenario = await Mutation.upsertForecastScenario(
      null,
      {
        input: {
          name: "Pessimiste",
          incomeMultiplier: 1,
          expenseMultiplier: 1,
        },
      },
      ctx(),
    );
    await Mutation.setDetectedRecurrenceCategory(
      null,
      { id: rec._id.toString(), category: "SOFTWARE" },
      ctx(),
    );
    const inScenario = await Query.forecastOccurrences(
      null,
      { ...horizon(), scenarioId: scenario._id.toString() },
      ctx(),
    );
    expect(inScenario.length).toBeGreaterThan(0);
    expect(inScenario.every((o) => o.category === "SOFTWARE")).toBe(true);
    const [listed] = await Query.detectedRecurrences(
      null,
      { scenarioId: scenario._id.toString() },
      ctx(),
    );
    expect(listed.categoryOverride).toBe("SOFTWARE");
  });

  it("refuse une récurrence d'un autre workspace", async () => {
    const other = await createRecurrence({
      workspaceId: new mongoose.Types.ObjectId(),
    });
    await expect(
      Mutation.setDetectedRecurrenceCategory(
        null,
        { id: other._id.toString(), category: "SOFTWARE" },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvée/);
  });
});
