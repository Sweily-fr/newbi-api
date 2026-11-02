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

import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { seedOrgMembership } from "../../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";

// Tailles des objets « présents sur R2 », lues par HEAD ou par liste
const r2Objects = new Map();
const r2Calls = { head: 0, list: 0 };

vi.mock("../../../src/services/cloudflareService.js", () => ({
  default: {
    invoicesBucketName: "invoices-bucket",
    documentBuckets: {
      quote: "quotes-bucket",
      creditNote: "credit-notes-bucket",
      purchaseOrder: "po-bucket",
      deliveryNote: "po-bucket",
    },
    documentAnnexesBucketName: "annexes-bucket",
    emailAttachmentsBucketName: "attachments-bucket",
    sharedDocumentsBucketName: "shared-bucket",
    kanbanBucketName: "kanban-bucket",
    receiptsBucketName: "receipts-bucket",
    ocrBucketName: "ocr-bucket",
    importedInvoicesBucketName: "imported-bucket",
    companyImagesBucketName: "company-bucket",
    signatureBucketName: "signature-bucket",
    resolveBucketAndKeyFromUrl: (url) => {
      const parsed = new URL(url);
      return {
        bucket: parsed.hostname.split(".")[0],
        key: parsed.pathname.replace(/^\//, ""),
      };
    },
    client: {
      send: vi.fn(async (command) => {
        const name = command.constructor.name;
        const { Bucket, Key, Prefix } = command.input;
        if (name === "HeadObjectCommand") {
          r2Calls.head += 1;
          const size = r2Objects.get(`${Bucket}/${Key}`);
          if (size === undefined) {
            const error = new Error("NotFound");
            error.name = "NotFound";
            throw error;
          }
          return { ContentLength: size };
        }
        if (name === "ListObjectsV2Command") {
          r2Calls.list += 1;
          const contents = [...r2Objects.entries()]
            .filter(([path]) => path.startsWith(`${Bucket}/${Prefix}`))
            .map(([path, size]) => ({
              Key: path.slice(Bucket.length + 1),
              Size: size,
            }));
          return { Contents: contents, IsTruncated: false };
        }
        throw new Error(`commande inattendue ${name}`);
      }),
    },
  },
}));

import WorkspaceStorageUsage from "../../../src/models/WorkspaceStorageUsage.js";
import WorkspaceStorageObject from "../../../src/models/WorkspaceStorageObject.js";
import SharedDocument from "../../../src/models/SharedDocument.js";
import Notification from "../../../src/models/Notification.js";
import {
  assertStorageAvailable,
  getWorkspaceStorageState,
  hasStorageAvailable,
  markStorageStale,
  reconcileWorkspaceStorage,
  recordStoredFile,
  recordStoredFileDeleted,
  refreshWorkspaceStorage,
  checkStorageAlerts,
} from "../../../src/services/storage/storageService.js";
import {
  computeWorkspaceStorage,
  registerStorageCollector,
  unregisterStorageCollector,
} from "../../../src/services/storage/storageUsageCompute.js";
import { BYTES_PER_GB } from "../../../src/services/storage/storageConfig.js";

const { ObjectId } = mongoose.Types;
const GB = BYTES_PER_GB;
const MB = 1_000_000;

const userId = buildUserId();
const otherUserId = buildUserId();
const organizationId = buildOrganizationId();
const ws = organizationId.toString();
const otherWs = buildOrganizationId().toString();

function db() {
  return mongoose.connection.db;
}

async function setPlan(plan, extra = {}) {
  await db()
    .collection("subscription")
    .updateOne({ referenceId: ws }, { $set: { plan, ...extra } });
}

async function seedUsage(totalBytes, extra = {}) {
  await WorkspaceStorageUsage.updateOne(
    { workspaceId: ws },
    {
      $set: {
        totalBytes,
        byCategory: { sharedDocuments: totalBytes },
        byUser: { [userId.toString()]: totalBytes },
        computedAt: new Date(),
        version: 1,
        stale: false,
        computingUntil: null,
        ...extra,
      },
    },
    { upsert: true },
  );
}

async function sharedDoc(overrides = {}) {
  const key = `shared-documents/${ws}/${new ObjectId()}.pdf`;
  return db()
    .collection("shareddocuments")
    .insertOne({
      workspaceId: organizationId,
      fileKey: key,
      fileUrl: `https://shared-bucket.r2.dev/${key}`,
      fileSize: 10 * MB,
      uploadedBy: userId,
      trashedAt: null,
      ...overrides,
    });
}

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  r2Objects.clear();
  r2Calls.head = 0;
  r2Calls.list = 0;
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await seedOrgMembership({
    userId: otherUserId,
    organizationId,
    role: "viewer",
  });
});

