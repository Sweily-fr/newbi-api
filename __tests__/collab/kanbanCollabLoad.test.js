import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import crypto from "node:crypto";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Redis simulé, partagé par les « instances » du test : verrou SET NX PX et
// libération par script (DEL si même jeton)
const locks = new Map();
let redisAvailable = true;
const cacheClient = {
  set: async (key, value, _px, _ttl, nx) => {
    if (nx === "NX" && locks.has(key)) return null;
    locks.set(key, value);
    return "OK";
  },
  eval: async (_script, _numKeys, key, token) => {
    if (locks.get(key) !== token) return 0;
    locks.delete(key);
    return 1;
  },
};
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    subscribe: async () => 1,
    unsubscribe: () => {},
  }),
  getCacheClient: () => (redisAvailable ? cacheClient : null),
  redisConfig: { host: "localhost", port: 6379, db: 0 },
}));
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
  collabExtensions,
  htmlToYdocUpdate,
  loadDocument,
  storeDocument,
  ydocToHtml,
} from "../../src/collab/kanbanCollabServer.js";
import { generateJSON } from "@tiptap/html";

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const workspaceId = buildOrganizationId();
const userId = buildUserId();

const HTML =
  '<p>Bonjour <strong>équipe</strong>, voir <a href="https://newbi.fr">le site</a></p><ul><li><p>un</p></li><li><p>deux</p></li></ul><pre><code>npm run dev</code></pre>';

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

// Synchronisation de deux instances par l'extension Redis : chacune reçoit
// l'état de l'autre
const syncInstances = (a, b) => {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, fromB);
  Y.applyUpdate(b, fromA);
};

const docFromUpdate = (update) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
};

describe("htmlToYdocUpdate (construction déterministe)", () => {
  it("cause : deux constructions avec un clientID aléatoire doublent le texte à la fusion", () => {
    const build = () =>
      Y.encodeStateAsUpdate(
        TiptapTransformer.toYdoc(
          generateJSON(HTML, collabExtensions),
          "default",
          collabExtensions,
        ),
      );
    const merged = docFromUpdate(build());
    Y.applyUpdate(merged, build());

    const once = ydocToHtml(docFromUpdate(build()));
    expect(ydocToHtml(merged)).toBe(`${once}${once}`);
  });

  it("deux constructions du même HTML donnent les mêmes octets et fusionnent sans doublon", () => {
    const first = htmlToYdocUpdate(HTML);
    const second = htmlToYdocUpdate(HTML);
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);

    const merged = docFromUpdate(first);
    Y.applyUpdate(merged, second);
    expect(ydocToHtml(merged)).toBe(ydocToHtml(docFromUpdate(first)));
  });

  it("reste fidèle au HTML (marques, liens, listes, code)", () => {
    const reference = ydocToHtml(
      TiptapTransformer.toYdoc(
        generateJSON(HTML, collabExtensions),
        "default",
        collabExtensions,
      ),
    );
    expect(ydocToHtml(docFromUpdate(htmlToYdocUpdate(HTML)))).toBe(reference);
    expect(ydocToHtml(docFromUpdate(htmlToYdocUpdate("")))).toBe("");
  });

  it("deux HTML différents ne partagent pas d'identifiants", () => {
    const a = docFromUpdate(htmlToYdocUpdate("<p>Version A</p>"));
    const b = docFromUpdate(htmlToYdocUpdate("<p>Version B</p>"));
    const clientsA = [...Y.decodeStateVector(Y.encodeStateVector(a)).keys()];
    const clientsB = [...Y.decodeStateVector(Y.encodeStateVector(b)).keys()];
    expect(clientsA).toHaveLength(1);
    expect(clientsA[0]).not.toBe(clientsB[0]);
  });
});

