/**
 * Archive PDF d'un devis, d'un bon de commande ou d'un bon de livraison
 * (servie à l'aperçu, au téléchargement et aux envois) : contenu vérifié,
 * jamais remplacée sur un document définitif (devis accepté, bon livré).
 * Chaque refus vient avant l'envoi au stockage.
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
import { Readable } from "node:stream";

const uploadDocumentPdf = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { uploadDocumentPdf },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Quote from "../../src/models/Quote.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import {
  archiveDocumentPdf,
  isPdfContent,
} from "../../src/utils/documentArchiveHelper.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
const HTML = Buffer.from("<!doctype html><html><body>Autre IBAN</body></html>");

const upload = (content, mimetype = "application/pdf") =>
  Promise.resolve({ createReadStream: () => Readable.from([content]), mimetype, filename: "document.pdf" });

async function insert(Model, overrides) {
  const _id = new mongoose.Types.ObjectId();
  await Model.collection.insertOne({
    _id,
    workspaceId,
    createdBy: userId,
    prefix: "D-202610",
    number: "0001",
    client: {
      name: "Client Archive",
      email: "archive@test.fr",
      type: "COMPANY",
      address: { street: "1 rue de l'Archive", city: "Paris", postalCode: "75001", country: "France" },
    },
    issueDate: new Date(),
    items: [{ description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20, unit: "" }],
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

const archiveQuote = (docId, file) =>
  archiveDocumentPdf({
    Model: Quote,
    docType: "quote",
    draftStatus: "DRAFT",
    lockedStatuses: ["COMPLETED"],
    workspaceId: String(workspaceId),
    docId: String(docId),
    file,
  });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  uploadDocumentPdf.mockReset();
  uploadDocumentPdf.mockImplementation(async (type, _buffer, ws, id) => ({ key: `${type}/${ws}/${id}.pdf` }));
});

describe("isPdfContent", () => {
  it("reconnaît l'en-tête d'un PDF, pas une page HTML ni un fichier vide", () => {
    expect(isPdfContent(PDF)).toBe(true);
    expect(isPdfContent(HTML)).toBe(false);
    expect(isPdfContent(Buffer.alloc(0))).toBe(false);
    expect(isPdfContent("%PDF-1.4")).toBe(false);
  });
});

describe("archiveDocumentPdf", () => {
  it("page HTML envoyée comme un PDF : refusée avant le stockage", async () => {
    const id = await insert(Quote, { status: "PENDING" });
    await expect(archiveQuote(id, upload(HTML))).rejects.toThrow(/doit être un PDF/);
    expect(uploadDocumentPdf).not.toHaveBeenCalled();
    expect((await Quote.findById(id)).archivedPdfKey).toBeUndefined();
  });

  it("devis en attente : archivé, puis réarchivé après une modification", async () => {
    const id = await insert(Quote, { status: "PENDING" });
    await archiveQuote(id, upload(PDF));
    await archiveQuote(id, upload(PDF));
    expect(uploadDocumentPdf).toHaveBeenCalledTimes(2);
    expect((await Quote.findById(id)).archivedPdfKey).toBeTruthy();
  });

  it("devis accepté déjà archivé : archive définitive, refus avant le stockage", async () => {
    const id = await insert(Quote, { status: "COMPLETED", archivedPdfKey: "quotes/origine.pdf" });
    await expect(archiveQuote(id, upload(PDF))).rejects.toThrow(/définitive/);
    expect(uploadDocumentPdf).not.toHaveBeenCalled();
    expect((await Quote.findById(id)).archivedPdfKey).toBe("quotes/origine.pdf");
  });

  it("devis accepté sans archive : archivé une fois", async () => {
    const id = await insert(Quote, { status: "COMPLETED" });
    await archiveQuote(id, upload(PDF));
    expect(uploadDocumentPdf).toHaveBeenCalledTimes(1);
  });

  it("bon de livraison livré déjà archivé : refus ; sans archive (après la réception) : archivé", async () => {
    const archive = (docId) =>
      archiveDocumentPdf({
        Model: DeliveryNote,
        docType: "deliveryNote",
        draftStatus: "DRAFT",
        lockedStatuses: ["DELIVERED"],
        workspaceId: String(workspaceId),
        docId: String(docId),
        file: upload(PDF),
      });
    const archived = await insert(DeliveryNote, { prefix: "BL-202610", status: "DELIVERED", archivedPdfKey: "deliveryNotes/origine.pdf" });
    const afterReception = await insert(DeliveryNote, { prefix: "BL-202610", number: "0002", status: "DELIVERED" });
    await expect(archive(archived)).rejects.toThrow(/définitive/);
    await archive(afterReception);
    expect(uploadDocumentPdf).toHaveBeenCalledTimes(1);
  });

  it("brouillon : refusé", async () => {
    const id = await insert(Quote, { status: "DRAFT", number: "DRAFT-0001" });
    await expect(archiveQuote(id, upload(PDF))).rejects.toThrow(/brouillon/);
    expect(uploadDocumentPdf).not.toHaveBeenCalled();
  });
});
