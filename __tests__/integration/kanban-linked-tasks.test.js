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

// Redis : on capture les publications pour vérifier que les DEUX tâches
// (et donc les deux tableaux) reçoivent leur événement temps réel.
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
  sendTaskAssignmentEmail: vi.fn(),
  sendMentionEmail: vi.fn(),
}));
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(),
}));

import { Board, Column, Task } from "../../src/models/kanban.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";

const { Mutation, Query, Task: TaskFields } = kanbanResolvers;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
let ctx;

const makeBoard = async (title, ws = organizationId) =>
  Board.create({ title, workspaceId: ws, userId });
const makeColumn = async (board, title) =>
  Column.create({
    title,
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: board.workspaceId,
    userId,
  });
const makeTask = async (board, column, title) =>
  Task.create({
    title,
    status: column._id.toString(),
    boardId: board._id,
    columnId: column._id.toString(),
    workspaceId: board.workspaceId,
    userId,
  });

const resolveLinked = (task) => TaskFields.linkedTasks(task, {}, {});

beforeAll(async () => {
  await startMongo();
  await mongoose.connection.db.collection("user").insertOne({
    _id: userId,
    email: "alice@test.fr",
    name: "Alice",
  });
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  published.length = 0;
  await mongoose.connection.db.collection("user").insertOne({
    _id: userId,
    email: "alice@test.fr",
    name: "Alice",
  });
  await seedOrgMembership({ userId, organizationId });
  ctx = buildContext({ userId, organizationId });
});

describe("Mutation.linkTask / unlinkTask", () => {
  it("lie deux tâches de tableaux différents, expose les infos et diffuse sur les deux tableaux", async () => {
    const board1 = await makeBoard("Tableau 1");
    const board2 = await makeBoard("Tableau 2");
    const col1 = await makeColumn(board1, "À faire");
    const col2 = await makeColumn(board2, "En cours");
    const a = await makeTask(board1, col1, "Tâche A");
    const b = await makeTask(board2, col2, "Tâche B");

    const result = await Mutation.linkTask(
      null,
      { taskId: a._id.toString(), linkedTaskId: b._id.toString() },
      ctx,
    );

    const linkedOfA = await resolveLinked(result);
    expect(linkedOfA).toEqual([
      expect.objectContaining({
        id: b._id.toString(),
        title: "Tâche B",
        boardId: board2._id.toString(),
        boardTitle: "Tableau 2",
        columnTitle: "En cours",
      }),
    ]);

    // Côté B : lien posé aussi
    const freshB = await Task.findById(b._id);
    const linkedOfB = await resolveLinked(freshB);
    expect(linkedOfB.map((t) => t.id)).toEqual([a._id.toString()]);

    // Activité journalisée avec le nom de l'auteur, sur les deux tâches
    expect(result.activity.at(-1)).toMatchObject({
      type: "updated",
      field: "linkedTasks",
      userName: "Alice",
      description: "a lié la tâche « Tâche B »",
    });
    expect(freshB.activity.at(-1).description).toBe(
      "a lié la tâche « Tâche A »",
    );

    // Un événement UPDATED par tableau (canal = workspace + board)
    const channels = published.map((p) => p.channel).sort();
    expect(channels).toEqual(
      [
        `TASK_UPDATED_${organizationId}_${board1._id}`,
        `TASK_UPDATED_${organizationId}_${board2._id}`,
      ].sort(),
    );
    expect(published.every((p) => p.payload.type === "UPDATED")).toBe(true);
  });

  it("délie des deux côtés depuis n'importe quel côté", async () => {
    const board = await makeBoard("Projet");
    const col = await makeColumn(board, "À faire");
    const a = await makeTask(board, col, "A");
    const b = await makeTask(board, col, "B");
    await Mutation.linkTask(
      null,
      { taskId: a._id.toString(), linkedTaskId: b._id.toString() },
      ctx,
    );
    published.length = 0;

    const result = await Mutation.unlinkTask(
      null,
      { taskId: b._id.toString(), linkedTaskId: a._id.toString() },
      ctx,
    );

    expect(await resolveLinked(result)).toEqual([]);
    expect(await resolveLinked(await Task.findById(a._id))).toEqual([]);
    expect(published).toHaveLength(2);
  });

  it("refuse de lier une tâche d'une autre organisation", async () => {
    const board = await makeBoard("Projet");
    const foreignBoard = await makeBoard("Ailleurs", otherOrganizationId);
    const col = await makeColumn(board, "À faire");
    const foreignCol = await makeColumn(foreignBoard, "À faire");
    const a = await makeTask(board, col, "A");
    const foreign = await makeTask(foreignBoard, foreignCol, "Étrangère");

    await expect(
      Mutation.linkTask(
        null,
        { taskId: a._id.toString(), linkedTaskId: foreign._id.toString() },
        ctx,
      ),
    ).rejects.toThrow("Tâche liée introuvable");
    expect(published).toHaveLength(0);
  });
});

