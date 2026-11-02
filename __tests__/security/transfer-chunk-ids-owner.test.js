/**
 * Création d'un transfert à partir d'identifiants de fichiers : seuls les
 * fichiers de l'utilisateur peuvent entrer dans son transfert
 * (createFileTransferWithIdsR2, l'envoi actuel). L'envoi en morceaux
 * historique (createFileTransferWithIds) est retiré : il ne crée plus rien.
 *
 * getFileInfoByTransferId cherchait le fichier par nom d'origine ou nom de
 * stockage dans TOUS les transferts « chunk », R2 compris. Le nom de stockage
 * est renvoyé aux destinataires par getFileTransferByLink : un destinataire
 * d'un transfert payant recopiait le fichier dans un transfert à lui et
 * récupérait son adresse de stockage, sans payer ni filigrane.
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
// Aucun appel réel à R2
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: {},
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import { toPublicTransferFiles } from "../../src/utils/transferAccess.js";
import chunkUploadResolvers from "../../src/resolvers/chunkUpload.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";

const { Mutation } = chunkUploadResolvers;

const STORAGE_URL =
  "https://transfer.test/prod/2026/10/12/t_v/fid123_contrat.pdf";

let victimId;
let victimWorkspace;
let attackerId;
let attackerWorkspace;

const errorOf = async (promiseFactory) => {
  try {
    await promiseFactory();
  } catch (error) {
    return error;
  }
  return null;
};
const codeOf = (error) => error?.extensions?.code || error?.code;

let insertedIdSeed = 0;
const insertTransfer = async (userId, workspaceId, file, extra = {}) => {
  const { insertedId } = await FileTransfer.collection.insertOne({
    userId,
    workspaceId: String(workspaceId),
    files: [
      {
        mimeType: "application/pdf",
        size: 2048,
        uploadedAt: new Date(),
        ...file,
      },
    ],
    totalSize: 2048,
    status: "active",
    uploadMethod: "chunk",
    shareLink: `lien-${insertedIdSeed++}`,
    accessKey: "cle",
    expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    ...extra,
  });
  return FileTransfer.findById(insertedId);
};

const createWithIds = (fileIds) =>
  chunkUploadR2Resolvers.Mutation.createFileTransferWithIdsR2(
    {},
    { fileIds, input: { workspaceId: String(attackerWorkspace) } },
    buildContext({ userId: attackerId, organizationId: attackerWorkspace }),
  );

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  victimId = buildUserId();
  victimWorkspace = buildOrganizationId();
  attackerId = buildUserId();
  attackerWorkspace = buildOrganizationId();
  await seedOrgMembership({
    userId: victimId,
    organizationId: victimWorkspace,
  });
  await seedOrgMembership({
    userId: attackerId,
    organizationId: attackerWorkspace,
  });
});

describe("fichiers d'un autre utilisateur", () => {
  let victimTransfer;

  beforeEach(async () => {
    // Transfert R2 payant du propriétaire, reçu par l'attaquant
    victimTransfer = await insertTransfer(
      victimId,
      victimWorkspace,
      {
        originalName: "contrat.pdf",
        displayName: "contrat.pdf",
        fileName: "fid123_contrat.pdf",
        filePath: STORAGE_URL,
        r2Key: "prod/2026/10/12/t_v/fid123_contrat.pdf",
        storageType: "r2",
        fileId: "fid123",
      },
      { isPaymentRequired: true, paymentAmount: 50, isPaid: false },
    );
  });

  it("refuse le nom de stockage lu dans le lien public", async () => {
    const [publicFile] = toPublicTransferFiles(victimTransfer);
    const error = await errorOf(() => createWithIds([publicFile.fileName]));
    expect(codeOf(error)).toBeTruthy();
    expect(codeOf(error)).not.toBe("METHOD_RETIRED");
    expect(await FileTransfer.countDocuments({ userId: attackerId })).toBe(0);
  });

  it("refuse le nom d'origine du fichier", async () => {
    const error = await errorOf(() => createWithIds(["contrat.pdf"]));
    expect(codeOf(error)).toBeTruthy();
    expect(codeOf(error)).not.toBe("METHOD_RETIRED");
    expect(await FileTransfer.countDocuments({ userId: attackerId })).toBe(0);
  });
});

describe("envoi en morceaux historique", () => {
  it("createFileTransferWithIds retirée : refusée, rien n'est créé", async () => {
    await insertTransfer(attackerId, attackerWorkspace, {
      originalName: "upload-42",
      displayName: "devis.pdf",
      fileName: "upload-42_devis.pdf",
      filePath: "/uploads/upload-42_devis.pdf",
    });
    const avant = await FileTransfer.countDocuments({});
    const error = await errorOf(() =>
      Mutation.createFileTransferWithIds(
        {},
        {
          fileIds: ["upload-42"],
          input: { workspaceId: String(attackerWorkspace) },
        },
        buildContext({ userId: attackerId, organizationId: attackerWorkspace }),
      ),
    );
    expect(codeOf(error)).toBe("METHOD_RETIRED");
    expect(await FileTransfer.countDocuments({})).toBe(avant);
  });
});
