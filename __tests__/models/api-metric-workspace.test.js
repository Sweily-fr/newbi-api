import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import ApiMetric from "../../src/models/ApiMetric.js";

const MINE = "64b000000000000000000001";
const OTHER = "64b000000000000000000002";
const day = new Date("2026-10-10T00:00:00.000Z");
const period = [new Date("2026-10-01"), new Date("2026-10-31")];

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  await ApiMetric.create([
    {
      provider: "bridge",
      endpoint: "/accounts",
      method: "GET",
      workspaceId: MINE,
      date: day,
      requestCount: 3,
      successCount: 3,
      cost: { total: 0.3, perRequest: 0.1 },
    },
    {
      provider: "bridge",
      endpoint: "/accounts",
      method: "GET",
      workspaceId: OTHER,
      date: day,
      requestCount: 700,
      successCount: 700,
      cost: { total: 70, perRequest: 0.1 },
    },
  ]);
});

describe("Métriques bancaires : un espace ne voit que les siennes", () => {
  it("getProviderStats ne compte que l'espace demandé", async () => {
    const [stats] = await ApiMetric.getProviderStats(MINE, "bridge", ...period);
    expect(stats.totalRequests).toBe(3);
    expect(stats.totalCost).toBeCloseTo(0.3);
  });

  it("getCostComparison ne compte que l'espace demandé", async () => {
    const rows = await ApiMetric.getCostComparison(MINE, ...period);
    expect(rows).toHaveLength(1);
    expect(rows[0].totalRequests).toBe(3);
  });

  it("sans espace, rien (jamais la somme de toutes les organisations)", async () => {
    expect(await ApiMetric.getProviderStats(null, "bridge", ...period)).toEqual(
      [],
    );
    expect(await ApiMetric.getCostComparison(undefined, ...period)).toEqual([]);
  });
});
