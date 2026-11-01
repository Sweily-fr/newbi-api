/**
 * Kanban : les pièces jointes d'un commentaire appartiennent à son auteur.
 *
 * uploadCommentImage et deleteCommentImage n'exigeaient que le droit de
 * commenter : un Éditeur ajoutait une image au commentaire du propriétaire,
 * ou retirait la sienne (et l'effaçait du stockage). Désormais seul l'auteur
 * en ajoute ; l'auteur ou le propriétaire du tableau en retire (même règle
 * que deleteComment).
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
import mongoose from "mongoose";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

const r2 = vi.hoisted(() => ({
  uploadTaskImage: vi.fn(async (buffer, fileName, taskId, userId) => ({
    key: `${taskId}/${userId}/comments/0f0e0d0c-0b0a-4908-8706-050403020100.png`,
    url: `https://kanban.test/${taskId}/${userId}/comments/0f0e0d0c.png`,
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
import taskImageResolvers from "../../src/resolvers/taskImage.js";

const M = taskImageResolvers.Mutation;

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
const otherEditor = buildUserId();

let task;
let ownerCommentId;
let editorCommentId;
let ownerImageId;
let editorImageId;

const ctx = (userId) => buildContext({ userId, organizationId: workspaceId });
const info = (fieldName) => ({ fieldName });

const pngFile = () =>
  Promise.resolve({
    filename: "capture.png",
    mimetype: "image/png",
    createReadStream: () => Readable.from([Buffer.from("png")]),
  });

const upload = (userId, commentId) =>
  M.uploadCommentImage(
    null,
    {
      taskId: String(task._id),
      commentId,
      file: pngFile(),
      workspaceId: String(workspaceId),
    },
    ctx(userId),
    info("uploadCommentImage"),
  );

const remove = (userId, commentId, imageId) =>
  M.deleteCommentImage(
    null,
    {
      taskId: String(task._id),
      commentId,
      imageId,
      workspaceId: String(workspaceId),
    },
    ctx(userId),
    info("deleteCommentImage"),
  );

const image = (userId) => ({
  _id: new mongoose.Types.ObjectId(),
  key: `${task?._id}/${userId}/comments/image.png`,
  url: "https://kanban.test/image.png",
  fileName: "image.png",
  fileSize: 3,
  contentType: "image/png",
  uploadedBy: String(userId),
  uploadedAt: new Date(),
});

const commentsInDb = async () =>
  (await Task.collection.findOne({ _id: task._id })).comments;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  r2.uploadTaskImage.mockClear();
  r2.deleteTaskImage.mockClear();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: editor,
    organizationId: workspaceId,
    role: "member",
  });
  await seedOrgMembership({
    userId: otherEditor,
    organizationId: workspaceId,
    role: "member",
  });
  const board = await Board.create({
    title: "Projet",
    userId: String(owner),
    workspaceId,
  });
  task = await Task.create({
    title: "Maquette",
    boardId: board._id,
    columnId: "colonne",
    status: "colonne",
    userId: String(owner),
    workspaceId,
  });
  const ownerImage = image(owner);
  const editorImage = image(editor);
  ownerImageId = String(ownerImage._id);
  editorImageId = String(editorImage._id);
  ownerCommentId = new mongoose.Types.ObjectId();
  editorCommentId = new mongoose.Types.ObjectId();
  await Task.collection.updateOne(
    { _id: task._id },
    {
      $set: {
        comments: [
          {
            _id: ownerCommentId,
            userId: String(owner),
            content: "Commentaire du propriétaire",
            images: [ownerImage],
            createdAt: new Date(),
          },
          {
            _id: editorCommentId,
            userId: String(editor),
            content: "Commentaire de l'Éditeur",
            images: [editorImage],
            createdAt: new Date(),
          },
        ],
      },
    },
  );
  ownerCommentId = String(ownerCommentId);
  editorCommentId = String(editorCommentId);
});

describe("Commentaire d'un autre membre", () => {
  it("l'Éditeur n'y ajoute pas d'image : refus expliqué, rien envoyé ni enregistré", async () => {
    const before = await commentsInDb();

    const result = await upload(editor, ownerCommentId);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/auteur du commentaire/);
    expect(r2.uploadTaskImage).not.toHaveBeenCalled();
    expect(await commentsInDb()).toEqual(before);
  });

  it("l'Éditeur n'en retire pas l'image : refus, image en base et dans le stockage", async () => {
    const before = await commentsInDb();

    await expect(remove(editor, ownerCommentId, ownerImageId)).rejects.toThrow(
      /auteur du commentaire/,
    );

    expect(r2.deleteTaskImage).not.toHaveBeenCalled();
    expect(await commentsInDb()).toEqual(before);
  });

  it("un autre Éditeur ne retire pas l'image de l'Éditeur", async () => {
    await expect(
      remove(otherEditor, editorCommentId, editorImageId),
    ).rejects.toThrow(/auteur du commentaire/);
    expect(r2.deleteTaskImage).not.toHaveBeenCalled();
  });
});

describe("Auteur et propriétaire du tableau", () => {
  it("l'auteur ajoute une image à son commentaire", async () => {
    const result = await upload(editor, editorCommentId);

    expect(result.success).toBe(true);
    const comment = (await commentsInDb()).find(
      (c) => String(c._id) === editorCommentId,
    );
    expect(comment.images).toHaveLength(2);
  });

  it("l'auteur retire l'image de son commentaire", async () => {
    await remove(editor, editorCommentId, editorImageId);

    const comment = (await commentsInDb()).find(
      (c) => String(c._id) === editorCommentId,
    );
    expect(comment.images).toHaveLength(0);
    expect(r2.deleteTaskImage).toHaveBeenCalledTimes(1);
  });

  it("le propriétaire du tableau retire l'image du commentaire d'un membre", async () => {
    await remove(owner, editorCommentId, editorImageId);

    const comment = (await commentsInDb()).find(
      (c) => String(c._id) === editorCommentId,
    );
    expect(comment.images).toHaveLength(0);
  });

  it("le propriétaire du tableau n'ajoute pas d'image au commentaire d'un membre", async () => {
    const result = await upload(owner, editorCommentId);

    expect(result.success).toBe(false);
    expect(r2.uploadTaskImage).not.toHaveBeenCalled();
  });
});
