/**
 * Automatisations des documents partagés : un document Newbi n'est copié
 * qu'une fois par dossier, quelle que soit l'automatisation qui l'y a mis.
 *
 * Signalé le 13/11/2026 : relancer une automatisation recopiait les factures
 * déjà classées. Le journal « déjà copié » était tenu automatisation par
 * automatisation : une automatisation supprimée puis recréée, ou une seconde
 * automatisation vers le même dossier, recopiait tout.
 *
 * Même signalement : les copies automatiques de factures d'achat échouaient
 * toutes (« Aucune URL source pour le fichier ») parce que les appelants
 * passaient fileUrl et que seul cloudflareUrl était lu. Seul le lancement
 * manuel, qui relit le fichier sur la facture, les faisait apparaître.
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

const r2 = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn(async () => true),
    copyToSharedDocuments: vi.fn(async (key, bucket, fileName) => {
      r2.n += 1;
      return {
        url: `https://r2.invalid/${r2.n}/${fileName}`,
        key: `shared/${r2.n}/${fileName}`,
      };
    }),
    uploadImage: vi.fn(async (buffer, fileName) => {
      r2.n += 1;
      return {
        url: `https://r2.invalid/${r2.n}/${fileName}`,
        key: `shared/${r2.n}/${fileName}`,
      };
    }),
    sharedDocumentsBucketName: "shared-test",
    importedInvoicesBucketName: "imported-test",
  },
}));
vi.mock("../../src/services/storage/storageService.js", () => ({
  assertStorageAvailable: vi.fn(async () => true),
  hasStorageAvailable: vi.fn(async () => true),
  recordStoredFile: vi.fn(async () => {}),
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const download = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { get: download, post: vi.fn() } }));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import DocumentAutomation from "../../src/models/DocumentAutomation.js";
import DocumentAutomationLog from "../../src/models/DocumentAutomationLog.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import service, {
  forgetAutomationLogs,
} from "../../src/services/documentAutomationService.js";

const { ObjectId } = mongoose.Types;
const workspaceId = new ObjectId();
const ws = String(workspaceId);
const userId = new ObjectId();
let folderA;
let folderB;

async function folder(name) {
  const { insertedId } = await mongoose.connection.db
    .collection("sharedfolders")
    .insertOne({ name, workspaceId, createdBy: userId, trashedAt: null });
  return insertedId;
}

async function importedInvoices(count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const { insertedId } = await ImportedInvoice.collection.insertOne({
      workspaceId,
      status: "VALIDATED",
      originalInvoiceNumber: `F-${i}`,
      vendor: { name: "Fournisseur" },
      file: {
        url: `https://r2.invalid/imported/${i}.pdf`,
        cloudflareKey: `${ws}/imported-${i}.pdf`,
        originalFileName: `facture-${i}.pdf`,
        mimeType: "application/pdf",
        fileSize: 100,
      },
      createdAt: new Date(),
    });
    ids.push(insertedId);
  }
  return ids;
}

async function automation({
  name = "Facture importée",
  targetFolderId,
  triggerType = "INVOICE_IMPORTED",
} = {}) {
  const { insertedId } = await DocumentAutomation.collection.insertOne({
    name,
    workspaceId,
    createdBy: userId,
    triggerType,
    isActive: true,
    actionConfig: {
      targetFolderId: targetFolderId || folderA,
      createSubfolder: false,
      documentStatus: "classified",
      tags: [],
    },
    stats: { totalExecutions: 0, failedExecutions: 0 },
    createdAt: new Date(),
  });
  return DocumentAutomation.findById(insertedId);
}

const run = (auto) =>
  service.executeAutomationForExistingDocuments(auto, ws, userId);
const copiesIn = (folderId) =>
  SharedDocument.countDocuments({ workspaceId, folderId, trashedAt: null });

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
  download.mockReset();
  folderA = await folder("Compta");
  folderB = await folder("Archives");
});

describe("lancement manuel : une seule copie par dossier", () => {
  it("même automatisation lancée deux fois : rien de recopié", async () => {
    await importedInvoices(3);
    const auto = await automation();

    const first = await run(auto);
    const second = await run(auto);

    expect(first.successCount).toBe(3);
    expect(second.successCount).toBe(0);
    expect(await copiesIn(folderA)).toBe(3);
  });

  it("deux automatisations vers le même dossier : la seconde ne recopie rien", async () => {
    await importedInvoices(3);
    const first = await automation({ name: "A" });
    const second = await automation({ name: "B" });

    await run(first);
    const result = await run(second);

    expect(result.successCount).toBe(0);
    expect(result.alreadyInFolderCount).toBe(3);
    expect(await copiesIn(folderA)).toBe(3);
    // La seconde est rattachée aux copies existantes : relancée, elle les
    // retrouve dans son propre journal
    const logs = await DocumentAutomationLog.find({
      automationId: second._id,
      status: "SUCCESS",
    }).lean();
    const copies = await SharedDocument.find({ workspaceId }).lean();
    expect(logs.map((l) => String(l.sharedDocumentId)).sort()).toEqual(
      copies.map((c) => String(c._id)).sort(),
    );
  });

  it("automatisation supprimée puis recréée : rien de recopié", async () => {
    await importedInvoices(3);
    const before = await automation();
    await run(before);
    // Copies faites avant ce correctif : sans document d'origine noté
    await SharedDocument.collection.updateMany(
      {},
      { $unset: { sourceDocumentType: "", sourceDocumentId: "" } },
    );

    await DocumentAutomation.deleteOne({ _id: before._id });
    await forgetAutomationLogs(before._id, workspaceId);
    expect(await DocumentAutomationLog.countDocuments()).toBe(0);

    const recreated = await automation();
    const result = await run(recreated);

    expect(result.successCount).toBe(0);
    expect(await copiesIn(folderA)).toBe(3);
  });

  it("automatisations vers deux dossiers différents : une copie dans chacun", async () => {
    await importedInvoices(2);
    await run(await automation({ name: "A", targetFolderId: folderA }));
    await run(await automation({ name: "B", targetFolderId: folderB }));

    expect(await copiesIn(folderA)).toBe(2);
    expect(await copiesIn(folderB)).toBe(2);
  });

  it("copie partie à la corbeille d'une autre automatisation : nouvelle copie", async () => {
    const [id] = await importedInvoices(1);
    await run(await automation({ name: "A" }));
    await SharedDocument.updateOne(
      { sourceDocumentId: id },
      { $set: { trashedAt: new Date(), originalFolderId: folderA } },
    );

    const result = await run(await automation({ name: "B" }));

    expect(result.successCount).toBe(1);
    expect(await copiesIn(folderA)).toBe(1);
  });

  it("chaque nouvelle copie note son document d'origine", async () => {
    const [id] = await importedInvoices(1);
    await run(await automation());

    const copy = await SharedDocument.findOne({ workspaceId }).lean();
    expect(copy.sourceDocumentType).toBe("importedInvoice");
    expect(String(copy.sourceDocumentId)).toBe(String(id));
  });
});

describe("déclenchement automatique", () => {
  it("document déjà classé par une autre automatisation : pas de seconde copie", async () => {
    const [id] = await importedInvoices(1);
    await run(await automation({ name: "A" }));
    await automation({ name: "B" });

    const result = await service.executeAutomationsForExpense(
      "INVOICE_IMPORTED",
      ws,
      { documentId: String(id), documentType: "importedInvoice" },
      String(userId),
    );

    expect(result.results.every((r) => r.success && r.skipped)).toBe(true);
    expect(await copiesIn(folderA)).toBe(1);
  });

  it("facture d'achat : le fichier est relu sur la facture (plus d'« Aucune URL source »)", async () => {
    download.mockResolvedValue({ data: Buffer.from("image-justificatif") });
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId,
      createdBy: userId,
      supplierName: "Canva",
      invoiceNumber: "CANVA-1",
      status: "PAID",
      amountTTC: 12,
      files: [
        {
          filename: `${ws}/abc.jpg`,
          originalFilename: "ticket-canva.jpg",
          mimetype: "image/jpeg",
          path: `${ws}/abc.jpg`,
          url: "https://r2.invalid/achats/abc.jpg",
          size: 18,
        },
      ],
      createdAt: new Date(),
    });
    await automation({ triggerType: "PURCHASE_INVOICE_PAID" });

    // Contexte tel que le passent les résolveurs : fileUrl, pas cloudflareUrl
    const result = await service.executeAutomationsForExpense(
      "PURCHASE_INVOICE_PAID",
      ws,
      {
        documentId: String(insertedId),
        documentType: "purchaseInvoice",
        documentNumber: "CANVA-1",
        fileUrl: "https://r2.invalid/achats/abc.jpg",
      },
      String(userId),
    );

    expect(result.results).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect(result.results[0].skipped).toBeUndefined();
    expect(download).toHaveBeenCalledWith(
      "https://r2.invalid/achats/abc.jpg",
      expect.anything(),
    );
    const copy = await SharedDocument.findOne({ workspaceId }).lean();
    expect(copy).toMatchObject({
      name: "ticket-canva.jpg",
      mimeType: "image/jpeg",
      fileExtension: "jpg",
      folderId: folderA,
    });
    expect(
      await DocumentAutomationLog.countDocuments({ status: "FAILED" }),
    ).toBe(0);
  });

  it("sans utilisateur (rapprochement, webhook) : copie au nom du créateur de l'automatisation", async () => {
    const [id] = await importedInvoices(1);
    await automation();

    await service.executeAutomationsForExpense(
      "INVOICE_IMPORTED",
      ws,
      { documentId: String(id), documentType: "importedInvoice" },
      null,
    );

    const copy = await SharedDocument.findOne({ workspaceId }).lean();
    expect(String(copy.uploadedBy)).toBe(String(userId));
  });
});