describe("Mutation.createTask avec linkedTaskIds", () => {
  it("pose les liens des deux côtés dès la création", async () => {
    const board = await makeBoard("Projet");
    const col = await makeColumn(board, "À faire");
    const existing = await makeTask(board, col, "Existante");

    const created = await Mutation.createTask(
      null,
      {
        input: {
          title: "Nouvelle",
          boardId: board._id.toString(),
          columnId: col._id.toString(),
          linkedTaskIds: [existing._id.toString(), "pas-un-id"],
        },
      },
      ctx,
    );

    expect((await resolveLinked(created)).map((t) => t.title)).toEqual([
      "Existante",
    ]);
    const freshExisting = await Task.findById(existing._id);
    expect(freshExisting.linkedTasks.map(String)).toEqual([
      created._id.toString(),
    ]);
    // Le champ d'entrée n'est pas persisté tel quel
    expect((await Task.findById(created._id).lean()).linkedTaskIds).toBe(
      undefined,
    );
  });
});

describe("Mutation.deleteTask", () => {
  it("retire la tâche supprimée des liens des autres et diffuse leur mise à jour", async () => {
    const board1 = await makeBoard("Tableau 1");
    const board2 = await makeBoard("Tableau 2");
    const col1 = await makeColumn(board1, "À faire");
    const col2 = await makeColumn(board2, "À faire");
    const a = await makeTask(board1, col1, "A");
    const b = await makeTask(board2, col2, "B");
    await Mutation.linkTask(
      null,
      { taskId: a._id.toString(), linkedTaskId: b._id.toString() },
      ctx,
    );
    published.length = 0;

    const deleted = await Mutation.deleteTask(
      null,
      { id: a._id.toString() },
      ctx,
    );

    expect(deleted).toBe(true);
    expect((await Task.findById(b._id)).linkedTasks).toHaveLength(0);
    const byType = published.map((p) => [p.payload.type, p.channel]);
    expect(byType).toContainEqual([
      "UPDATED",
      `TASK_UPDATED_${organizationId}_${board2._id}`,
    ]);
    expect(byType).toContainEqual([
      "DELETED",
      `TASK_UPDATED_${organizationId}_${board1._id}`,
    ]);
  });
});

describe("Query.searchTasks", () => {
  it("cherche dans tout le workspace, jamais dans une autre organisation", async () => {
    const board = await makeBoard("Projet");
    const foreignBoard = await makeBoard("Ailleurs", otherOrganizationId);
    const col = await makeColumn(board, "À faire");
    const foreignCol = await makeColumn(foreignBoard, "À faire");
    const self = await makeTask(board, col, "Facture client");
    await makeTask(board, col, "Facture fournisseur");
    await makeTask(foreignBoard, foreignCol, "Facture étrangère");

    const found = await Query.searchTasks(
      null,
      { search: "facture", excludeTaskId: self._id.toString() },
      ctx,
    );

    expect(found.map((t) => t.title)).toEqual(["Facture fournisseur"]);
    expect(found[0]).toMatchObject({
      boardId: board._id.toString(),
      boardTitle: "Projet",
      columnTitle: "À faire",
    });
  });
});
