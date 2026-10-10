import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

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

// Aucun appel réel à R2 : seul le contrôle d'accès est testé
const r2 = vi.hoisted(() => ({
  startMultipartUpload: vi.fn(async () => ({
    uploadId: "upload-1",
    key: "prod/2026/10/10/t_x/f_y_video.mp4",
    presignedUrls: [{ partNumber: 1, uploadUrl: "https://r2/part-1" }],
  })),
  completeMultipartUpload: vi.fn(async () => ({
    key: "prod/2026/10/10/t_x/f_y_video.mp4",
    url: "https://r2/video.mp4",
    size: 1024,
    etag: "etag",
  })),
}));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: r2,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";
import chunkUploadResolvers from "../../src/resolvers/chunkUpload.js";

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
let ownWorkspace;
let viewerWorkspace;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  r2.startMultipartUpload.mockClear();
  userId = buildUserId();
  ownWorkspace = buildOrganizationId();
  viewerWorkspace = buildOrganizationId();
  await seedOrgMembership({ userId, organizationId: ownWorkspace });
  // « Membre » (viewer) : lecture seule, pas de création de transfert
  await seedOrgMembership({
    userId,
    organizationId: viewerWorkspace,
    role: "viewer",
  });
});

const startArgs = {
  transferId: "transfer-1",
  fileId: "file-1",
  fileName: "video.mp4",
  fileSize: 1024,
  mimeType: "video/mp4",
  totalParts: 1,
};

describe("Création de transfert en morceaux : droit « Créer » exigé", () => {
  it("startMultipartUpload refuse un rôle sans le droit", async () => {
    const error = await errorOf(() =>
      Mutation.startMultipartUpload(
        {},
        startArgs,
        buildContext({ userId, organizationId: viewerWorkspace }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.startMultipartUpload).not.toHaveBeenCalled();
  });

  it("startMultipartUpload accepte un rôle avec le droit", async () => {
    const result = await Mutation.startMultipartUpload(
      {},
      startArgs,
      buildContext({ userId, organizationId: ownWorkspace }),
    );
    expect(result.uploadId).toBe("upload-1");
  });

  it("completeMultipartUpload refuse un rôle sans le droit", async () => {
    const error = await errorOf(() =>
      Mutation.completeMultipartUpload(
        {},
        {
          uploadId: "upload-1",
          key: "prod/2026/10/10/t_x/f_y_video.mp4",
          parts: [{ partNumber: 1, etag: "etag" }],
          transferId: "transfer-1",
          fileId: "file-1",
        },
        buildContext({ userId, organizationId: viewerWorkspace }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
  });

  it("createFileTransferWithIdsR2 contrôle l'espace du transfert (input)", async () => {
    // En-tête sur l'espace où il a le droit, transfert rangé dans l'autre
    const error = await errorOf(() =>
      Mutation.createFileTransferWithIdsR2(
        {},
        {
          fileIds: ["inconnu"],
          input: { workspaceId: viewerWorkspace.toString() },
        },
        buildContext({ userId, organizationId: ownWorkspace }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
  });

  it("createFileTransferWithIdsR2 passe le contrôle avec le droit", async () => {
    const error = await errorOf(() =>
      Mutation.createFileTransferWithIdsR2(
        {},
        {
          fileIds: ["inconnu"],
          input: { workspaceId: ownWorkspace.toString() },
        },
        buildContext({ userId, organizationId: viewerWorkspace }),
      ),
    );
    // Contrôle passé : échoue ensuite sur le fichier inconnu
    expect(codeOf(error)).toBe("FILE_TRANSFER_R2_CREATION_ERROR");
  });

  it("createFileTransferWithIds (envoi local historique) refuse un rôle sans le droit", async () => {
    const error = await errorOf(() =>
      chunkUploadResolvers.Mutation.createFileTransferWithIds(
        {},
        { fileIds: ["inconnu"], input: {} },
        buildContext({ userId, organizationId: viewerWorkspace }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
  });
});
