/**
 * Kanban : supprimer une tâche, une colonne ou un tableau effaçait les
 * documents en base mais laissait les pièces jointes en accès public dans
 * le bucket kanban (et l'état de l'éditeur collaboratif). Les fichiers du
 * dossier de la tâche sont désormais effacés, sauf s'ils sont encore
 * utilisés ailleurs (autre tâche, post de réseau social).
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
import mongoose from "mongoose";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const r2 = vi.hoisted(() => ({ deleteTaskImage: vi.fn(async () => true) }));
vi.mock("../../src/services/cloudflareService.js", () => ({ default: r2 }));
vi.mock("../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import KanbanCollabDoc from "../../src/models/KanbanCollabDoc.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import { cleanupDeletedTasksFiles } from "../../src/services/kanbanTaskFilesCleanup.js";

const { Mutation } = kanbanResolvers;
const org = buildOrganizationId();
const owner = buildUserId();
const ctx = () => buildContext({ userId: owner, organizationId: org });

let board;
let column;

const image = (key) => ({
  key,
  url: `https://kanban.test/${key}`,
  fileName: "f.png",
  uploadedBy: owner.toString(),
});

const seedTask = async (title, extra = {}) => {
  const task = await Task.create({
    title,
    status: column._id.toString(),
    boardId: board._id,
    columnId: column._id.toString(),
    workspaceId: org,
    userId: owner,
  });
  const id = task._id.toString();
  task.images = [image(`${id}/${owner}/description/a.png`)];
  task.comments = [
    {
      userId: owner.toString(),
      content: "Voir pièce",
      images: [image(`${id}/${owner}/comments/c1/b.png`)],
    },
  ];
  Object.assign(task, extra);
  await task.save();
  await KanbanCollabDoc.create({
    taskId: id,
    field: "default",
    state: Buffer.from([0]),
    htmlHash: "x",
  });
  return task;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
const deletedKeys = () => r2.deleteTaskImage.mock.calls.map(([key]) => key);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  vi.clearAllMocks();
  await seedOrgMembership({ userId: owner, organizationId: org });
  board = await Board.create({
    title: "Tableau",
    workspaceId: org,
    userId: owner.toString(),
  });
  column = await Column.create({
    title: "À faire",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: org,
    userId: owner,
  });
});

describe("Suppression d'une tâche, d'une colonne ou d'un tableau", () => {
  it("deleteTask efface ses pièces jointes et son état collaboratif", async () => {
    const task = await seedTask("T1");
    const id = task._id.toString();
    expect(await Mutation.deleteTask(null, { id }, ctx())).toBe(true);
    await flush();
    expect(deletedKeys().sort()).toEqual(
      [
        `${id}/${owner}/comments/c1/b.png`,
        `${id}/${owner}/description/a.png`,
      ].sort(),
    );
    expect(await KanbanCollabDoc.countDocuments({ taskId: id })).toBe(0);
  });

  it("deleteColumn et deleteBoard effacent les fichiers de leurs tâches", async () => {
    const t1 = await seedTask("T1");
    const t2 = await seedTask("T2");
    await Mutation.deleteColumn(null, { id: column._id.toString() }, ctx());
    await flush();
    expect(deletedKeys()).toHaveLength(4);
    expect(
      deletedKeys().every(
        (k) => k.startsWith(`${t1._id}/`) || k.startsWith(`${t2._id}/`),
      ),
    ).toBe(true);

    vi.clearAllMocks();
    column = await Column.create({
      title: "Encore",
      color: "#000",
      boardId: board._id,
      order: 1,
      workspaceId: org,
      userId: owner,
    });
    await seedTask("T3");
    await Mutation.deleteBoard(null, { id: board._id.toString() }, ctx());
    await flush();
    expect(deletedKeys()).toHaveLength(2);
  });
});

describe("Fichiers gardés", () => {
  it("fichier encore utilisé par une autre tâche ou un post : gardé", async () => {
    const task = await seedTask("T1");
    const id = task._id.toString();
    const shared = `${id}/${owner}/description/a.png`;
    const inPost = `${id}/${owner}/comments/c1/b.png`;
    await Task.create({
      title: "Copie",
      status: column._id.toString(),
      boardId: board._id,
      columnId: column._id.toString(),
      workspaceId: org,
      userId: owner,
      description: `<img src="https://kanban.test/${shared}">`,
    });
    await mongoose.connection.db
      .collection("socialposts")
      .insertOne({ media: [{ url: `https://kanban.test/${inPost}` }] });
    await Task.deleteOne({ _id: task._id });
    const result = await cleanupDeletedTasksFiles([task.toObject()]);
    expect(result).toEqual({ deleted: 0, kept: 2 });
    expect(r2.deleteTaskImage).not.toHaveBeenCalled();
  });

  it("clé hors du dossier de la tâche : jamais effacée", async () => {
    const task = await seedTask("T1");
    task.images.push(image("autre-tache/x/description/z.png"));
    await task.save();
    await Task.deleteOne({ _id: task._id });
    await cleanupDeletedTasksFiles([task.toObject()]);
    expect(deletedKeys()).not.toContain("autre-tache/x/description/z.png");
  });
});
