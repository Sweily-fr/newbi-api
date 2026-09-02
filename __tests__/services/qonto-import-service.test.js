import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-qonto";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

const {
  listClientInvoicesMock,
  listSupplierInvoicesMock,
  listQuotesMock,
  getQuoteMock,
  downloadAttachmentMock,
  uploadImageMock,
} = vi.hoisted(() => ({
  listClientInvoicesMock: vi.fn(),
  listSupplierInvoicesMock: vi.fn(),
  listQuotesMock: vi.fn(),
  getQuoteMock: vi.fn(),
  downloadAttachmentMock: vi.fn(),
  uploadImageMock: vi.fn(),
}));

vi.mock("../../src/services/qontoService.js", () => ({
  default: {
    listClientInvoices: listClientInvoicesMock,
    listSupplierInvoices: listSupplierInvoicesMock,
    listQuotes: listQuotesMock,
    getQuote: getQuoteMock,
    downloadAttachment: downloadAttachmentMock,
  },
}));

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { uploadImage: uploadImageMock },
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import QontoAccount from "../../src/models/QontoAccount.js";
import Invoice from "../../src/models/Invoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Expense from "../../src/models/Expense.js";
import Supplier from "../../src/models/Supplier.js";
import Quote from "../../src/models/Quote.js";
import ImportedQuote from "../../src/models/ImportedQuote.js";
import {
  importFromQonto,
  importClientInvoices,
  importSupplierInvoices,
  importQuotes,
} from "../../src/services/qontoImportService.js";

const organizationId = buildOrganizationId();
const userId = buildUserId();

const pdf = Buffer.from("%PDF-1.4 test");

const clientInvoice = (overrides = {}) => ({
  id: "ci-1",
  number: "Q-2026-001",
  status: "unpaid",
  issue_date: "2026-09-01",
  due_date: "2026-10-01",
  currency: "EUR",
  total_amount: { value: "120.00", currency: "EUR" },
  vat_amount: { value: "20.00", currency: "EUR" },
  attachment_id: "att-1",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:05:00Z",
  client: {
    id: "c-1",
    name: "Client Qonto SA",
    tax_identification_number: "732829320",
    billing_address: {
      street_address: "1 rue",
      city: "Paris",
      zip_code: "75001",
    },
  },
  organization: { legal_name: "Ma Société" },
  items: [
    {
      title: "Presta",
      quantity: "2",
      unit_price: { value: "50.00" },
      vat_rate: "0.2",
      subtotal: { value: "100.00" },
    },
  ],
  ...overrides,
});

const supplierInvoice = (overrides = {}) => ({
  id: "si-1",
  status: "awaiting_payment",
  invoice_number: "FA-42",
  supplier_name: "Fournisseur SARL",
  issue_date: "2026-08-20",
  due_date: "2026-09-20",
  total_amount: { value: "240.00", currency: "EUR" },
  total_amount_excluding_taxes: { value: "200.00", currency: "EUR" },
  total_tax_amount: { value: "40.00", currency: "EUR" },
  attachment_id: "att-2",
  file_name: "fa-42.pdf",
  created_at: "2026-08-20T09:00:00Z",
  updated_at: "2026-08-21T09:00:00Z",
  ...overrides,
});

const pages = (items) => ({ items, nextPage: null });

const createAccount = (overrides = {}) =>
  QontoAccount.create({
    organizationId: organizationId.toString(),
    login: "acme-1234",
    secretKey: "sk",
    isConnected: true,
    ...overrides,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  listClientInvoicesMock.mockReset().mockResolvedValue(pages([]));
  listSupplierInvoicesMock.mockReset().mockResolvedValue(pages([]));
  listQuotesMock.mockReset().mockResolvedValue(pages([]));
  getQuoteMock.mockReset();
  downloadAttachmentMock.mockReset().mockResolvedValue({
    buffer: pdf,
    fileName: "doc.pdf",
    contentType: "application/pdf",
  });
  uploadImageMock.mockReset().mockResolvedValue({
    key: `${organizationId}/ocr/doc.pdf`,
    url: "https://r2.example/doc.pdf",
  });
});

