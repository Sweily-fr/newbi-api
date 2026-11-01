/**
 * Création d'un transfert : ce que l'API accepte, quel que soit le client.
 *
 *  - taille d'un fichier bornée par l'offre de l'espace (5 / 15 / 50 Go),
 *    refusée avant tout appel à R2 ;
 *  - identifiants d'envoi (repris dans la clé R2 et le nom affiché) sûrs ;
 *  - durée de validité de 1 à 30 jours (les choix du site et de l'app) ;
 *  - mot de passe non vide si le transfert est protégé, titre borné ;
 *  - montant demandé positif, borné, en devise prise en charge ;
 *  - abonnement échu : refus même sans en-tête d'espace.
 * Le stockage R2 est simulé.
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
  startMultipartUpload: vi.fn(async (transferId, fileId, fileName) => ({
    uploadId: `upload-${fileId}`,
    key: `prod/2026/10/10/t_${transferId}/f_${fileId}_${fileName}`,
    presignedUrls: [{ partNumber: 1, uploadUrl: "https://r2/part-1" }],
  })),
  completeMultipartUpload: vi.fn(async (_uploadId, key) => ({
    key,
    url: `https://r2/${key}`,
    size: 1024,
    etag: "etag",
  })),
  deleteFiles: vi.fn(async () => {}),
}));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: r2,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";

const { Mutation } = chunkUploadR2Resolvers;
const GO = 1024 * 1024 * 1024;

const errorOf = async (fn) => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
};
const codeOf = (error) => error?.extensions?.code || error?.code;

let userId;
let workspace;
let ctx;
let seq = 0;

const setPlan = (plan) =>
  mongoose.connection.db
    .collection("subscription")
    .updateOne({ referenceId: workspace.toString() }, { $set: { plan } });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  r2.startMultipartUpload.mockClear();
  r2.deleteFiles.mockClear();
  userId = buildUserId();
  workspace = buildOrganizationId();
  await seedOrgMembership({ userId, organizationId: workspace });
  ctx = buildContext({ userId, organizationId: workspace });
});

const start = (overrides = {}, context = ctx) =>
  Mutation.startMultipartUpload(
    {},
    {
      transferId: "transfer-1",
      fileId: `file-${++seq}`,
      fileName: "video.mp4",
      fileSize: 1024,
      mimeType: "video/mp4",
      totalParts: 1,
      ...overrides,
    },
    context,
  );

/** Envoie un fichier (démarré et finalisé) et renvoie son fileId. */
const envoyer = async () => {
  const fileId = `file-${++seq}`;
  const started = await start({ fileId });
  await Mutation.completeMultipartUpload(
    {},
    {
      uploadId: started.uploadId,
      key: started.key,
      parts: [{ partNumber: 1, etag: "etag" }],
      transferId: "transfer-1",
      fileId,
    },
    ctx,
  );
  return fileId;
};

const creer = async (input) => {
  const fileId = await envoyer();
  return {
    fileId,
    run: () =>
      Mutation.createFileTransferWithIdsR2(
        {},
        { fileIds: [fileId], input: { workspaceId: workspace.toString(), ...input } },
        ctx,
      ),
  };
};

