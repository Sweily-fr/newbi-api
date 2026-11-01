/**
 * Justificatifs envoyés : taille et nombre bornés avant toute lecture
 * complète, et aucun fichier envoyé sur R2 tant que tous ne sont pas
 * valides (pas d'objet orphelin quand un fichier du lot est refusé).
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

const state = vi.hoisted(() => ({ uploads: [], deleted: [], failOn: null }));

vi.mock("../../src/services/cloudflareService.js", async (importOriginal) => {
  const original = await importOriginal();
  const service = original.default;
  service.uploadImage = async (buffer, name, userId, type, orgId) => {
    if (state.failOn === name) throw new Error("R2 indisponible");
    state.uploads.push(name);
    return { key: `${orgId}/${name}`, url: `https://r2.test/${orgId}/${name}` };
  };
  service.deleteImage = async (key) => {
    state.deleted.push(key);
    return true;
  };
  return original;
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

import { Readable } from "stream";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Transaction from "../../src/models/Transaction.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import bankingResolvers from "../../src/resolvers/banking.js";
import { readUploadBounded } from "../../src/utils/boundedUpload.js";

const userId = buildUserId();
const org = buildOrganizationId();
const ws = String(org);
const ctx = () => buildContext({ userId, organizationId: org });

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const EXE = Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1");
const MB = 1024 * 1024;

/**
 * Fichier de `megabytes` Mo produit à la demande, commençant comme un PDF ;
 * `read.chunks` compte les morceaux réellement lus.
 */
function largeFile(megabytes) {
  const read = { chunks: 0 };
  const createReadStream = () =>
    Readable.from(
      (function* () {
        for (let i = 0; i < megabytes; i++) {
          read.chunks += 1;
          const chunk = Buffer.alloc(MB, 0x20);
          if (i === 0) PDF.copy(chunk);
          yield chunk;
        }
      })(),
    );
  return { createReadStream, read };
}

const upload = (buffer, filename, mimetype = "application/pdf") =>
  Promise.resolve({
    createReadStream: () => Readable.from([buffer]),
    filename,
    mimetype,
  });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  state.uploads = [];
  state.deleted = [];
  state.failOn = null;
  await seedOrgMembership({ userId, organizationId: org, role: "owner" });
});

async function insertTransaction() {
  const { insertedId } = await Transaction.collection.insertOne({
    workspaceId: ws,
    amount: -10,
    receiptFiles: [],
  });
  return insertedId.toString();
}

const sendReceipts = (transactionId, files) =>
  bankingResolvers.Mutation.uploadTransactionReceipt(
    null,
    { transactionId, workspaceId: ws, files },
    ctx(),
  );

describe("readUploadBounded", () => {
  it("s'arrête dès que la limite est dépassée", async () => {
    const file = largeFile(100);
    const result = await readUploadBounded(file.createReadStream, 10 * MB);
    expect(result.tooLarge).toBe(true);
    expect(result.buffer).toBeNull();
    expect(file.read.chunks).toBeLessThanOrEqual(12);
  });

  it("rend le fichier entier sous la limite", async () => {
    const result = await readUploadBounded(() => Readable.from([PDF]), 10 * MB);
    expect(result.tooLarge).toBe(false);
    expect(result.buffer.equals(PDF)).toBe(true);
  });
});

