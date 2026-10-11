import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";

// Redis simulé : métadonnées d'envoi encore en cache
const redis = vi.hoisted(() => ({ entries: new Map(), available: true }));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async (key) => redis.entries.get(key) ?? null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => (redis.available ? {} : null),
}));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: {},
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import {
  cleanupOrphanTransferFiles,
  datedPrefixes,
} from "../../src/jobs/cleanupOrphanTransferFiles.js";

const NOW = new Date("2026-10-11T12:00:00");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

// Bucket R2 simulé
let objects;
let uploads;
const service = {
  bucketName: "transferts",
  client: {
    send: async (command) => {
      if (command instanceof HeadObjectCommand) {
        const object = objects.get(command.input.Key);
        if (!object) {
          const error = new Error("NotFound");
          error.name = "NotFound";
          throw error;
        }
        return { Metadata: object.metadata };
      }
      if (command instanceof ListMultipartUploadsCommand) {
        return { Uploads: uploads, IsTruncated: false };
      }
      throw new Error("Commande inattendue");
    },
  },
  listObjects: async (prefix) =>
    [...objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, o]) => ({
        key,
        lastModified: o.lastModified,
        size: o.size,
      })),
  deleteFiles: vi.fn(async (keys) => {
    keys.forEach((key) => objects.delete(key));
    return { deleted: keys.length, errors: 0 };
  }),
  abortMultipartUpload: vi.fn(async () => {}),
};

const [todayPrefix, yesterdayPrefix] = datedPrefixes(NOW, 1);

// Fichier finalisé par un envoi : métadonnées R2 posées au démarrage
const putUploaded = (key, fileId, finishedHoursAgo) =>
  objects.set(key, {
    lastModified: hoursAgo(finishedHoursAgo),
    size: 1024,
    metadata: {
      fileid: fileId,
      transferid: `transfert-${fileId}`,
      uploadedat: hoursAgo(finishedHoursAgo + 1).toISOString(),
    },
  });

const attachToTransfer = (files) =>
  FileTransfer.collection.insertOne({
    userId: "u1",
    status: "active",
    files,
  });

const run = (options = {}) =>
  cleanupOrphanTransferFiles({ now: NOW, service, ...options });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  objects = new Map();
  uploads = [];
  redis.entries.clear();
  redis.available = true;
  service.deleteFiles.mockClear();
  service.abortMultipartUpload.mockClear();
});

describe("Nettoyage des fichiers de transfert orphelins", () => {
  it("supprime un fichier finalisé depuis plus de 24 h d'un lot annulé", async () => {
    const key = `${yesterdayPrefix}t_lot/f_abc_video.mp4`;
    putUploaded(key, "abc", 30);

    const stats = await run();

    expect(stats.deleted).toBe(1);
    expect(objects.has(key)).toBe(false);
  });

  it("ne touche jamais un fichier rattaché à un transfert (clé R2 ou fileId)", async () => {
    const byKey = `${yesterdayPrefix}t_a/f_k1_contrat.pdf`;
    const byFileId = `${yesterdayPrefix}t_b/f_k2_devis.pdf`;
    putUploaded(byKey, "k1", 40);
    putUploaded(byFileId, "k2", 40);
    await attachToTransfer([{ r2Key: byKey, fileId: "autre" }]);
    // Transfert expiré : son propre nettoyage s'en charge
    await FileTransfer.collection.insertOne({
      userId: "u2",
      status: "expired",
      files: [{ fileId: "k2" }],
    });

    const stats = await run();

    expect(stats.deleted).toBe(0);
    expect(objects.has(byKey)).toBe(true);
    expect(objects.has(byFileId)).toBe(true);
    expect(service.deleteFiles).not.toHaveBeenCalled();
  });

  it("garde les fichiers récents, d'origine inconnue ou dont l'envoi est encore en cache", async () => {
    const recent = `${todayPrefix}t_r/f_r1_photo.jpg`;
    const unknown = `${yesterdayPrefix}t_u/f_u1_note.txt`;
    const pending = `${yesterdayPrefix}t_p/f_p1_plan.pdf`;
    putUploaded(recent, "r1", 2);
    objects.set(unknown, {
      lastModified: hoursAgo(48),
      size: 10,
      metadata: {},
    });
    putUploaded(pending, "p1", 30);
    redis.entries.set("filetransfer:meta:p1", { r2Key: pending });

    const stats = await run();

    expect(stats.deleted).toBe(0);
    expect([...objects.keys()].sort()).toEqual(
      [recent, unknown, pending].sort(),
    );
  });

  it("ne parcourt que les préfixes datés de prod/", async () => {
    const trash = "_backoffice_trash/backup1/prod/2026/10/01/t_x/f_x_doc.pdf";
    objects.set(trash, {
      lastModified: hoursAgo(200),
      size: 10,
      metadata: { fileid: "x" },
    });

    await run();

    expect(objects.has(trash)).toBe(true);
  });

  it("annule les envois multipart abandonnés depuis plus de 24 h", async () => {
    uploads = [
      { UploadId: "ancien", Key: "prod/k1", Initiated: hoursAgo(30) },
      { UploadId: "recent", Key: "prod/k2", Initiated: hoursAgo(3) },
      { UploadId: "connu", Key: "prod/k3", Initiated: hoursAgo(30) },
    ];
    redis.entries.set("filetransfer:meta:multipart:connu", { key: "prod/k3" });

    const stats = await run();

    expect(stats.abortedUploads).toBe(1);
    expect(service.abortMultipartUpload).toHaveBeenCalledWith(
      "ancien",
      "prod/k1",
    );
  });

  it("simulation : liste sans rien supprimer", async () => {
    const key = `${yesterdayPrefix}t_lot/f_sim_archive.zip`;
    putUploaded(key, "sim", 30);
    uploads = [{ UploadId: "ancien", Key: "prod/k1", Initiated: hoursAgo(30) }];

    const stats = await run({ dryRun: true });

    expect(stats.keys).toEqual([key]);
    expect(objects.has(key)).toBe(true);
    expect(service.deleteFiles).not.toHaveBeenCalled();
    expect(service.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("ne supprime rien sans Redis (envois en attente invisibles)", async () => {
    redis.available = false;
    const key = `${yesterdayPrefix}t_lot/f_nr_doc.pdf`;
    putUploaded(key, "nr", 30);

    const stats = await run();

    expect(stats.skipped).toBe(true);
    expect(objects.has(key)).toBe(true);
  });
});
