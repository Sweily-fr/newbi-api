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
// Push mobile capturé (pas d'envoi Expo réel)
const sendPushToUser = vi.fn(async () => {});
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: (...a) => sendPushToUser(...a),
}));
import { Board, Column, Task } from "../../src/models/kanban.js";
import Notification from "../../src/models/Notification.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import { sendMentionEmail } from "../../src/utils/mailer.js";

const { Mutation } = kanbanResolvers;

const alice = buildUserId();
const bob = buildUserId();
const organizationId = buildOrganizationId();
let ctx;
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

const pushesTo = (userId) =>
  sendPushToUser.mock.calls.filter(([to]) => to === String(userId));

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  sendPushToUser.mockClear();
  sendMentionEmail.mockClear();
  await mongoose.connection.db.collection("user").insertMany([
    { _id: alice, email: "alice@test.fr", name: "Alice" },
    { _id: bob, email: "bob@test.fr", name: "Bob" },
  ]);
  await seedOrgMembership({ userId: alice, organizationId });
  await seedOrgMembership({ userId: bob, organizationId, role: "member" });
  ctx = buildContext({ userId: alice, organizationId });
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

describe("Push TASK_ASSIGNED", () => {
  it("garde le format lu par le mobile et ajoute workspace, notification et url", async () => {
    const task = await Mutation.createTask(
      null,
      {
        input: {
          title: "Préparer la démo",
          boardId: board._id.toString(),
          columnId: column._id.toString(),
          assignedMembers: [bob.toString()],
        },
      },
      ctx,
    );

    await vi.waitFor(() => expect(pushesTo(bob)).toHaveLength(1));
    const notification = await Notification.findOne({ type: "TASK_ASSIGNED" });
    const [, payload] = pushesTo(bob)[0];
    expect(payload).toEqual({
      title: "Nouvelle tâche assignée",
      body: "Alice vous a assigné à « Préparer la démo »",
      data: {
        type: "TASK_ASSIGNED",
        boardId: board._id.toString(),
        taskId: String(task.id || task._id),
        workspaceId: organizationId.toString(),
        notificationId: notification._id.toString(),
        actorId: alice.toString(),
        url: expect.stringContaining(`?task=${task.id || task._id}`),
      },
    });
  });
});

describe("Push MENTION", () => {
  it("notifie le membre mentionné avec la tâche et le commentaire", async () => {
    const task = await makeTask();

    const updated = await Mutation.addComment(
      null,
      {
        taskId: task._id.toString(),
        input: {
          content: "<p>@Bob tu peux regarder ?</p>",
          mentionedUserIds: [bob.toString()],
        },
      },
      ctx,
    );

    await vi.waitFor(() => expect(pushesTo(bob)).toHaveLength(1));
    const notification = await Notification.findOne({ type: "MENTION" });
    const [, payload] = pushesTo(bob)[0];
    expect(payload.title).toBe(notification.title);
    expect(payload.body).toBe(notification.message);
    expect(payload.data).toEqual({
      type: "MENTION",
      workspaceId: organizationId.toString(),
      notificationId: notification._id.toString(),
      boardId: board._id.toString(),
      taskId: task._id.toString(),
      actorId: alice.toString(),
      commentId: String(
        updated.comments.at(-1).id || updated.comments.at(-1)._id,
      ),
      url: expect.stringContaining(`?task=${task._id}`),
    });
    // L'auteur ne reçoit rien
    expect(pushesTo(alice)).toHaveLength(0);
  });

  it("respecte la préférence kanban_mention.push", async () => {
    await mongoose.connection.db
      .collection("user")
      .updateOne(
        { _id: bob },
        { $set: { "notificationPreferences.kanban_mention.push": false } },
      );
    const task = await makeTask();

    await Mutation.addComment(
      null,
      {
        taskId: task._id.toString(),
        input: { content: "<p>@Bob</p>", mentionedUserIds: [bob.toString()] },
      },
      ctx,
    );

    // Laisse le traitement des mentions (en arrière-plan) se terminer :
    // l'e-mail part (préférence e-mail active), ni notification ni push
    await vi.waitFor(() => expect(sendMentionEmail).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await Notification.countDocuments({ type: "MENTION" })).toBe(0);
    expect(pushesTo(bob)).toHaveLength(0);
  });

  it("notifie une nouvelle mention ajoutée en modifiant un commentaire", async () => {
    const task = await makeTask();
    const withComment = await Mutation.addComment(
      null,
      { taskId: task._id.toString(), input: { content: "<p>Note</p>" } },
      ctx,
    );
    const comment = withComment.comments.at(-1);
    const commentId = String(comment.id || comment._id);

    await Mutation.updateComment(
      null,
      {
        taskId: task._id.toString(),
        commentId,
        content: "<p>Note @Bob</p>",
        mentionedUserIds: [bob.toString()],
      },
      ctx,
    );

    await vi.waitFor(() => expect(pushesTo(bob)).toHaveLength(1));
    const [, payload] = pushesTo(bob)[0];
    expect(payload.data).toMatchObject({
      type: "MENTION",
      taskId: task._id.toString(),
      commentId,
    });
  });
});
