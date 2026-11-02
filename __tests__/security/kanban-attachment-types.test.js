/**
 * Kanban : pièces jointes servies depuis un bucket public avec le type
 * déduit de l'extension. Le type déclaré par le client était seul vérifié :
 * « dessin.svg » envoyé comme image/png était servi en image/svg+xml
 * (script exécuté à l'ouverture du lien). Le type servi et l'extension de
 * la clé viennent désormais du type déclaré, qui doit être accepté.
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

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const r2 = vi.hoisted(() => ({
  uploadTaskImage: vi.fn(async (buffer, fileName, taskId, userId) => ({
    key: `${taskId}/${userId}/description/0f0e0d0c.png`,
    url: `https://kanban.test/${taskId}/0f0e0d0c.png`,
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
import {
  kanbanFileType,
  isSafeImageFileName,
} from "../../src/utils/kanbanFileTypes.js";

describe("kanbanFileType", () => {
  it.each([
    ["photo.PNG", "image/png", ".png", "image/png"],
    ["devis.pdf", "application/pdf", ".pdf", "application/pdf"],
    ["clip.mov", "video/quicktime", ".mov", "video/quicktime"],
    ["IMG_0001", "image/jpeg", ".jpg", "image/jpeg"],
    ["IMG_0001.HEIC", "image/jpeg", ".jpg", "image/jpeg"],
    // Nom piégé : rangé et servi selon le type déclaré, jamais en SVG/HTML
    ["dessin.svg", "image/png", ".png", "image/png"],
    ["page.html", "text/plain", ".txt", "text/plain"],
    ["sans-type.csv", null, ".csv", "text/csv"],
  ])("%s (%s) : %s, %s", (name, declared, extension, served) => {
    expect(kanbanFileType(name, declared)).toEqual({
      extension,
      contentType: served,
    });
  });

  it.each([
    ["dessin.svg", "image/svg+xml"],
    ["page.html", "text/html"],
    ["dessin.svg", null],
    ["page.htm", null],
    ["sans-extension", null],
  ])("%s (déclaré %s) refusé", (name, declared) => {
    expect(kanbanFileType(name, declared)).toBeNull();
  });

  it("avatar de visiteur : seules les extensions d'image inoffensives", () => {
    expect(isSafeImageFileName("moi.webp")).toBe(true);
    expect(isSafeImageFileName("moi.svg")).toBe(false);
    expect(isSafeImageFileName("moi")).toBe(false);
  });
});

const workspaceId = buildOrganizationId();
const owner = buildUserId();
let task;

const file = (filename, mimetype) =>
  Promise.resolve({
    filename,
    mimetype,
    createReadStream: () =>
      Readable.from([Buffer.from("<svg onload=alert(1)>")]),
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
  vi.clearAllMocks();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  const board = await Board.create({
    title: "Tableau",
    workspaceId,
    userId: owner.toString(),
  });
  task = await Task.create({
    title: "Tâche",
    status: "todo",
    boardId: board._id,
    columnId: "todo",
    workspaceId,
    userId: owner,
  });
});

describe("uploadTaskImage", () => {
  const send = (filename, mimetype) =>
    taskImageResolvers.Mutation.uploadTaskImage(
      null,
      {
        taskId: String(task._id),
        file: file(filename, mimetype),
        workspaceId: String(workspaceId),
      },
      buildContext({ userId: owner, organizationId: workspaceId }),
      { fieldName: "uploadTaskImage" },
    );

  it("SVG déclaré image/svg+xml : refusé, rien n'est envoyé au stockage", async () => {
    const result = await send("dessin.svg", "image/svg+xml");
    expect(result.success).toBe(false);
    expect(r2.uploadTaskImage).not.toHaveBeenCalled();
  });

  it("SVG déclaré image/png : le type déclaré est transmis au stockage", async () => {
    const result = await send("dessin.svg", "image/png");
    expect(result.success).toBe(true);
    expect(r2.uploadTaskImage).toHaveBeenCalledTimes(1);
    expect(r2.uploadTaskImage.mock.calls[0][6]).toBe("image/png");
  });
});
