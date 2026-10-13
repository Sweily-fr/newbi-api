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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

// Publications temps réel capturées (même canal que updateTask)
const published = [];
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async (channel, payload) => {
      published.push({ channel, payload });
    },
    asyncIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(async () => true),
  sendMentionEmail: vi.fn(async () => true),
}));
vi.mock("../../src/resolvers/notification.js", () => ({
  publishNotification: vi.fn(async () => {}),
}));
const sendPushToUser = vi.fn(async () => {});
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: (...a) => sendPushToUser(...a),
}));
vi.mock("../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import { Board, Column, Task } from "../../src/models/kanban.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import { preserveChecklistIds } from "../../src/services/kanbanTaskFieldsService.js";

const { Mutation, ChecklistItem } = kanbanResolvers;

const alice = buildUserId();
const bob = buildUserId();
const carol = buildUserId();
const organizationId = buildOrganizationId();
let aliceCtx;
let bobCtx;
let board;
let column;

const makeTask = (fields = {}) =>
  Task.create({
    title: "Préparer la démo",
    status: column._id.toString(),
    boardId: board._id,
    columnId: column._id.toString(),
    workspaceId: organizationId,
    userId: alice,
    ...fields,
  });

const freshTask = (task) => Task.findById(task._id).lean();
const taskEvents = () =>
  published.filter((p) => p.channel.startsWith("TASK_UPDATED_"));
const pushesTo = (userId) =>
  sendPushToUser.mock.calls.filter(([to]) => to === String(userId));
const newHexId = () => new mongoose.Types.ObjectId().toString();
const tag = (name, bg = "#DBEAFE") => ({
  name,
  className: "",
  bg,
  text: "#1D4ED8",
  border: "#BFDBFE",
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  published.length = 0;
  sendPushToUser.mockClear();
  await mongoose.connection.db.collection("user").insertMany([
    { _id: alice, email: "alice@test.fr", name: "Alice" },
    { _id: bob, email: "bob@test.fr", name: "Bob" },
    { _id: carol, email: "carol@test.fr", name: "Carol" },
  ]);
  await seedOrgMembership({ userId: alice, organizationId });
  await seedOrgMembership({ userId: bob, organizationId, role: "member" });
  // Seuls les membres de l'espace peuvent être assignés
  await seedOrgMembership({ userId: carol, organizationId, role: "member" });
  aliceCtx = buildContext({ userId: alice, organizationId });
  bobCtx = buildContext({ userId: bob, organizationId });
  board = await Board.create({
    title: "Projet",
    workspaceId: organizationId,
    userId: alice,
  });
  column = await Column.create({
    title: "À faire",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: organizationId,
    userId: alice,
  });
});

describe("Membres assignés", () => {
  it("deux assignations simultanées sont toutes les deux conservées", async () => {
    const task = await makeTask();
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.assignTaskMember(
        null,
        { taskId, memberId: bob.toString() },
        aliceCtx,
      ),
      Mutation.assignTaskMember(
        null,
        { taskId, memberId: carol.toString() },
        bobCtx,
      ),
    ]);

    const fresh = await freshTask(task);
    expect([...fresh.assignedMembers].sort()).toEqual(
      [bob.toString(), carol.toString()].sort(),
    );
    const assigned = fresh.activity.filter((a) => a.type === "assigned");
    expect(assigned).toHaveLength(2);
    expect(assigned.map((a) => a.description)).toEqual([
      "assigné 1 membre",
      "assigné 1 membre",
    ]);
    expect(taskEvents()).toHaveLength(2);
    expect(taskEvents()[0].channel).toBe(
      `TASK_UPDATED_${organizationId}_${board._id}`,
    );
    expect(taskEvents()[0].payload.type).toBe("UPDATED");
  });

  it("un retrait n'efface pas une assignation faite en même temps", async () => {
    const task = await makeTask({ assignedMembers: [bob.toString()] });
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.unassignTaskMember(
        null,
        { taskId, memberId: bob.toString() },
        aliceCtx,
      ),
      Mutation.assignTaskMember(
        null,
        { taskId, memberId: carol.toString() },
        bobCtx,
      ),
    ]);

    const fresh = await freshTask(task);
    expect(fresh.assignedMembers).toEqual([carol.toString()]);
    const unassigned = fresh.activity.find((a) => a.type === "unassigned");
    expect(unassigned.oldValue).toEqual([bob.toString()]);
    expect(unassigned.description).toBe("désassigné 1 membre");
  });

  it("notifie le membre assigné, pas l'auteur qui s'assigne lui-même", async () => {
    const task = await makeTask();
    const taskId = task._id.toString();

    await Mutation.assignTaskMember(
      null,
      { taskId, memberId: bob.toString() },
      aliceCtx,
    );
    await Mutation.assignTaskMember(
      null,
      { taskId, memberId: alice.toString() },
      aliceCtx,
    );

    await vi.waitFor(() => expect(pushesTo(bob)).toHaveLength(1));
    const [, payload] = pushesTo(bob)[0];
    expect(payload.title).toBe("Nouvelle tâche assignée");
    expect(payload.body).toBe("Alice vous a assigné à « Préparer la démo »");
    expect(payload.data).toMatchObject({
      boardId: board._id.toString(),
      taskId,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushesTo(alice)).toHaveLength(0);
  });

  it("est idempotente : ni activité ni diffusion quand rien ne change", async () => {
    const task = await makeTask({ assignedMembers: [bob.toString()] });
    const taskId = task._id.toString();

    const result = await Mutation.assignTaskMember(
      null,
      { taskId, memberId: bob.toString() },
      aliceCtx,
    );
    await Mutation.unassignTaskMember(
      null,
      { taskId, memberId: carol.toString() },
      aliceCtx,
    );

    expect(result.assignedMembers).toEqual([bob.toString()]);
    const fresh = await freshTask(task);
    expect(fresh.activity).toHaveLength(0);
    expect(taskEvents()).toHaveLength(0);
  });

  it("refuse un rôle sans droit d'écriture sur le kanban", async () => {
    const viewer = buildUserId();
    await seedOrgMembership({ userId: viewer, organizationId, role: "viewer" });
    const task = await makeTask();

    await expect(
      Mutation.assignTaskMember(
        null,
        { taskId: task._id.toString(), memberId: bob.toString() },
        buildContext({ userId: viewer, organizationId }),
      ),
    ).rejects.toThrow();
    expect((await freshTask(task)).assignedMembers).toEqual([]);
  });

  it("refuse une tâche d'un autre espace", async () => {
    const other = await Task.create({
      title: "Ailleurs",
      status: "todo",
      boardId: new mongoose.Types.ObjectId(),
      columnId: "todo",
      workspaceId: buildOrganizationId(),
      userId: alice,
    });

    await expect(
      Mutation.assignTaskMember(
        null,
        { taskId: other._id.toString(), memberId: bob.toString() },
        aliceCtx,
      ),
    ).rejects.toThrow("Task not found");
    expect((await freshTask(other)).assignedMembers).toEqual([]);
  });
});