describe("importClientInvoices (Qonto → factures importées)", () => {
  it("crée une ImportedInvoice avec le PDF et avance le curseur", async () => {
    const account = await createAccount();
    listClientInvoicesMock.mockResolvedValue(pages([clientInvoice()]));

    const out = await importClientInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 1, errors: 0 });

    const doc = await ImportedInvoice.findOne({ qontoId: "ci-1" });
    expect(doc).toBeTruthy();
    expect(doc.source).toBe("QONTO");
    expect(doc.status).toBe("VALIDATED");
    expect(doc.originalInvoiceNumber).toBe("Q-2026-001");
    expect(doc.totalTTC).toBe(120);
    expect(doc.totalVAT).toBe(20);
    expect(doc.totalHT).toBe(100);
    expect(doc.client.name).toBe("Client Qonto SA");
    expect(doc.client.siret).toBe("732829320");
    expect(doc.items[0]).toMatchObject({
      quantity: 2,
      unitPrice: 50,
      vatRate: 20,
    });
    expect(doc.file.url).toBe("https://r2.example/doc.pdf");
    expect(downloadAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({ login: "acme-1234", secretKey: "sk" }),
      "att-1",
    );
    expect(account.importCursors.clientInvoices.toISOString()).toBe(
      "2026-09-01T10:05:00.000Z",
    );
  });

  it("est idempotent et met à jour le statut payé", async () => {
    const account = await createAccount();
    listClientInvoicesMock.mockResolvedValue(pages([clientInvoice()]));
    await importClientInvoices(account, String(userId));

    listClientInvoicesMock.mockResolvedValue(
      pages([
        clientInvoice({
          status: "paid",
          paid_at: "2026-09-10T12:00:00Z",
          updated_at: "2026-09-10T12:00:00Z",
        }),
      ]),
    );
    const out = await importClientInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 0, updated: 1 });
    expect(await ImportedInvoice.countDocuments({ qontoId: "ci-1" })).toBe(1);
    const doc = await ImportedInvoice.findOne({ qontoId: "ci-1" });
    expect(doc.status).toBe("COMPLETED");
    expect(doc.paymentDate.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("ignore les brouillons et les factures poussées par Newbi", async () => {
    const account = await createAccount();
    await Invoice.create({
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "F-",
      number: "000001",
      status: "PENDING",
      issueDate: new Date(),
      dueDate: new Date(),
      qontoId: "ci-pushed",
      client: {
        type: "COMPANY",
        name: "Client SA",
        email: "c@test.fr",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "Acme",
        email: "a@test.fr",
        address: {
          street: "2 rue",
          city: "Paris",
          postalCode: "75002",
          country: "France",
        },
      },
      items: [{ description: "P", quantity: 1, unitPrice: 1, vatRate: 20 }],
    });
    listClientInvoicesMock.mockResolvedValue(
      pages([
        clientInvoice({ id: "ci-draft", status: "draft" }),
        clientInvoice({ id: "ci-pushed" }),
      ]),
    );
    const out = await importClientInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 0, skipped: 2 });
    expect(await ImportedInvoice.countDocuments()).toBe(0);
    expect(downloadAttachmentMock).not.toHaveBeenCalled();
  });

  it("diffère une facture dont le PDF n'est pas encore généré sans avancer le curseur au-delà", async () => {
    const account = await createAccount();
    listClientInvoicesMock.mockResolvedValue(
      pages([
        clientInvoice({
          id: "ci-nopdf",
          attachment_id: null,
          updated_at: "2026-09-01T10:00:00Z",
        }),
        clientInvoice({ id: "ci-ok", updated_at: "2026-09-01T11:00:00Z" }),
      ]),
    );
    const out = await importClientInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 1, skipped: 1 });
    expect(account.importCursors.clientInvoices.toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
  });

  it("interroge Qonto avec le curseur (marge de 5 min) et pagine", async () => {
    const account = await createAccount({
      importCursors: { clientInvoices: new Date("2026-09-01T12:00:00Z") },
    });
    listClientInvoicesMock
      .mockResolvedValueOnce({
        items: [clientInvoice({ id: "p1" })],
        nextPage: 2,
      })
      .mockResolvedValueOnce(pages([clientInvoice({ id: "p2" })]));
    const out = await importClientInvoices(account, String(userId));
    expect(out.imported).toBe(2);
    expect(listClientInvoicesMock).toHaveBeenCalledTimes(2);
    const [, opts] = listClientInvoicesMock.mock.calls[0];
    expect(opts.updatedAtFrom.toISOString()).toBe("2026-09-01T11:55:00.000Z");
    expect(listClientInvoicesMock.mock.calls[1][1].page).toBe(2);
  });
});

