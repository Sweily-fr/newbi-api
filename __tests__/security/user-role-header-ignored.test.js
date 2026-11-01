/**
 * En-tête x-user-role envoyé par le client : jamais une source de droits.
 *
 * server.js recopie l'en-tête dans le contexte, mais le RBAC le remplace par
 * le rôle lu en base avant tout resolver. Un membre « Lecture seule » qui
 * envoie « owner » garde son rôle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import organizationRoleResolvers from "../../src/resolvers/organizationRole.js";

const organizationId = buildOrganizationId();
const ownerId = buildUserId();
const viewerId = buildUserId();

// Contexte tel que server.js le construit, en-tête x-user-role compris
const serverContext = (userId) => ({
  req: {
    headers: {
      "x-organization-id": String(organizationId),
      "x-user-role": "owner",
    },
  },
  user: {
    _id: new mongoose.Types.ObjectId(String(userId)),
    id: String(userId),
    email: `${userId}@test.fr`,
  },
  organizationId: String(organizationId),
  userRole: "owner",
});

const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error?.extensions?.code || error?.code || error?.message;
  }
};

beforeAll(async () => {
  await startMongo();
  await seedOrgMembership({ userId: ownerId, organizationId });
  await seedOrgMembership({
    userId: viewerId,
    organizationId,
    role: "viewer",
  });
});
afterAll(async () => {
  await stopMongo();
});

describe("x-user-role: owner envoyé par un membre « Lecture seule »", () => {
  it("myPermissions renvoie son vrai rôle", async () => {
    const result = await organizationRoleResolvers.Query.myPermissions(
      null,
      {},
      serverContext(viewerId),
    );
    expect(result.role).toBe("viewer");
  });

  it("créer un rôle est refusé", async () => {
    const code = await codeOf(
      organizationRoleResolvers.Mutation.createOrganizationRole(
        null,
        { input: { name: "Rôle maison", actions: {} } },
        serverContext(viewerId),
      ),
    );
    expect(code).toBe("FORBIDDEN");
    const roles = await mongoose.connection.db
      .collection("organizationRole")
      .countDocuments({ organizationId });
    expect(roles).toBe(0);
  });

  it("transférer la propriété est refusé", async () => {
    const code = await codeOf(
      organizationRoleResolvers.Mutation.transferOrganizationOwnership(
        null,
        { memberId: String(viewerId) },
        serverContext(viewerId),
      ),
    );
    expect(code).toBe("FORBIDDEN");
    const owner = await mongoose.connection.db
      .collection("member")
      .findOne({ userId: new mongoose.Types.ObjectId(String(ownerId)) });
    expect(owner.role).toBe("owner");
  });
});