describe("Stockage : recalcul complet", () => {
  it("additionne les fichiers de l'espace, corbeille comprise, sans les autres espaces", async () => {
    await sharedDoc();
    await sharedDoc({ trashedAt: new Date(), fileSize: 5 * MB });
    await db()
      .collection("shareddocuments")
      .insertOne({
        workspaceId: new ObjectId(otherWs),
        fileKey: "shared-documents/autre/x.pdf",
        fileSize: 99 * MB,
      });

    const result = await computeWorkspaceStorage(ws);
    expect(result.totalBytes).toBe(15 * MB);
    expect(result.byCategory.sharedDocuments).toBe(15 * MB);
    expect(result.byUser[userId.toString()]).toBe(15 * MB);
    expect(result.fileCount).toBe(2);
  });

  it("compte une seule fois un justificatif repris par une facture d'achat", async () => {
    const key = `${ws}/recu.pdf`;
    await db()
      .collection("transactions")
      .insertOne({
        workspaceId: ws,
        receiptFiles: [
          {
            key,
            url: `https://receipts-bucket.r2.dev/${key}`,
            size: 2 * MB,
            uploadedBy: userId.toString(),
          },
        ],
      });
    await db()
      .collection("purchaseinvoices")
      .insertOne({
        workspaceId: organizationId,
        createdBy: otherUserId,
        files: [
          {
            path: key,
            url: `https://receipts-bucket.r2.dev/${key}`,
            size: 2 * MB,
          },
        ],
      });

    const result = await computeWorkspaceStorage(ws);
    expect(result.totalBytes).toBe(2 * MB);
    expect(result.byCategory.receipts).toBe(2 * MB);
    expect(result.byCategory.purchaseInvoices).toBeUndefined();
  });

  it("lit sur R2 la taille des PDF archivés, puis la mémorise", async () => {
    const key = `invoices/${ws}/2026/10/f1_newbi_F-001.pdf`;
    r2Objects.set(`invoices-bucket/${key}`, 300_000);
    await db().collection("invoices").insertOne({
      workspaceId: organizationId,
      archivedPdfKey: key,
      createdBy: userId,
    });

    const first = await computeWorkspaceStorage(ws);
    expect(first.totalBytes).toBe(300_000);
    expect(first.byCategory.billingDocuments).toBe(300_000);
    expect(r2Calls.head).toBe(1);

    const remembered = await WorkspaceStorageObject.findOne({ key }).lean();
    expect(remembered.size).toBe(300_000);
    expect(remembered.source).toBe("head");

    const second = await computeWorkspaceStorage(ws);
    expect(second.totalBytes).toBe(300_000);
    expect(r2Calls.head).toBe(1);
  });

  it("liste le préfixe de l'espace quand beaucoup de tailles manquent", async () => {
    const docs = [];
    for (let i = 0; i < 12; i++) {
      const key = `quotes/${ws}/2026/10/d${i}_newbi.pdf`;
      r2Objects.set(`quotes-bucket/${key}`, 1000);
      docs.push({ workspaceId: organizationId, archivedPdfKey: key });
    }
    // Ancienne archive non référencée : jamais comptée
    r2Objects.set(`quotes-bucket/quotes/${ws}/2026/09/vieux.pdf`, 999_999);
    await db().collection("quotes").insertMany(docs);

    const result = await computeWorkspaceStorage(ws);
    expect(result.totalBytes).toBe(12_000);
    expect(r2Calls.list).toBe(1);
    expect(r2Calls.head).toBe(0);
  });

  it("ne compte que les transferts encore actifs", async () => {
    await db()
      .collection("filetransfers")
      .insertMany([
        {
          workspaceId: ws,
          userId,
          status: "active",
          expiryDate: new Date(Date.now() + 86400000),
          shareLink: "lien-a",
          downloadLink: "telechargement-a",
          files: [{ r2Key: "prod/a", size: 4 * MB }],
        },
        {
          workspaceId: ws,
          userId,
          status: "expired",
          expiryDate: new Date(Date.now() - 86400000),
          shareLink: "lien-b",
          downloadLink: "telechargement-b",
          files: [{ r2Key: "prod/b", size: 40 * MB }],
        },
        {
          workspaceId: ws,
          userId,
          status: "active",
          expiryDate: new Date(Date.now() - 1000),
          shareLink: "lien-c",
          downloadLink: "telechargement-c",
          files: [{ r2Key: "prod/c", size: 40 * MB }],
        },
      ]);
    const result = await computeWorkspaceStorage(ws);
    expect(result.byCategory.transfers).toBe(4 * MB);
  });

  it("additionne les images du kanban et attribue les dépôts", async () => {
    await db()
      .collection("tasks")
      .insertOne({
        workspaceId: organizationId,
        images: [
          { key: "t/1", fileSize: 3 * MB, uploadedBy: userId.toString() },
        ],
        comments: [
          {
            images: [
              { key: "t/2", fileSize: MB, uploadedBy: "external_a@b.fr" },
            ],
          },
        ],
      });
    const result = await computeWorkspaceStorage(ws);
    expect(result.byCategory.kanban).toBe(4 * MB);
    expect(result.byUser[userId.toString()]).toBe(3 * MB);
    expect(result.byUser.unattributed).toBe(MB);
  });

  it("accepte des collecteurs ajoutés par d'autres modules", async () => {
    registerStorageCollector("essai", async ({ workspaceId }) => [
      { key: `extra/${workspaceId}`, size: 7, category: "social" },
    ]);
    try {
      const result = await computeWorkspaceStorage(ws);
      expect(result.byCategory.social).toBe(7);
    } finally {
      unregisterStorageCollector("essai");
    }
  });

  it("met en cache le résultat dans la nouvelle collection", async () => {
    await sharedDoc();
    const doc = await refreshWorkspaceStorage(ws);
    expect(doc.totalBytes).toBe(10 * MB);
    const stored = await db()
      .collection("workspace_storage_usage")
      .findOne({ workspaceId: ws });
    expect(stored.totalBytes).toBe(10 * MB);
    expect(stored.computingUntil).toBeNull();
    expect(stored.stale).toBe(false);
  });
});

