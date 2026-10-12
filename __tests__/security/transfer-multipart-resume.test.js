import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Reprise d'un envoi multipart interrompu (app mobile fermée pendant
// l'envoi) : parts déjà reçues, nouvelles URL des parts manquantes, et
// finalisation rejouée sans effet de bord.

vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

// Redis simulé en mémoire : les métadonnées passent par le cache partagé
const redisStore = vi.hoisted(() => new Map());
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async (key) => redisStore.get(key) ?? null,
  cacheSet: async (key, value) => {
    redisStore.set(key, value);
  },
  cacheDel: async (key) => {
    redisStore.delete(key);
  },
  getCacheClient: () => null,
}));

// Aucun appel réel à R2
const r2 = vi.hoisted(() => {
  let counter = 0;
  return {
    startMultipartUpload: vi.fn(
      async (transferId, fileId, fileName, fileSize, mimeType, totalParts) => {
        counter += 1;
        return {
          uploadId: `upload-${counter}`,
          key: `prod/2026/10/11/t_${transferId}/f_${fileId}_${fileName}`,
          presignedUrls: Array.from({ length: totalParts }, (_, i) => ({
            partNumber: i + 1,
            uploadUrl: `https://r2/part-${i + 1}`,
          })),
        };
      },
    ),
    completeMultipartUpload: vi.fn(async (uploadId, key) => ({
      key,
      url: `https://r2/${key}`,
      size: 1024,
      etag: "etag-final",
    })),
    abortMultipartUpload: vi.fn(async () => {}),
    listMultipartUploadParts: vi.fn(async () => [
      { partNumber: 1, etag: "etag-1", size: 52428800 },
      { partNumber: 2, etag: "etag-2", size: 52428800 },
    ]),
    generateMultipartPartUrls: vi.fn(async (uploadId, key, partNumbers) =>
      partNumbers.map((partNumber) => ({
        partNumber,
        uploadUrl: `https://r2/${uploadId}/fresh-${partNumber}`,
      })),
    ),
    deleteFiles: vi.fn(async (keys) => ({ deleted: keys.length, errors: 0 })),
  };
});
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: r2,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";

const { Mutation } = chunkUploadR2Resolvers;

const errorOf = async (promiseFactory) => {
  try {
    await promiseFactory();
  } catch (error) {
    return error;
  }
  return null;
};
const codeOf = (error) => error?.extensions?.code || error?.code;

let userId;
let colleague;
let workspaceId;
let otherWorkspaceId;
let viewerWorkspaceId;
let ctx;
let fileCounter = 0;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  redisStore.clear();
  vi.clearAllMocks();
  userId = buildUserId();
  colleague = buildUserId();
  workspaceId = buildOrganizationId();
  otherWorkspaceId = buildOrganizationId();
  viewerWorkspaceId = buildOrganizationId();
  await seedOrgMembership({ userId, organizationId: workspaceId });
  await seedOrgMembership({ userId, organizationId: otherWorkspaceId });
  await seedOrgMembership({
    userId,
    organizationId: viewerWorkspaceId,
    role: "viewer",
  });
  await seedOrgMembership({ userId: colleague, organizationId: workspaceId });
  ctx = buildContext({ userId, organizationId: workspaceId });
});

const start = async ({ context = ctx, totalParts = 3 } = {}) => {
  fileCounter += 1;
  const fileId = `file-${fileCounter}`;
  const result = await Mutation.startMultipartUpload(
    {},
    {
      transferId: `transfer-${fileCounter}`,
      fileId,
      fileName: "video.mp4",
      fileSize: totalParts * 52428800,
      mimeType: "video/mp4",
      totalParts,
    },
    context,
  );
  return { ...result, fileId };
};

const complete = ({ uploadId, key, fileId }, context = ctx) =>
  Mutation.completeMultipartUpload(
    {},
    { uploadId, key, parts: [{ partNumber: 1, etag: "etag-1" }], fileId },
    context,
  );

const listParts = ({ uploadId, key }, context = ctx) =>
  Mutation.listMultipartUploadParts({}, { uploadId, key }, context);

const refresh = ({ uploadId, key }, partNumbers, context = ctx) =>
  Mutation.refreshMultipartUploadUrls(
    {},
    { uploadId, key, partNumbers },
    context,
  );

const otherMemberCtx = () =>
  buildContext({ userId: colleague, organizationId: workspaceId });