describe("uploadTransactionReceipt", () => {
  it("trois fichiers dont le troisième de 11 Mo : refus, rien envoyé", async () => {
    const transactionId = await insertTransaction();
    const big = largeFile(11);

    const result = await sendReceipts(transactionId, [
      upload(PDF, "ticket-1.pdf"),
      upload(PDF, "ticket-2.pdf"),
      Promise.resolve({
        createReadStream: big.createReadStream,
        filename: "gros.pdf",
        mimetype: "application/pdf",
      }),
    ]);

    expect(result).toMatchObject({
      success: false,
      message: "Fichier trop volumineux (gros.pdf). Maximum 10 Mo.",
    });
    expect(state.uploads).toEqual([]);
    const tx = await Transaction.collection.findOne({});
    expect(tx.receiptFiles).toHaveLength(0);
  });

  it("un fichier non PDF dans le lot : refus, rien envoyé", async () => {
    const transactionId = await insertTransaction();

    const result = await sendReceipts(transactionId, [
      upload(PDF, "ticket.pdf"),
      upload(EXE, "outil.exe"),
    ]);

    expect(result.success).toBe(false);
    expect(result.message).toBe("Type de fichier non supporté (outil.exe).");
    expect(state.uploads).toEqual([]);
  });

  it("plus de 20 fichiers : refus avant toute lecture", async () => {
    const transactionId = await insertTransaction();
    let opened = 0;
    const files = Array.from({ length: 21 }, (_, i) =>
      Promise.resolve({
        createReadStream: () => {
          opened += 1;
          return Readable.from([PDF]);
        },
        filename: `ticket-${i}.pdf`,
        mimetype: "application/pdf",
      }),
    );

    const result = await sendReceipts(transactionId, files);

    expect(result).toMatchObject({
      success: false,
      message: "20 justificatifs au plus par envoi.",
    });
    expect(opened).toBe(0);
  });

  it("échec d'envoi du deuxième fichier : le premier est retiré de R2", async () => {
    const transactionId = await insertTransaction();
    state.failOn = "ticket-2.pdf";

    const result = await sendReceipts(transactionId, [
      upload(PDF, "ticket-1.pdf"),
      upload(PDF, "ticket-2.pdf"),
    ]);

    expect(result.success).toBe(false);
    expect(state.uploads).toEqual(["ticket-1.pdf"]);
    expect(state.deleted).toEqual([`${ws}/ticket-1.pdf`]);
    const tx = await Transaction.collection.findOne({});
    expect(tx.receiptFiles).toHaveLength(0);
  });

  it("deux PDF valides : envoyés et enregistrés", async () => {
    const transactionId = await insertTransaction();

    const result = await sendReceipts(transactionId, [
      upload(PDF, "ticket-1.pdf"),
      upload(PDF, "ticket-2.pdf"),
    ]);

    expect(result.success).toBe(true);
    expect(state.uploads).toEqual(["ticket-1.pdf", "ticket-2.pdf"]);
    expect(result.receiptFiles).toHaveLength(2);
  });
});

describe("addPurchaseInvoiceFile (fichier envoyé)", () => {
  async function insertInvoice() {
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: org,
      createdBy: userId,
      supplierName: "Fournisseur Limite",
      issueDate: new Date(),
      amountTTC: 10,
      status: "TO_PROCESS",
      files: [],
    });
    return insertedId.toString();
  }
  const addFile = (purchaseInvoiceId, file) =>
    purchaseInvoiceResolvers.Mutation.addPurchaseInvoiceFile(
      null,
      { purchaseInvoiceId, input: { file } },
      ctx(),
    );

  it("fichier de 30 Mo : refusé, lecture interrompue, rien envoyé", async () => {
    const id = await insertInvoice();
    const big = largeFile(30);

    await expect(
      addFile(
        id,
        Promise.resolve({
          createReadStream: big.createReadStream,
          filename: "scan.pdf",
          mimetype: "application/pdf",
        }),
      ),
    ).rejects.toThrow("Fichier trop volumineux (scan.pdf). Maximum 10 Mo.");
    expect(big.read.chunks).toBeLessThanOrEqual(12);
    expect(state.uploads).toEqual([]);
    const invoice = await PurchaseInvoice.collection.findOne({});
    expect(invoice.files).toHaveLength(0);
  });

  it("exécutable : refusé, rien envoyé", async () => {
    const id = await insertInvoice();
    await expect(
      addFile(id, upload(EXE, "facture.exe", "application/pdf")),
    ).rejects.toThrow("Type de fichier non supporté (facture.exe)");
    expect(state.uploads).toEqual([]);
  });
});
