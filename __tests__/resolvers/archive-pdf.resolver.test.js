/**
 * Archivage du PDF d'une facture ou d'un avoir envoyé par le site
 * (archiveInvoicePdf, archiveCreditNotePdf) : l'archive est le document qui
 * fait foi. Seul un vrai PDF est accepté (type annoncé et contenu « %PDF- »),
 * et l'archive d'une facture payée, annulée ou transmise ne se remplace plus.
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
import mongoose from "mongoose";

const { uploadInvoicePdf, uploadDocumentPdf } = vi.hoisted(() => ({
  uploadInvoicePdf: vi.fn(),
  uploadDocumentPdf: vi.fn(),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { uploadInvoicePdf, uploadDocumentPdf },
}));
vi.mock("../../src/services/creditNoteFacturXArchiveService.js", () => ({
  triggerCreditNoteFacturXArchive: vi.fn(),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import CreditNote from "../../src/models/CreditNote.js";
import eInvoicingResolvers from "../../src/resolvers/eInvoicing.js";
import creditNoteResolvers from "../../src/resolvers/creditNote.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  uploadInvoicePdf.mockReset();
  uploadInvoicePdf.mockResolvedValue({ key: "factures/nouvelle.pdf" });
  uploadDocumentPdf.mockReset();
  uploadDocumentPdf.mockResolvedValue({ key: "avoirs/nouvel.pdf" });
});

const ctx = () =>
  buildContext({ userId, organizationId, extra: { userRole: "owner" } });

const VRAI_PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const HTML = Buffer.from("<html><body>Autre IBAN</body></html>");
const upload = (content, mimetype = "application/pdf") =>
  Promise.resolve({
    filename: "facture.pdf",
    mimetype,
    createReadStream: () => Readable.from([content]),
  });

const insertInvoice = (fields = {}) =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-102026",
    number: "0001",
    status: "PENDING",
    items: [
      { description: "Service", quantity: 1, unitPrice: 100, vatRate: 20 },
    ],
    client: {
      name: "Acme",
      email: "client@test.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    ...fields,
  });

const archiveInvoice = (invoiceId, file) =>
  eInvoicingResolvers.Mutation.archiveInvoicePdf(
    null,
    {
      workspaceId: organizationId.toString(),
      invoiceId: invoiceId.toString(),
      file,
    },
    ctx(),
  );

describe("archiveInvoicePdf : seul un vrai PDF, et pas sur une facture figée", () => {
  it("facture en attente : un vrai PDF est archivé", async () => {
    const { insertedId } = await insertInvoice();

    await archiveInvoice(insertedId, upload(VRAI_PDF));

    expect(uploadInvoicePdf).toHaveBeenCalledTimes(1);
    const apres = await Invoice.collection.findOne({ _id: insertedId });
    expect(apres.archivedPdfKey).toBe("factures/nouvelle.pdf");
  });

  for (const [cas, file] of [
    ["page HTML nommée .pdf, annoncée application/pdf", upload(HTML)],
    ["PDF sans type annoncé", upload(VRAI_PDF, null)],
    ["image annoncée image/png", upload(VRAI_PDF, "image/png")],
  ]) {
    it(`${cas} : refusé, archive inchangée`, async () => {
      const { insertedId } = await insertInvoice({
        archivedPdfKey: "factures/origine.pdf",
      });

      await expect(archiveInvoice(insertedId, file)).rejects.toThrow(
        /doit être un PDF/,
      );

      expect(uploadInvoicePdf).not.toHaveBeenCalled();
      const apres = await Invoice.collection.findOne({ _id: insertedId });
      expect(apres.archivedPdfKey).toBe("factures/origine.pdf");
    });
  }

  for (const [cas, fields] of [
    ["payée", { status: "COMPLETED", paymentDate: new Date() }],
    ["annulée", { status: "CANCELED" }],
    [
      "transmise en facturation électronique",
      { superPdpInvoiceId: "spdp-1", eInvoiceStatus: "VALIDATED" },
    ],
  ]) {
    it(`facture ${cas} déjà archivée : l'archive ne se remplace pas`, async () => {
      const { insertedId } = await insertInvoice({
        archivedPdfKey: "factures/origine.pdf",
        ...fields,
      });

      await expect(
        archiveInvoice(insertedId, upload(VRAI_PDF)),
      ).rejects.toThrow(/ne se remplace plus/);

      expect(uploadInvoicePdf).not.toHaveBeenCalled();
      const apres = await Invoice.collection.findOne({ _id: insertedId });
      expect(apres.archivedPdfKey).toBe("factures/origine.pdf");
    });
  }

  it("facture payée jamais archivée : sa première archive est acceptée", async () => {
    const { insertedId } = await insertInvoice({ status: "COMPLETED" });

    await archiveInvoice(insertedId, upload(VRAI_PDF));

    expect(uploadInvoicePdf).toHaveBeenCalledTimes(1);
  });
});

describe("archiveCreditNotePdf : mêmes règles pour l'avoir", () => {
  const insertCreditNote = (fields = {}) =>
    CreditNote.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "AV",
      number: "0001",
      status: "CREATED",
      creditType: "CORRECTION",
      originalInvoice: new mongoose.Types.ObjectId(),
      originalInvoiceNumber: "0001",
      items: [
        { description: "Retour", quantity: -1, unitPrice: 100, vatRate: 20 },
      ],
      client: {
        name: "Acme",
        email: "client@test.fr",
        address: {
          street: "1 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "Studio Test",
        address: {
          street: "1 rue de la Paix",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      finalTotalTTC: -120,
      ...fields,
    });
  const archiveCreditNote = (creditNoteId, file) =>
    creditNoteResolvers.Mutation.archiveCreditNotePdf(
      null,
      { creditNoteId: creditNoteId.toString(), file },
      ctx(),
    );

  it("une page HTML est refusée", async () => {
    const { insertedId } = await insertCreditNote();

    await expect(archiveCreditNote(insertedId, upload(HTML))).rejects.toThrow(
      /doit être un PDF/,
    );
    expect(uploadDocumentPdf).not.toHaveBeenCalled();
  });

  it("avoir transmis déjà archivé : l'archive ne se remplace pas", async () => {
    const { insertedId } = await insertCreditNote({
      archivedPdfKey: "avoirs/origine.pdf",
      superPdpInvoiceId: "spdp-avoir",
      eInvoiceStatus: "VALIDATED",
    });

    await expect(
      archiveCreditNote(insertedId, upload(VRAI_PDF)),
    ).rejects.toThrow(/ne se remplace plus/);
    expect(uploadDocumentPdf).not.toHaveBeenCalled();
  });

  it("avoir non transmis : un vrai PDF est archivé", async () => {
    const { insertedId } = await insertCreditNote();

    await archiveCreditNote(insertedId, upload(VRAI_PDF));

    expect(uploadDocumentPdf).toHaveBeenCalledTimes(1);
  });
});
