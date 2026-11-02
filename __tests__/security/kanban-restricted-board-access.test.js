/**
 * Kanban : tableau réservé à une liste de membres (board.members).
 *
 * Seules les requêtes boards et board appliquaient la liste : colonnes,
 * tâches, recherche, modifications, commentaires, minuteurs, images, liens
 * publics, visiteurs invités, modèles et souscriptions ne regardaient que
 * l'espace. Un membre absent de la liste reçoit désormais « Board not found »
 * partout ; le propriétaire, un membre listé et l'administrateur gardent
 * l'accès.
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

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
});
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterator: () => ({}),
    asyncIterableIterator: () => ({
      next: async () => ({ done: true }),
      return: async () => ({ done: true }),
    }),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(async () => true),
  sendMentionEmail: vi.fn(async () => true),
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
}));
vi.mock("../../src/resolvers/notification.js", () => ({
  publishNotification: vi.fn(async () => {}),
}));
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(async () => {}),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn(async () => true),
    uploadImage: vi.fn(async () => ({})),
  },
}));
vi.mock("../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";
import userInvitedResolvers from "../../src/resolvers/userInvited.js";
import kanbanTemplateResolvers from "../../src/resolvers/kanbanTemplate.js";
import taskImageResolvers from "../../src/resolvers/taskImage.js";

const { Query, Mutation, Subscription, Task: TaskType } = kanbanResolvers;

const owner = buildUserId();
const listed = buildUserId();
const outsider = buildUserId(); // Éditeur absent de la liste
const admin = buildUserId();
const org = buildOrganizationId();
const ctxOf = (userId) => buildContext({ userId, organizationId: org });

let board;
let todo;
let doing;
let secretTask;
let openBoard;
let openTask;

const NOT_FOUND = "Board not found";

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
    { _id: owner, email: "owner@a.fr", name: "Owner" },
    { _id: listed, email: "listed@a.fr", name: "Listed" },
    { _id: outsider, email: "outsider@a.fr", name: "Outsider" },
    { _id: admin, email: "admin@a.fr", name: "Admin" },
  ]);
  await seedOrgMembership({ userId: owner, organizationId: org });
  await seedOrgMembership({
    userId: listed,
    organizationId: org,
    role: "member",
  });
  await seedOrgMembership({
    userId: outsider,
    organizationId: org,
    role: "member",
  });
  await seedOrgMembership({
    userId: admin,
    organizationId: org,
    role: "admin",
  });

  board = await Board.create({
    title: "Projet RH confidentiel",
    workspaceId: org,
    userId: owner.toString(),
    members: [listed.toString()],
  });
  todo = await Column.create({
    title: "À faire",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: org,
    userId: owner,
  });
  doing = await Column.create({
    title: "En cours",
    color: "#111",
    boardId: board._id,
    order: 1,
    workspaceId: org,
    userId: owner,
  });
  secretTask = await Task.create({
    title: "Salaire 48 000",
    description: "Ne pas diffuser",
    status: todo._id.toString(),
    boardId: board._id,
    columnId: todo._id.toString(),
    workspaceId: org,
    userId: owner,
  });
  openBoard = await Board.create({
    title: "Ouvert",
    workspaceId: org,
    userId: owner.toString(),
  });
  const openColumn = await Column.create({
    title: "À faire",
    color: "#000",
    boardId: openBoard._id,
    order: 0,
    workspaceId: org,
    userId: owner,
  });
  openTask = await Task.create({
    title: "Tâche ouverte",
    status: openColumn._id.toString(),
    boardId: openBoard._id,
    columnId: openColumn._id.toString(),
    workspaceId: org,
    userId: owner,
    linkedTasks: [],
  });
});

const id = (doc) => doc._id.toString();

describe("Membre absent de la liste : lectures refusées", () => {
  const reads = () => [
    [
      "columns",
      () => Query.columns(null, { boardId: id(board) }, ctxOf(outsider)),
    ],
    ["column", () => Query.column(null, { id: id(todo) }, ctxOf(outsider))],
    ["tasks", () => Query.tasks(null, { boardId: id(board) }, ctxOf(outsider))],
    ["task", () => Query.task(null, { id: id(secretTask) }, ctxOf(outsider))],
    [
      "taskPresence",
      () => Query.taskPresence(null, { boardId: id(board) }, ctxOf(outsider)),
    ],
    [
      "getPublicShares",
      () =>
        publicBoardShareResolvers.Query.getPublicShares(
          null,
          { boardId: id(board) },
          ctxOf(outsider),
        ),
    ],
    [
      "getInvitedUsersForBoard",
      () =>
        userInvitedResolvers.Query.getInvitedUsersForBoard(
          null,
          { boardId: id(board) },
          ctxOf(outsider),
        ),
    ],
  ];

  it.each([0, 1, 2, 3, 4, 5, 6])("lecture n° %s refusée", async (index) => {
    const [, call] = reads()[index];
    await expect(call()).rejects.toThrow(NOT_FOUND);
  });

  it("searchTasks ne renvoie aucune tâche du tableau", async () => {
    const byBoard = await Query.searchTasks(
      null,
      { boardId: id(board) },
      ctxOf(outsider),
    );
    expect(byBoard).toEqual([]);
    const bySearch = await Query.searchTasks(
      null,
      { search: "Salaire" },
      ctxOf(outsider),
    );
    expect(bySearch).toEqual([]);
    const all = await Query.searchTasks(null, { search: "e" }, ctxOf(outsider));
    expect(all.map((t) => t.title)).toContain("Tâche ouverte");
    expect(all.map((t) => t.title)).not.toContain("Salaire 48 000");
  });

  it("une tâche liée sur le tableau restreint n'est pas résumée", async () => {
    const infos = await TaskType.linkedTasks(
      { linkedTasks: [secretTask._id], workspaceId: org },
      {},
      ctxOf(outsider),
    );
    expect(infos).toEqual([]);
    const forListed = await TaskType.linkedTasks(
      { linkedTasks: [secretTask._id], workspaceId: org },
      {},
      ctxOf(listed),
    );
    expect(forListed.map((t) => t.title)).toEqual(["Salaire 48 000"]);
  });

  it("souscriptions au tableau refusées", async () => {
    for (const name of ["taskUpdated", "columnUpdated", "taskPresence"]) {
      await expect(
        Subscription[name].subscribe(
          null,
          { boardId: id(board), workspaceId: org.toString() },
          ctxOf(outsider),
        ),
      ).rejects.toThrow(NOT_FOUND);
    }
  });

  it("boardUpdated ne transmet pas le tableau restreint", async () => {
    const payload = {
      type: "UPDATED",
      board: board.toObject(),
      workspaceId: org.toString(),
    };
    const args = { workspaceId: org.toString() };
    expect(
      await Subscription.boardUpdated.resolve(payload, args, ctxOf(outsider)),
    ).toBeNull();
    expect(
      await Subscription.boardUpdated.resolve(payload, args, ctxOf(listed)),
    ).toBe(payload);
    expect(
      await Subscription.boardUpdated.resolve(payload, args, ctxOf(admin)),
    ).toBe(payload);
  });
});

describe("Membre absent de la liste : écritures refusées, base inchangée", () => {
  const writes = () => [
    () =>
      Mutation.updateTask(
        null,
        { input: { id: id(secretTask), title: "Modifiée" } },
        ctxOf(outsider),
      ),
    () =>
      Mutation.moveTask(
        null,
        { id: id(secretTask), columnId: id(doing), position: 0 },
        ctxOf(outsider),
      ),
    () =>
      Mutation.addComment(
        null,
        { taskId: id(secretTask), input: { content: "Hors liste" } },
        ctxOf(outsider),
      ),
    () =>
      Mutation.createTask(
        null,
        {
          input: {
            title: "Ajoutée",
            boardId: id(board),
            columnId: id(todo),
            status: id(todo),
          },
        },
        ctxOf(outsider),
      ),
    () =>
      Mutation.createColumn(
        null,
        {
          input: {
            title: "Intruse",
            color: "#f00",
            boardId: id(board),
            order: 5,
          },
        },
        ctxOf(outsider),
      ),
    () =>
      Mutation.updateBoard(
        null,
        { input: { id: id(board), members: [outsider.toString()] } },
        ctxOf(outsider),
      ),
    () => Mutation.deleteTask(null, { id: id(secretTask) }, ctxOf(outsider)),
    () =>
      Mutation.startTimer(null, { taskId: id(secretTask) }, ctxOf(outsider)),
    () =>
      Mutation.linkTask(
        null,
        { taskId: id(openTask), linkedTaskId: id(secretTask) },
        ctxOf(outsider),
      ),
    () =>
      publicBoardShareResolvers.Mutation.createPublicShare(
        null,
        { input: { boardId: id(board), name: "Lien" } },
        ctxOf(outsider),
      ),
    () =>
      kanbanTemplateResolvers.Mutation.saveBoardAsTemplate(
        null,
        { input: { boardId: id(board), name: "Copie" } },
        ctxOf(outsider),
      ),
    () =>
      taskImageResolvers.Mutation.deleteTaskImage(
        null,
        {
          taskId: id(secretTask),
          imageId: new mongoose.Types.ObjectId().toString(),
        },
        ctxOf(outsider),
      ),
  ];

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    "écriture n° %s refusée",
    async (index) => {
      const before = JSON.stringify(
        await Task.find({}).sort({ _id: 1 }).lean(),
      );
      const boardBefore = JSON.stringify(
        await Board.findById(board._id).lean(),
      );
      await expect(writes()[index]()).rejects.toThrow(NOT_FOUND);
      expect(JSON.stringify(await Task.find({}).sort({ _id: 1 }).lean())).toBe(
        before,
      );
      expect(JSON.stringify(await Board.findById(board._id).lean())).toBe(
        boardBefore,
      );
      expect(await Column.countDocuments({ boardId: board._id })).toBe(2);
      expect(await PublicBoardShare.countDocuments({})).toBe(0);
    },
  );
});

describe("Accès gardé pour le propriétaire, le membre listé et l'administrateur", () => {
  it.each([
    ["propriétaire", () => owner],
    ["membre listé", () => listed],
    ["administrateur", () => admin],
  ])("%s lit les tâches et en modifie une", async (_label, who) => {
    const tasks = await Query.tasks(null, { boardId: id(board) }, ctxOf(who()));
    expect(tasks.map((t) => t.title)).toContain("Salaire 48 000");
    const updated = await Mutation.updateTask(
      null,
      { input: { id: id(secretTask), title: "Relue" } },
      ctxOf(who()),
    );
    expect(updated.title).toBe("Relue");
  });

  it("un tableau sans liste reste ouvert à tout l'espace", async () => {
    const tasks = await Query.tasks(
      null,
      { boardId: id(openBoard) },
      ctxOf(outsider),
    );
    expect(tasks.map((t) => t.title)).toEqual(["Tâche ouverte"]);
  });
});
