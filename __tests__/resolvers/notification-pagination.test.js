/**
 * Notifications d'activité : page bornée. Un décalage négatif ne fait plus
 * échouer la lecture, une limite démesurée est plafonnée à 100.
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
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { buildContext } from "../helpers/auth.js";
import notificationResolvers from "../../src/resolvers/notification.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  const now = Date.now();
  await mongoose.connection.db.collection("notifications").insertMany(
    Array.from({ length: 120 }, (_, i) => ({
      userId,
      workspaceId: organizationId,
      type: "TASK_ASSIGNED",
      title: `Notification ${i}`,
      message: "Tâche assignée",
      read: false,
      createdAt: new Date(now - i * 1000),
      updatedAt: new Date(now - i * 1000),
    })),
  );
});

const list = (args) =>
  notificationResolvers.Query.getNotifications(
    null,
    { workspaceId: organizationId.toString(), ...args },
    buildContext({ userId, organizationId }),
  );

describe("getNotifications : pagination bornée", () => {
  it("limite démesurée : 100 au plus", async () => {
    const r = await list({ limit: 1_000_000 });
    expect(r.notifications).toHaveLength(100);
    expect(r.totalCount).toBe(120);
  });

  it("décalage négatif : première page, sans erreur", async () => {
    const r = await list({ limit: 5, offset: -10 });
    expect(r.notifications.map((n) => n.title)).toEqual([
      "Notification 0",
      "Notification 1",
      "Notification 2",
      "Notification 3",
      "Notification 4",
    ]);
  });

  it("limite nulle ou négative : au moins une notification", async () => {
    expect((await list({ limit: -3 })).notifications).toHaveLength(1);
  });

  it("valeurs usuelles inchangées (50, puis la page suivante)", async () => {
    const first = await list({});
    expect(first.notifications).toHaveLength(50);
    const next = await list({ limit: 50, offset: 100 });
    expect(next.notifications).toHaveLength(20);
  });
});
