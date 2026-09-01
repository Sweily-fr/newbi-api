import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getReceivedInvoices = vi.fn();
const getReceivedInvoiceDetail = vi.fn();
const getArchivedPdf = vi.fn();
const transformReceivedInvoiceToPurchaseInvoice = vi.fn();
vi.mock("../../src/services/superPdpService.js", () => ({
  default: {
    getReceivedInvoices: (...a) => getReceivedInvoices(...a),
    getReceivedInvoiceDetail: (...a) => getReceivedInvoiceDetail(...a),
    getArchivedPdf: (...a) => getArchivedPdf(...a),
    // Même prédicat que l'implémentation réelle
    hasReceivedInvoiceData: (superPdpInvoice) => {
      if (!superPdpInvoice) return false;
      const invoice = superPdpInvoice.en_invoice || superPdpInvoice;
      return Boolean(invoice.seller || invoice.totals || invoice.number);
    },
    transformReceivedInvoiceToPurchaseInvoice: (...a) =>
      transformReceivedInvoiceToPurchaseInvoice(...a),
  },
}));

const uploadImage = vi.fn();
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    uploadImage: (...a) => uploadImage(...a),
  },
}));

const publishNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/resolvers/notification.js", () => ({
  publishNotification: (...a) => publishNotification(...a),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Notification from "../../src/models/Notification.js";
import {
  importReceivedInvoices,
  invoiceIsAddressedToOrganization,
} from "../../src/services/purchaseInvoiceReceptionService.js";
import mongoose from "mongoose";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  getReceivedInvoices.mockReset();
  getReceivedInvoiceDetail.mockReset();
  getArchivedPdf.mockReset();
  // Par défaut : pas de PDF disponible (best-effort, l'import continue)
  getArchivedPdf.mockRejectedValue(new Error("PDF indisponible"));
  uploadImage.mockReset();
  transformReceivedInvoiceToPurchaseInvoice.mockReset();
  publishNotification.mockClear();
});

const detailFor = (id) => ({
  id,
  en_invoice: {
    number: "FA-2026-001",
    seller: { name: "Acme Telecom" },
    totals: { total_with_vat: "1200" },
  },
});

describe("invoiceIsAddressedToOrganization", () => {
  const org = (siret) => ({ companyInfo: { siret } });
  const withBuyer = (buyer) => ({
    en_invoice: { number: "F1", seller: {}, totals: {}, buyer },
  });

  it("accepte quand le SIREN du buyer correspond au SIRET de l'org", () => {
    expect(
      invoiceIsAddressedToOrganization(
        withBuyer({
          legal_registration_identifier: { value: "123456789", scheme: "0002" },
        }),
        org("12345678900019"),
      ),
    ).toBe(true);
  });

  it("refuse quand le SIREN du buyer ne correspond pas", () => {
    expect(
      invoiceIsAddressedToOrganization(
        withBuyer({
          legal_registration_identifier: { value: "111111111", scheme: "0002" },
        }),
        org("12345678900019"),
      ),
    ).toBe(false);
  });

  it("matche via le numéro de TVA intracom du buyer", () => {
    expect(
      invoiceIsAddressedToOrganization(
        withBuyer({ vat_identifier: "FR32123456789" }),
        org("12345678900019"),
      ),
    ).toBe(true);
  });

  it("matche via l'adresse électronique (SIRET, scheme 0009)", () => {
    expect(
      invoiceIsAddressedToOrganization(
        withBuyer({ electronic_address: { value: "12345678900019" } }),
        org("123456789"),
      ),
    ).toBe(true);
  });

  it("accepte si l'org n'a pas de SIRET (comparaison impossible)", () => {
    expect(
      invoiceIsAddressedToOrganization(
        withBuyer({
          legal_registration_identifier: { value: "111111111" },
        }),
        { companyInfo: {} },
      ),
    ).toBe(true);
  });

  it("accepte si le buyer n'a aucun identifiant exploitable", () => {
    expect(
      invoiceIsAddressedToOrganization(
        withBuyer({ name: "Client sans SIREN" }),
        org("12345678900019"),
      ),
    ).toBe(true);
  });
});