describe("Stockage : état et quota", () => {
  it("calcule au premier appel puis donne le quota de l'offre", async () => {
    await sharedDoc();
    const state = await getWorkspaceStorageState(ws);
    expect(state.ready).toBe(true);
    expect(state.plan).toBe("pme");
    expect(state.quotaBytes).toBe(400 * GB);
    expect(state.usedBytes).toBe(10 * MB);
    expect(state.level).toBe("ok");
  });

  it("ajoute les packs actifs au quota de l'offre", async () => {
    await setPlan("freelance");
    await seedUsage(GB, { packs: { quantity: 2, interval: "month" } });
    const state = await getWorkspaceStorageState(ws);
    expect(state.quotaBytes).toBe(175 * GB);
    expect(state.packs).toBe(2);
  });

  it("ignore les packs d'un abonnement qui n'est plus actif", async () => {
    await setPlan("freelance", {
      status: "canceled",
      periodEnd: new Date(Date.now() - 1000),
    });
    await seedUsage(GB, { packs: { quantity: 2, interval: "month" } });
    const state = await getWorkspaceStorageState(ws);
    expect(state.quotaBytes).toBe(75 * GB);
  });

  it("reconnaît les offres « pro » et « enterprise » de la base", async () => {
    await setPlan("enterprise");
    await seedUsage(GB);
    expect((await getWorkspaceStorageState(ws)).quotaBytes).toBe(1000 * GB);
    await setPlan("pro");
    expect((await getWorkspaceStorageState(ws)).quotaBytes).toBe(400 * GB);
  });

  it("passe au niveau d'alerte à 80 % puis à 100 %", async () => {
    await setPlan("freelance");
    await seedUsage(61 * GB);
    expect((await getWorkspaceStorageState(ws)).level).toBe("warning");
    await seedUsage(75 * GB);
    expect((await getWorkspaceStorageState(ws)).level).toBe("full");
  });
});

