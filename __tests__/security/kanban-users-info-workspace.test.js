/**
 * usersInfo : nom, e-mail et photo des seuls membres de l'espace.
 *
 * La query n'avait aucune garde : n'importe qui, même sans compte, lisait
 * l'identité de n'importe quel utilisateur à partir de son id.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";

const { Query } = kanbanResolvers;

const alice = buildUserId(); // membre de A (appelante)
const bob = buildUserId(); // membre de A
const mallory = buildUserId(); // membre de B seulement
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

const call = async (userIds, context) =>
  Query.usersInfo(
    null,
    { userIds: userIds.map(String) },
    { db: mongoose.connection.db, ...context },
    { fieldName: "usersInfo" },
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
  await mongoose.connection.db.collection("user").insertMany([
    { _id: alice, email: "alice@a.fr", name: "Alice" },
    { _id: bob, email: "bob@a.fr", name: "Bob" },
    { _id: mallory, email: "mallory@b.fr", name: "Mallory" },
  ]);
  await seedOrgMembership({ userId: alice, organizationId: orgA });
  await seedOrgMembership({
    userId: bob,
    organizationId: orgA,
    role: "member",
  });
  await seedOrgMembership({ userId: mallory, organizationId: orgB });
});

describe("usersInfo", () => {
  it("refuse un appel sans utilisateur connecté", async () => {
    await expect(
      call([alice, bob], { user: null, req: { headers: {} } }),
    ).rejects.toThrow(/connecté/);
  });

  it("ne renvoie pas un utilisateur d'un autre espace", async () => {
    const users = await call(
      [bob, mallory],
      buildContext({ userId: alice, organizationId: orgA }),
    );
    expect(users.map((u) => u.id).sort()).toEqual([String(bob)]);
    expect(users.some((u) => u.email === "mallory@b.fr")).toBe(false);
  });

  it("refuse l'en-tête d'un espace dont l'appelant n'est pas membre", async () => {
    await expect(
      call([mallory], buildContext({ userId: alice, organizationId: orgB })),
    ).rejects.toThrow("pas membre");
  });

  it("renvoie les membres de l'espace", async () => {
    const users = await call(
      [alice, bob],
      buildContext({ userId: alice, organizationId: orgA }),
    );
    expect(users).toHaveLength(2);
    expect(users.find((u) => u.id === String(bob))).toMatchObject({
      name: "Bob",
      email: "bob@a.fr",
    });
  });
});
