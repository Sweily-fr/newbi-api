/**
 * Automatisations de documents : deux exécutions simultanées pour le même
 * document ne laissent qu'un document partagé. Celle qui arrive en second
 * retire sa copie (document et fichier) au lieu de la laisser en double ;
 * un échec enregistré entre-temps est remplacé par la réussite.
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

const deleteImage = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage,
    sharedDocumentsBucketName: "shared-documents-test",
  },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import DocumentAutomationLog from "../../src/models/DocumentAutomationLog.js";
import { recordAutomationSuccess } from "../../src/services/documentAutomationService.js";

const { ObjectId } = mongoose.Types;
const workspaceId = new ObjectId();
const automationId = new ObjectId();
const sourceDocumentId = new ObjectId();

async function sharedDoc(fileKey) {
  const _id = new ObjectId();
  await SharedDocument.collection.insertOne({
    _id,
    workspaceId,
    name: "facture.pdf",
    fileKey,
    fileUrl: `https://exemple.invalid/${fileKey}`,
  });
  return { _id, workspaceId, fileKey };
}

const logData = (doc) => ({
  automationId,
  workspaceId,
  sourceDocumentType: "invoice",
  sourceDocumentId,
  sourceDocumentNumber: "F-001",
  sharedDocumentId: doc._id,
  status: "SUCCESS",
  fileName: "facture.pdf",
});

beforeAll(async () => {
  await startMongo();
  await DocumentAutomationLog.init();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await DocumentAutomationLog.init();
  deleteImage.mockClear();
});

describe("Document classé deux fois au même instant", () => {
  it("la seconde exécution retire sa copie et renvoie le document déjà classé", async () => {
    const first = await sharedDoc("cle-1");
    const second = await sharedDoc("cle-2");

    const a = await recordAutomationSuccess(logData(first), first);
    const b = await recordAutomationSuccess(logData(second), second);

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(String(b.log.sharedDocumentId)).toBe(String(first._id));
    const remaining = await SharedDocument.find({ workspaceId }).lean();
    expect(remaining.map((d) => d.fileKey)).toEqual(["cle-1"]);
    expect(deleteImage).toHaveBeenCalledWith("cle-2", "shared-documents-test");
    expect(await DocumentAutomationLog.countDocuments()).toBe(1);
  });

  it("deux exécutions simultanées : un seul document partagé", async () => {
    const docs = await Promise.all([sharedDoc("cle-a"), sharedDoc("cle-b")]);
    const results = await Promise.all(
      docs.map((doc) => recordAutomationSuccess(logData(doc), doc)),
    );
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(await SharedDocument.countDocuments({ workspaceId })).toBe(1);
  });

  it("un échec enregistré entre-temps est remplacé, le document gardé", async () => {
    await DocumentAutomationLog.create({
      ...logData({ _id: null }),
      sharedDocumentId: null,
      status: "FAILED",
      error: "PDF indisponible",
    });
    const doc = await sharedDoc("cle-ok");

    const result = await recordAutomationSuccess(logData(doc), doc);

    expect(result.duplicate).toBe(false);
    const log = await DocumentAutomationLog.findOne().lean();
    expect(log.status).toBe("SUCCESS");
    expect(log.error).toBeUndefined();
    expect(String(log.sharedDocumentId)).toBe(String(doc._id));
    expect(await SharedDocument.countDocuments({ workspaceId })).toBe(1);
    expect(deleteImage).not.toHaveBeenCalled();
  });
});
