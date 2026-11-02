/**
 * Tableau public : ce qu'un visiteur reçoit.
 *
 * getPublicBoard (et la réponse d'un commentaire, et le temps réel)
 * renvoyaient l'adresse e-mail des autres visiteurs et des membres, le taux
 * horaire des tâches, l'identifiant du créateur de chaque tâche et celui de
 * l'espace et du créateur du lien ; les permissions du lien (commentaires,
 * pièces jointes, membres, dates) n'étaient pas appliquées.
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
import mongoose from "mongoose";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
});

const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

// Codes envoyés par e-mail, relevés dans la boîte simulée
const mailbox = vi.hoisted(() => ({ codes: new Map() }));
vi.mock("../../src/utils/mailer.js", () => ({
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
  sendBoardVisitorCodeEmail: vi.fn(async (email, { code }) => {
    mailbox.codes.set(email, code);
    return true;
  }),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { Board, Task } from "../../src/models/kanban.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import UserInvited from "../../src/models/UserInvited.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";
import userInvitedResolvers from "../../src/resolvers/userInvited.js";

const VISITOR = "visiteur@exemple.fr";
const OTHER = "autre@exemple.fr";

const anonymous = () => ({
  user: null,
  req: { ip: "203.0.113.9" },
  db: mongoose.connection.db,
});

const Q = publicBoardShareResolvers.Query;
const M = publicBoardShareResolvers.Mutation;
const IQ = userInvitedResolvers.Query;
const IM = userInvitedResolvers.Mutation;

const getPublicBoard = (args, context = anonymous()) =>
  Q.getPublicBoard({}, { token: share.token, ...args }, context);

const authenticate = (input) =>
  IM.authenticateInvitedUser(
    {},
    { input: { token: share.token, ...input } },
    anonymous(),
  );

// Parcours complet : code reçu par e-mail puis connexion
async function signIn(email, shareToken = share.token, extra = {}) {
  await IM.requestInvitedEmailCode(
    {},
    { token: shareToken, email },
    anonymous(),
  );
  const result = await IM.authenticateInvitedUser(
    {},
    {
      input: {
        token: shareToken,
        email,
        emailCode: mailbox.codes.get(email),
        ...extra,
      },
    },
    anonymous(),
  );
  return result;
}

const subscribeError = async (args, context = anonymous()) => {
  try {
    const iterator =
      await publicBoardShareResolvers.Subscription.publicTaskUpdated.subscribe(
        {},
        { token: share.token, boardId: board._id.toString(), ...args },
        context,
        {},
      );
    await iterator?.return?.();
  } catch (error) {
    return error;
  }
  return null;
};

let board;
let share;
let task;
let workspaceId;
let ownerId;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  resetMemoryAttempts();
  mailbox.codes.clear();
  workspaceId = buildOrganizationId();
  ownerId = buildUserId();
  board = await Board.create({
    title: "Tableau client",
    workspaceId,
    userId: ownerId,
  });
  share = await PublicBoardShare.create({
    token: PublicBoardShare.generateToken(),
    boardId: board._id,
    workspaceId,
    createdBy: ownerId,
  });
  task = await Task.create({
    title: "Tâche",
    status: "todo",
    boardId: board._id,
    columnId: "colonne",
    workspaceId,
    userId: ownerId,
  });
});

const OWNER_EMAIL = "proprietaire@entreprise.fr";

const seedContent = async () => {
  await mongoose.connection.db.collection("user").insertOne({
    _id: ownerId,
    email: OWNER_EMAIL,
    name: "Paule Propriétaire",
  });
  task.timeTracking = { totalSeconds: 3600, hourlyRate: 95 };
  task.assignedMembers = [ownerId.toString()];
  task.dueDate = new Date("2026-12-01");
  task.images = [
    {
      key: "k/logo.png",
      url: "https://cdn/logo.png",
      fileName: "logo.png",
      uploadedBy: ownerId.toString(),
    },
  ];
  task.comments = [
    {
      userId: `external_${OTHER}`,
      userEmail: OTHER,
      userName: "Bruno",
      content: "Commentaire de Bruno",
      isExternal: true,
    },
    {
      userId: ownerId.toString(),
      userEmail: OWNER_EMAIL,
      userName: "Paule",
      content: "Réponse de l'équipe",
      isExternal: false,
    },
  ];
  await task.save();
};

describe("Tableau public : données renvoyées au visiteur", () => {
  beforeEach(seedContent);

  it("ni e-mail des autres, ni taux horaire, ni identifiants internes", async () => {
    const { sessionToken } = await signIn(VISITOR);
    await M.addExternalComment(
      {},
      {
        token: share.token,
        taskId: task._id.toString(),
        content: "Mon commentaire",
        sessionToken,
      },
      anonymous(),
    );
    const result = await getPublicBoard({ sessionToken });
    expect(result.success).toBe(true);
    const json = JSON.stringify(result);
    expect(json).not.toContain(OTHER);
    expect(json).not.toContain(OWNER_EMAIL);
    expect(json).not.toContain(workspaceId.toString());

    const [publicTask] = result.board.tasks;
    expect(publicTask.timeTracking.hourlyRate).toBeNull();
    expect(publicTask.timeTracking.totalSeconds).toBe(3600);
    expect(publicTask.userId).toBeNull();
    expect(publicTask.createdByName).toBe("Paule Propriétaire");
    expect(result.share.createdBy).toBeNull();
    expect(result.share.workspaceId).toBeNull();

    // Ses propres commentaires restent reconnaissables
    const mine = publicTask.comments.find(
      (c) => c.content === "Mon commentaire",
    );
    expect(mine.userEmail).toBe(VISITOR);
    const bruno = publicTask.comments.find(
      (c) => c.content === "Commentaire de Bruno",
    );
    expect(bruno.userEmail).toBeNull();
    expect(bruno.userName).toBe("Bruno");
  });

  it("la réponse d'un commentaire suit la même règle", async () => {
    const { sessionToken } = await signIn(VISITOR);
    const result = await M.addExternalComment(
      {},
      {
        token: share.token,
        taskId: task._id.toString(),
        content: "Mon commentaire",
        sessionToken,
      },
      anonymous(),
    );
    expect(result.success).toBe(true);
    const json = JSON.stringify(result.task);
    expect(json).not.toContain(OTHER);
    expect(json).not.toContain(OWNER_EMAIL);
    expect(result.task.userId).toBeNull();
    expect(result.task.timeTracking.hourlyRate).toBeNull();
  });

  it("le temps réel suit la même règle", async () => {
    const { sessionToken } = await signIn(VISITOR);
    const iterator =
      await publicBoardShareResolvers.Subscription.publicTaskUpdated.subscribe(
        {},
        { token: share.token, boardId: board._id.toString(), sessionToken },
        anonymous(),
        {},
      );
    const next = iterator.next();
    await pubsub.publish(`TASK_UPDATED_${workspaceId}_${board._id}`, {
      type: "UPDATED",
      task: task.toObject(),
      taskId: task._id.toString(),
      boardId: board._id.toString(),
      workspaceId: workspaceId.toString(),
    });
    const { value } = await next;
    const payload =
      await publicBoardShareResolvers.Subscription.publicTaskUpdated.resolve(
        value,
        { token: share.token, boardId: board._id.toString(), sessionToken },
        anonymous(),
      );
    await iterator.return?.();
    const json = JSON.stringify(payload);
    expect(json).not.toContain(OTHER);
    expect(json).not.toContain(OWNER_EMAIL);
    expect(payload.task.userId).toBeNull();
    expect(payload.task.timeTracking.hourlyRate).toBeNull();
    expect(payload.task.createdByName).toBe("Paule Propriétaire");
  });

  it("permissions du lien appliquées : ni commentaires, ni pièces jointes, ni membres, ni dates", async () => {
    share.permissions.canViewComments = false;
    share.permissions.canViewAttachments = false;
    share.permissions.canViewAssignees = false;
    share.permissions.canViewDueDates = false;
    await share.save();
    const { sessionToken } = await signIn(VISITOR);
    const result = await getPublicBoard({ sessionToken });
    expect(result.success).toBe(true);
    const [publicTask] = result.board.tasks;
    expect(publicTask.comments).toEqual([]);
    expect(publicTask.images).toEqual([]);
    expect(publicTask.assignedMembers).toEqual([]);
    expect(publicTask.dueDate).toBeNull();
    expect(publicTask.createdByName).toBeNull();
    expect(result.board.members).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("Paule");
  });

  it("lien sans les tâches : aucune tâche", async () => {
    share.permissions.canViewTasks = false;
    await share.save();
    const { sessionToken } = await signIn(VISITOR);
    const result = await getPublicBoard({ sessionToken });
    expect(result.success).toBe(true);
    expect(result.board.tasks).toEqual([]);
  });
});
