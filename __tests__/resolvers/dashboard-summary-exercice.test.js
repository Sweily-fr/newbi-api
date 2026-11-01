/**
 * Encaissements et décaissements de l'accueil bornés à l'exercice comptable
 * en cours (Paramètres : début et fin d'exercice) :
 *   - début seul (01/07) : l'exercice glissant qui contient aujourd'hui ;
 *   - début et fin passés (exercice clos) : sa période complète ;
 *   - premier exercice long qui contient aujourd'hui : tel que saisi ;
 *   - dates mal formées : année civile, jamais depuis 1970.
 * Horloge simulée au 15/03/2026 (Date seule).
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
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import "../../src/models/AccountBanking.js";
import Transaction from "../../src/models/Transaction.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = () => organizationId.toString();

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
  // Une entrée par date (montants distincts) : la somme dit lesquelles comptent
  const entries = [
    ["1970-01-02", 1],
    ["2024-03-01", 2],
    ["2024-12-31", 4],
    ["2025-06-30", 8],
    ["2025-07-01", 16],
    ["2026-01-01", 32],
    ["2026-03-10", 64],
    ["2026-03-20", 128], // future : jamais comptée
  ];
  await Transaction.collection.insertMany(
    entries.map(([day, amount]) => ({
      workspaceId: ws(),
      provider: "bridge",
      status: "completed",
      deletedAt: null,
      amount,
      date: new Date(`${day}T10:00:00Z`),
      description: `Entrée du ${day}`,
    })),
  );
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2026-03-15T10:00:00Z"),
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function income(fiscal) {
  await mongoose.connection.db
    .collection("organization")
    .updateOne({ _id: organizationId }, { $set: fiscal }, { upsert: true });
  const r = await dashboardAggregationResolvers.Query.dashboardSummary(
    null,
    { workspaceId: ws() },
    buildContext({ userId, organizationId }),
  );
  return r.totalIncome;
}

describe("dashboardSummary : exercice comptable", () => {
  it("sans exercice configuré : année civile jusqu'à aujourd'hui", async () => {
    expect(await income({})).toBe(32 + 64);
  });

  it("début seul (01/07/2020) : du 01/07/2025 à aujourd'hui", async () => {
    expect(await income({ fiscalYearStartDate: "2020-07-01" })).toBe(
      16 + 32 + 64,
    );
  });

  it("exercice clos (2024) : sa période complète", async () => {
    expect(
      await income({
        fiscalYearStartDate: "2024-01-01",
        fiscalYearEndDate: "2024-12-31",
      }),
    ).toBe(2 + 4);
  });

  it("premier exercice long qui contient aujourd'hui : tel que saisi", async () => {
    expect(
      await income({
        fiscalYearStartDate: "2025-06-30",
        fiscalYearEndDate: "2026-06-30",
      }),
    ).toBe(8 + 16 + 32 + 64);
  });

  for (const [label, fiscal] of [
    ["début illisible", { fiscalYearStartDate: "pas-une-date" }],
    ["mois 13", { fiscalYearStartDate: "2025-13-01" }],
    [
      "début et fin illisibles",
      { fiscalYearStartDate: "abc", fiscalYearEndDate: "def" },
    ],
  ]) {
    it(`${label} : année civile, jamais depuis 1970`, async () => {
      expect(await income(fiscal)).toBe(32 + 64);
    });
  }

  it("fin illisible : ignorée, l'exercice suit le début (01/07)", async () => {
    expect(
      await income({
        fiscalYearStartDate: "2025-07-01",
        fiscalYearEndDate: "31/12/2025",
      }),
    ).toBe(16 + 32 + 64);
  });
});