describe("importSupplierInvoices (Qonto → factures d'achat)", () => {
  it("crée une PurchaseInvoice + fournisseur avec le PDF", async () => {
    const account = await createAccount();
    listSupplierInvoicesMock.mockResolvedValue(pages([supplierInvoice()]));

    const out = await importSupplierInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 1, errors: 0 });

    const pi = await PurchaseInvoice.findOne({ qontoId: "si-1" });
    expect(pi).toBeTruthy();
    expect(pi.source).toBe("QONTO");
    expect(pi.status).toBe("TO_PAY");
    expect(pi.invoiceNumber).toBe("FA-42");
    expect(pi.supplierName).toBe("Fournisseur SARL");
    expect(pi.amountTTC).toBe(240);
    expect(pi.amountHT).toBe(200);
    expect(pi.amountTVA).toBe(40);
    expect(pi.vatRate).toBe(20);
    expect(pi.files).toHaveLength(1);
    expect(pi.files[0].url).toBe("https://r2.example/doc.pdf");

    const supplier = await Supplier.findById(pi.supplierId);
    expect(supplier.name).toBe("Fournisseur SARL");
    expect(account.importCursors.supplierInvoices.toISOString()).toBe(
      "2026-08-21T09:00:00.000Z",
    );
  });

  it("réutilise un fournisseur existant (insensible à la casse)", async () => {
    const account = await createAccount();
    const existing = await Supplier.create({
      workspaceId: organizationId,
      createdBy: userId,
      name: "FOURNISSEUR sarl",
    });
    listSupplierInvoicesMock.mockResolvedValue(pages([supplierInvoice()]));
    await importSupplierInvoices(account, String(userId));
    const pi = await PurchaseInvoice.findOne({ qontoId: "si-1" });
    expect(String(pi.supplierId)).toBe(String(existing._id));
    expect(await Supplier.countDocuments()).toBe(1);
  });

  it("ne réimporte pas une facture déposée par Newbi et complète montants + paiement au rejeu", async () => {
    const account = await createAccount();
    await PurchaseInvoice.create({
      workspaceId: organizationId,
      createdBy: userId,
      qontoId: "si-pushed",
      supplierName: "X",
      invoiceNumber: "P-1",
      issueDate: new Date(),
      amountHT: 10,
      amountTVA: 2,
      amountTTC: 12,
      currency: "EUR",
    });
    await Expense.create({
      workspaceId: organizationId,
      createdBy: userId,
      qontoId: "si-expense",
      title: "Dépense",
      amount: 10,
      date: new Date(),
    });

    listSupplierInvoicesMock.mockResolvedValue(
      pages([
        supplierInvoice({ id: "si-pushed" }),
        supplierInvoice({ id: "si-expense" }),
        supplierInvoice({
          id: "si-new",
          status: "to_review",
          invoice_number: null,
          supplier_name: null,
          total_amount: null,
          total_amount_excluding_taxes: null,
          total_tax_amount: null,
        }),
      ]),
    );
    let out = await importSupplierInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 1, skipped: 2 });

    const created = await PurchaseInvoice.findOne({ qontoId: "si-new" });
    expect(created.status).toBe("TO_PROCESS");
    expect(created.supplierName).toBe("Fournisseur Qonto");
    expect(created.invoiceNumber).toMatch(/^QONTO-/);
    expect(created.amountTTC).toBe(0);

    // Qonto a analysé le fichier puis marqué la facture payée
    listSupplierInvoicesMock.mockResolvedValue(
      pages([
        supplierInvoice({
          id: "si-new",
          status: "paid",
          payment_date: "2026-09-05",
          updated_at: "2026-09-05T08:00:00Z",
        }),
      ]),
    );
    out = await importSupplierInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 0, updated: 1 });
    const updated = await PurchaseInvoice.findOne({ qontoId: "si-new" });
    expect(updated.status).toBe("PAID");
    expect(updated.amountTTC).toBe(240);
    expect(updated.amountHT).toBe(200);
    expect(updated.supplierName).toBe("Fournisseur SARL");
    expect(updated.invoiceNumber).toBe("FA-42");
    expect(await PurchaseInvoice.countDocuments({ qontoId: "si-new" })).toBe(1);
  });

  it("ignore les factures rejetées et sans pièce jointe", async () => {
    const account = await createAccount();
    listSupplierInvoicesMock.mockResolvedValue(
      pages([
        supplierInvoice({ id: "si-rej", status: "rejected" }),
        supplierInvoice({
          id: "si-noatt",
          attachment_id: null,
          display_attachment_id: null,
        }),
      ]),
    );
    const out = await importSupplierInvoices(account, String(userId));
    expect(out).toMatchObject({ imported: 0, skipped: 2 });
  });
});

