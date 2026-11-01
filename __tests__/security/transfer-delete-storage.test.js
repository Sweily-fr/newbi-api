/**
 * Transfert supprimé ou expiré : fichiers et aperçus effacés de R2.
 *
 * deleteFileTransfer passait le transfert à « deleted » puis appelait une
 * suppression qui ne traite que le disque local (filePath R2 = URL) ; le job
 * d'expiration ne repasse que sur les transferts actifs. Les fichiers d'un
 * transfert supprimé restaient donc sur R2, et les aperçus <clé>.preview.jpg
 * n'étaient jamais effacés. R2 est simulé.
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

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

const r2 = vi.hoisted(() => ({
  deleteFiles: vi.fn(async (keys) => ({ deleted: keys.length, errors: 0 })),
  deleteFile: vi.fn(async () => true),
}));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: r2,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";
import { markExpiredTransfersAndDeleteR2 } from "../../src/jobs/cleanupExpiredFiles.js";

const { Mutation } = fileTransferResolvers;

let userId;
let workspace;
let ctx;

const fichierR2 = (key) => ({
  originalName: key.split("/").pop(),
  fileName: key.split("/").pop(),
  filePath: `https://transferts.example/${key}`,
  r2Key: key,
  mimeType: "image/jpeg",
  size: 2048,
  storageType: "r2",
  fileId: key,
});

const transfert = (keys, extra = {}) =>
  FileTransfer.create({
    userId,
    workspaceId: workspace,
    shareLink: `lien-${new mongoose.Types.ObjectId()}`,
    accessKey: "k".repeat(32),
    files: keys.map(fichierR2),
    totalSize: 2048 * keys.length,
    expiryDate: new Date(Date.now() + 86_400_000),
    status: "active",
    uploadMethod: "chunk",
    ...extra,
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
  r2.deleteFiles.mockClear();
  r2.deleteFile.mockClear();
  userId = buildUserId();
  workspace = buildOrganizationId();
  await seedOrgMembership({ userId, organizationId: workspace });
  ctx = buildContext({ userId, organizationId: workspace });
});

const supprimer = (t) =>
  Mutation.deleteFileTransfer({}, { id: t._id.toString() }, ctx);

describe("deleteFileTransfer : fichiers R2 effacés", () => {
  it("le fichier et son aperçu sont supprimés de R2", async () => {
    const t = await transfert(["prod/2026/10/10/t_a/f_1_photo.jpg"]);

    expect(await supprimer(t)).toBe(true);

    expect((await FileTransfer.findById(t._id)).status).toBe("deleted");
    const cles = r2.deleteFiles.mock.calls.flatMap(([keys]) => keys);
    expect(cles).toEqual(
      expect.arrayContaining([
        "prod/2026/10/10/t_a/f_1_photo.jpg",
        "prod/2026/10/10/t_a/f_1_photo.jpg.preview.jpg",
      ]),
    );
  });

  it("un fichier repris par un autre transfert en ligne est gardé", async () => {
    const partage = "prod/2026/10/10/t_b/f_1_plan.pdf";
    const propre = "prod/2026/10/10/t_b/f_2_devis.pdf";
    const t = await transfert([partage, propre]);
    await transfert([partage]);

    await supprimer(t);

    const cles = r2.deleteFiles.mock.calls.flatMap(([keys]) => keys);
    expect(cles).toContain(propre);
    expect(cles).not.toContain(partage);
  });

  it("le transfert d'un autre utilisateur n'est ni supprimé ni effacé", async () => {
    const autre = await FileTransfer.create({
      userId: buildUserId(),
      workspaceId: workspace,
      shareLink: "lien-autre",
      accessKey: "a".repeat(32),
      files: [fichierR2("prod/2026/10/10/t_c/f_1_x.jpg")],
      totalSize: 2048,
      expiryDate: new Date(Date.now() + 86_400_000),
      status: "active",
    });

    await expect(supprimer(autre)).rejects.toThrow(/non trouvé/);
    expect((await FileTransfer.findById(autre._id)).status).toBe("active");
    expect(r2.deleteFiles).not.toHaveBeenCalled();
  });

  it("R2 injoignable : la suppression du transfert aboutit quand même", async () => {
    r2.deleteFiles.mockRejectedValueOnce(new Error("R2 indisponible"));
    const t = await transfert(["prod/2026/10/10/t_d/f_1_x.jpg"]);

    expect(await supprimer(t)).toBe(true);
    expect((await FileTransfer.findById(t._id)).status).toBe("deleted");
  });
});

describe("Job d'expiration : aperçus effacés avec les fichiers", () => {
  it("transfert expiré : fichier et aperçu supprimés, transfert « deleted »", async () => {
    const t = await transfert(["prod/2026/10/01/t_e/f_1_x.heic"], {
      expiryDate: new Date(Date.now() - 1000),
    });

    await markExpiredTransfersAndDeleteR2();

    const cles = r2.deleteFile.mock.calls.map(([key]) => key);
    expect(cles).toEqual(
      expect.arrayContaining([
        "prod/2026/10/01/t_e/f_1_x.heic",
        "prod/2026/10/01/t_e/f_1_x.heic.preview.jpg",
      ]),
    );
    expect((await FileTransfer.findById(t._id)).status).toBe("deleted");
  });

  it("transfert encore valide : rien n'est supprimé", async () => {
    const t = await transfert(["prod/2026/10/10/t_f/f_1_x.jpg"]);

    await markExpiredTransfersAndDeleteR2();

    expect(r2.deleteFile).not.toHaveBeenCalled();
    expect((await FileTransfer.findById(t._id)).status).toBe("active");
  });
});
