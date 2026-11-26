import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import {
  canonicalPlanKey,
  normalizePlan,
} from "../../src/services/storage/storageConfig.js";
import {
  getLiveSubscriptionPlan,
  getWorkspacePlan,
} from "../../src/services/esignatureQuota.js";
import { getCampaignPlan } from "../../src/services/emailCampaigns/quota.js";
import {
  getWorkspacePlanLimits,
  PLAN_LIMITS,
} from "../../src/services/planLimits.js";
import { getProspectBalance } from "../../src/services/prospects/prospectQuota.js";

/**
 * Anciennes clés d'offre (« pro », « enterprise ») encore portées par des
 * abonnements en prod : lues comme l'offre actuelle (Premium, Entreprise),
 * comme planLabel() du site, sans jamais réécrire l'abonnement en base.
 */

let workspaceId;

async function abonnement(plan, status = "active") {
  await mongoose.connection.db.collection("subscription").insertOne({
    referenceId: workspaceId,
    plan,
    status,
    periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  workspaceId = buildOrganizationId().toString();
});

describe("clé d'offre actuelle", () => {
  it("lit les anciennes clés comme l'offre actuelle, garde les autres", () => {
    expect(canonicalPlanKey("pro")).toBe("pme");
    expect(canonicalPlanKey(" Enterprise ")).toBe("entreprise");
    expect(canonicalPlanKey("tpe")).toBe("pme");
    expect(canonicalPlanKey("PME")).toBe("pme");
    expect(canonicalPlanKey("inconnue")).toBe("inconnue");
    expect(canonicalPlanKey(null)).toBe("");
    // Le stockage garde sa règle : inconnue = Standard
    expect(normalizePlan("inconnue")).toBe("freelance");
    expect(normalizePlan("enterprise")).toBe("entreprise");
  });
});

describe.each([
  ["pro", "pme", 30],
  ["enterprise", "entreprise", 100],
])("abonnement à l'ancienne clé « %s »", (stored, current, credits) => {
  it(`compte comme l'offre ${current} partout`, async () => {
    await abonnement(stored);

    expect(await getLiveSubscriptionPlan(workspaceId)).toBe(current);
    expect(await getWorkspacePlan(workspaceId)).toBe(current);
    expect(await getCampaignPlan(workspaceId)).toBe(current);
    expect(await getWorkspacePlanLimits(workspaceId)).toEqual({
      plan: current,
      limits: PLAN_LIMITS[current],
    });
    expect(await getProspectBalance(workspaceId)).toMatchObject({
      plan: current,
      monthlyCredits: credits,
      available: credits,
    });

    // L'abonnement en base n'est pas touché
    const doc = await mongoose.connection.db
      .collection("subscription")
      .findOne({ referenceId: workspaceId });
    expect(doc.plan).toBe(stored);
  });
});

it("une clé inconnue garde l'offre par défaut de chaque lecteur", async () => {
  await abonnement("mystere");
  expect(await getWorkspacePlan(workspaceId)).toBe("freelance");
  expect(await getCampaignPlan(workspaceId)).toBe("freelance");
  expect((await getProspectBalance(workspaceId)).plan).toBeNull();
});