describe("loadDocument : deux instances PM2 en même temps", () => {
  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });
  beforeEach(async () => {
    await clearMongo();
    locks.clear();
    redisAvailable = true;
  });

  it("l'une construit, l'autre recharge l'état stocké : la fusion ne double rien", async () => {
    const task = await makeTask(HTML);
    const documentName = `kanban-task:${task._id}`;
    const instanceA = new Y.Doc();
    const instanceB = new Y.Doc();

    await Promise.all([
      loadDocument({ documentName, document: instanceA }),
      loadDocument({ documentName, document: instanceB }),
    ]);
    syncInstances(instanceA, instanceB);

    const expected = ydocToHtml(docFromUpdate(htmlToYdocUpdate(HTML)));
    expect(ydocToHtml(instanceA)).toBe(expected);
    expect(ydocToHtml(instanceB)).toBe(expected);
    // État construit enregistré une fois, avec l'empreinte du HTML lu
    const stored = await KanbanCollabDoc.find({
      taskId: String(task._id),
    }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].htmlHash).toBe(sha1(HTML));
    expect(locks.size).toBe(0);
  });

  it("sans Redis (pas de verrou), deux constructions simultanées ne doublent pas non plus", async () => {
    redisAvailable = false;
    const task = await makeTask(HTML);
    const documentName = `kanban-task:${task._id}`;
    const instanceA = new Y.Doc();
    const instanceB = new Y.Doc();

    await Promise.all([
      loadDocument({ documentName, document: instanceA }),
      loadDocument({ documentName, document: instanceB }),
    ]);
    syncInstances(instanceA, instanceB);

    expect(ydocToHtml(instanceA)).toBe(
      ydocToHtml(docFromUpdate(htmlToYdocUpdate(HTML))),
    );
  });

  it("une modification en cours sur une instance n'est pas doublée par l'ouverture sur une autre", async () => {
    const task = await makeTask("<p>Début</p>");
    const documentName = `kanban-task:${task._id}`;
    const instanceA = new Y.Doc();
    await loadDocument({ documentName, document: instanceA });

    // Frappe sur l'instance A, pas encore enregistrée (debounce)
    instanceA.transact(() => {
      const paragraph = instanceA.getXmlFragment("default").get(0);
      paragraph.get(0).insert(5, " de la description");
    });

    const instanceB = new Y.Doc();
    await loadDocument({ documentName, document: instanceB });
    syncInstances(instanceA, instanceB);

    expect(ydocToHtml(instanceB)).toBe("<p>Début de la description</p>");
    expect(ydocToHtml(instanceA)).toBe("<p>Début de la description</p>");
  });

  it("attend un enregistrement en cours au lieu de lire un état à moitié écrit", async () => {
    const task = await makeTask("<p>Début</p>");
    const documentName = `kanban-task:${task._id}`;
    const instanceA = new Y.Doc();
    await loadDocument({ documentName, document: instanceA });
    instanceA.transact(() => {
      instanceA.getXmlFragment("default").get(0).get(0).insert(5, " modifié");
    });

    // L'instance A enregistre : verrou pris, task.description écrite, puis
    // KanbanCollabDoc. L'instance B ouvre la tâche entre les deux écritures.
    const lockKey = `kanban-collab:document-lock:${task._id}`;
    locks.set(lockKey, "instance-A");
    await Task.updateOne(
      { _id: task._id },
      { $set: { description: "<p>Début modifié</p>" } },
    );
    const instanceB = new Y.Doc();
    const loadingB = loadDocument({ documentName, document: instanceB });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await KanbanCollabDoc.updateOne(
      { taskId: String(task._id) },
      {
        $set: {
          state: Buffer.from(Y.encodeStateAsUpdate(instanceA)),
          htmlHash: sha1("<p>Début modifié</p>"),
        },
      },
    );
    locks.delete(lockKey);
    await loadingB;
    syncInstances(instanceA, instanceB);

    expect(ydocToHtml(instanceB)).toBe("<p>Début modifié</p>");
    expect(ydocToHtml(instanceA)).toBe("<p>Début modifié</p>");
  });

  it("storeDocument enregistre sous le même verrou", async () => {
    const task = await makeTask("<p>Avant</p>");
    const documentName = `kanban-task:${task._id}`;
    const document = new Y.Doc();
    await loadDocument({ documentName, document });
    document.transact(() => {
      document.getXmlFragment("default").get(0).get(0).insert(5, " et après");
    });

    const lockKey = `kanban-collab:document-lock:${task._id}`;
    locks.set(lockKey, "autre-instance");
    const storing = storeDocument({
      documentName,
      document,
      lastContext: { user: { id: String(userId) } },
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await Task.findById(task._id).lean()).description).toBe(
      "<p>Avant</p>",
    );

    locks.delete(lockKey);
    await storing;
    const fresh = await Task.findById(task._id).lean();
    expect(fresh.description).toBe("<p>Avant et après</p>");
    const stored = await KanbanCollabDoc.findOne({
      taskId: String(task._id),
    }).lean();
    expect(stored.htmlHash).toBe(sha1("<p>Avant et après</p>"));
    expect(locks.size).toBe(0);
  });
});
