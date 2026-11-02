/**
 * Scénarios de prévision créés au même instant : jamais plus de 5, et deux
 * créations du même nom n'en modifient pas une en silence (la seconde est
 * refusée avec un message clair).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import ForecastScenario from "../../src/models/ForecastScenario.js";
import resolvers from "../../src/resolvers/treasuryForecast.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });
const { Mutation } = resolvers;
const create = (name, incomeMultiplier = 1.1) =>
  Mutation.upsertForecastScenario(
    null,
    { input: { name, incomeMultiplier, expenseMultiplier: 1 } },
    ctx(),
  );

beforeAll(async () => {
  await startMongo();
  await ForecastScenario.init();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await ForecastScenario.init();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

describe("Scénarios créés au même instant", () => {
  it("huit créations simultanées : 5 scénarios au plus, les autres refusées", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => create(`Scénario ${i + 1}`)),
    );
    const count = await ForecastScenario.countDocuments({
      workspaceId: new mongoose.Types.ObjectId(organizationId),
    });
    expect(count).toBe(5);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect(r.reason.message).toBe(
        "Vous ne pouvez pas créer plus de 5 scénarios",
      );
    }
  });

  it("même nom créé deux fois au même instant : un seul scénario, l'autre création refusée", async () => {
    const results = await Promise.allSettled([
      create("Optimiste", 1.2),
      create("Optimiste", 1.5),
    ]);
    const saved = await ForecastScenario.find({ name: "Optimiste" }).lean();
    expect(saved).toHaveLength(1);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    // Le scénario gardé est celui de la création acceptée, pas un mélange
    expect(saved[0].incomeMultiplier).toBe(ok[0].value.incomeMultiplier);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused.reason.message).toBe("Un scénario porte déjà ce nom");
  });
});
