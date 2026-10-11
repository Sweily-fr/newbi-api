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
    startMultipartUpload: vi.fn(async (transferId, fileId, fileName) => {
      counter += 1;
      return {
        uploadId: `upload-${counter}`,
        key: `prod/2026/10/11/t_${transferId}/f_${fileId}_${fileName}`,
        presignedUrls: [{ partNumber: 1, uploadUrl: "https://r2/part-1" }],
      };
    }),
    completeMultipartUpload: vi.fn(async (uploadId, key) => ({
      key,
      url: `https://r2/${key}`,
      size: 1024,
      etag: "etag",
    })),
    abortMultipartUpload: vi.fn(async () => {}),
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
import FileTransfer from "../../src/models/FileTransfer.js";
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

const start = async (context = ctx) => {
  fileCounter += 1;
  const fileId = `file-${fileCounter}`;
  const result = await Mutation.startMultipartUpload(
    {},
    {
      transferId: `transfer-${fileCounter}`,
      fileId,
      fileName: "video.mp4",
      fileSize: 1024,
      mimeType: "video/mp4",
      totalParts: 1,
    },
    context,
  );
  return { ...result, fileId };
};

const complete = ({ uploadId, key, fileId }, context = ctx) =>
  Mutation.completeMultipartUpload(
    {},
    { uploadId, key, parts: [{ partNumber: 1, etag: "etag" }], fileId },
    context,
  );

const abort = ({ uploadId, key }, context = ctx) =>
  Mutation.abortMultipartUpload({}, { uploadId, key }, context);

