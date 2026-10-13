/**
 * Kanban : assignations et mentions limitées aux membres de l'espace.
 *
 * assignedMembers et mentionedUserIds n'étaient jamais confrontés aux
 * membres de l'espace : n'importe quel utilisateur recevait e-mail et
 * notification (et son identité s'affichait sur la page publique), et
 * l'e-mail d'assignation reprenait le titre du tableau et de la colonne
 * lus par leur seul id, éventuellement ceux d'un autre espace.
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
vi.mock("../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(async () => true),
  sendMentionEmail: vi.fn(async () => true),
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
import Notification from "../../src/models/Notification.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import {
  sendTaskAssignmentEmail,
  sendMentionEmail,
} from "../../src/utils/mailer.js";

const { Mutation } = kanbanResolvers;

const alice = buildUserId(); // membre de A (appelante)
const bob = buildUserId(); // membre de A
const mallory = buildUserId(); // membre de B seulement
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const ctx = () => buildContext({ userId: alice, organizationId: orgA });

let boardA;
let columnA;

const emailsTo = (mock, address) =>
  mock.mock.calls.filter(([to]) => to === address);
const notificationsFor = (userId) =>
  Notification.countDocuments({ userId: String(userId) });

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

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  sendTaskAssignmentEmail.mockClear();
  sendMentionEmail.mockClear();
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
  boardA = await Board.create({ title: "A", workspaceId: orgA, userId: alice });
  columnA = await Column.create({
    title: "À faire",
    color: "#000",
    boardId: boardA._id,
    order: 0,
    workspaceId: orgA,
    userId: alice,
  });
});

describe("assignations", () => {
  it("createTask n'assigne ni ne notifie un utilisateur d'un autre espace", async () => {
    const task = await Mutation.createTask(
      null,
      {
        input: {
          title: "Nouvelle",
          boardId: boardA._id.toString(),
          columnId: columnA._id.toString(),
          assignedMembers: [bob.toString(), mallory.toString()],
        },
      },
      ctx(),
    );

    await vi.waitFor(() =>
      expect(emailsTo(sendTaskAssignmentEmail, "bob@a.fr")).toHaveLength(1),
    );
    const stored = await Task.collection.findOne({ _id: task._id });
    expect(stored.assignedMembers).toEqual([bob.toString()]);
    expect(emailsTo(sendTaskAssignmentEmail, "mallory@b.fr")).toHaveLength(0);
    expect(await notificationsFor(mallory)).toBe(0);
  });

  it("updateTask n'ajoute pas un utilisateur d'un autre espace", async () => {
    const task = await seedTask();
    await Mutation.updateTask(
      null,
      {
        input: {
          id: task._id.toString(),
          assignedMembers: [bob.toString(), mallory.toString()],
        },
      },
      ctx(),
    );

    await vi.waitFor(() =>
      expect(emailsTo(sendTaskAssignmentEmail, "bob@a.fr")).toHaveLength(1),
    );
    const stored = await Task.collection.findOne({ _id: task._id });
    expect(stored.assignedMembers).toEqual([bob.toString()]);
    expect(emailsTo(sendTaskAssignmentEmail, "mallory@b.fr")).toHaveLength(0);
  });

  it("assignTaskMember refuse un utilisateur d'un autre espace", async () => {
    const task = await seedTask();
    await expect(
      Mutation.assignTaskMember(
        null,
        { taskId: task._id.toString(), memberId: mallory.toString() },
        ctx(),
      ),
    ).rejects.toThrow("Membre introuvable");

    const stored = await Task.collection.findOne({ _id: task._id });
    expect(stored.assignedMembers || []).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emailsTo(sendTaskAssignmentEmail, "mallory@b.fr")).toHaveLength(0);
  });

  it("l'e-mail ne reprend pas les titres du tableau d'un autre espace", async () => {
    // Tâche glissée avant le correctif dans le tableau de B
    const boardB = await Board.create({
      title: "Tableau secret de B",
      workspaceId: orgB,
      userId: mallory,
    });
    const columnB = await Column.create({
      title: "Colonne secrète de B",
      color: "#000",
      boardId: boardB._id,
      order: 0,
      workspaceId: orgB,
      userId: mallory,
    });
    const task = await seedTask({
      boardId: boardB._id,
      columnId: columnB._id.toString(),
    });

    await Mutation.assignTaskMember(
      null,
      { taskId: task._id.toString(), memberId: bob.toString() },
      ctx(),
    );

    await vi.waitFor(() =>
      expect(emailsTo(sendTaskAssignmentEmail, "bob@a.fr")).toHaveLength(1),
    );
    const [, payload] = emailsTo(sendTaskAssignmentEmail, "bob@a.fr")[0];
    expect(payload.boardName).not.toContain("secret");
    expect(payload.columnName).not.toContain("secrète");
  });

  it("assigne et notifie un membre de l'espace", async () => {
    const task = await seedTask();
    const updated = await Mutation.assignTaskMember(
      null,
      { taskId: task._id.toString(), memberId: bob.toString() },
      ctx(),
    );
    expect(updated.assignedMembers).toEqual([bob.toString()]);
    await vi.waitFor(() =>
      expect(emailsTo(sendTaskAssignmentEmail, "bob@a.fr")).toHaveLength(1),
    );
    const [, payload] = emailsTo(sendTaskAssignmentEmail, "bob@a.fr")[0];
    expect(payload.boardName).toBe("A");
    expect(payload.columnName).toBe("À faire");
  });
});

describe("mentions", () => {
  it("addComment ne notifie pas un utilisateur d'un autre espace", async () => {
    const task = await seedTask();
    await Mutation.addComment(
      null,
      {
        taskId: task._id.toString(),
        input: {
          content: "Regardez ça",
          mentionedUserIds: [mallory.toString(), bob.toString()],
        },
      },
      ctx(),
    );

    await vi.waitFor(() =>
      expect(emailsTo(sendMentionEmail, "bob@a.fr")).toHaveLength(1),
    );
    expect(emailsTo(sendMentionEmail, "mallory@b.fr")).toHaveLength(0);
    expect(await notificationsFor(mallory)).toBe(0);
  });

  it("updateComment ne notifie pas un utilisateur d'un autre espace", async () => {
    const task = await seedTask({
      comments: [{ userId: alice.toString(), content: "Bonjour" }],
    });
    const commentId = task.comments[0]._id.toString();

    await Mutation.updateComment(
      null,
      {
        taskId: task._id.toString(),
        commentId,
        content: "Bonjour à vous",
        mentionedUserIds: [mallory.toString(), bob.toString()],
      },
      ctx(),
    );

    await vi.waitFor(() =>
      expect(emailsTo(sendMentionEmail, "bob@a.fr")).toHaveLength(1),
    );
    expect(emailsTo(sendMentionEmail, "mallory@b.fr")).toHaveLength(0);
    expect(await notificationsFor(mallory)).toBe(0);
  });
});
