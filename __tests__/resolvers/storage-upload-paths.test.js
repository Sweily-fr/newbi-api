import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Readable } from "stream";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

/**
 * Espace de stockage plein : chaque chemin d'envoi refuse le nouveau
 * fichier avec le code STORAGE_QUOTA_EXCEEDED, sans rien écrire sur R2 ;
 * les PDF légaux (archive d'une facture émise) passent et sont comptés.
 */

const cf = vi.hoisted(() => ({
  uploadImage: vi.fn(async (_b, name) => ({
    key: `k/${name}`,
    url: `https://x.r2.dev/k/${name}`,
  })),
  uploadTaskImage: vi.fn(async () => ({
    key: "t/1",
    url: "https://x/t/1",
    fileName: "a.png",
    fileSize: 10,
    contentType: "image/png",
  })),
  uploadDocumentAnnex: vi.fn(async () => ({})),
  uploadInvoicePdf: vi.fn(async (_b, ws, id) => ({
    key: `invoices/${ws}/2026/11/${id}_newbi.pdf`,
  })),
  uploadDocumentPdf: vi.fn(async (type, _b, ws, id) => ({
    key: `${type}s/${ws}/${id}.pdf`,
  })),
}));

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    ...cf,
    invoicesBucketName: "invoices",
    documentBuckets: { quote: "quotes", creditNote: "credit-notes" },
    documentAnnexesBucketName: "annexes",
    sharedDocumentsBucketName: "shared",
    kanbanBucketName: "kanban",
    receiptsBucketName: "receipts",
    ocrBucketName: "ocr",
    deleteImage: vi.fn(),
  },
}));

vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: {
    bucketName: "transfers",
    initiateMultipartUpload: vi.fn(async () => ({ uploadId: "u", key: "k" })),
    generateMultipartUploadUrls: vi.fn(async () => []),
  },
}));

import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";
import taskImageResolvers from "../../src/resolvers/taskImage.js";
import bankingResolvers from "../../src/resolvers/banking.js";
import chunkUploadR2Resolvers from "../../src/resolvers/chunkUploadR2.js";
import documentAnnexResolvers from "../../src/resolvers/documentAnnex.js";
import eInvoicingResolvers from "../../src/resolvers/eInvoicing.js";
import { archiveDocumentPdf } from "../../src/utils/documentArchiveHelper.js";
import Quote from "../../src/models/Quote.js";
import { Task } from "../../src/models/kanban.js";

const GB = 1_000_000_000;
const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = organizationId.toString();
let PDF;
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

const upload = (buffer, filename, mimetype) =>
  Promise.resolve({
    filename,
    mimetype,
    encoding: "7bit",
    createReadStream: () => Readable.from([buffer]),
  });

const ctx = () => buildContext({ userId, organizationId });
const db = () => mongoose.connection.db;

async function usage(totalBytes) {
  await db()
    .collection("workspace_storage_usage")
    .updateOne(
      { workspaceId: ws },
      {
        $set: {
          workspaceId: ws,
          totalBytes,
          byCategory: {},
          byUser: {},
          computedAt: new Date(),
          version: 1,
          stale: false,
          computingUntil: null,
          alertLevel: 100,
        },
      },
      { upsert: true },
    );
}

const refused = (promise) =>
  expect(promise).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });

beforeAll(async () => {
  await startMongo();
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.addPage();
  PDF = Buffer.from(await pdf.save());
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  // Offre TPE (données de test) : 400 Go, espace plein
  await usage(400 * GB);
});

