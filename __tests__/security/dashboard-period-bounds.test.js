/**
 * Périodes personnalisées des tableaux de bord et du prévisionnel : dates
 * validées (format, jour réel, bornes, durée) avant tout calcul, avec un
 * message en français. Une plage invalide est refusée rapidement.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";
import treasuryForecastResolvers from "../../src/resolvers/treasuryForecast.js";
import {
  parsePeriodDate,
  validateDayPeriod,
  validateMonthPeriod,
} from "../../src/utils/periodBounds.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = () => organizationId.toString();
const ctx = () => buildContext({ userId, organizationId });

const chart = (period) =>
  dashboardAggregationResolvers.Query.dashboardTreasuryChart(
    null,
    { workspaceId: ws(), period },
    ctx(),
  );
const categories = (period) =>
  dashboardAggregationResolvers.Query.dashboardCategoryAggregation(
    null,
    { workspaceId: ws(), period },
    ctx(),
  );
const forecast = (startDate, endDate) =>
  treasuryForecastResolvers.Query.treasuryForecastData(
    null,
    { workspaceId: ws(), startDate, endDate },
    ctx(),
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
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

describe("dashboardTreasuryChart : période personnalisée", () => {
  const invalid = [
    ["année hors bornes", "-271821-04-20", "2026-10-31"],
    ["plage de plusieurs siècles", "0001-01-01", "9999-12-31"],
    ["jour inexistant", "2026-02-31", "2026-03-31"],
    ["texte libre", "hier", "2026-10-31"],
    ["fin avant le début", "2026-10-31", "2026-01-01"],
    ["plus de 20 ans", "1995-01-01", "2026-10-31"],
  ];
  for (const [label, startDate, endDate] of invalid) {
    it(`refuse ${label} avec une erreur de validation`, async () => {
      const started = Date.now();
      await expect(chart({ startDate, endDate })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(/^Période (invalide|trop longue)/),
      });
      expect(Date.now() - started).toBeLessThan(1000);
    });
  }

  it("accepte une période valide et renvoie les points de la période", async () => {
    const result = await chart({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(result.dataPoints[0].date).toBe("2026-01-01");
    expect(result.dataPoints.map((p) => p.date)).toContain("2026-01-31");
  });

  it("les presets ne sont pas concernés", async () => {
    const result = await chart({ preset: "30d" });
    expect(result.dataPoints.length).toBeGreaterThan(29);
  });

  it("dashboardCategoryAggregation applique les mêmes bornes", async () => {
    await expect(
      categories({ startDate: "0001-01-01", endDate: "9999-12-31" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("treasuryForecastData : période en mois", () => {
  it("refuse une fin de période mal formée", async () => {
    await expect(forecast("2026-01", "9999999")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("refuse une plage de plus de 20 ans", async () => {
    await expect(forecast("2000-01", "2026-12")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Période trop longue : 20 ans au maximum",
    });
  });

  it("refuse un mois inexistant", async () => {
    await expect(forecast("2026-13", "2027-01")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("periodBounds", () => {
  it("accepte une date simple ou une date ISO complète", () => {
    expect(parsePeriodDate("2026-10-31")?.toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
    expect(parsePeriodDate("2026-10-31T10:00:00.000Z")?.toISOString()).toBe(
      "2026-10-31T10:00:00.000Z",
    );
    expect(parsePeriodDate("2026-02-29")).toBeNull();
    expect(parsePeriodDate(42)).toBeNull();
  });

  it("validateDayPeriod renvoie les dates d'une période valide", () => {
    const { startDate, endDate } = validateDayPeriod(
      "2024-02-29",
      "2026-10-31",
    );
    expect(startDate.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });

  it("validateMonthPeriod garde le mois d'une date complète", () => {
    expect(validateMonthPeriod("2026-10-15", "2027-03")).toEqual({
      startMonth: "2026-10",
      endMonth: "2027-03",
    });
  });
});