describe("Tags", () => {
  it("deux ajouts simultanés sont conservés, sans doublon de casse", async () => {
    const task = await makeTask({ tags: [tag("Design")] });
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.addTaskTag(null, { taskId, tag: tag("Urgent") }, aliceCtx),
      Mutation.addTaskTag(null, { taskId, tag: tag("Client") }, bobCtx),
      Mutation.addTaskTag(null, { taskId, tag: tag("design") }, bobCtx),
    ]);

    const fresh = await freshTask(task);
    expect(fresh.tags.map((t) => t.name).sort()).toEqual([
      "Client",
      "Design",
      "Urgent",
    ]);
    const tagActivities = fresh.activity.filter((a) => a.field === "tags");
    expect(tagActivities).toHaveLength(2);
    const urgent = tagActivities.find((a) => a.description.includes("Urgent"));
    expect(urgent.description).toBe("a ajouté le tag : Urgent");
    expect(urgent.newValue).toEqual([
      { name: "Urgent", bg: "#DBEAFE", text: "#1D4ED8", border: "#BFDBFE" },
    ]);
  });

  it("retire un tag sans tenir compte de la casse, même pendant un ajout", async () => {
    const task = await makeTask({ tags: [tag("Urgent", "#FEE2E2")] });
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.removeTaskTag(null, { taskId, tagName: "urgent" }, aliceCtx),
      Mutation.addTaskTag(null, { taskId, tag: tag("Client") }, bobCtx),
    ]);

    const fresh = await freshTask(task);
    expect(fresh.tags.map((t) => t.name)).toEqual(["Client"]);
    const removed = fresh.activity.find((a) =>
      a.description.startsWith("a supprimé le tag"),
    );
    expect(removed.description).toBe("a supprimé le tag : Urgent");
    expect(removed.oldValue[0].bg).toBe("#FEE2E2");
  });

  it("échappe les caractères spéciaux du nom", async () => {
    const task = await makeTask({ tags: [tag("C++")] });
    const taskId = task._id.toString();

    await Mutation.addTaskTag(null, { taskId, tag: tag("C+") }, aliceCtx);
    await Mutation.addTaskTag(null, { taskId, tag: tag("c++") }, aliceCtx);

    const fresh = await freshTask(task);
    expect(fresh.tags.map((t) => t.name)).toEqual(["C++", "C+"]);
  });
});

