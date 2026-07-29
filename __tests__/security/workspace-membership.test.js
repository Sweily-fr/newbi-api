import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { userBelongsToWorkspace } from "../../src/utils/workspace-membership.js";

// Ce contrôle est la base du middleware requireWorkspaceMembership qui protège
// désormais les routes REST bancaires (banking / banking-connect / -sync /
// -cache) et l'IDOR cross-org qui permettait lecture + suppression des données
// bancaires d'une autre organisation via un simple header x-workspace-id.

const userA = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({
    userId: userA,
    organizationId: orgA,
    role: "owner",
  });
});

describe("userBelongsToWorkspace (base du contrôle d'appartenance REST)", () => {
  it("autorise un membre de son propre workspace", async () => {
    expect(
      await userBelongsToWorkspace(userA.toString(), orgA.toString()),
    ).toBe(true);
  });

  it("refuse l'accès à un workspace dont l'utilisateur n'est pas membre", async () => {
    expect(
      await userBelongsToWorkspace(userA.toString(), orgB.toString()),
    ).toBe(false);
  });

  it("refuse un identifiant invalide sans lever", async () => {
    expect(await userBelongsToWorkspace("not-an-id", orgA.toString())).toBe(
      false,
    );
  });
});
