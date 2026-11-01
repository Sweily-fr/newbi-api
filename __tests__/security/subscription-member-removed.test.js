/**
 * Souscriptions temps réel d'un espace (kanban, documents partagés) après le
 * retrait du membre.
 *
 * L'appartenance est vérifiée à l'ouverture de la souscription, puis avant
 * chaque événement : un membre retiré de l'espace ne reçoit plus rien et sa
 * souscription se termine. Les membres restants continuent de recevoir.
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
import { PubSub } from "graphql-subscriptions";

vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
});

const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";
import { endWhenMemberRemoved } from "../../src/utils/subscriptionMembership.js";

const workspaceId = buildOrganizationId();
const removedId = buildUserId();
const keptId = buildUserId();
const boardId = new mongoose.Types.ObjectId().toString();
const ws = String(workspaceId);

const wsContext = (userId) => ({
  // Contexte d'une connexion WebSocket (server.js, onConnect)
  user: {
    _id: new mongoose.Types.ObjectId(String(userId)),
    id: String(userId),
    email: `${userId}@test.fr`,
  },
  db: mongoose.connection.db,
});

const withTimeout = (promise, ms = 1500) =>
  Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve("__AUCUN__"), ms)),
  ]);

const SUBSCRIPTIONS = [
  {
    label: "boardUpdated",
    open: (ctx) =>
      kanbanResolvers.Subscription.boardUpdated.subscribe(
        null,
        { workspaceId: ws },
        ctx,
      ),
    channel: `BOARD_UPDATED_${ws}`,
  },
  {
    label: "taskUpdated",
    open: (ctx) =>
      kanbanResolvers.Subscription.taskUpdated.subscribe(
        null,
        { workspaceId: ws, boardId },
        ctx,
      ),
    channel: `TASK_UPDATED_${ws}_${boardId}`,
  },
  {
    label: "columnUpdated",
    open: (ctx) =>
      kanbanResolvers.Subscription.columnUpdated.subscribe(
        null,
        { workspaceId: ws, boardId },
        ctx,
      ),
    channel: `COLUMN_UPDATED_${ws}_${boardId}`,
  },
  {
    label: "taskPresence",
    open: (ctx) =>
      kanbanResolvers.Subscription.taskPresence.subscribe(
        null,
        { workspaceId: ws, boardId, clientId: "onglet" },
        ctx,
      ),
    channel: `TASK_PRESENCE_${ws}_${boardId}`,
  },
  {
    label: "sharedDocumentsChanged",
    open: (ctx) =>
      sharedDocumentResolvers.Subscription.sharedDocumentsChanged.subscribe(
        null,
        { workspaceId: ws },
        ctx,
      ),
    channel: `SHARED_DOCUMENTS_CHANGED_${ws}`,
  },
];

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: removedId, organizationId: workspaceId });
  await seedOrgMembership({ userId: keptId, organizationId: workspaceId });
});

describe("souscriptions d'un membre retiré de l'espace", () => {
  it("les noms de canal du test sont ceux publiés par l'API", async () => {
    const source = await import("fs").then((fs) =>
      fs.readFileSync(
        new URL("../../src/resolvers/kanban.js", import.meta.url),
        "utf8",
      ),
    );
    for (const name of [
      "BOARD_UPDATED",
      "TASK_UPDATED",
      "COLUMN_UPDATED",
      "TASK_PRESENCE",
    ]) {
      expect(source).toMatch(new RegExp(`const ${name} = "${name}"`));
    }
  });

  it.each(SUBSCRIPTIONS.map((s) => [s.label, s]))(
    "%s : plus aucun événement après le retrait, les autres membres reçoivent toujours",
    async (_label, { open, channel }) => {
      const removed = await open(wsContext(removedId));
      const kept = await open(wsContext(keptId));

      // Avant le retrait : les deux membres reçoivent
      const first = [removed.next(), kept.next()];
      await new Promise((r) => setTimeout(r, 20));
      await pubsub.publish(channel, { workspaceId: ws, n: 1 });
      const [r1, k1] = await Promise.all(first);
      expect(r1.value).toMatchObject({ n: 1 });
      expect(k1.value).toMatchObject({ n: 1 });

      // Retrait du membre (document member supprimé)
      await mongoose.connection.db
        .collection("member")
        .deleteOne({ userId: new mongoose.Types.ObjectId(String(removedId)) });
      invalidateOrgCache();

      const second = [removed.next(), kept.next()];
      await new Promise((r) => setTimeout(r, 20));
      await pubsub.publish(channel, { workspaceId: ws, n: 2 });
      const [r2, k2] = await Promise.all(second.map((p) => withTimeout(p)));
      expect(r2).toEqual({ value: undefined, done: true });
      expect(k2.value).toMatchObject({ n: 2 });

      await kept.return?.();
    },
  );
});

describe("endWhenMemberRemoved", () => {
  it("un espace qui n'est pas un identifiant termine la souscription", async () => {
    const source = {
      next: vi.fn(async () => ({ value: { n: 1 }, done: false })),
      return: vi.fn(async () => ({ value: undefined, done: true })),
    };
    const iterator = endWhenMemberRemoved(source, {
      user: { id: "pas-un-identifiant" },
      workspaceId: { $ne: null },
    });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(source.return).toHaveBeenCalled();
  });
});
