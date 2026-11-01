/**
 * Un même objet R2 sert parfois à plusieurs documents de l'espace : facture
 * importée convertie en facture d'achat, justificatif de transaction devenu
 * facture d'achat puis délié. Supprimer l'un des documents ne doit jamais
 * effacer le fichier que l'autre affiche encore.
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

const r2 = vi.hoisted(() => ({ deleted: [] }));

vi.mock("../../src/services/cloudflareService.js", () => {
  const keyOf = (url) => {
    const m = /^https:\/\/([a-z]+)\.r2\.test\/(.+)$/.exec(url || "");
    return m ? { bucket: m[1], key: m[2] } : null;
  };
  return {
    default: {
      importedInvoicesBucketName: "imported",
      receiptsBucketName: "receipts",
      resolveBucketAndKeyFromUrl: keyOf,
      resolveWorkspaceFileUrl: () => ({ bucket: "ocr", key: "k" }),
      deleteImage: async (key, bucket) => {
        r2.deleted.push(`${bucket}/${key}`);
        return true;
      },
      deleteImageByUrl: async (url) => {
        const resolved = keyOf(url);
        r2.deleted.push(`${resolved.bucket}/${resolved.key}`);
        return true;
      },
    },
  };
});
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/transactionReceiptOcrService.js", () => ({
  default: {
    processReceiptsForTransaction: vi.fn().mockResolvedValue(undefined),
    processUploadedReceipts: vi.fn().mockResolvedValue(undefined),
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import Transaction from "../../src/models/Transaction.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";
import bankingResolvers from "../../src/resolvers/banking.js";

const { ObjectId } = mongoose.Types;
const owner = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);
const ctx = () => buildContext({ userId: owner, organizationId });
const PI = purchaseInvoiceResolvers.Mutation;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  r2.deleted.length = 0;
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
});

async function importedInvoice(n) {
  const key = `${ws}/gmail-${n}.pdf`;
  return ImportedInvoice.create({
    workspaceId: organizationId,
    importedBy: owner,
    status: "PENDING_REVIEW",
    source: "GMAIL",
    originalInvoiceNumber: `GM-${n}`,
    vendor: { name: `Fournisseur Gmail ${n}` },
    invoiceDate: new Date("2026-10-01T00:00:00.000Z"),
    totalHT: 100,
    totalVAT: 20,
    totalTTC: 120,
    file: {
      url: `https://imported.r2.test/${key}`,
      cloudflareKey: key,
      originalFileName: `facture-${n}.pdf`,
      mimeType: "application/pdf",
      fileSize: 10,
    },
  });
}

const convert = (id) =>
  importedInvoiceResolvers.Mutation.convertImportedInvoiceToPurchaseInvoice(
    null,
    { id: String(id), forceCreate: true },
    ctx(),
  );

describe("facture importée convertie en facture d'achat", () => {
  it("supprimer la facture importée garde le fichier de la facture d'achat", async () => {
    const imported = await importedInvoice(1);
    const purchase = await convert(imported._id);

    await importedInvoiceResolvers.Mutation.deleteImportedInvoice(
      null,
      { id: String(imported._id) },
      ctx(),
    );

    expect(r2.deleted).toEqual([]);
    const kept = await PurchaseInvoice.findById(purchase._id).lean();
    expect(kept.files[0].url).toBe(imported.file.url);
  });

  it("suppression groupée : même chose, une importée non convertie perd son fichier", async () => {
    const converted = await importedInvoice(2);
    const alone = await importedInvoice(3);
    await convert(converted._id);

    await importedInvoiceResolvers.Mutation.deleteImportedInvoices(
      null,
      { ids: [String(converted._id), String(alone._id)] },
      ctx(),
    );

    expect(r2.deleted).toEqual([`imported/${alone.file.cloudflareKey}`]);
  });

  it("supprimer la facture d'achat garde le fichier de la facture importée", async () => {
    const imported = await importedInvoice(4);
    const purchase = await convert(imported._id);

    await PI.deletePurchaseInvoice(null, { id: String(purchase._id) }, ctx());

    expect(r2.deleted).toEqual([]);
    expect(await ImportedInvoice.exists({ _id: imported._id })).toBeTruthy();
  });

  it("une fois les deux supprimés, le fichier part avec le dernier", async () => {
    const imported = await importedInvoice(5);
    const purchase = await convert(imported._id);

    await PI.deletePurchaseInvoice(null, { id: String(purchase._id) }, ctx());
    await importedInvoiceResolvers.Mutation.deleteImportedInvoice(
      null,
      { id: String(imported._id) },
      ctx(),
    );

    expect(r2.deleted).toEqual([`imported/${imported.file.cloudflareKey}`]);
  });
});

describe("deux factures d'achat avec le même fichier", () => {
  const file = (key) => ({
    _id: new ObjectId(),
    filename: key,
    originalFilename: "facture.pdf",
    mimetype: "application/pdf",
    path: key,
    url: `https://ocr.r2.test/${key}`,
    size: 10,
  });
  const insert = async (files, n) =>
    (
      await PurchaseInvoice.collection.insertOne({
        workspaceId: organizationId,
        createdBy: owner,
        supplierName: "Fournisseur Partagé",
        invoiceNumber: `PART-${n}`,
        issueDate: new Date(),
        amountTTC: 50,
        status: "TO_PAY",
        files,
        linkedTransactionIds: [],
      })
    ).insertedId;

  it("supprimer l'une garde le fichier de l'autre ; supprimer la seconde l'efface", async () => {
    const key = `${ws}/partage.pdf`;
    const a = await insert([file(key)], 1);
    const b = await insert([file(key)], 2);

    await PI.deletePurchaseInvoice(null, { id: String(a) }, ctx());
    expect(r2.deleted).toEqual([]);

    await PI.deletePurchaseInvoice(null, { id: String(b) }, ctx());
    expect(r2.deleted).toEqual([`ocr/${key}`]);
  });

  it("suppression groupée des deux : fichier effacé", async () => {
    const key = `${ws}/partage-groupe.pdf`;
    const a = await insert([file(key)], 3);
    const b = await insert([file(key)], 4);

    await PI.bulkDeletePurchaseInvoices(
      null,
      { ids: [String(a), String(b)] },
      ctx(),
    );
    expect(r2.deleted).toEqual([`ocr/${key}`, `ocr/${key}`]);
  });

  it("retirer le fichier de l'une garde celui de l'autre", async () => {
    const key = `${ws}/retrait.pdf`;
    const shared = file(key);
    const a = await insert([shared], 5);
    await insert([file(key)], 6);

    await PI.removePurchaseInvoiceFile(
      null,
      { purchaseInvoiceId: String(a), fileId: String(shared._id) },
      ctx(),
    );

    expect(r2.deleted).toEqual([]);
    const after = await PurchaseInvoice.collection.findOne({ _id: a });
    expect(after.files).toHaveLength(0);
  });
});

describe("justificatif devenu facture d'achat puis délié", () => {
  it("retirer le justificatif de la transaction garde le fichier de la facture", async () => {
    const key = `${ws}/receipts/ticket.pdf`;
    const url = `https://receipts.r2.test/${key}`;
    const transactionId = new ObjectId();
    const receiptId = new ObjectId();
    const { insertedId: purchaseId } =
      await PurchaseInvoice.collection.insertOne({
        workspaceId: organizationId,
        createdBy: owner,
        supplierName: "Fournisseur Ticket",
        issueDate: new Date(),
        amountTTC: 27.4,
        status: "PAID",
        source: "OCR",
        files: [
          {
            _id: new ObjectId(),
            filename: "ticket.pdf",
            originalFilename: "ticket.pdf",
            mimetype: "application/pdf",
            path: key,
            url,
            size: 10,
          },
        ],
        linkedTransactionIds: [transactionId],
        isReconciled: true,
      });
    await Transaction.collection.insertOne({
      _id: transactionId,
      externalId: "tx-ticket",
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -27.4,
      currency: "EUR",
      workspaceId: ws,
      date: new Date(),
      reconciliationStatus: "matched",
      linkedInvoiceIds: [],
      linkedPurchaseInvoiceIds: [purchaseId],
      linkedImportedInvoiceIds: [],
      receiptFiles: [
        {
          _id: receiptId,
          url,
          key,
          filename: "ticket.pdf",
          mimetype: "application/pdf",
          size: 10,
          purchaseInvoiceId: purchaseId,
        },
      ],
    });

    // Délier : le pointeur du justificatif est remis à zéro, la facture
    // garde son fichier.
    await PI.unlinkPurchaseInvoiceFromTransaction(
      null,
      {
        purchaseInvoiceId: String(purchaseId),
        transactionId: String(transactionId),
      },
      ctx(),
    );
    const tx = await Transaction.collection.findOne({ _id: transactionId });
    expect(tx.receiptFiles[0].purchaseInvoiceId).toBeNull();

    const result = await bankingResolvers.Mutation.removeTransactionReceiptFile(
      null,
      {
        transactionId: String(transactionId),
        workspaceId: ws,
        fileId: String(receiptId),
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.receiptFiles).toHaveLength(0);
    expect(r2.deleted).toEqual([]);
    const invoice = await PurchaseInvoice.collection.findOne({
      _id: purchaseId,
    });
    expect(invoice.files[0].url).toBe(url);
  });

  it("un justificatif qui ne sert qu'à la transaction est bien effacé", async () => {
    const key = `${ws}/receipts/seul.pdf`;
    const transactionId = new ObjectId();
    const receiptId = new ObjectId();
    await Transaction.collection.insertOne({
      _id: transactionId,
      externalId: "tx-seul",
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -9,
      currency: "EUR",
      workspaceId: ws,
      date: new Date(),
      receiptFiles: [
        {
          _id: receiptId,
          url: `https://receipts.r2.test/${key}`,
          key,
          filename: "seul.pdf",
          mimetype: "application/pdf",
          size: 10,
          purchaseInvoiceId: null,
        },
      ],
    });

    await bankingResolvers.Mutation.removeTransactionReceiptFile(
      null,
      {
        transactionId: String(transactionId),
        workspaceId: ws,
        fileId: String(receiptId),
      },
      ctx(),
    );

    expect(r2.deleted).toEqual([`receipts/${key}`]);
  });
});