describe("importReceivedInvoices — notification d'arrivée", () => {
  it("importe la facture, crée le fournisseur et notifie l'utilisateur", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockResolvedValue(detailFor("sp-1"));
    transformReceivedInvoiceToPurchaseInvoice.mockReturnValue({
      supplierName: "Acme Telecom",
      invoiceNumber: "FA-2026-001",
      amountTTC: 1200,
      currency: "EUR",
      status: "TO_PROCESS",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
      eInvoiceReceivedAt: new Date(),
      ocrMetadata: {},
      workspaceId,
      createdBy: userId,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(1);

    const pi = await PurchaseInvoice.findOne({ superPdpInvoiceId: "sp-1" });
    expect(pi).toBeTruthy();
    expect(pi.supplierName).toBe("Acme Telecom");

    const notif = await Notification.findOne({
      type: "PURCHASE_INVOICE_RECEIVED",
    });
    expect(notif).toBeTruthy();
    expect(notif.data.supplierName).toBe("Acme Telecom");
    expect(notif.data.purchaseInvoiceId).toBe(pi._id.toString());
    expect(publishNotification).toHaveBeenCalledTimes(1);
  });

  it("est idempotent : ignore une facture déjà importée (pas de doublon ni notif)", async () => {
    await PurchaseInvoice.create({
      workspaceId,
      createdBy: userId,
      supplierName: "Acme Telecom",
      amountTTC: 1200,
      currency: "EUR",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
    });

    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1" }],
      hasAfter: false,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect(publishNotification).not.toHaveBeenCalled();
    expect(
      await Notification.countDocuments({ type: "PURCHASE_INVOICE_RECEIVED" }),
    ).toBe(0);
  });
});

describe("importReceivedInvoices — récupération du détail EN16931", () => {
  it("récupère le détail quand la liste ne renvoie qu'un résumé", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1", direction: "in", processing_rule: "B2B" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockResolvedValue(detailFor("sp-1"));
    transformReceivedInvoiceToPurchaseInvoice.mockReturnValue({
      supplierName: "Acme Telecom",
      invoiceNumber: "FA-2026-001",
      amountTTC: 1200,
      currency: "EUR",
      status: "TO_PROCESS",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
      eInvoiceReceivedAt: new Date(),
      ocrMetadata: {},
      workspaceId,
      createdBy: userId,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(1);
    expect(getReceivedInvoiceDetail).toHaveBeenCalledWith(
      workspaceId.toString(),
      "sp-1",
    );
    // Le transform reçoit le détail, pas le résumé de liste
    expect(transformReceivedInvoiceToPurchaseInvoice).toHaveBeenCalledWith(
      detailFor("sp-1"),
      workspaceId.toString(),
      userId.toString(),
    );
  });

  it("n'appelle pas le détail si l'élément de liste contient déjà en_invoice", async () => {
    const fullItem = detailFor("sp-1");
    getReceivedInvoices.mockResolvedValue({
      invoices: [fullItem],
      hasAfter: false,
    });
    transformReceivedInvoiceToPurchaseInvoice.mockReturnValue({
      supplierName: "Acme Telecom",
      amountTTC: 1200,
      currency: "EUR",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
      ocrMetadata: {},
      workspaceId,
      createdBy: userId,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(1);
    expect(getReceivedInvoiceDetail).not.toHaveBeenCalled();
  });

  it("ne crée pas de facture vide si le détail est irrécupérable", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1", direction: "in" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockRejectedValue(new Error("timeout"));

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(0);
    expect(res.errors).toBe(1);
    expect(transformReceivedInvoiceToPurchaseInvoice).not.toHaveBeenCalled();
    expect(await PurchaseInvoice.countDocuments()).toBe(0);
    expect(publishNotification).not.toHaveBeenCalled();
  });

  it("rattache le PDF SuperPDP à la facture importée", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1", direction: "in" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockResolvedValue(detailFor("sp-1"));
    getArchivedPdf.mockResolvedValue(Buffer.from("%PDF-1.4 fake"));
    uploadImage.mockResolvedValue({
      key: "org/abc.pdf",
      url: "https://ocr.example.com/org/abc.pdf",
    });
    transformReceivedInvoiceToPurchaseInvoice.mockReturnValue({
      supplierName: "Acme Telecom",
      invoiceNumber: "FA-2026-001",
      amountTTC: 1200,
      currency: "EUR",
      status: "TO_PROCESS",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
      eInvoiceReceivedAt: new Date(),
      ocrMetadata: {},
      workspaceId,
      createdBy: userId,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(1);
    expect(getArchivedPdf).toHaveBeenCalledWith(workspaceId.toString(), "sp-1");
    expect(uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      "facture-FA-2026-001.pdf",
      userId.toString(),
      "ocr",
      workspaceId.toString(),
    );

    const pi = await PurchaseInvoice.findOne({ superPdpInvoiceId: "sp-1" });
    expect(pi.files).toHaveLength(1);
    expect(pi.files[0].url).toBe("https://ocr.example.com/org/abc.pdf");
    expect(pi.files[0].mimetype).toBe("application/pdf");
  });

  it("importe quand même la facture si le PDF est indisponible", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1", direction: "in" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockResolvedValue(detailFor("sp-1"));
    getArchivedPdf.mockRejectedValue(new Error("500 sur /download"));
    transformReceivedInvoiceToPurchaseInvoice.mockReturnValue({
      supplierName: "Acme Telecom",
      invoiceNumber: "FA-2026-001",
      amountTTC: 1200,
      currency: "EUR",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
      ocrMetadata: {},
      workspaceId,
      createdBy: userId,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(1);
    expect(res.errors).toBe(0);
    const pi = await PurchaseInvoice.findOne({ superPdpInvoiceId: "sp-1" });
    expect(pi.files).toHaveLength(0);
  });

  it("ignore une facture adressée à un autre destinataire (compte SuperPDP partagé)", async () => {
    // Organisation avec un SIRET différent du buyer de la facture
    await mongoose.connection.db.collection("organization").insertOne({
      _id: workspaceId,
      name: "Autre Société",
      companyInfo: { siret: "98765432100019" },
    });

    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1", direction: "in" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockResolvedValue({
      id: "sp-1",
      en_invoice: {
        number: "FA-2026-001",
        seller: { name: "Acme Telecom" },
        totals: { total_with_vat: "1200" },
        buyer: {
          name: "Sweily",
          legal_registration_identifier: { value: "123456789", scheme: "0002" },
        },
      },
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.errors).toBe(0);
    expect(transformReceivedInvoiceToPurchaseInvoice).not.toHaveBeenCalled();
    expect(await PurchaseInvoice.countDocuments()).toBe(0);
  });

  it("ne crée pas de facture vide si le détail renvoyé est vide lui aussi", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1", direction: "in" }],
      hasAfter: false,
    });
    getReceivedInvoiceDetail.mockResolvedValue({ id: "sp-1", direction: "in" });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(0);
    expect(res.errors).toBe(1);
    expect(transformReceivedInvoiceToPurchaseInvoice).not.toHaveBeenCalled();
    expect(await PurchaseInvoice.countDocuments()).toBe(0);
  });
});