describe("Checklist", () => {
  it("ajoute avec l'id du client, sans doublon si la requête est rejouée", async () => {
    const task = await makeTask();
    const taskId = task._id.toString();
    const itemId = newHexId();

    const first = await Mutation.addChecklistItem(
      null,
      { taskId, text: " Relire le devis ", itemId },
      aliceCtx,
    );
    await Mutation.addChecklistItem(
      null,
      { taskId, text: "Relire le devis", itemId },
      aliceCtx,
    );

    expect(first.checklist.map((i) => ChecklistItem.id(i))).toEqual([itemId]);
    const fresh = await freshTask(task);
    expect(fresh.checklist).toHaveLength(1);
    expect(fresh.checklist[0]).toMatchObject({
      text: "Relire le devis",
      completed: false,
    });
    expect(String(fresh.checklist[0]._id)).toBe(itemId);
    expect(
      fresh.activity
        .filter((a) => a.field === "checklist")
        .map((a) => a.description),
    ).toEqual(["a ajouté l'élément : Relire le devis"]);
  });

  it("deux personnes qui modifient deux éléments en même temps ne s'écrasent pas", async () => {
    const task = await makeTask({
      checklist: [{ text: "Maquette" }, { text: "Recette" }],
    });
    const [maquette, recette] = task.checklist.map((i) => i._id.toString());
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.updateChecklistItem(
        null,
        { taskId, itemId: maquette, completed: true },
        aliceCtx,
      ),
      Mutation.updateChecklistItem(
        null,
        { taskId, itemId: recette, text: "Recette client" },
        bobCtx,
      ),
      Mutation.addChecklistItem(
        null,
        { taskId, text: "Livraison", itemId: newHexId() },
        bobCtx,
      ),
    ]);

    const fresh = await freshTask(task);
    expect(
      fresh.checklist.map((i) => [String(i._id), i.text, i.completed]),
    ).toEqual([
      [maquette, "Maquette", true],
      [recette, "Recette client", false],
      [expect.any(String), "Livraison", false],
    ]);
    const descriptions = fresh.activity.map((a) => a.description);
    expect(descriptions).toContain("a coché l'élément : Maquette");
    expect(descriptions).toContain(
      "a ajouté l'élément : Recette client et a supprimé l'élément : Recette",
    );
  });

  it("ne trace qu'une fois un élément coché deux fois", async () => {
    const task = await makeTask({ checklist: [{ text: "Maquette" }] });
    const itemId = task.checklist[0]._id.toString();
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.updateChecklistItem(
        null,
        { taskId, itemId, completed: true },
        aliceCtx,
      ),
      Mutation.updateChecklistItem(
        null,
        { taskId, itemId, completed: true },
        bobCtx,
      ),
    ]);
    await Mutation.updateChecklistItem(
      null,
      { taskId, itemId, completed: false },
      aliceCtx,
    );

    const fresh = await freshTask(task);
    expect(fresh.checklist[0].completed).toBe(false);
    expect(fresh.activity.map((a) => a.description)).toEqual([
      "a coché l'élément : Maquette",
      "a décoché l'élément : Maquette",
    ]);
  });

  it("supprime un élément ; un élément déjà supprimé renvoie la tâche sans erreur", async () => {
    const task = await makeTask({
      checklist: [{ text: "Maquette" }, { text: "Recette" }],
    });
    const itemId = task.checklist[0]._id.toString();
    const taskId = task._id.toString();

    await Mutation.removeChecklistItem(null, { taskId, itemId }, aliceCtx);
    const again = await Mutation.removeChecklistItem(
      null,
      { taskId, itemId },
      bobCtx,
    );
    const update = await Mutation.updateChecklistItem(
      null,
      { taskId, itemId, completed: true },
      bobCtx,
    );

    expect(again.checklist.map((i) => i.text)).toEqual(["Recette"]);
    expect(update.checklist.map((i) => i.text)).toEqual(["Recette"]);
    const fresh = await freshTask(task);
    expect(fresh.activity.map((a) => a.description)).toEqual([
      "a supprimé l'élément : Maquette",
    ]);
    expect(taskEvents()).toHaveLength(1);
  });

  it("refuse un identifiant ou un texte invalide", async () => {
    const task = await makeTask({ checklist: [{ text: "Maquette" }] });
    const taskId = task._id.toString();

    await expect(
      Mutation.updateChecklistItem(
        null,
        { taskId, itemId: "temp-123", completed: true },
        aliceCtx,
      ),
    ).rejects.toThrow("Identifiant d'élément de checklist invalide");
    await expect(
      Mutation.addChecklistItem(null, { taskId, text: "   " }, aliceCtx),
    ).rejects.toThrow("Le texte de l'élément est requis");
  });
});