describe("abortMultipartUpload", () => {
  it("annule l'envoi démarré par le même utilisateur dans le même espace", async () => {
    const upload = await start();
    await expect(abort(upload)).resolves.toBe(true);
    expect(r2.abortMultipartUpload).toHaveBeenCalledWith(
      upload.uploadId,
      upload.key,
    );
    // Entrée consommée : un second appel ne trouve plus l'envoi
    await expect(abort(upload)).resolves.toBe(false);
  });

  it("refuse un rôle sans le droit « Créer » des transferts", async () => {
    const upload = await start();
    const error = await errorOf(() =>
      abort(
        upload,
        buildContext({ userId, organizationId: viewerWorkspaceId }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuse une clé qui n'est pas celle de l'envoi", async () => {
    const upload = await start();
    const other = await start();
    const error = await errorOf(() =>
      abort({ uploadId: upload.uploadId, key: other.key }),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuse l'envoi d'un autre membre de l'espace", async () => {
    const upload = await start();
    const error = await errorOf(() =>
      abort(
        upload,
        buildContext({ userId: colleague, organizationId: workspaceId }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuse depuis un autre espace du même utilisateur", async () => {
    const upload = await start();
    const error = await errorOf(() =>
      abort(upload, buildContext({ userId, organizationId: otherWorkspaceId })),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("renvoie false pour un envoi inconnu, sans appeler R2", async () => {
    await expect(
      abort({ uploadId: "inconnu", key: "prod/x/f_y_z.mp4" }),
    ).resolves.toBe(false);
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("renvoie false une fois l'envoi finalisé", async () => {
    const upload = await start();
    await complete(upload);
    await expect(abort(upload)).resolves.toBe(false);
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("considère comme annulé un envoi que R2 ne connaît plus", async () => {
    const upload = await start();
    const noSuchUpload = Object.assign(new Error("NoSuchUpload"), {
      name: "NoSuchUpload",
    });
    r2.abortMultipartUpload.mockRejectedValueOnce(noSuchUpload);
    await expect(abort(upload)).resolves.toBe(true);
  });

  it("signale une autre erreur de R2", async () => {
    const upload = await start();
    r2.abortMultipartUpload.mockRejectedValueOnce(new Error("R2 indisponible"));
    const error = await errorOf(() => abort(upload));
    expect(codeOf(error)).toBe("MULTIPART_ABORT_ERROR");
  });
});

describe("completeMultipartUpload : envoi de l'appelant uniquement", () => {
  it("finalise l'envoi démarré par le même utilisateur dans le même espace", async () => {
    const upload = await start();
    const result = await complete(upload);
    expect(result.success).toBe(true);
    expect(r2.completeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("refuse l'envoi d'un autre membre, sans le finaliser ni l'annuler", async () => {
    const upload = await start();
    const error = await errorOf(() =>
      complete(
        upload,
        buildContext({ userId: colleague, organizationId: workspaceId }),
      ),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.completeMultipartUpload).not.toHaveBeenCalled();
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuse depuis un autre espace ou avec une autre clé", async () => {
    const upload = await start();
    const other = await start();
    expect(
      codeOf(
        await errorOf(() =>
          complete(
            upload,
            buildContext({ userId, organizationId: otherWorkspaceId }),
          ),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      codeOf(
        await errorOf(() =>
          complete({ ...upload, key: other.key, fileId: upload.fileId }),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(r2.completeMultipartUpload).not.toHaveBeenCalled();
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuse un envoi inconnu", async () => {
    const error = await errorOf(() =>
      complete({
        uploadId: "inconnu",
        key: "prod/x/f_y_z.mp4",
        fileId: "file-x",
      }),
    );
    expect(codeOf(error)).toBe("FORBIDDEN");
    expect(r2.completeMultipartUpload).not.toHaveBeenCalled();
    expect(r2.abortMultipartUpload).not.toHaveBeenCalled();
  });
});

describe("createFileTransferWithIdsR2 : fichiers de l'utilisateur uniquement", () => {
  const createWith = (fileIds, context = ctx) =>
    Mutation.createFileTransferWithIdsR2(
      {},
      { fileIds, input: { workspaceId: workspaceId.toString() } },
      context,
    );

  const transferOf = (ownerId, fileId) =>
    FileTransfer.create({
      userId: ownerId,
      workspaceId: workspaceId.toString(),
      uploadMethod: "chunk",
      files: [
        {
          originalName: "contrat.pdf",
          fileName: "contrat.pdf",
          filePath: "https://r2/contrat.pdf",
          r2Key: `prod/2026/10/11/t_z/f_${fileId}_contrat.pdf`,
          mimeType: "application/pdf",
          size: 2048,
          storageType: "r2",
          fileId,
        },
      ],
      totalSize: 2048,
      shareLink: "i".repeat(32),
      accessKey: "j".repeat(32),
      expiryDate: new Date(Date.now() + 86400000),
      passwordProtected: true,
      password: "MotDePasse!2026",
    });

  it("refuse le fichier envoyé par un autre utilisateur (cache)", async () => {
    const colleagueCtx = buildContext({
      userId: colleague,
      organizationId: workspaceId,
    });
    const theirs = await start(colleagueCtx);
    await complete(theirs, colleagueCtx);
    const error = await errorOf(() => createWith([theirs.fileId]));
    expect(error).not.toBeNull();
    expect(await FileTransfer.countDocuments({ userId })).toBe(0);
  });

  it("ne reprend pas le fichier du transfert d'un autre (destinataire)", async () => {
    await transferOf(colleague, "fichier-protege");
    const error = await errorOf(() => createWith(["fichier-protege"]));
    expect(error).not.toBeNull();
    expect(await FileTransfer.countDocuments({ userId })).toBe(0);
  });

  it("reprend toujours un fichier de ses propres transferts", async () => {
    await transferOf(userId, "mon-fichier");
    const result = await createWith(["mon-fichier"]);
    expect(result.fileTransfer.files[0].fileId).toBe("mon-fichier");
  });
});

describe("createFileTransferWithIdsR2 : nettoyage d'un lot sans transfert", () => {
  const create = (fileIds, context = ctx) =>
    Mutation.createFileTransferWithIdsR2(
      {},
      { fileIds, input: { workspaceId: workspaceId.toString() } },
      context,
    );

  it("supprime de R2 les fichiers déjà finalisés si la création échoue", async () => {
    const first = await start();
    await complete(first);
    const error = await errorOf(() => create([first.fileId, "jamais-envoye"]));
    expect(error).not.toBeNull();
    expect(r2.deleteFiles).toHaveBeenCalledWith([first.key]);
  });

  it("ne supprime pas les fichiers envoyés par un autre utilisateur", async () => {
    const colleagueCtx = buildContext({
      userId: colleague,
      organizationId: workspaceId,
    });
    const theirs = await start(colleagueCtx);
    await complete(theirs, colleagueCtx);
    const error = await errorOf(() => create([theirs.fileId, "jamais-envoye"]));
    expect(error).not.toBeNull();
    expect(r2.deleteFiles).not.toHaveBeenCalled();
  });

  it("ne supprime pas un fichier déjà rattaché à un transfert", async () => {
    const first = await start();
    await complete(first);
    await FileTransfer.create({
      userId,
      workspaceId: workspaceId.toString(),
      files: [
        {
          originalName: "video.mp4",
          fileName: "video.mp4",
          filePath: `https://r2/${first.key}`,
          r2Key: first.key,
          mimeType: "video/mp4",
          size: 1024,
          storageType: "r2",
          fileId: first.fileId,
        },
      ],
      totalSize: 1024,
      shareLink: "e".repeat(32),
      accessKey: "f".repeat(32),
      expiryDate: new Date(Date.now() + 86400000),
    });
    const error = await errorOf(() => create([first.fileId, "jamais-envoye"]));
    expect(error).not.toBeNull();
    expect(r2.deleteFiles).not.toHaveBeenCalled();
  });

  it("ne supprime rien quand le transfert est créé", async () => {
    const first = await start();
    await complete(first);
    const result = await create([first.fileId]);
    expect(result.shareLink).toBeTruthy();
    expect(r2.deleteFiles).not.toHaveBeenCalled();
  });
});