describe("Stockage : refus des nouveaux envois", () => {
  it("laisse passer un envoi qui tient dans le quota", async () => {
    await setPlan("freelance");
    await seedUsage(70 * GB);
    await expect(assertStorageAvailable(ws, 4 * GB)).resolves.toBeTruthy();
  });

  it("refuse un envoi qui dépasse, avec un code dédié et les propositions", async () => {
    await setPlan("freelance");
    await seedUsage(74 * GB);
    const error = await assertStorageAvailable(ws, 2 * GB).catch((e) => e);
    expect(error.code).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(error.message).toMatch(
      /Espace de stockage plein : 74 Go utilisés sur 75 Go/,
    );
    expect(error.message).toMatch(/Vos fichiers existants restent disponibles/);
    // Ni lien ni prix dans le message (affiché tel quel par l'app mobile)
    expect(error.message).not.toMatch(/newbi\.fr|€|http/);
    expect(error.details.offer.packs.additionalPacks).toBe(1);
    expect(error.details.offer.upgrade.plan).toBe("pme");
    expect(error.details.incomingBytes).toBe(2 * GB);
  });

  it("refuse un envoi de taille inconnue quand l'espace est déjà plein", async () => {
    await setPlan("freelance");
    await seedUsage(75 * GB);
    await expect(assertStorageAvailable(ws, 0)).rejects.toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
    });
    expect(await hasStorageAvailable(ws, 0)).toBe(false);
  });

  it("ne refuse jamais un PDF légal généré automatiquement", async () => {
    await setPlan("freelance");
    await seedUsage(80 * GB);
    await expect(
      assertStorageAvailable(ws, 5 * MB, { legal: true }),
    ).resolves.toBeNull();
  });

  it("laisse passer tant que le premier calcul n'est pas terminé", async () => {
    await WorkspaceStorageUsage.create({
      workspaceId: ws,
      computingUntil: new Date(Date.now() + 60_000),
    });
    const state = await assertStorageAvailable(ws, 500 * GB, { waitMs: 50 });
    expect(state.ready).toBe(false);
  });

  it("ne supprime rien quand l'espace est déjà au-dessus", async () => {
    await sharedDoc({ fileSize: 80 * GB });
    await setPlan("freelance");
    await refreshWorkspaceStorage(ws);
    await expect(assertStorageAvailable(ws, MB)).rejects.toMatchObject({
      code: "STORAGE_QUOTA_EXCEEDED",
    });
    expect(await SharedDocument.countDocuments({})).toBe(1);
    expect((await getWorkspaceStorageState(ws)).usedBytes).toBe(80 * GB);
  });
});