describe("updateTask (apps en store) : compatibilité", () => {
  it("garde les ids de checklist envoyés, ou retrouvés par le texte", async () => {
    const task = await makeTask({
      checklist: [{ text: "Maquette" }, { text: "Recette" }],
    });
    const [maquette, recette] = task.checklist.map((i) => i._id.toString());

    const result = await Mutation.updateTask(
      null,
      {
        input: {
          id: task._id.toString(),
          checklist: [
            { id: maquette, text: "Maquette", completed: true },
            // ancien client : pas d'id, même texte
            { text: "Recette", completed: false },
            { id: "temp-42", text: "Nouvelle", completed: false },
            { id: "6b0c7e44-1a1b-4c1e-9b0a-1234567890ab", text: "Uuid" },
          ],
        },
      },
      aliceCtx,
    );

    const ids = result.checklist.map((i) => ChecklistItem.id(i));
    expect(ids[0]).toBe(maquette);
    expect(ids[1]).toBe(recette);
    expect(ids[2]).toMatch(/^[0-9a-f]{24}$/);
    expect(ids[3]).toMatch(/^[0-9a-f]{24}$/);
    const fresh = await freshTask(task);
    expect(fresh.checklist.map((i) => [i.text, i.completed])).toEqual([
      ["Maquette", true],
      ["Recette", false],
      ["Nouvelle", false],
      ["Uuid", false],
    ]);
    expect(
      fresh.activity.find((a) => a.field === "checklist").description,
    ).toBe(
      "a ajouté les éléments : Nouvelle ;; Uuid et a coché l'élément : Maquette",
    );
  });

  it("un id d'une autre tâche n'est pas repris", async () => {
    const other = await makeTask({ checklist: [{ text: "Ailleurs" }] });
    const task = await makeTask();

    const result = await Mutation.updateTask(
      null,
      {
        input: {
          id: task._id.toString(),
          checklist: [{ id: other.checklist[0]._id.toString(), text: "Copie" }],
        },
      },
      aliceCtx,
    );

    expect(ChecklistItem.id(result.checklist[0])).not.toBe(
      other.checklist[0]._id.toString(),
    );
  });

  it("tableaux complets toujours acceptés (tags, membres) et activité ajoutée sans écraser", async () => {
    const task = await makeTask({
      tags: [tag("Design")],
      assignedMembers: [bob.toString()],
    });
    const taskId = task._id.toString();

    await Promise.all([
      Mutation.updateTask(
        null,
        {
          input: {
            id: taskId,
            title: "Préparer la démo client",
            tags: [tag("Design"), tag("Urgent")],
            assignedMembers: [bob.toString(), carol.toString()],
          },
        },
        aliceCtx,
      ),
      Mutation.addChecklistItem(
        null,
        { taskId, text: "Relire", itemId: newHexId() },
        bobCtx,
      ),
    ]);

    const fresh = await freshTask(task);
    expect(fresh.title).toBe("Préparer la démo client");
    expect(fresh.tags.map((t) => t.name)).toEqual(["Design", "Urgent"]);
    expect([...fresh.assignedMembers].sort()).toEqual(
      [bob.toString(), carol.toString()].sort(),
    );
    expect(fresh.checklist.map((i) => i.text)).toEqual(["Relire"]);
    const descriptions = fresh.activity.map((a) => a.description);
    expect(descriptions).toEqual(
      expect.arrayContaining([
        "assigné 1 membre",
        "a modifié le titre",
        "a ajouté le tag : Urgent",
        "a ajouté l'élément : Relire",
      ]),
    );
    await vi.waitFor(() => expect(pushesTo(carol)).toHaveLength(1));
  });
});

describe("ChecklistItem.id", () => {
  it("expose l'_id des tâches lues en lean() ou depuis le cache Redis", () => {
    const id = new mongoose.Types.ObjectId();
    expect(ChecklistItem.id({ _id: id, text: "a" })).toBe(id.toString());
    expect(ChecklistItem.id({ _id: id.toString(), text: "a" })).toBe(
      id.toString(),
    );
    expect(ChecklistItem.id({ text: "sans id" })).toBeNull();
  });
});

describe("preserveChecklistIds", () => {
  it("ne reprend qu'une fois un même élément existant", () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const result = preserveChecklistIds(
      [
        { text: "x" },
        { id: a.toString(), text: "x" },
        { text: "x" },
        { text: "x" },
      ],
      [
        { _id: a, text: "x" },
        { _id: b, text: "x" },
      ],
    );
    expect(result.map((i) => (i._id ? String(i._id) : null))).toEqual([
      b.toString(),
      a.toString(),
      null,
      null,
    ]);
  });
});
