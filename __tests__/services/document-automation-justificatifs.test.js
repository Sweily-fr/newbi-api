/**
 * Automatisations des documents partagés : justificatif copié et documents
 * sans fichier.
 *
 * Signalé le 19/11/2026 en testant « Fact. achat payée » : 16 réussies et
 * 3 échecs sur 19 factures payées.
 * - Deux factures n'avaient aucun fichier joint : rien à copier, ce n'est pas
 *   un échec. Elles sont maintenant comptées « sans fichier joint ».
 * - Une facture avait deux justificatifs dont le premier avait disparu du
 *   stockage (404) : seul le premier était lu. Le premier fichier lisible est
 *   maintenant copié.
 * - Le message d'échec partiel ne contient plus de tiret long.
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
  getPubSub: () => ({
    publish: async () => {},
    asyncIterator: () => ({}),
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const download = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { get: download, post: vi.fn() } }));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import DocumentAutomation from "../../src/models/DocumentAutomation.js";
import DocumentAutomationLog from "../../src/models/DocumentAutomationLog.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Transaction from "../../src/models/Transaction.js";
import service from "../../src/services/documentAutomationService.js";
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";
import {
  downloadFirstAvailableFile,
  isNoSourceFileError,
} from "../../src/utils/automationSourceFile.js";

const { ObjectId } = mongoose.Types;
const workspaceId = buildOrganizationId();
const ws = String(workspaceId);
const owner = buildUserId();
let folderId;

const MISSING = "https://r2.invalid/achats/disparu.pdf";

function notFound() {
  const error = new Error("Request failed with status code 404");
  error.response = { status: 404 };
  return error;
}

/** Téléchargement simulé : 404 pour MISSING, sinon le contenu de l'URL */
function storage(url) {
  if (url === MISSING) return Promise.reject(notFound());
  return Promise.resolve({ data: Buffer.from(`contenu ${url}`) });
}

const pdf = (name, url) => ({
  filename: `${ws}/${name}`,
  originalFilename: name,
  mimetype: "application/pdf",
  path: `${ws}/${name}`,
  url,
  size: 10,
});

async function paidInvoice(invoiceNumber, files) {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId,
    createdBy: owner,
    supplierName: "Fournisseur",
    invoiceNumber,
    status: "PAID",
    amountTTC: 12,
    files,
    createdAt: new Date(),
  });
  return insertedId;
}

async function automation(triggerType = "PURCHASE_INVOICE_PAID") {
  const { insertedId } = await DocumentAutomation.collection.insertOne({
    name: "Fact. achat payée → Compta",
    workspaceId,
    createdBy: owner,
    triggerType,
    isActive: true,
    actionConfig: {
      targetFolderId: folderId,
      createSubfolder: false,
      documentStatus: "classified",
      tags: [],
    },
    stats: { totalExecutions: 0, failedExecutions: 0 },
    createdAt: new Date(),
  });
  return DocumentAutomation.findById(insertedId);
}

const runManually = (auto) =>
  documentAutomationResolvers.Mutation.runDocumentAutomation(
    null,
    { workspaceId: ws, id: String(auto._id) },
    buildContext({ userId: owner, organizationId: ws }),
    { fieldName: "runDocumentAutomation" },
  );

const copies = () =>
  SharedDocument.find({ workspaceId, folderId, trashedAt: null })
    .sort({ name: 1 })
    .lean();

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
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  download.mockReset();
  download.mockImplementation(storage);
  const { insertedId } = await mongoose.connection.db
    .collection("sharedfolders")
    .insertOne({
      name: "Compta",
      workspaceId,
      createdBy: owner,
      trashedAt: null,
    });
  folderId = insertedId;
});

describe("premier justificatif lisible", () => {
  it("premier fichier disparu du stockage : le suivant est copié", async () => {
    const result = await downloadFirstAvailableFile(
      [pdf("a.pdf", MISSING), pdf("b.pdf", "https://r2.invalid/b.pdf")],
      { get: storage },
    );
    expect(result.file.originalFilename).toBe("b.pdf");
    expect(result.buffer.toString()).toBe("contenu https://r2.invalid/b.pdf");
  });

  it("aucun fichier joint : erreur « sans fichier », pas un échec", async () => {
    const error = await downloadFirstAvailableFile([], { get: storage }).catch(
      (e) => e,
    );
    expect(isNoSourceFileError(error)).toBe(true);
    const sansUrl = await downloadFirstAvailableFile([{ filename: "x.pdf" }], {
      get: storage,
    }).catch((e) => e);
    expect(isNoSourceFileError(sansUrl)).toBe(true);
  });

  it("tous les fichiers disparus : vrai échec, message clair", async () => {
    const one = await downloadFirstAvailableFile([pdf("a.pdf", MISSING)], {
      get: storage,
    }).catch((e) => e);
    expect(isNoSourceFileError(one)).toBe(false);
    expect(one.message).toBe(
      "Le fichier joint n'est plus disponible dans le stockage",
    );
    const two = await downloadFirstAvailableFile(
      [pdf("a.pdf", MISSING), pdf("b.pdf", MISSING)],
      { get: storage },
    ).catch((e) => e);
    expect(two.message).toBe(
      "Aucun des fichiers joints n'est disponible dans le stockage",
    );
  });

  it("fichier vide : le suivant est copié", async () => {
    const get = vi.fn(async (url) => ({
      data: url.endsWith("vide.pdf") ? Buffer.alloc(0) : Buffer.from("ok"),
    }));
    const result = await downloadFirstAvailableFile(
      [
        pdf("vide.pdf", "https://r2.invalid/vide.pdf"),
        pdf("b.pdf", "https://r2.invalid/b.pdf"),
      ],
      { get },
    );
    expect(result.file.originalFilename).toBe("b.pdf");
  });
});

