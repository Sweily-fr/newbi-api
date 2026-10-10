import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

const redis = vi.hoisted(() => ({
  cacheSet: vi.fn(async () => {}),
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: redis.cacheSet,
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

const presigner = vi.hoisted(() => ({
  getSignedUrl: vi.fn(async () => "https://r2.example/part?signature"),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => presigner);

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import cloudflareTransferService from "../../src/services/cloudflareTransferService.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";

const { Mutation } = chunkUploadR2Resolvers;

let ctx;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  redis.cacheSet.mockClear();
  presigner.getSignedUrl.mockClear();
  const userId = buildUserId();
  const organizationId = buildOrganizationId();
  await seedOrgMembership({ userId, organizationId });
  ctx = buildContext({ userId, organizationId });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Envoi multipart de gros fichiers", () => {
  it("signe les URL des parts pour 12 h", async () => {
    vi.spyOn(cloudflareTransferService.client, "send").mockResolvedValue({
      UploadId: "upload-1",
    });

    await cloudflareTransferService.startMultipartUpload(
      "transfer-1",
      "file-1",
      "video.mp4",
      3 * 1024 * 1024 * 1024,
      "video/mp4",
      3,
    );

    expect(presigner.getSignedUrl).toHaveBeenCalledTimes(3);
    for (const [, , options] of presigner.getSignedUrl.mock.calls) {
      expect(options.expiresIn).toBe(12 * 60 * 60);
    }
  });

  it("garde les métadonnées d'un fichier envoyé 24 h pour créer le transfert", async () => {
    vi.spyOn(
      cloudflareTransferService,
      "completeMultipartUpload",
    ).mockResolvedValue({
      key: "prod/2026/10/10/t_transfer-1/f_file-1_video.mp4",
      url: "https://r2.example/video.mp4",
      size: 1024,
      etag: "etag",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await Mutation.completeMultipartUpload(
      {},
      {
        uploadId: "upload-1",
        key: "prod/2026/10/10/t_transfer-1/f_file-1_video.mp4",
        parts: [{ partNumber: 1, etag: "etag" }],
        transferId: "transfer-1",
        fileId: "file-1",
      },
      ctx,
    );
    expect(redis.cacheSet).toHaveBeenCalledWith(
      "filetransfer:meta:file-1",
      expect.objectContaining({ fileId: "file-1" }),
      24 * 60 * 60,
    );

    // Les autres fichiers du lot mettent plus d'une heure à partir
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);

    const result = await Mutation.createFileTransferWithIdsR2(
      {},
      { fileIds: ["file-1"], input: {} },
      ctx,
    );
    expect(result.fileTransfer.files).toHaveLength(1);
    expect(result.fileTransfer.files[0].fileId).toBe("file-1");
  });
});