const qontoQuote = (overrides = {}) => ({
  id: "qq-1",
  number: "Q-2026-001",
  status: "pending_approval",
  issue_date: "2026-09-01",
  expiry_date: "2026-09-30",
  currency: "EUR",
  total_amount: { value: "360.00", currency: "EUR" },
  vat_amount: { value: "60.00", currency: "EUR" },
  attachment_id: "att-q",
  created_at: "2026-09-01T10:00:00Z",
  client: {
    id: "c-1",
    name: "Client Qonto SA",
    tax_identification_number: "732829320",
  },
  organization: { legal_name: "Ma Société" },
  items: [
    {
      title: "Prestation",
      quantity: "3",
      unit_price: { value: "100.00" },
      vat_rate: "0.2",
      subtotal: { value: "300.00" },
    },
  ],
  ...overrides,
});

const quoteDoc = (overrides = {}) => ({
  workspaceId: organizationId,
  createdBy: userId,
  prefix: "D-",
  number: "000001",
  status: "PENDING",
  issueDate: new Date("2026-09-01"),
  validUntil: new Date("2026-09-30"),
  client: {
    type: "COMPANY",
    name: "Client SA",
    email: "c@test.fr",
    address: {
      street: "1 rue",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
  },
  companyInfo: {
    name: "Acme",
    email: "a@test.fr",
    address: {
      street: "2 rue",
      city: "Paris",
      postalCode: "75002",
      country: "France",
    },
  },
  items: [{ description: "P", quantity: 1, unitPrice: 1, vatRate: 20 }],
  ...overrides,
});

describe("importQuotes (Qonto → devis importés)", () => {
  it("crée un ImportedQuote avec le PDF et avance le curseur (created_at)", async () => {
    const account = await createAccount();
    listQuotesMock.mockResolvedValue(pages([qontoQuote()]));
    const out = await importQuotes(account, String(userId));
    expect(out).toMatchObject({ imported: 1, errors: 0 });
    const doc = await ImportedQuote.findOne({ qontoId: "qq-1" });
    expect(doc.source).toBe("QONTO");
    expect(doc.status).toBe("PENDING_REVIEW");
    expect(doc.originalQuoteNumber).toBe("Q-2026-001");
    expect(doc.totalTTC).toBe(360);
    expect(doc.totalHT).toBe(300);
    expect(doc.validUntil.toISOString()).toMatch(/^2026-09-30/);
    expect(doc.items[0]).toMatchObject({
      quantity: 3,
      unitPrice: 100,
      vatRate: 20,
    });
    expect(account.importCursors.quotes.toISOString()).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    expect(listQuotesMock.mock.calls[0][1].createdAtFrom).toBeNull();
  });

  it("ignore les devis poussés par Newbi et les annulés, et suit le statut des devis en attente", async () => {
    const account = await createAccount();
    await Quote.create(quoteDoc({ qontoId: "qq-pushed" }));
    listQuotesMock.mockResolvedValue(
      pages([
        qontoQuote({ id: "qq-pushed" }),
        qontoQuote({ id: "qq-cancel", status: "canceled" }),
        qontoQuote(),
      ]),
    );
    let out = await importQuotes(account, String(userId));
    expect(out).toMatchObject({ imported: 1, skipped: 2 });

    // Le devis importé passe accepté côté Qonto → relu via getQuote
    listQuotesMock.mockResolvedValue(pages([]));
    getQuoteMock.mockResolvedValue({ id: "qq-1", status: "approved" });
    out = await importQuotes(account, String(userId));
    expect(out).toMatchObject({ imported: 0, updated: 1 });
    expect(getQuoteMock).toHaveBeenCalledWith(expect.anything(), "qq-1");
    const doc = await ImportedQuote.findOne({ qontoId: "qq-1" });
    expect(doc.status).toBe("VALIDATED");
    expect(await ImportedQuote.countDocuments()).toBe(1);
  });
});

const pastCursors = {
  clientInvoices: new Date("2026-01-01T00:00:00Z"),
  supplierInvoices: new Date("2026-01-01T00:00:00Z"),
  quotes: new Date("2026-01-01T00:00:00Z"),
};

describe("importFromQonto", () => {
  it("initialise les curseurs à maintenant sur un compte sans curseur (pas d'historique)", async () => {
    const account = await createAccount();
    listClientInvoicesMock.mockResolvedValue(pages([clientInvoice()]));
    const before = Date.now();
    const out = await importFromQonto(account, String(userId));
    expect(out.success).toBe(true);
    const [, opts] = listClientInvoicesMock.mock.calls[0];
    // Curseur = maintenant (moins la marge de 5 min), et non null
    expect(opts.updatedAtFrom.getTime()).toBeGreaterThanOrEqual(
      before - 5 * 60 * 1000,
    );
    const fresh = await QontoAccount.findById(account._id);
    expect(fresh.importCursors.quotes).toBeTruthy();
    expect(fresh.importCursors.supplierInvoices).toBeTruthy();
  });

  it("respecte les préférences et met à jour stats + lastImportAt", async () => {
    const account = await createAccount({
      importCursors: pastCursors,
      autoSync: { importClientInvoices: false, importSupplierInvoices: true },
    });
    listClientInvoicesMock.mockResolvedValue(pages([clientInvoice()]));
    listSupplierInvoicesMock.mockResolvedValue(pages([supplierInvoice()]));

    const out = await importFromQonto(account, String(userId));
    expect(out.success).toBe(true);
    expect(listClientInvoicesMock).not.toHaveBeenCalled();
    expect(out.results.supplierInvoices.imported).toBe(1);

    const fresh = await QontoAccount.findById(account._id);
    expect(fresh.stats.supplierInvoicesImported).toBe(1);
    expect(fresh.stats.clientInvoicesImported).toBe(0);
    expect(fresh.lastImportAt).toBeTruthy();
  });

  it("force=true ignore les préférences (import manuel)", async () => {
    const account = await createAccount({
      importCursors: pastCursors,
      autoSync: { importClientInvoices: false, importSupplierInvoices: false },
    });
    listClientInvoicesMock.mockResolvedValue(pages([clientInvoice()]));
    const out = await importFromQonto(account, String(userId), { force: true });
    expect(out.results.clientInvoices.imported).toBe(1);
  });

  it("enregistre importError si Qonto est injoignable", async () => {
    const account = await createAccount({ importCursors: pastCursors });
    listClientInvoicesMock.mockRejectedValue(new Error("Qonto API 503"));
    const out = await importFromQonto(account, String(userId));
    expect(out.success).toBe(false);
    const fresh = await QontoAccount.findById(account._id);
    expect(fresh.importError).toMatch(/503/);
  });
});
