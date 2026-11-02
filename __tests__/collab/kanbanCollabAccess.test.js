/**
 * Édition collaborative (/collab) : droits vérifiés à la connexion ET
 * pendant celle-ci.
 *   - abonnement inactif : connexion en lecture seule (les mutations kanban
 *     sont refusées dans ce cas, l'éditeur collaboratif écrivait quand même) ;
 *   - membre retiré de l'espace, retiré de la liste du tableau ou sans
 *     session valide : connexion fermée au message suivant (30 s au plus) ;
 *   - rôle rétrogradé sans écriture : connexion passée en lecture seule.
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
import mongoose from "mongoose";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    subscribe: async () => 1,
    unsubscribe: () => {},
  }),
  getCacheClient: () => null,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  redisConfig: { host: "localhost", port: 6379, db: 0 },
}));
vi.mock("@hocuspocus/extension-redis", () => ({ Redis: class {} }));
vi.mock("../../src/resolvers/kanban.js", () => ({
  publishTaskUpdated: vi.fn(async () => null),
}));
const jwtUser = vi.hoisted(() => ({ current: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: vi.fn(async () => jwtUser.current),
  clientIpOf: () => "127.0.0.1",
  isAuthenticated: (resolver) => resolver,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { Board, Task } from "../../src/models/kanban.js";
import {
  authenticate,
  recheckConnection,
  COLLAB_RECHECK_MS,
} from "../../src/collab/kanbanCollabServer.js";

const org = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
let board;
let task;

const db = () => mongoose.connection.db;

const connect = async (userId) => {
  jwtUser.current = { _id: userId };
  const connectionConfig = { readOnly: false };
  const context = await authenticate({
    token: "jeton",
    documentName: `kanban-task:${task._id}`,
    connectionConfig,
  });
  return { context, connectionConfig };
};

const later = (context) => ({
  connection: { readOnly: false },
  context,
  now: context.checkedAt + COLLAB_RECHECK_MS + 1,
});

const seedSession = (userId) =>
  db()
    .collection("session")
    .insertOne({
      userId,
      token: `session-${userId}`,
      expiresAt: new Date(Date.now() + 3600_000),
    });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache(org.toString());
  await seedOrgMembership({ userId: owner, organizationId: org });
  await seedOrgMembership({
    userId: editor,
    organizationId: org,
    role: "member",
  });
  await seedSession(owner);
  await seedSession(editor);
  board = await Board.create({
    title: "Tableau",
    workspaceId: org,
    userId: owner.toString(),
  });
  task = await Task.create({
    title: "Tâche",
    status: "todo",
    boardId: board._id,
    columnId: "todo",
    workspaceId: org,
    userId: owner,
  });
});

describe("Connexion", () => {
  it("abonnement actif : édition autorisée", async () => {
    const { connectionConfig } = await connect(editor);
    expect(connectionConfig.readOnly).toBe(false);
  });

  it("abonnement inactif : lecture seule", async () => {
    await db()
      .collection("subscription")
      .updateOne(
        { referenceId: org.toString() },
        { $set: { status: "unpaid" } },
      );
    invalidateSubCache(org.toString());
    const { connectionConfig } = await connect(editor);
    expect(connectionConfig.readOnly).toBe(true);
  });

  it("tableau réservé à d'autres membres : refusée", async () => {
    await Board.updateOne(
      { _id: board._id },
      { $set: { members: [owner.toString()] } },
    );
    await expect(connect(editor)).rejects.toThrow("Accès refusé");
  });
});

describe("Pendant la connexion", () => {
  it("droits inchangés : connexion gardée", async () => {
    const { context } = await connect(editor);
    const payload = later(context);
    await expect(recheckConnection(payload)).resolves.toBeUndefined();
    expect(payload.connection.readOnly).toBe(false);
  });

  it("membre retiré de l'espace : connexion fermée", async () => {
    const { context } = await connect(editor);
    await db().collection("member").deleteOne({ userId: editor });
    invalidateOrgCache();
    await expect(recheckConnection(later(context))).rejects.toMatchObject({
      code: 4403,
    });
  });

  it("retiré de la liste du tableau : connexion fermée", async () => {
    const { context } = await connect(editor);
    await Board.updateOne(
      { _id: board._id },
      { $set: { members: [owner.toString()] } },
    );
    await expect(recheckConnection(later(context))).rejects.toMatchObject({
      code: 4403,
    });
  });

  it("plus aucune session valide : connexion fermée", async () => {
    const { context } = await connect(editor);
    await db().collection("session").deleteMany({ userId: editor });
    await expect(recheckConnection(later(context))).rejects.toMatchObject({
      code: 4403,
    });
  });

  it("rétrogradé en lecture seule : connexion en lecture seule", async () => {
    const { context } = await connect(editor);
    await db()
      .collection("member")
      .updateOne({ userId: editor }, { $set: { role: "viewer" } });
    invalidateOrgCache();
    const payload = later(context);
    await recheckConnection(payload);
    expect(payload.connection.readOnly).toBe(true);
  });

  it("abonnement devenu inactif : connexion en lecture seule", async () => {
    const { context } = await connect(editor);
    await db()
      .collection("subscription")
      .updateOne(
        { referenceId: org.toString() },
        { $set: { status: "unpaid" } },
      );
    invalidateSubCache(org.toString());
    const payload = later(context);
    await recheckConnection(payload);
    expect(payload.connection.readOnly).toBe(true);
  });

  it("relu au plus toutes les 30 s", async () => {
    const { context } = await connect(editor);
    await db().collection("member").deleteOne({ userId: editor });
    invalidateOrgCache();
    await expect(
      recheckConnection({
        connection: {},
        context,
        now: context.checkedAt + 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("connexion interne sans utilisateur : ignorée", async () => {
    await expect(
      recheckConnection({
        connection: {},
        context: { externalDescription: true },
      }),
    ).resolves.toBeUndefined();
  });
});