describe("lancement manuel (cas signalé : 16 réussies, 3 échecs)", () => {
  it("factures sans fichier comptées à part, justificatif suivant copié", async () => {
    await paidInvoice("OK-1", [pdf("ok-1.pdf", "https://r2.invalid/ok-1.pdf")]);
    await paidInvoice("SANS-A", []);
    await paidInvoice("SANS-B", undefined);
    await paidInvoice("DEUX", [
      pdf("devis-disparu.pdf", MISSING),
      pdf("devis-present.pdf", "https://r2.invalid/devis-present.pdf"),
    ]);
    const auto = await automation();

    const stats = await service.executeAutomationForExistingDocuments(
      auto,
      ws,
      owner,
    );
    expect(stats).toMatchObject({
      successCount: 2,
      failCount: 0,
      noFileCount: 2,
      firstError: null,
    });
    expect((await copies()).map((d) => d.name)).toEqual([
      "devis-present.pdf",
      "ok-1.pdf",
    ]);
    const saved = await DocumentAutomation.findById(auto._id).lean();
    expect(saved.stats.failedExecutions).toBe(0);
  });

  it("messages : sans fichier signalé, relance sans doublon", async () => {
    await paidInvoice("OK-1", [pdf("ok-1.pdf", "https://r2.invalid/ok-1.pdf")]);
    await paidInvoice("SANS-A", []);
    await paidInvoice("SANS-B", []);
    const auto = await automation();

    const first = await runManually(auto);
    expect(first).toMatchObject({
      status: "COMPLETED",
      failCount: 0,
      message: "1 document(s) traité(s) avec succès, 2 sans fichier joint",
    });

    // Relance : rien de nouveau, rien de recopié, pas d'échec
    const again = await runManually(auto);
    expect(again).toMatchObject({
      status: "COMPLETED",
      failCount: 0,
      message: "Aucun nouveau document à traiter, 2 sans fichier joint",
    });
    expect(await copies()).toHaveLength(1);

    // Automatisation recréée vers le même dossier : toujours aucun doublon
    await DocumentAutomation.deleteOne({ _id: auto._id });
    const recreated = await automation();
    const third = await runManually(recreated);
    expect(third.message).toBe(
      "Tous les documents sont déjà dans le dossier, 2 sans fichier joint",
    );
    expect(await copies()).toHaveLength(1);
  });

  it("échec partiel : message sans tiret long", async () => {
    await paidInvoice("OK-1", [pdf("ok-1.pdf", "https://r2.invalid/ok-1.pdf")]);
    await paidInvoice("PERDU", [pdf("perdu.pdf", MISSING)]);
    const auto = await automation();

    const result = await runManually(auto);
    expect(result).toMatchObject({
      status: "PARTIAL",
      message:
        "1 succès, 1 échec(s). Le fichier joint n'est plus disponible dans le stockage",
    });
    expect(result.message).not.toContain("—");
  });
});

describe("déclenchement automatique", () => {
  it("facture d'achat sans fichier : ignorée, ni échec ni journal FAILED", async () => {
    const id = await paidInvoice("SANS", []);
    const auto = await automation();

    const result = await service.executeAutomationsForExpense(
      "PURCHASE_INVOICE_PAID",
      ws,
      {
        documentId: String(id),
        documentType: "purchaseInvoice",
        documentNumber: "SANS",
      },
      String(owner),
    );

    expect(result.results).toEqual([
      expect.objectContaining({
        success: true,
        skipped: true,
        noSourceFile: true,
      }),
    ]);
    expect(await DocumentAutomationLog.countDocuments()).toBe(0);
    const saved = await DocumentAutomation.findById(auto._id).lean();
    expect(saved.stats.failedExecutions).toBe(0);
    expect(await copies()).toHaveLength(0);
  });

  it("premier justificatif disparu : le suivant est copié", async () => {
    const id = await paidInvoice("DEUX", [
      pdf("devis-disparu.pdf", MISSING),
      pdf("devis-present.pdf", "https://r2.invalid/devis-present.pdf"),
    ]);
    await automation();

    const result = await service.executeAutomationsForExpense(
      "PURCHASE_INVOICE_PAID",
      ws,
      {
        documentId: String(id),
        documentType: "purchaseInvoice",
        documentNumber: "DEUX",
        fileUrl: MISSING,
      },
      String(owner),
    );

    expect(result.results).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect((await copies()).map((d) => d.name)).toEqual(["devis-present.pdf"]);
    expect(
      await DocumentAutomationLog.countDocuments({ status: "FAILED" }),
    ).toBe(0);
  });

  it("transaction : justificatif suivant copié quand le premier a disparu", async () => {
    const txId = new ObjectId();
    await Transaction.collection.insertOne({
      _id: txId,
      workspaceId: ws,
      amount: -12,
      description: "Achat",
      date: new Date(),
      receiptFiles: [
        { _id: new ObjectId(), filename: "ticket-disparu.jpg", url: MISSING },
        {
          _id: new ObjectId(),
          filename: "ticket.jpg",
          mimetype: "image/jpeg",
          url: "https://r2.invalid/ticket.jpg",
        },
      ],
    });
    await automation("TRANSACTION_RECEIPT");

    const result = await service.executeAutomations(
      "TRANSACTION_RECEIPT",
      ws,
      {
        documentId: String(txId),
        documentType: "transaction",
        documentNumber: "",
        clientName: "Achat",
      },
      String(owner),
    );

    expect(result.results).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect((await copies()).map((d) => d.name)).toEqual(["ticket.jpg"]);
  });
});
