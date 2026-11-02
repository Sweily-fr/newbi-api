import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

vi.mock("../../src/services/cloudflareService.js", () => ({ default: {} }));

import storageResolvers from "../../src/resolvers/storage.js";

const GB = 1_000_000_000;
const ownerId = buildUserId();
const viewerId = buildUserId();
const organizationId = buildOrganizationId();
const ws = organizationId.toString();

async function seedUsage(totalBytes) {
  await mongoose.connection.db.collection("workspace_storage_usage").insertOne({
    workspaceId: ws,
    totalBytes,
    byCategory: { sharedDocuments: totalBytes },
    byUser: { [ownerId.toString()]: totalBytes - GB, unattributed: GB },
    computedAt: new Date(),
    version: 1,
    stale: false,
    computingUntil: null,
    alertLevel: 100,
    packs: { quantity: 1, interval: "month" },
  });
}

const query = (userId) =>
  storageResolvers.Query.workspaceStorage(
    null,
    { workspaceId: ws },
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
  await seedOrgMembership({ userId: ownerId, organizationId, role: "owner" });
  await seedOrgMembership({ userId: viewerId, organizationId, role: "viewer" });
  await mongoose.connection.db
    .collection("user")
    .insertOne({ _id: ownerId, name: "Alice", lastName: "Martin", email: "alice@test.fr" });
});

describe("Requête workspaceStorage", () => {
  it("donne au propriétaire l'état, le détail et la proposition", async () => {
    await seedUsage(440 * GB);
    const storage = await query(ownerId);
    // Offre TPE (pme) des données de test + 1 pack
    expect(storage).toMatchObject({
      ready: true,
      plan: "pme",
      planLabel: "TPE",
      usedBytes: 440 * GB,
      quotaBytes: 450 * GB,
      baseQuotaBytes: 400 * GB,
      remainingBytes: 10 * GB,
      packs: 1,
      level: "warning",
      canViewDetails: true,
    });
    expect(storage.byCategory[0]).toMatchObject({
      category: "sharedDocuments",
      label: "Documents partagés",
    });
    expect(storage.byUser.map((u) => u.name)).toEqual(["Alice Martin", "Non attribué"]);
    expect(storage.offer.upgrade.plan).toBe("entreprise");
  });

  it("ne donne que l'état à un membre qui ne voit pas l'abonnement", async () => {
    await seedUsage(10 * GB);
    const storage = await query(viewerId);
    expect(storage.usedBytes).toBe(10 * GB);
    expect(storage.canViewDetails).toBe(false);
    expect(storage.byCategory).toBeNull();
    expect(storage.byUser).toBeNull();
    expect(storage.offer).toBeNull();
  });

  it("refuse une personne étrangère à l'espace", async () => {
    await seedUsage(10 * GB);
    await expect(query(buildUserId())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
