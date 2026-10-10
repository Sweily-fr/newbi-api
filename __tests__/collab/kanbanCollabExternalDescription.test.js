import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import crypto from "node:crypto";
import * as Y from "yjs";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// PubSub Redis simulé : messages sérialisés en JSON comme RedisPubSub, remis
// à tous les abonnés de l'instance (ici une seule)
const subscribers = new Map();
let nextSubscriptionId = 1;
let pubsubAvailable = true;
const pubsub = {
  publish: async (channel, payload) => {
    const message = JSON.parse(JSON.stringify(payload));
    for (const { channel: ch, onMessage } of subscribers.values()) {
      if (ch === channel) onMessage(message);
    }
  },
  subscribe: async (channel, onMessage) => {
    const id = nextSubscriptionId++;
    subscribers.set(id, { channel, onMessage });
    return id;
  },
  unsubscribe: (id) => subscribers.delete(id),
};
// Verrou Redis simulé (SET NX PX)
const locks = new Set();
const cacheClient = {
  set: async (key, _value, _px, _ttl, nx) => {
    if (nx === "NX" && locks.has(key)) return null;
    locks.add(key);
    return "OK";
  },
};
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => {
    if (!pubsubAvailable) throw new Error("Redis PubSub non initialisé");
    return pubsub;
  },
  getCacheClient: () => cacheClient,
  redisConfig: { host: "localhost", port: 6379, db: 0 },
}));
// Une seule instance dans le test : pas de synchronisation inter-instances
vi.mock("@hocuspocus/extension-redis", () => ({
  Redis: class {},
}));
vi.mock("../../src/resolvers/kanban.js", () => ({
  publishTaskUpdated: vi.fn(async () => null),
}));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: vi.fn(),
}));
vi.mock("../../src/middlewares/org-resolver.js", () => ({
  getActiveOrganization: vi.fn(),
}));
vi.mock("../../src/services/organizationRoleService.js", () => ({
  getEffectiveLevelsFor: vi.fn(),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { Task } from "../../src/models/kanban.js";
import KanbanCollabDoc from "../../src/models/KanbanCollabDoc.js";
import {
  createKanbanCollabServer,
  destroyKanbanCollabServer,
  handleExternalDescriptionMessage,
  htmlToYdocUpdate,
  replaceDocumentHtml,
  syncExternalDescription,
  ydocToHtml,
} from "../../src/collab/kanbanCollabServer.js";

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const workspaceId = buildOrganizationId();
const userId = buildUserId();

const docFromHtml = (html) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, htmlToYdocUpdate(html));
  return doc;
};

// Éditeur connecté : copie du document serveur qui reçoit ses mises à jour
// (ce que fait le provider Hocuspocus d'un navigateur)
const connectEditor = (serverDocument) => {
  const editor = new Y.Doc();
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(serverDocument));
  serverDocument.on("update", (update) => Y.applyUpdate(editor, update));
  return editor;
};

const makeTask = (description) =>
  Task.create({
    title: "Tâche",
    description,
    status: "todo",
    boardId: buildOrganizationId(),
    columnId: "todo",
    workspaceId,
    userId,
  });

describe("replaceDocumentHtml", () => {
  it("remplace le contenu sans doubler le texte chez un pair", () => {
    const server = docFromHtml("<p>Avant</p><ul><li><p>un</p></li></ul>");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    server.on("update", (update) => Y.applyUpdate(peer, update));

    expect(
      replaceDocumentHtml(server, "<p><strong>Après</strong> mobile</p>"),
    ).toBe(true);

    expect(ydocToHtml(server)).toBe("<p><strong>Après</strong> mobile</p>");
    expect(ydocToHtml(peer)).toBe("<p><strong>Après</strong> mobile</p>");
  });

  it("ne touche pas un document déjà à jour", () => {
    const server = docFromHtml("<p>Identique</p>");
    const updates = [];
    server.on("update", (update) => updates.push(update));
    expect(replaceDocumentHtml(server, "<p>Identique</p>")).toBe(false);
    expect(updates).toHaveLength(0);
  });
});

