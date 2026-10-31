/**
 * Images des commentaires de visiteurs (tableau kanban partagé) : seules les
 * images envoyées par ce visiteur pour cette tâche sont acceptées, leur
 * adresse est recalculée côté serveur, et la suppression d'une image ne
 * touche le stockage que pour un fichier rangé sous la tâche concernée.
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
import { Readable } from "stream";
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

const mailbox = vi.hoisted(() => ({ codes: new Map() }));
vi.mock("../../src/utils/mailer.js", () => ({
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
  sendBoardVisitorCodeEmail: vi.fn(async (email, { code }) => {
    mailbox.codes.set(email, code);
    return true;
  }),
}));

const r2 = vi.hoisted(() => ({
  uploadTaskImage: vi.fn(async (buffer, fileName, taskId, folder) => ({
    key: `${taskId}/${folder}/description/0f0e0d0c-0b0a-4908-8706-050403020100.png`,
    url: `https://kanban.test/${taskId}/${folder}/description/0f0e0d0c-0b0a-4908-8706-050403020100.png`,
    contentType: "image/png",
    fileName,
    fileSize: buffer.length,
  })),
  getTaskImageUrl: (key) => `https://kanban.test/${key}`,
  deleteTaskImage: vi.fn(async () => true),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({ default: r2 }));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { Board, Task } from "../../src/models/kanban.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";
import userInvitedResolvers from "../../src/resolvers/userInvited.js";
import taskImageResolvers from "../../src/resolvers/taskImage.js";

const VISITOR = "visiteur@exemple.fr";
const VISITOR_FOLDER = "visitor_visiteur_at_exemple.fr";
const M = publicBoardShareResolvers.Mutation;
const IM = userInvitedResolvers.Mutation;

const anonymous = () => ({
  user: null,
  req: { ip: "203.0.113.9" },
  db: mongoose.connection.db,
});

async function signIn(email) {
  await IM.requestInvitedEmailCode(
    {},
    { token: share.token, email },
    anonymous(),
  );
  const result = await IM.authenticateInvitedUser(
    {},
    {
      input: {
        token: share.token,
        email,
        emailCode: mailbox.codes.get(email),
      },
    },
    anonymous(),
  );
  return result.sessionToken;
}

let board;
let share;
let task;
let otherTask;
let workspaceId;
let ownerId;
let sessionToken;

const comment = (images, extra = {}) =>
  M.addExternalComment(
    {},
    {
      token: share.token,
      taskId: task._id.toString(),
      content: "Voici la capture",
      images,
      sessionToken,
      ...extra,
    },
    anonymous(),
  );

const ownKey = () =>
  `${task._id}/${VISITOR_FOLDER}/description/0f0e0d0c-0b0a-4908-8706-050403020100.png`;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  resetMemoryAttempts();
  mailbox.codes.clear();
  r2.uploadTaskImage.mockClear();
  r2.deleteTaskImage.mockClear();
  workspaceId = buildOrganizationId();
  ownerId = buildUserId();
  await seedOrgMembership({ userId: ownerId, organizationId: workspaceId });
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
  const taskFields = {
    status: "todo",
    boardId: board._id,
    columnId: "colonne",
    workspaceId,
    userId: ownerId,
  };
  task = await Task.create({ title: "Tâche", ...taskFields });
  otherTask = await Task.create({ title: "Autre tâche", ...taskFields });
  sessionToken = await signIn(VISITOR);
});

describe("addExternalComment : images contrôlées", () => {
  it("accepte l'image envoyée par ce visiteur pour cette tâche", async () => {
    const upload = await M.uploadExternalCommentImage(
      {},
      {
        token: share.token,
        taskId: task._id.toString(),
        file: Promise.resolve({
          createReadStream: () => Readable.from([Buffer.from("png")]),
          filename: "capture.png",
          mimetype: "image/png",
        }),
        sessionToken,
      },
      anonymous(),
    );
    expect(upload.success).toBe(true);
    expect(upload.image.key.startsWith(`${task._id}/${VISITOR_FOLDER}/`)).toBe(
      true,
    );

    const result = await comment([
      {
        id: "1",
        key: upload.image.key,
        url: "https://suivi.exemple.invalid/pixel.png",
        fileName: "capture.png",
        contentType: "text/html",
      },
    ]);
    expect(result.success).toBe(true);
    const saved = await Task.findById(task._id).lean();
    const [image] = saved.comments[0].images;
    expect(image.key).toBe(upload.image.key);
    // Adresse recalculée depuis la clé, type limité aux images
    expect(image.url).toBe(`https://kanban.test/${upload.image.key}`);
    expect(image.contentType).toBe("image/jpeg");
  });

  it.each([
    [
      "d'une autre tâche",
      () =>
        `${otherTask._id}/${VISITOR_FOLDER}/description/0f0e0d0c-0b0a-4908-8706-050403020100.png`,
    ],
    [
      "d'un autre espace",
      () =>
        `${new mongoose.Types.ObjectId()}/${new mongoose.Types.ObjectId()}/description/abc.png`,
    ],
    [
      "d'un autre visiteur",
      () =>
        `${task._id}/visitor_autre_at_exemple.fr/description/0f0e0d0c-0b0a-4908-8706-050403020100.png`,
    ],
    [
      "d'un membre de l'espace",
      () => `${task._id}/${ownerId}/description/abc.png`,
    ],
  ])("refuse une clé %s", async (_label, keyOf) => {
    const result = await comment([
      { id: "1", key: keyOf(), url: "https://x", fileName: "a.png" },
    ]);
    expect(result.success).toBe(false);
    const saved = await Task.findById(task._id).lean();
    expect(saved.comments || []).toHaveLength(0);
  });

  it("refuse plus de 10 images", async () => {
    const images = Array.from({ length: 11 }, (_, i) => ({
      id: String(i),
      key: ownKey(),
      url: "https://x",
      fileName: "a.png",
    }));
    const result = await comment(images);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/10 images au plus/);
  });
});

describe("suppression d'une image : stockage touché pour la tâche seulement", () => {
  const ctx = () =>
    buildContext({ userId: ownerId, organizationId: workspaceId });

  const seedCommentImage = async (key) => {
    const saved = await Task.findById(task._id);
    saved.comments.push({
      userId: "external_visiteur@exemple.fr",
      content: "Image",
      images: [
        { key, url: "https://x", fileName: "a.png", uploadedBy: "visiteur" },
      ],
    });
    await saved.save();
    const created = saved.comments.at(-1);
    return {
      commentId: created._id.toString(),
      imageId: created.images[0]._id.toString(),
    };
  };

  it("une clé hors du dossier de la tâche : seule l'entrée en base est retirée", async () => {
    const foreignKey = `${otherTask._id}/${ownerId}/description/fichier.pdf`;
    const { commentId, imageId } = await seedCommentImage(foreignKey);

    await taskImageResolvers.Mutation.deleteCommentImage(
      {},
      {
        taskId: task._id.toString(),
        commentId,
        imageId,
        workspaceId: workspaceId.toString(),
      },
      ctx(),
    );

    expect(r2.deleteTaskImage).not.toHaveBeenCalled();
    const saved = await Task.findById(task._id).lean();
    expect(saved.comments.at(-1).images).toHaveLength(0);
  });

  it("une image de la tâche est bien supprimée du stockage", async () => {
    const { commentId, imageId } = await seedCommentImage(ownKey());

    await taskImageResolvers.Mutation.deleteCommentImage(
      {},
      {
        taskId: task._id.toString(),
        commentId,
        imageId,
        workspaceId: workspaceId.toString(),
      },
      ctx(),
    );

    expect(r2.deleteTaskImage).toHaveBeenCalledWith(ownKey());
  });

  it("image de description hors du dossier de la tâche : fichier conservé", async () => {
    const saved = await Task.findById(task._id);
    saved.images.push({
      key: `${otherTask._id}/${ownerId}/description/fichier.png`,
      url: "https://x",
      fileName: "fichier.png",
      uploadedBy: ownerId.toString(),
    });
    await saved.save();

    await taskImageResolvers.Mutation.deleteTaskImage(
      {},
      {
        taskId: task._id.toString(),
        imageId: saved.images[0]._id.toString(),
        workspaceId: workspaceId.toString(),
      },
      ctx(),
    );

    expect(r2.deleteTaskImage).not.toHaveBeenCalled();
    const after = await Task.findById(task._id).lean();
    expect(after.images).toHaveLength(0);
  });
});
