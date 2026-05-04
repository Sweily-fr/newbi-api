import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

const {
  syncCustomerInvoiceMock,
  syncSupplierInvoiceMock,
  syncQuoteMock,
  syncPurchaseInvoiceMock,
} = vi.hoisted(() => ({
  syncCustomerInvoiceMock: vi.fn(),
  syncSupplierInvoiceMock: vi.fn(),
  syncQuoteMock: vi.fn(),
  syncPurchaseInvoiceMock: vi.fn(),
}));

vi.mock("../../src/services/pennylaneService.js", () => ({
  default: {
    syncCustomerInvoice: syncCustomerInvoiceMock,
    syncSupplierInvoice: syncSupplierInvoiceMock,
    syncQuote: syncQuoteMock,
    syncPurchaseInvoice: syncPurchaseInvoiceMock,
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import PennylaneAccount from "../../src/models/PennylaneAccount.js";
import Invoice from "../../src/models/Invoice.js";
import Expense from "../../src/models/Expense.js";
import Quote from "../../src/models/Quote.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  syncInvoiceIfNeeded,
  syncExpenseIfNeeded,
  syncQuoteIfNeeded,
  syncPurchaseInvoiceIfNeeded,
} from "../../src/services/pennylaneSyncHelper.js";

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
  syncCustomerInvoiceMock.mockReset();
  syncSupplierInvoiceMock.mockReset();
  syncQuoteMock.mockReset();
  syncPurchaseInvoiceMock.mockReset();
});

const seedAccount = (overrides = {}) =>
  PennylaneAccount.create({
    organizationId: organizationId.toString(),
    apiToken: "test-token",
    isConnected: true,
    autoSync: { invoices: true, supplierInvoices: true, quotes: true },
    ...overrides,
  });

const baseInvoice = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  status: "PENDING",
  prefix: "F-202604",
  number: "0001",
  ...overrides,
});

describe("syncInvoiceIfNeeded — guards", () => {
  it("no-op when invoice missing", async () => {
    await syncInvoiceIfNeeded(null, organizationId);
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });

  it("no-op when workspaceId missing", async () => {
    await syncInvoiceIfNeeded(baseInvoice(), null);
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });

  it("no-op when status not syncable (e.g., DRAFT)", async () => {
    await seedAccount();
    await syncInvoiceIfNeeded(baseInvoice({ status: "DRAFT" }), organizationId);
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });

  it("no-op when invoice already SYNCED", async () => {
    await seedAccount();
    await syncInvoiceIfNeeded(
      baseInvoice({ pennylaneSyncStatus: "SYNCED" }),
      organizationId,
    );
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });

  it("no-op when no Pennylane account", async () => {
    await syncInvoiceIfNeeded(baseInvoice(), organizationId);
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });

  it("no-op when autoSync.invoices is disabled", async () => {
    await seedAccount({
      autoSync: { invoices: false, supplierInvoices: true, quotes: true },
    });
    await syncInvoiceIfNeeded(baseInvoice(), organizationId);
    expect(syncCustomerInvoiceMock).not.toHaveBeenCalled();
  });
});

describe("syncInvoiceIfNeeded — happy path", () => {
  it("syncs and marks invoice SYNCED on success", async () => {
    await seedAccount();
    // Real invoice document so we can verify the DB update
    const invoice = await Invoice.create({
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "F-202604",
      number: "0001",
      status: "PENDING",
      issueDate: new Date(),
      dueDate: new Date(),
      items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 20 }],
      finalTotalTTC: 120,
      client: {
        type: "COMPANY",
        name: "Acme",
        email: "client@acme.fr",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "My Co",
        email: "contact@myco.fr",
        siret: "12345678901234",
        companyStatus: "SARL",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
    });

    syncCustomerInvoiceMock.mockResolvedValue({
      success: true,
      pennylaneId: "pl-123",
    });

    await syncInvoiceIfNeeded(invoice.toObject(), organizationId);

    expect(syncCustomerInvoiceMock).toHaveBeenCalledWith(
      "test-token",
      expect.objectContaining({ _id: invoice._id }),
    );

    const fresh = await Invoice.findById(invoice._id);
    expect(fresh.pennylaneSyncStatus).toBe("SYNCED");
    expect(fresh.pennylaneId).toBe("pl-123");

    const account = await PennylaneAccount.findOne({
      organizationId: organizationId.toString(),
    });
    expect(account.stats.invoicesSynced).toBe(1);
    expect(account.lastSyncAt).toBeInstanceOf(Date);
  });

  it("marks invoice ERROR when service returns success=false", async () => {
    await seedAccount();
    const invoice = await Invoice.create({
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "F-202604",
      number: "0002",
      status: "PENDING",
      issueDate: new Date(),
      dueDate: new Date(),
      items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 20 }],
      finalTotalTTC: 120,
      client: {
        type: "COMPANY",
        name: "Acme",
        email: "client@acme.fr",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "My Co",
        email: "contact@myco.fr",
        siret: "12345678901234",
        companyStatus: "SARL",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
    });
    syncCustomerInvoiceMock.mockResolvedValue({
      success: false,
      message: "API down",
    });

    await syncInvoiceIfNeeded(invoice.toObject(), organizationId);

    const fresh = await Invoice.findById(invoice._id);
    expect(fresh.pennylaneSyncStatus).toBe("ERROR");
  });

  it("swallows thrown errors silently", async () => {
    await seedAccount();
    syncCustomerInvoiceMock.mockRejectedValue(new Error("network"));
    // Should not throw
    await expect(
      syncInvoiceIfNeeded(baseInvoice(), organizationId),
    ).resolves.toBeUndefined();
  });
});

