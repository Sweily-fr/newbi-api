/**
 * Automatisations des documents partagés : tous les justificatifs d'une
 * facture d'achat ou d'une transaction (demande du 19/11/2026).
 *
 * Avant, une seule pièce était copiée par document (la première lisible).
 * Maintenant chaque justificatif DIFFÉRENT rejoint le dossier, à côté de la
 * copie principale ; un même PDF déposé plusieurs fois (même nom, même
 * taille) n'est copié qu'une fois. Les copies faites avant ce changement
 * (sans empreinte) comptent pour le justificatif qu'elles portent : rien
 * n'est recopié, seuls les justificatifs manquants sont ajoutés.
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
import service, {
  forgetAutomationLogs,
} from "../../src/services/documentAutomationService.js";
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";
import {
  distinctSourceFiles,
  fileSignature,
  planExtraCopies,
} from "../../src/utils/automationSourceFile.js";
import { findDuplicateCopies } from "../../scripts/dedoublonner-copies-automatisations.js";

const { ObjectId } = mongoose.Types;
const workspaceId = buildOrganizationId();
const ws = String(workspaceId);
const owner = buildUserId();
let folderId;

const MISSING = "https://r2.invalid/achats/disparu.pdf";

function storage(url) {
  if (url === MISSING) {
    const error = new Error("Request failed with status code 404");
    error.response = { status: 404 };
    return Promise.reject(error);
  }
  return Promise.resolve({ data: Buffer.from(`contenu ${url}`) });
}

const pdf = (name, url, size = 10) => ({
  _id: new ObjectId(),
  filename: `${ws}/${name}`,
  originalFilename: name,
  mimetype: "application/pdf",
  path: `${ws}/${name}`,
  url,
  size,
});

async function paidInvoice(invoiceNumber, files) {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId,
    createdBy: owner,
    supplierName: "Canva",
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

const fire = (id, invoiceNumber = "F-1") =>
  service.executeAutomationsForExpense(
    "PURCHASE_INVOICE_PAID",
    ws,
    {
      documentId: String(id),
      documentType: "purchaseInvoice",
      documentNumber: invoiceNumber,
    },
    String(owner),
  );

const names = async () =>
  (
    await SharedDocument.find({ workspaceId, folderId, trashedAt: null })
      .sort({ name: 1 })
      .lean()
  ).map((d) => d.name);

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

describe("justificatifs différents d'un document", () => {
  it("un même PDF déposé deux fois n'est gardé qu'une fois", () => {
    const a = pdf("facture.pdf", "https://r2.invalid/a1.pdf", 100);
    const aBis = pdf("Facture.pdf", "https://r2.invalid/a2.pdf", 100);
    const b = pdf("recu.pdf", "https://r2.invalid/b.pdf", 50);
    const autreTaille = pdf("facture.pdf", "https://r2.invalid/a3.pdf", 120);
    expect(fileSignature(a)).toBe(fileSignature(aBis));
    expect(distinctSourceFiles([a, aBis, b, autreTaille])).toEqual([
      a,
      b,
      autreTaille,
    ]);
  });

  it("plan : rien sans copie principale dans le dossier", () => {
    const files = [pdf("a.pdf", "u1"), pdf("b.pdf", "u2")];
    expect(planExtraCopies(files, [])).toEqual({ toCopy: [], restore: [] });
  });

  it("plan : une copie ancienne sans empreinte couvre son justificatif", () => {
    const a = pdf("a.pdf", "u1", 10);
    const b = pdf("b.pdf", "u2", 20);
    // Copie de b, faite avant le changement (nom + taille)
    const byName = planExtraCopies(
      [a, b],
      [{ _id: 1, name: "b.pdf", fileSize: 20 }],
    );
    expect(byName.toCopy).toEqual([a]);
    // Copie au nom construit : elle couvre le premier justificatif
    const byOrder = planExtraCopies(
      [a, b],
      [{ _id: 1, name: "facture-achat-F1-Canva.pdf", fileSize: 999 }],
    );
    expect(byOrder.toCopy).toEqual([b]);
  });

  it("plan : copie supplémentaire à la corbeille restaurée, pas recopiée", () => {
    const a = pdf("a.pdf", "u1", 10);
    const b = pdf("b.pdf", "u2", 20);
    const plan = planExtraCopies(
      [a, b],
      [
        {
          _id: 1,
          name: "a.pdf",
          fileSize: 10,
          sourceFileSignature: fileSignature(a),
        },
        {
          _id: 2,
          name: "b.pdf",
          fileSize: 20,
          sourceFileSignature: fileSignature(b),
          trashedAt: new Date(),
        },
      ],
    );
    expect(plan).toEqual({ toCopy: [], restore: [2] });
  });
});

describe("lancement manuel", () => {
  it("copie tous les justificatifs différents, puis rien à la relance", async () => {
    await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50),
      pdf("facture.pdf", "https://r2.invalid/facture-bis.pdf", 100),
    ]);
    await paidInvoice("F-2", [pdf("seule.pdf", "https://r2.invalid/s.pdf")]);
    const auto = await automation();

    const first = await runManually(auto);
    expect(first).toMatchObject({
      status: "COMPLETED",
      message:
        "2 document(s) traité(s) avec succès, 1 justificatif(s) supplémentaire(s)",
    });
    expect(await names()).toEqual(["facture.pdf", "recu.pdf", "seule.pdf"]);

    const again = await runManually(auto);
    expect(again.status).toBe("NO_DOCUMENTS");
    expect(await names()).toHaveLength(3);
  });

  it("facture déjà classée avant le changement : seul le justificatif manquant est ajouté", async () => {
    const id = await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50),
    ]);
    const auto = await automation();
    // Copie principale d'avant : sans empreinte, connue par le journal
    const { insertedId: oldCopy } = await SharedDocument.collection.insertOne({
      name: "facture.pdf",
      originalName: "facture.pdf",
      fileUrl: "https://r2.invalid/shared/old.pdf",
      fileKey: "shared/old.pdf",
      mimeType: "application/pdf",
      fileSize: 100,
      fileExtension: "pdf",
      workspaceId,
      folderId,
      uploadedBy: owner,
      uploadedByName: "Automatisation",
      trashedAt: null,
      createdAt: new Date(),
    });
    await DocumentAutomationLog.create({
      automationId: auto._id,
      workspaceId,
      sourceDocumentType: "purchaseInvoice",
      sourceDocumentId: id,
      sharedDocumentId: oldCopy,
      targetFolderId: folderId,
      status: "SUCCESS",
    });

    const result = await runManually(auto);
    expect(result).toMatchObject({
      status: "COMPLETED",
      message: "1 justificatif(s) supplémentaire(s) copié(s)",
    });
    expect(await names()).toEqual(["facture.pdf", "recu.pdf"]);
  });

  it("justificatif ajouté après coup : la relance l'ajoute, sans rien recopier", async () => {
    const id = await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
    ]);
    const auto = await automation();
    await runManually(auto);
    expect(await names()).toEqual(["facture.pdf"]);

    await PurchaseInvoice.collection.updateOne(
      { _id: id },
      { $push: { files: pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50) } },
    );
    const result = await runManually(auto);
    expect(result.message).toBe("1 justificatif(s) supplémentaire(s) copié(s)");
    expect(await names()).toEqual(["facture.pdf", "recu.pdf"]);
  });

  it("automatisation recréée ou doublée vers le même dossier : aucun doublon", async () => {
    await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50),
    ]);
    const auto = await automation();
    await runManually(auto);
    expect(await names()).toHaveLength(2);

    await forgetAutomationLogs(auto._id, workspaceId);
    await DocumentAutomation.deleteOne({ _id: auto._id });
    const recreated = await automation();
    const second = await automation();
    await runManually(recreated);
    await runManually(second);

    expect(await names()).toEqual(["facture.pdf", "recu.pdf"]);
  });

  it("copie supplémentaire mise à la corbeille : la relance la restaure", async () => {
    await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50),
    ]);
    const auto = await automation();
    await runManually(auto);
    await SharedDocument.updateOne(
      { workspaceId, name: "recu.pdf" },
      { $set: { trashedAt: new Date() } },
    );

    await runManually(auto);
    expect(await names()).toEqual(["facture.pdf", "recu.pdf"]);
    expect(await SharedDocument.countDocuments({ workspaceId })).toBe(2);
  });

  it("justificatif supplémentaire illisible : la copie principale reste un succès", async () => {
    await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("perdu.pdf", MISSING, 50),
    ]);
    const auto = await automation();

    const result = await runManually(auto);
    expect(result).toMatchObject({ status: "COMPLETED", failCount: 0 });
    expect(await names()).toEqual(["facture.pdf"]);
  });
});

describe("déclenchement automatique", () => {
  it("facture d'achat : tous les justificatifs, puis le nouveau seulement", async () => {
    const id = await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50),
    ]);
    await automation();

    await fire(id);
    expect(await names()).toEqual(["facture.pdf", "recu.pdf"]);
    const primary = await SharedDocument.findOne({
      name: "facture.pdf",
    }).lean();
    expect(primary.sourceFileSignature).toBe("facture.pdf|100");

    await fire(id);
    expect(await names()).toHaveLength(2);

    await PurchaseInvoice.collection.updateOne(
      { _id: id },
      {
        $push: { files: pdf("avoir.pdf", "https://r2.invalid/avoir.pdf", 30) },
      },
    );
    await fire(id);
    expect(await names()).toEqual(["avoir.pdf", "facture.pdf", "recu.pdf"]);
  });

  it("transaction : chaque nouveau justificatif déposé rejoint le dossier", async () => {
    const txId = new ObjectId();
    const receipt = (name, size) => ({
      _id: new ObjectId(),
      filename: name,
      mimetype: "application/pdf",
      size,
      url: `https://r2.invalid/${name}`,
    });
    await Transaction.collection.insertOne({
      _id: txId,
      workspaceId: ws,
      amount: -12,
      description: "Achat",
      date: new Date(),
      receiptFiles: [receipt("ticket.pdf", 10), receipt("facture.pdf", 20)],
    });
    await automation("TRANSACTION_RECEIPT");
    const trigger = () =>
      service.executeAutomations(
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

    await trigger();
    expect(await names()).toEqual(["facture.pdf", "ticket.pdf"]);

    await Transaction.collection.updateOne(
      { _id: txId },
      { $push: { receiptFiles: receipt("note.pdf", 30) } },
    );
    await trigger();
    expect(await names()).toEqual(["facture.pdf", "note.pdf", "ticket.pdf"]);
  });
});

describe("script dedoublonner-copies-automatisations", () => {
  it("les copies de justificatifs différents ne sont pas des doublons", async () => {
    await paidInvoice("F-1", [
      pdf("facture.pdf", "https://r2.invalid/facture.pdf", 100),
      pdf("recu.pdf", "https://r2.invalid/recu.pdf", 50),
    ]);
    const auto = await automation();
    await runManually(auto);

    const { groups } = await findDuplicateCopies({ workspaceId: ws });
    expect(groups).toHaveLength(0);

    // Vrai doublon : deux copies du même justificatif
    const copy = await SharedDocument.findOne({ name: "recu.pdf" }).lean();
    const { _id, ...rest } = copy;
    await SharedDocument.collection.insertOne({
      ...rest,
      createdAt: new Date(Date.now() + 1000),
    });
    const after = await findDuplicateCopies({ workspaceId: ws });
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0].duplicates).toHaveLength(1);
  });
});