describe("listMultipartUploadParts", () => {
  it("liste les parts reçues par R2 pour l'envoi de l'appelant", async () => {
    const upload = await start();
    const result = await listParts(upload);
    expect(result).toEqual({
      completed: false,
      fileId: upload.fileId,
      totalParts: 3,
      parts: [
        { partNumber: 1, etag: "etag-1", size: 52428800 },
        { partNumber: 2, etag: "etag-2", size: 52428800 },
      ],
    });
    expect(r2.listMultipartUploadParts).toHaveBeenCalledWith(
      upload.uploadId,
      upload.key,
    );
  });

  it("refuse un rôle sans le droit « Créer » des transferts", async () => {
    const upload = await start();
    const error = await errorOf(() =>
      listParts(
        upload,
        buildContext({ userId, organizationId: viewerWorkspaceId }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.listMultipartUploadParts).not.toHaveBeenCalled();
  });

  it("refuse l'envoi d'un autre membre de l'espace", async () => {
    const upload = await start();
    const error = await errorOf(() => listParts(upload, otherMemberCtx()));
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.listMultipartUploadParts).not.toHaveBeenCalled();
  });

  it("refuse depuis un autre espace du même utilisateur", async () => {
    const upload = await start();
    const error = await errorOf(() =>
      listParts(
        upload,
        buildContext({ userId, organizationId: otherWorkspaceId }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.listMultipartUploadParts).not.toHaveBeenCalled();
  });

  it("refuse une clé qui n'est pas celle de l'envoi", async () => {
    const upload = await start();
    const other = await start();
    const error = await errorOf(() =>
      listParts({ uploadId: upload.uploadId, key: other.key }),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.listMultipartUploadParts).not.toHaveBeenCalled();
  });

  it("renvoie null pour un envoi inconnu, sans appeler R2", async () => {
    await expect(
      listParts({ uploadId: "inconnu", key: "prod/x/f_y_z.mp4" }),
    ).resolves.toBeNull();
    expect(r2.listMultipartUploadParts).not.toHaveBeenCalled();
  });

  it("signale un envoi déjà finalisé, sans appeler R2", async () => {
    const upload = await start();
    await complete(upload);
    await expect(listParts(upload)).resolves.toEqual({
      completed: true,
      fileId: upload.fileId,
      totalParts: 3,
      parts: [],
    });
    expect(r2.listMultipartUploadParts).not.toHaveBeenCalled();
  });

  it("oublie un envoi que R2 ne connaît plus", async () => {
    const upload = await start();
    r2.listMultipartUploadParts.mockRejectedValueOnce(
      Object.assign(new Error("NoSuchUpload"), { name: "NoSuchUpload" }),
    );
    await expect(listParts(upload)).resolves.toBeNull();
    // Plus rien à annuler ni à reprendre
    await expect(Mutation.abortMultipartUpload({}, upload, ctx)).resolves.toBe(
      false,
    );
    await expect(listParts(upload)).resolves.toBeNull();
  });

  it("signale une autre erreur de R2", async () => {
    const upload = await start();
    r2.listMultipartUploadParts.mockRejectedValueOnce(
      new Error("R2 indisponible"),
    );
    const error = await errorOf(() => listParts(upload));
    expect(codeOf(error)).toBe("MULTIPART_LIST_ERROR");
  });
});

describe("refreshMultipartUploadUrls", () => {
  it("remet de nouvelles URL pour les parts demandées, sans doublon", async () => {
    const upload = await start();
    const urls = await refresh(upload, [3, 1, 3]);
    expect(r2.generateMultipartPartUrls).toHaveBeenCalledWith(
      upload.uploadId,
      upload.key,
      [3, 1],
    );
    expect(urls.map((u) => u.partNumber).sort()).toEqual([1, 3]);
  });

  it("refuse une part hors de l'envoi", async () => {
    const upload = await start({ totalParts: 3 });
    for (const partNumbers of [[4], [0], [1.5], []]) {
      const error = await errorOf(() => refresh(upload, partNumbers));
      expect(codeOf(error)).toBe("BAD_USER_INPUT");
    }
    expect(r2.generateMultipartPartUrls).not.toHaveBeenCalled();
  });

  it("refuse l'envoi d'un autre membre, d'un autre espace ou une autre clé", async () => {
    const upload = await start();
    const other = await start();
    const attempts = [
      () => refresh(upload, [1], otherMemberCtx()),
      () =>
        refresh(
          upload,
          [1],
          buildContext({ userId, organizationId: otherWorkspaceId }),
        ),
      () =>
        refresh(
          upload,
          [1],
          buildContext({ userId, organizationId: viewerWorkspaceId }),
        ),
      () => refresh({ uploadId: upload.uploadId, key: other.key }, [1]),
    ];
    for (const attempt of attempts) {
      expect(codeOf(await errorOf(attempt))).toBe("FORBIDDEN");
    }
    expect(r2.generateMultipartPartUrls).not.toHaveBeenCalled();
  });

  it("refuse un envoi inconnu ou déjà finalisé", async () => {
    const upload = await start();
    await complete(upload);
    expect(codeOf(await errorOf(() => refresh(upload, [2])))).toBe("FORBIDDEN");
    expect(
      codeOf(
        await errorOf(() =>
          refresh({ uploadId: "inconnu", key: "prod/x/f_y_z.mp4" }, [1]),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(r2.generateMultipartPartUrls).not.toHaveBeenCalled();
  });
});

describe("completeMultipartUpload rejoué", () => {
  it("renvoie le même résultat sans refinaliser ni annuler", async () => {
    const upload = await start();
    const first = await complete(upload);
    const second = await complete(upload);
    expect(second).toEqual(first);
    expect(second.fileId).toBe(upload.fileId);
    expect(r2.completeMultipartUpload).toHaveBeenCalledTimes(1);
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuse de rattacher l'envoi finalisé à un autre fichier", async () => {
    const upload = await start();
    await complete(upload);
    const error = await errorOf(() =>
      complete({ ...upload, fileId: "autre-fichier" }),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("refuse toujours l'envoi finalisé d'un autre membre", async () => {
    const upload = await start();
    await complete(upload);
    const error = await errorOf(() => complete(upload, otherMemberCtx()));
    expect(codeOf(error)).toBe("FORBIDDEN");
  });
});