describe("Stockage : compteur à l'envoi et à la suppression", () => {
  it("ajoute un envoi au compteur et le mémorise", async () => {
    await seedUsage(GB);
    await recordStoredFile({
      workspaceId: ws,
      key: "k/1",
      size: 5 * MB,
      category: "kanban",
      userId: userId.toString(),
    });
    const usage = await WorkspaceStorageUsage.findOne({
      workspaceId: ws,
    }).lean();
    expect(usage.totalBytes).toBe(GB + 5 * MB);
    expect(usage.byCategory.kanban).toBe(5 * MB);
    expect(usage.byUser[userId.toString()]).toBe(GB + 5 * MB);
    expect((await WorkspaceStorageObject.findOne({ key: "k/1" })).size).toBe(
      5 * MB,
    );
  });

  it("ne compte que l'écart quand la même clé est réécrite", async () => {
    await seedUsage(0);
    await recordStoredFile({
      workspaceId: ws,
      key: "a.pdf",
      size: 100,
      category: "billingDocuments",
    });
    await recordStoredFile({
      workspaceId: ws,
      key: "a.pdf",
      size: 150,
      category: "billingDocuments",
    });
    const usage = await WorkspaceStorageUsage.findOne({
      workspaceId: ws,
    }).lean();
    expect(usage.totalBytes).toBe(150);
    expect(usage.fileCount).toBe(1);
  });

  it("retire une suppression de taille connue", async () => {
    await seedUsage(GB);
    await recordStoredFile({
      workspaceId: ws,
      key: "x",
      size: 10 * MB,
      category: "sharedDocuments",
    });
    await recordStoredFileDeleted({ workspaceId: ws, key: "x" });
    const usage = await WorkspaceStorageUsage.findOne({
      workspaceId: ws,
    }).lean();
    expect(usage.totalBytes).toBe(GB);
    expect(await WorkspaceStorageObject.countDocuments({ key: "x" })).toBe(0);
  });

  it("marque le compteur à recalculer quand la taille supprimée est inconnue", async () => {
    await seedUsage(GB);
    await recordStoredFileDeleted({ workspaceId: ws, key: "inconnu" });
    const usage = await WorkspaceStorageUsage.findOne({
      workspaceId: ws,
    }).lean();
    expect(usage.stale).toBe(true);
    expect(usage.totalBytes).toBe(GB);
  });

  it("ne crée pas de compteur avant le premier calcul", async () => {
    await recordStoredFile({
      workspaceId: ws,
      key: "y",
      size: 10,
      category: "kanban",
    });
    expect(
      await WorkspaceStorageUsage.countDocuments({ workspaceId: ws }),
    ).toBe(0);
  });
});

describe("Stockage : réconciliation", () => {
  it("recalcule les compteurs périmés à partir de la base", async () => {
    await sharedDoc({ fileSize: 3 * MB });
    await seedUsage(42 * GB);
    await markStorageStale(ws);
    const result = await reconcileWorkspaceStorage();
    expect(result.refreshed).toBe(1);
    const usage = await WorkspaceStorageUsage.findOne({
      workspaceId: ws,
    }).lean();
    expect(usage.totalBytes).toBe(3 * MB);
    expect(usage.stale).toBe(false);
  });

  it("recalcule un compteur de plus de 24 h et laisse les autres", async () => {
    await sharedDoc({ fileSize: 3 * MB });
    await seedUsage(42 * GB, {
      computedAt: new Date(Date.now() - 25 * 3600 * 1000),
    });
    await WorkspaceStorageUsage.create({
      workspaceId: otherWs,
      totalBytes: 7,
      computedAt: new Date(),
      version: 1,
    });
    const result = await reconcileWorkspaceStorage();
    expect(result.candidates).toBe(1);
    const other = await WorkspaceStorageUsage.findOne({
      workspaceId: otherWs,
    }).lean();
    expect(other.totalBytes).toBe(7);
  });
});

describe("Stockage : alertes", () => {
  it("notifie une fois les rôles qui voient l'abonnement à 80 % puis à 100 %", async () => {
    await setPlan("freelance");
    await seedUsage(61 * GB);
    const first = await checkStorageAlerts(ws);
    expect(first).toMatchObject({ level: 80, notified: 1 });
    expect(await checkStorageAlerts(ws)).toBeNull();

    await seedUsage(76 * GB);
    expect(await checkStorageAlerts(ws)).toMatchObject({ level: 100 });

    const notifications = await Notification.find({}).lean();
    expect(notifications.map((n) => n.type).sort()).toEqual([
      "STORAGE_ALMOST_FULL",
      "STORAGE_FULL",
    ]);
    // Le membre en lecture seule (viewer) ne gère pas l'abonnement
    expect(
      notifications.every((n) => String(n.userId) === userId.toString()),
    ).toBe(true);
    expect(notifications[0].data.url).toMatch(/parametres=stockage/);
  });

  it("réarme l'alerte quand l'espace redescend", async () => {
    await setPlan("freelance");
    await seedUsage(61 * GB);
    await checkStorageAlerts(ws);
    await seedUsage(10 * GB);
    await checkStorageAlerts(ws);
    const usage = await WorkspaceStorageUsage.findOne({
      workspaceId: ws,
    }).lean();
    expect(usage.alertLevel).toBe(0);
  });
});