describe("startMultipartUpload : taille bornée par l'offre", () => {
  it("offre Freelance : fichier de 6 Go refusé avec message, sans appel à R2", async () => {
    await setPlan("freelance");
    const error = await errorOf(() => start({ fileSize: 6 * GO, totalParts: 600 }));
    expect(error?.message).toMatch(/taille maximale de votre offre \(5 Go/);
    expect(r2.startMultipartUpload).not.toHaveBeenCalled();
  });

  it("offre Freelance : fichier de 5 Go accepté", async () => {
    await setPlan("freelance");
    const res = await start({ fileSize: 5 * GO, totalParts: 500 });
    expect(res.uploadId).toBeTruthy();
  });

  it("offre TPE : 15 Go accepté, 16 Go refusé", async () => {
    await setPlan("pme");
    expect((await start({ fileSize: 15 * GO, totalParts: 1500 })).uploadId).toBeTruthy();
    const error = await errorOf(() => start({ fileSize: 16 * GO, totalParts: 1600 }));
    expect(error?.message).toMatch(/15 Go/);
  });

  it("offre Entreprise : 50 Go accepté", async () => {
    await setPlan("entreprise");
    expect((await start({ fileSize: 50 * GO, totalParts: 5000 })).uploadId).toBeTruthy();
  });

  it("taille négative refusée", async () => {
    const error = await errorOf(() => start({ fileSize: -5 }));
    expect(error?.message).toMatch(/Taille de fichier invalide/);
    expect(r2.startMultipartUpload).not.toHaveBeenCalled();
  });
});

describe("startMultipartUpload : identifiants sûrs", () => {
  it.each([
    ["transferId", "../autre"],
    ["transferId", "a/b"],
    ["fileId", "<svg onload=alert(1)>"],
    ["fileId", "x".repeat(129)],
  ])("%s « %s » refusé sans appel à R2", async (champ, valeur) => {
    const error = await errorOf(() => start({ [champ]: valeur }));
    expect(error?.message).toMatch(/Identifiant d'envoi invalide/);
    expect(r2.startMultipartUpload).not.toHaveBeenCalled();
  });

  it("UUID du site et de l'application acceptés", async () => {
    const res = await start({
      transferId: "3b241101-e2bb-4255-8caf-4136c566a962",
      fileId: "9f8c7a1e-0d2b-4b8e-9a51-2f0c3e7d6b14",
    });
    expect(res.key).toContain("t_3b241101-e2bb-4255-8caf-4136c566a962/");
  });
});

describe("createFileTransferWithIdsR2 : options validées", () => {
  it.each([3650, 0, -1, 2.5, 31])(
    "durée de %s jours refusée avec message, fichiers gardés pour réessayer",
    async (expiryDays) => {
      const { run } = await creer({ expiryDays });
      const error = await errorOf(run);
      expect(error?.message).toMatch(/entre 1 et 30 jours/);
      expect(await FileTransfer.countDocuments()).toBe(0);
      expect(r2.deleteFiles).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 7, 30])("durée de %s jours acceptée", async (expiryDays) => {
    const { run } = await creer({ expiryDays });
    const avant = Date.now();
    const { fileTransfer } = await run();
    const jours = (fileTransfer.expiryDate.getTime() - avant) / 86_400_000;
    expect(Math.round(jours)).toBe(expiryDays);
  });

  it("sans durée : 7 jours", async () => {
    const { run } = await creer({});
    const { fileTransfer } = await run();
    const jours = (fileTransfer.expiryDate.getTime() - Date.now()) / 86_400_000;
    expect(Math.round(jours)).toBe(7);
  });

  it.each([["", "vide"], ["   ", "espaces"], [null, "absent"]])(
    "protégé par un mot de passe %j (%s) : refusé",
    async (password) => {
      const { run } = await creer({ passwordProtected: true, password });
      const error = await errorOf(run);
      expect(error?.message).toMatch(/Saisissez un mot de passe/);
      expect(await FileTransfer.countDocuments()).toBe(0);
    },
  );

  it("titre de 300 caractères refusé", async () => {
    const { run } = await creer({ title: "a".repeat(300) });
    const error = await errorOf(run);
    expect(error?.message).toMatch(/255 caractères/);
  });

  it("vrai titre (accents, « n° », œ) enregistré tel quel", async () => {
    const titre = "Plans n° 12 : maîtrise d'œuvre « Lyon » – été";
    const { run } = await creer({ title: titre });
    const { fileTransfer } = await run();
    const relu = await FileTransfer.findById(fileTransfer._id).lean();
    expect(relu.title).toBe(titre);
  });

  it.each([
    [{ paymentAmount: -5 }, /Montant du paiement invalide/],
    [{ isPaymentRequired: true, paymentAmount: 0 }, /entre 0,50 et 100 000/],
    [{ paymentAmount: 1e9 }, /entre 0,50 et 100 000/],
    [{ paymentAmount: 10, paymentCurrency: "XYZ" }, /Devise non prise en charge/],
  ])("paiement %j refusé", async (input, message) => {
    const { run } = await creer(input);
    const error = await errorOf(run);
    expect(error?.message).toMatch(message);
    expect(await FileTransfer.countDocuments()).toBe(0);
  });

  it("paiement de 19,99 € enregistré au centime", async () => {
    const { run } = await creer({ paymentAmount: 19.99, paymentCurrency: "eur" });
    const { fileTransfer } = await run();
    expect(fileTransfer.isPaymentRequired).toBe(true);
    expect(fileTransfer.paymentAmount).toBe(19.99);
    expect(fileTransfer.paymentCurrency).toBe("EUR");
  });
});

describe("Abonnement échu : création refusée même sans en-tête d'espace", () => {
  it("startMultipartUpload et createFileTransferWithIdsR2 refusés", async () => {
    const expiredUser = buildUserId();
    const expiredWs = buildOrganizationId();
    await seedOrgMembership({
      userId: expiredUser,
      organizationId: expiredWs,
      subscriptionStatus: "expired",
    });
    const sansEntete = {
      ...buildContext({ userId: expiredUser, organizationId: expiredWs }),
      workspaceId: undefined,
      req: { headers: {} },
    };

    const e1 = await errorOf(() => start({}, sansEntete));
    expect(codeOf(e1)).toBe("SUBSCRIPTION_READ_ONLY");
    expect(r2.startMultipartUpload).not.toHaveBeenCalled();

    const e2 = await errorOf(() =>
      Mutation.createFileTransferWithIdsR2(
        {},
        { fileIds: ["file-x"], input: { workspaceId: expiredWs.toString() } },
        sansEntete,
      ),
    );
    expect(codeOf(e2)).toBe("SUBSCRIPTION_READ_ONLY");
    expect(await FileTransfer.countDocuments()).toBe(0);
  });
});