describe("Stockage plein : refus sur chaque chemin d'envoi", () => {
  it("document partagé", async () => {
    await refused(
      sharedDocumentResolvers.Mutation.uploadSharedDocument(
        null,
        { workspaceId: ws, file: upload(PDF, "a.pdf", "application/pdf") },
        ctx(),
      ),
    );
    expect(cf.uploadImage).not.toHaveBeenCalled();
    expect(await db().collection("shareddocuments").countDocuments()).toBe(0);
  });

  it("image de tâche du kanban", async () => {
    const { insertedId } = await Task.collection.insertOne({
      title: "Tâche",
      status: "todo",
      boardId: new mongoose.Types.ObjectId(),
      columnId: new mongoose.Types.ObjectId().toString(),
      workspaceId: organizationId,
      userId,
      images: [],
    });
    const task = { _id: insertedId };
    await refused(
      taskImageResolvers.Mutation.uploadTaskImage(
        null,
        {
          taskId: task._id.toString(),
          workspaceId: ws,
          file: upload(PNG, "a.png", "image/png"),
        },
        ctx(),
      ),
    );
    expect(cf.uploadTaskImage).not.toHaveBeenCalled();
  });

  it("justificatif de transaction", async () => {
    const { insertedId } = await db().collection("transactions").insertOne({
      workspaceId: ws,
      amount: -10,
      receiptFiles: [],
    });
    await refused(
      bankingResolvers.Mutation.uploadTransactionReceipt(
        null,
        {
          transactionId: insertedId.toString(),
          workspaceId: ws,
          files: [upload(PDF, "recu.pdf", "application/pdf")],
        },
        ctx(),
      ),
    );
    expect(cf.uploadImage).not.toHaveBeenCalled();
  });

  it("transfert de fichiers (envoi en plusieurs parties)", async () => {
    await refused(
      chunkUploadR2Resolvers.Mutation.startMultipartUpload(
        null,
        {
          transferId: "t1",
          fileId: "f1",
          fileName: "film.mp4",
          fileSize: 1000,
          mimeType: "video/mp4",
          totalParts: 1,
        },
        ctx(),
      ),
    );
  });

  it("transfert de fichiers (URL présignées) : méthode retirée, aucun envoi possible", async () => {
    await expect(
      chunkUploadR2Resolvers.Mutation.generatePresignedUploadUrls(
        null,
        { fileId: "f2", totalChunks: 1, fileName: "a.zip" },
        ctx(),
      ),
    ).rejects.toMatchObject({ extensions: { code: "METHOD_RETIRED" } });
  });

  it("annexe PDF d'un document", async () => {
    await refused(
      documentAnnexResolvers.Mutation.uploadDocumentAnnex(
        null,
        {
          documentType: "QUOTE",
          workspaceId: ws,
          file: upload(PDF, "cgv.pdf", "application/pdf"),
        },
        ctx(),
      ),
    );
    expect(cf.uploadDocumentAnnex).not.toHaveBeenCalled();
  });

  it("PDF d'un devis généré à la demande", async () => {
    const quote = await Quote.collection.insertOne({
      workspaceId: organizationId,
      status: "PENDING",
      number: "D-1",
    });
    await refused(
      archiveDocumentPdf({
        Model: Quote,
        docType: "quote",
        draftStatus: "DRAFT",
        workspaceId: ws,
        docId: quote.insertedId,
        file: upload(PDF, "devis.pdf", "application/pdf"),
      }),
    );
    expect(cf.uploadDocumentPdf).not.toHaveBeenCalled();
  });
});

describe("Stockage plein : les PDF légaux passent et sont comptés", () => {
  it("archive d'une facture émise", async () => {
    const { default: Invoice } = await import("../../src/models/Invoice.js");
    vi.spyOn(Invoice.prototype, "save").mockResolvedValue(undefined);
    const { insertedId } = await db().collection("invoices").insertOne({
      workspaceId: organizationId,
      status: "PENDING",
      number: "F-1",
      prefix: "F-",
      createdBy: userId,
    });
    await eInvoicingResolvers.Mutation.archiveInvoicePdf(
      null,
      {
        workspaceId: ws,
        invoiceId: insertedId.toString(),
        file: upload(PDF, "f.pdf", "application/pdf"),
      },
      ctx(),
    );
    expect(cf.uploadInvoicePdf).toHaveBeenCalled();
    const counter = await db()
      .collection("workspace_storage_usage")
      .findOne({ workspaceId: ws });
    expect(counter.totalBytes).toBe(400 * GB + PDF.length);
  });

  it("avoir archivé (document comptable légal)", async () => {
    const { default: CreditNote } =
      await import("../../src/models/CreditNote.js");
    vi.spyOn(CreditNote.prototype, "save").mockResolvedValue(undefined);
    const note = await CreditNote.collection.insertOne({
      workspaceId: organizationId,
      status: "CREATED",
      number: "A-1",
    });
    await archiveDocumentPdf({
      Model: CreditNote,
      docType: "creditNote",
      draftStatus: "DRAFT",
      workspaceId: ws,
      docId: note.insertedId,
      file: upload(PDF, "avoir.pdf", "application/pdf"),
    });
    expect(cf.uploadDocumentPdf).toHaveBeenCalled();
  });
});

describe("Espace avec de la place : l'envoi passe et compte", () => {
  it("document partagé enregistré et ajouté au compteur", async () => {
    await usage(GB);
    const result = await sharedDocumentResolvers.Mutation.uploadSharedDocument(
      null,
      { workspaceId: ws, file: upload(PDF, "a.pdf", "application/pdf") },
      ctx(),
    );
    expect(result.success).toBe(true);
    const counter = await db()
      .collection("workspace_storage_usage")
      .findOne({ workspaceId: ws });
    expect(counter.totalBytes).toBe(GB + PDF.length);
    expect(counter.byCategory.sharedDocuments).toBe(PDF.length);
  });
});