describe("Description modifiée hors collab (updateTask)", () => {
  let hocuspocus;

  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });
  beforeEach(async () => {
    await clearMongo();
    locks.clear();
    subscribers.clear();
    pubsubAvailable = true;
    hocuspocus = createKanbanCollabServer({ authenticate: async () => ({}) });
    // Laisse l'abonnement au canal se poser
    await new Promise((resolve) => setImmediate(resolve));
  });
  afterEach(async () => {
    pubsubAvailable = true;
    await destroyKanbanCollabServer();
  });

  it("applique la nouvelle description au document ouvert et réaligne l'empreinte", async () => {
    const task = await makeTask("<p>Version bureau</p>");
    const documentName = `kanban-task:${task._id}`;
    // Un éditeur a la tâche ouverte
    const desktop = await hocuspocus.openDirectConnection(documentName, {});
    const editor = connectEditor(desktop.document);
    expect(ydocToHtml(editor)).toBe("<p>Version bureau</p>");

    // L'app mobile enregistre une autre description (updateTask)
    await Task.updateOne(
      { _id: task._id },
      { $set: { description: "<p>Version mobile</p>" } },
    );
    await syncExternalDescription(task._id, "<p>Version mobile</p>");

    await vi.waitFor(async () => {
      const stored = await KanbanCollabDoc.findOne({
        taskId: String(task._id),
      }).lean();
      expect(stored?.htmlHash).toBe(sha1("<p>Version mobile</p>"));
    });
    expect(ydocToHtml(desktop.document)).toBe("<p>Version mobile</p>");
    // L'éditeur connecté reçoit la modification (sans doublon)
    expect(ydocToHtml(editor)).toBe("<p>Version mobile</p>");
    const fresh = await Task.findById(task._id).lean();
    expect(fresh.description).toBe("<p>Version mobile</p>");

    await desktop.disconnect();
  });

  it("normalise un texte brut envoyé par le mobile en HTML d'éditeur", async () => {
    const task = await makeTask("<p>Avant</p>");
    const documentName = `kanban-task:${task._id}`;
    const desktop = await hocuspocus.openDirectConnection(documentName, {});

    await Task.updateOne(
      { _id: task._id },
      { $set: { description: "Texte du mobile" } },
    );
    await syncExternalDescription(task._id, "Texte du mobile");

    await vi.waitFor(async () => {
      const fresh = await Task.findById(task._id).lean();
      expect(fresh.description).toBe("<p>Texte du mobile</p>");
    });
    const stored = await KanbanCollabDoc.findOne({
      taskId: String(task._id),
    }).lean();
    expect(stored.htmlHash).toBe(sha1("<p>Texte du mobile</p>"));

    await desktop.disconnect();
  });

  it("ne charge pas un document fermé (reconstruit à la prochaine ouverture)", async () => {
    const task = await makeTask("<p>Avant</p>");
    await Task.updateOne(
      { _id: task._id },
      { $set: { description: "<p>Après</p>" } },
    );

    const status = await handleExternalDescriptionMessage({
      id: "m-1",
      taskId: String(task._id),
      html: "<p>Après</p>",
    });

    expect(status).toBe("not-loaded");
    expect(hocuspocus.documents.has(`kanban-task:${task._id}`)).toBe(false);
    expect(await KanbanCollabDoc.countDocuments()).toBe(0);
  });

  it("n'applique un même message qu'une fois (instances concurrentes)", async () => {
    const task = await makeTask("<p>Avant</p>");
    const desktop = await hocuspocus.openDirectConnection(
      `kanban-task:${task._id}`,
      {},
    );
    const message = {
      id: "m-2",
      taskId: String(task._id),
      html: "<p>Après</p>",
    };

    const first = await handleExternalDescriptionMessage(message);
    const second = await handleExternalDescriptionMessage(message);

    expect(first).toBe("applied");
    expect(second).toBe("locked");
    expect(ydocToHtml(desktop.document)).toBe("<p>Après</p>");
    await desktop.disconnect();
  });

  it("applique localement quand le PubSub est indisponible", async () => {
    const task = await makeTask("<p>Avant</p>");
    const desktop = await hocuspocus.openDirectConnection(
      `kanban-task:${task._id}`,
      {},
    );
    pubsubAvailable = false;

    await syncExternalDescription(task._id, "<p>Sans Redis</p>");

    expect(ydocToHtml(desktop.document)).toBe("<p>Sans Redis</p>");
    await desktop.disconnect();
  });
});
