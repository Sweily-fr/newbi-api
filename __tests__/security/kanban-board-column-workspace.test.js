/**
 * Kanban : tableau, colonne et client fournis par le client doivent être
 * ceux de l'espace.
 *
 * createColumn et createTask acceptaient le boardId / columnId d'un autre
 * espace, updateTask et moveTask une colonne d'un autre espace : un membre
 * de A ajoutait colonnes et tâches au tableau de B, affichées sur la page
 * publique de B (qui lisait colonnes et tâches par tableau seulement).
 * createBoard et updateBoard rattachaient le client d'un autre espace.
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
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
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
vi.mock("../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import Client from "../../src/models/Client.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import UserInvited from "../../src/models/UserInvited.js";
import { createVisitorSessionToken } from "../../src/utils/boardVisitorSession.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";

const { Mutation } = kanbanResolvers;

const alice = buildUserId(); // membre de A
const bob = buildUserId(); // membre de B
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const ctx = () => buildContext({ userId: alice, organizationId: orgA });

let boardA;
let columnA;
let otherColumnA;
let boardB;
let columnB;

const seedBoard = async (workspaceId, userId, title) => {
  const board = await Board.create({ title, workspaceId, userId });
  const column = await Column.create({
    title: "À faire",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId,
    userId,
  });
  return { board, column };
};

const seedTask = (fields = {}) =>
  Task.create({
    title: "Tâche A",
    status: columnA._id.toString(),
    boardId: boardA._id,
    columnId: columnA._id.toString(),
    workspaceId: orgA,
    userId: alice,
    ...fields,
  });

const insertClient = async (workspaceId, name) => {
  const { insertedId } = await Client.collection.insertOne({
    workspaceId,
    name,
    email: `${name.toLowerCase().replace(/\s/g, "")}@test.fr`,
    type: "COMPANY",
  });
  return insertedId;
};

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
    { _id: bob, email: "bob@b.fr", name: "Bob" },
  ]);
  await seedOrgMembership({ userId: alice, organizationId: orgA });
  await seedOrgMembership({ userId: bob, organizationId: orgB });
  ({ board: boardA, column: columnA } = await seedBoard(orgA, alice, "A"));
  otherColumnA = await Column.create({
    title: "En cours",
    color: "#111",
    boardId: boardA._id,
    order: 1,
    workspaceId: orgA,
    userId: alice,
  });
  ({ board: boardB, column: columnB } = await seedBoard(orgB, bob, "B"));
});

describe("colonnes et tâches dans le tableau d'un autre espace", () => {
  it("createColumn refuse le tableau d'un autre espace", async () => {
    await expect(
      Mutation.createColumn(
        null,
        {
          input: {
            title: "Intrus",
            color: "#f00",
            boardId: boardB._id.toString(),
            order: 9,
          },
        },
        ctx(),
      ),
    ).rejects.toThrow("Board not found");
    expect(await Column.countDocuments({ boardId: boardB._id })).toBe(1);
  });

  it("createTask refuse le tableau et la colonne d'un autre espace", async () => {
    await expect(
      Mutation.createTask(
        null,
        {
          input: {
            title: "Intrus",
            boardId: boardB._id.toString(),
            columnId: columnB._id.toString(),
          },
        },
        ctx(),
      ),
    ).rejects.toThrow("Board not found");
    expect(await Task.countDocuments({ boardId: boardB._id })).toBe(0);
  });

  it("createTask refuse une colonne d'un autre espace dans son tableau", async () => {
    await expect(
      Mutation.createTask(
        null,
        {
          input: {
            title: "Intrus",
            boardId: boardA._id.toString(),
            columnId: columnB._id.toString(),
          },
        },
        ctx(),
      ),
    ).rejects.toThrow("Column not found");
    expect(await Task.countDocuments({})).toBe(0);
  });

  it("updateTask refuse une colonne d'un autre espace", async () => {
    const task = await seedTask();
    await expect(
      Mutation.updateTask(
        null,
        {
          input: { id: task._id.toString(), columnId: columnB._id.toString() },
        },
        ctx(),
      ),
    ).rejects.toThrow("Column not found");
    const after = await Task.collection.findOne({ _id: task._id });
    expect(after.columnId).toBe(columnA._id.toString());
  });

  it("moveTask refuse une colonne d'un autre espace", async () => {
    const task = await seedTask();
    await expect(
      Mutation.moveTask(
        null,
        {
          id: task._id.toString(),
          columnId: columnB._id.toString(),
          position: 0,
        },
        ctx(),
      ),
    ).rejects.toThrow();
    const after = await Task.collection.findOne({ _id: task._id });
    expect(after.columnId).toBe(columnA._id.toString());
  });

  it("garde la création et le déplacement dans son propre tableau", async () => {
    const column = await Mutation.createColumn(
      null,
      {
        input: {
          title: "Terminé",
          color: "#0f0",
          boardId: boardA._id.toString(),
          order: 2,
        },
      },
      ctx(),
    );
    expect(String(column.boardId)).toBe(boardA._id.toString());

    const created = await Mutation.createTask(
      null,
      {
        input: {
          title: "Nouvelle",
          boardId: boardA._id.toString(),
          columnId: columnA._id.toString(),
        },
      },
      ctx(),
    );
    const taskId = String(created.id || created._id);

    const moved = await Mutation.moveTask(
      null,
      { id: taskId, columnId: otherColumnA._id.toString(), position: 0 },
      ctx(),
    );
    expect(moved.columnId).toBe(otherColumnA._id.toString());

    const updated = await Mutation.updateTask(
      null,
      { input: { id: taskId, columnId: columnA._id.toString() } },
      ctx(),
    );
    expect(updated.columnId).toBe(columnA._id.toString());
  });
});

describe("page publique d'un tableau", () => {
  it("n'affiche pas les colonnes ni les tâches d'un autre espace", async () => {
    const share = await PublicBoardShare.create({
      token: PublicBoardShare.generateToken(),
      boardId: boardB._id,
      workspaceId: orgB,
      createdBy: bob,
    });
    const visitor = await UserInvited.create({
      email: "visiteur@exemple.fr",
      emailVerifiedAt: new Date(),
    });
    // Données glissées par l'espace A avant le correctif
    const { insertedId: intruderColumn } = await Column.collection.insertOne({
      title: "Colonne intruse",
      color: "#f00",
      boardId: boardB._id,
      order: 5,
      workspaceId: orgA,
      userId: alice,
    });
    await Task.collection.insertOne({
      title: "Tâche intruse",
      boardId: boardB._id,
      columnId: intruderColumn.toString(),
      status: intruderColumn.toString(),
      position: 0,
      workspaceId: orgA,
      userId: alice,
      assignedMembers: [],
      comments: [],
      activity: [],
    });
    await Task.create({
      title: "Tâche B",
      boardId: boardB._id,
      columnId: columnB._id.toString(),
      status: columnB._id.toString(),
      workspaceId: orgB,
      userId: bob,
    });

    const result = await publicBoardShareResolvers.Query.getPublicBoard(
      {},
      {
        token: share.token,
        sessionToken: createVisitorSessionToken(visitor, share),
      },
      { user: null, req: { ip: "203.0.113.1" } },
    );

    expect(result.success).toBe(true);
    expect(result.board.columns.map((c) => c.title)).toEqual(["À faire"]);
    expect(result.board.tasks.map((t) => t.title)).toEqual(["Tâche B"]);
  });
});

describe("client rattaché à un tableau", () => {
  it("createBoard refuse le client d'un autre espace", async () => {
    const clientB = await insertClient(orgB, "Client B");
    await expect(
      Mutation.createBoard(
        null,
        { input: { title: "Projet", clientId: clientB.toString() } },
        ctx(),
      ),
    ).rejects.toThrow("Client non trouvé");
    expect(await Board.countDocuments({ workspaceId: orgA })).toBe(1);
  });

  it("updateBoard refuse le client d'un autre espace", async () => {
    const clientB = await insertClient(orgB, "Client B");
    await expect(
      Mutation.updateBoard(
        null,
        {
          input: { id: boardA._id.toString(), clientId: clientB.toString() },
        },
        ctx(),
      ),
    ).rejects.toThrow("Client non trouvé");
    const after = await Board.collection.findOne({ _id: boardA._id });
    expect(after.clientId ?? null).toBeNull();
  });

  it("accepte un client de l'espace", async () => {
    const clientA = await insertClient(orgA, "Client A");
    const board = await Mutation.updateBoard(
      null,
      { input: { id: boardA._id.toString(), clientId: clientA.toString() } },
      ctx(),
    );
    expect(String(board.clientId)).toBe(clientA.toString());
  });
});