describe("syncQuoteIfNeeded", () => {
  it("only syncs when status === COMPLETED", async () => {
    await seedAccount();
    await syncQuoteIfNeeded(
      { _id: new mongoose.Types.ObjectId(), status: "PENDING" },
      organizationId,
    );
    expect(syncQuoteMock).not.toHaveBeenCalled();
  });

  it("no-op when autoSync.quotes is disabled", async () => {
    await seedAccount({
      autoSync: { invoices: true, supplierInvoices: true, quotes: false },
    });
    await syncQuoteIfNeeded(
      { _id: new mongoose.Types.ObjectId(), status: "COMPLETED" },
      organizationId,
    );
    expect(syncQuoteMock).not.toHaveBeenCalled();
  });

  it("syncs a COMPLETED quote and marks SYNCED on success", async () => {
    await seedAccount();
    const quote = await Quote.create({
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "D-202604",
      number: "Q-0001",
      status: "COMPLETED",
      issueDate: new Date(),
      validUntil: new Date(Date.now() + 86400000),
      items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 20 }],
      finalTotalTTC: 120,
      client: {
        type: "COMPANY",
        name: "Acme",
        email: "client@acme.fr",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      companyInfo: {
        name: "My Co",
        email: "contact@myco.fr",
        siret: "12345678901234",
        companyStatus: "SARL",
        address: {
          street: "1 rue",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
    });
    syncQuoteMock.mockResolvedValue({ success: true, pennylaneId: "q-1" });

    await syncQuoteIfNeeded(quote.toObject(), organizationId);

    const fresh = await Quote.findById(quote._id);
    expect(fresh.pennylaneSyncStatus).toBe("SYNCED");
    expect(fresh.pennylaneId).toBe("q-1");
  });
});

describe("syncExpenseIfNeeded", () => {
  it("syncs APPROVED expense and marks SYNCED", async () => {
    await seedAccount();
    const expense = await Expense.create({
      workspaceId: organizationId,
      createdBy: userId,
      title: "Test",
      amount: 50,
      currency: "EUR",
      date: new Date(),
      status: "APPROVED",
    });
    syncSupplierInvoiceMock.mockResolvedValue({
      success: true,
      pennylaneId: "e-1",
    });

    await syncExpenseIfNeeded(expense.toObject(), organizationId);

    const fresh = await Expense.findById(expense._id);
    expect(fresh.pennylaneSyncStatus).toBe("SYNCED");

    const account = await PennylaneAccount.findOne({
      organizationId: organizationId.toString(),
    });
    expect(account.stats.expensesSynced).toBe(1);
  });

  it("no-op for non-syncable status (e.g., PENDING)", async () => {
    await seedAccount();
    await syncExpenseIfNeeded(
      { _id: new mongoose.Types.ObjectId(), status: "PENDING" },
      organizationId,
    );
    expect(syncSupplierInvoiceMock).not.toHaveBeenCalled();
  });

  it("no-op when autoSync.supplierInvoices is disabled", async () => {
    await seedAccount({
      autoSync: { invoices: true, supplierInvoices: false, quotes: true },
    });
    await syncExpenseIfNeeded(
      { _id: new mongoose.Types.ObjectId(), status: "APPROVED" },
      organizationId,
    );
    expect(syncSupplierInvoiceMock).not.toHaveBeenCalled();
  });
});

describe("syncPurchaseInvoiceIfNeeded", () => {
  it("syncs PAID purchase invoice and marks SYNCED", async () => {
    await seedAccount();
    const pi = await PurchaseInvoice.create({
      workspaceId: organizationId,
      createdBy: userId,
      invoiceNumber: "INV-1",
      supplierName: "OVH",
      issueDate: new Date(),
      dueDate: new Date(),
      amountHT: 100,
      amountTTC: 120,
      vatAmount: 20,
      status: "PAID",
    });
    syncPurchaseInvoiceMock.mockResolvedValue({
      success: true,
      pennylaneId: "pi-1",
    });

    await syncPurchaseInvoiceIfNeeded(pi.toObject(), organizationId);

    const fresh = await PurchaseInvoice.findById(pi._id);
    expect(fresh.pennylaneSyncStatus).toBe("SYNCED");
  });

  it("no-op for non-syncable status", async () => {
    await seedAccount();
    await syncPurchaseInvoiceIfNeeded(
      { _id: new mongoose.Types.ObjectId(), status: "DRAFT" },
      organizationId,
    );
    expect(syncPurchaseInvoiceMock).not.toHaveBeenCalled();
  });
});
