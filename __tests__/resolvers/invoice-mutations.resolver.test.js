import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

// ─── Mock Mongoose models ───────────────────────────────────────────

vi.mock("../../src/models/Invoice.js", () => {
  class MockInvoice {
    constructor(data) {
      Object.assign(this, data);
      this._id = data._id || new mongoose.Types.ObjectId();
      this.save = vi.fn().mockResolvedValue(true);
      this.populate = vi.fn().mockResolvedValue(this);
    }
  }
  MockInvoice.findOne = vi.fn();
  MockInvoice.find = vi.fn();
  MockInvoice.countDocuments = vi.fn();
  MockInvoice.findById = vi.fn();
  MockInvoice.findByIdAndUpdate = vi.fn();
  MockInvoice.findByIdAndDelete = vi.fn();
  MockInvoice.deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
  MockInvoice.aggregate = vi.fn();
  MockInvoice.startSession = vi.fn().mockResolvedValue({
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    abortTransaction: vi.fn(),
    endSession: vi.fn(),
  });
  return { default: MockInvoice };
});

vi.mock("../../src/models/User.js", () => ({
  default: { findById: vi.fn() },
}));

vi.mock("../../src/models/Quote.js", () => ({
  default: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock("../../src/models/PurchaseOrder.js", () => ({
  default: { findOne: vi.fn() },
}));

vi.mock("../../src/models/Event.js", () => {
  class MockEvent {
    constructor(data) {
      Object.assign(this, data);
      this.save = vi.fn().mockResolvedValue(true);
    }
  }
  MockEvent.findOne = vi.fn();
  MockEvent.findByIdAndDelete = vi.fn();
  MockEvent.deleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
  MockEvent.deleteInvoiceEvent = vi.fn().mockResolvedValue(undefined);
  return { default: MockEvent };
});

vi.mock("../../src/models/Client.js", () => ({
  default: { findOne: vi.fn() },
}));

// ─── Mock middlewares (pass-through) ────────────────────────────────

vi.mock("../../src/middlewares/rbac.js", () => ({
  requireRead: () => (resolver) => resolver,
  requireWrite: () => (resolver) => resolver,
  requireDelete: () => (resolver) => resolver,
  resolveWorkspaceId: (input, context) =>
    input && context && input !== context ? context : input || context,
}));

vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  isAuthenticated: (resolver) => resolver,
}));

vi.mock("../../src/middlewares/company-info-guard.js", () => ({
  requireCompanyInfo: (resolver) => resolver,
  getOrganizationInfo: vi.fn().mockResolvedValue({
    companyName: "Test SASU",
    companyAddress: {
      street: "1 rue du Test",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
    companyPhone: "+33100000000",
    companyEmail: "contact@test.fr",
    companySiret: "12345678901234",
    companyVatNumber: "FR12345678901",
    companyCapitalSocial: "1000",
    companyRcs: "Paris",
    companyStatus: "SASU",
    legalForm: "SASU",
    companyBankDetails: { iban: "FR76...", bic: "BNPAFRPP", bankName: "BNP" },
  }),
}));

vi.mock("../../src/utils/companyInfoMapper.js", () => ({
  mapOrganizationToCompanyInfo: vi.fn().mockReturnValue({
    name: "Test SASU",
    address: {
      street: "1 rue du Test",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
  }),
}));

vi.mock("../../src/utils/documentNumbers.js", () => ({
  generateInvoiceNumber: vi.fn().mockResolvedValue("001"),
}));

vi.mock("../../src/utils/errors.js", async () => {
  const actual = await vi.importActual("../../src/utils/errors.js");
  return actual;
});

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../src/services/superPdpService.js", () => ({
  default: { sendInvoice: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { getSettings: vi.fn().mockResolvedValue(null) },
}));

vi.mock("../../src/utils/eInvoiceRoutingHelper.js", () => ({
  evaluateAndRouteInvoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/notificationService.js", () => ({
  default: { createAndSendNotification: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import after mocks ────────────────────────────────────────────

import Invoice from "../../src/models/Invoice.js";
import Event from "../../src/models/Event.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";

const workspaceId = "507f1f77bcf86cd799439011";

const mockContext = {
  user: {
    id: "user-1",
    _id: "user-1",
    name: "Test User",
    email: "test@test.com",
  },
  workspaceId,
  userRole: "owner",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Query.invoice ──────────────────────────────────────────────────

describe("Invoice Resolver - Query.invoice", () => {
  const resolver = invoiceResolvers.Query.invoice;

  it("should return an invoice by id", async () => {
    const mockInvoice = { _id: "inv-1", number: "001", status: "PENDING" };
    // Pattern: Invoice.findOne({ ... }).populate("createdBy")
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockInvoice),
    });

    const result = await resolver(
      null,
      { id: "inv-1", workspaceId },
      mockContext,
    );
    expect(result).toEqual(mockInvoice);
  });

  it("should throw NOT_FOUND when invoice does not exist", async () => {
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null),
    });

    await expect(
      resolver(null, { id: "nonexistent", workspaceId }, mockContext),
    ).rejects.toThrow();
  });
});

// ─── Query.invoices ─────────────────────────────────────────────────

describe("Invoice Resolver - Query.invoices", () => {
  const resolver = invoiceResolvers.Query.invoices;

  it("should return paginated invoice list", async () => {
    const mockInvoices = [{ number: "001" }, { number: "002" }];
    Invoice.countDocuments.mockResolvedValue(50);
    // Pattern: Invoice.find(query).populate("createdBy").sort().skip().limit()
    Invoice.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(mockInvoices),
          }),
        }),
      }),
    });

    const result = await resolver(
      null,
      { workspaceId, page: 1, limit: 10 },
      mockContext,
    );

    expect(result.invoices).toEqual(mockInvoices);
    expect(result.totalCount).toBe(50);
    expect(result.hasNextPage).toBe(true);
  });

  it("should apply status filter", async () => {
    Invoice.countDocuments.mockResolvedValue(5);
    Invoice.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId, status: "PENDING", page: 1, limit: 10 },
      mockContext,
    );

    const queryArg = Invoice.find.mock.calls[0][0];
    expect(queryArg.status).toBe("PENDING");
  });

  it("should apply search filter", async () => {
    Invoice.countDocuments.mockResolvedValue(1);
    Invoice.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId, search: "Alpha", page: 1, limit: 10 },
      mockContext,
    );

    const queryArg = Invoice.countDocuments.mock.calls[0][0];
    expect(queryArg.$or).toBeDefined();
  });
});

// ─── Query.invoiceStats ─────────────────────────────────────────────

describe("Invoice Resolver - Query.invoiceStats", () => {
  const resolver = invoiceResolvers.Query.invoiceStats;

  it("should return aggregated stats", async () => {
    const mockStats = {
      totalCount: 20,
      draftCount: 5,
      pendingCount: 8,
      completedCount: 6,
      canceledCount: 1,
      totalAmount: 45000,
    };
    Invoice.aggregate.mockResolvedValue([mockStats]);

    const result = await resolver(null, { workspaceId }, mockContext);

    expect(result.totalCount).toBe(20);
    expect(result.pendingCount).toBe(8);
    expect(result.totalAmount).toBe(45000);
  });

  it("should return default stats when no invoices", async () => {
    Invoice.aggregate.mockResolvedValue([undefined]);

    const result = await resolver(null, { workspaceId }, mockContext);

    expect(result.totalCount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });
});

// ─── Mutation.deleteInvoice ─────────────────────────────────────────

describe("Invoice Resolver - Mutation.deleteInvoice", () => {
  const resolver = invoiceResolvers.Mutation.deleteInvoice;

  it("should delete a DRAFT invoice", async () => {
    const mockInvoice = {
      _id: "inv-1",
      status: "DRAFT",
      workspaceId,
      sourceQuote: null,
      convertedFromQuote: null,
      save: vi.fn().mockResolvedValue(true),
    };
    // deleteInvoice uses Invoice.findOne() without populate
    Invoice.findOne.mockResolvedValue(mockInvoice);
    Invoice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    Event.deleteInvoiceEvent.mockResolvedValue(undefined);
    Event.deleteMany.mockResolvedValue({ deletedCount: 0 });

    const result = await resolver(
      null,
      { id: "inv-1", workspaceId },
      mockContext,
    );

    expect(result).toBe(true);
  });

  it("should throw when deleting a COMPLETED invoice", async () => {
    Invoice.findOne.mockResolvedValue({
      _id: "inv-1",
      status: "COMPLETED",
      workspaceId,
    });

    await expect(
      resolver(null, { id: "inv-1", workspaceId }, mockContext),
    ).rejects.toThrow();
  });

  it("should throw NOT_FOUND when invoice does not exist", async () => {
    Invoice.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: "nonexistent", workspaceId }, mockContext),
    ).rejects.toThrow();
  });
});

// ─── Mutation.markInvoiceAsPaid ─────────────────────────────────────

describe("Invoice Resolver - Mutation.markInvoiceAsPaid", () => {
  const resolver = invoiceResolvers.Mutation.markInvoiceAsPaid;

  it("should mark a PENDING invoice as paid", async () => {
    const mockInvoice = {
      _id: "inv-1",
      status: "PENDING",
      workspaceId,
      createdBy: { _id: "user-1" },
      client: { _id: "client-1", name: "Alpha", email: "a@b.com" },
      save: vi.fn().mockResolvedValue(true),
      populate: vi.fn().mockImplementation(function () {
        return Promise.resolve(this);
      }),
    };
    // markInvoiceAsPaid uses Invoice.findOne().populate("createdBy")
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockInvoice),
    });

    const result = await resolver(
      null,
      { id: "inv-1", workspaceId, paymentDate: "2026-03-15" },
      mockContext,
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.save).toHaveBeenCalled();
  });

  it("should throw NOT_FOUND when invoice does not exist", async () => {
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null),
    });

    await expect(
      resolver(null, { id: "nonexistent", workspaceId }, mockContext),
    ).rejects.toThrow();
  });
});

// ─── Mutation.changeInvoiceStatus ───────────────────────────────────

describe("Invoice Resolver - Mutation.changeInvoiceStatus", () => {
  const resolver = invoiceResolvers.Mutation.changeInvoiceStatus;

  it("should transition PENDING to COMPLETED", async () => {
    const mockInvoice = {
      _id: "inv-1",
      status: "PENDING",
      workspaceId,
      number: "001",
      prefix: "F-032026",
      createdBy: { _id: "user-1" },
      client: { _id: "client-1", name: "Alpha" },
      items: [{ quantity: 1, unitPrice: 1000, vatRate: 20 }],
      save: vi.fn().mockResolvedValue(true),
      populate: vi.fn().mockImplementation(function () {
        return Promise.resolve(this);
      }),
    };
    // changeInvoiceStatus uses Invoice.findOne().populate("createdBy")
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockInvoice),
    });

    const result = await resolver(
      null,
      { id: "inv-1", workspaceId, status: "COMPLETED" },
      mockContext,
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.save).toHaveBeenCalled();
  });

  it("should transition PENDING to CANCELED", async () => {
    const mockInvoice = {
      _id: "inv-1",
      status: "PENDING",
      workspaceId,
      number: "001",
      createdBy: { _id: "user-1" },
      client: { _id: "client-1", name: "Alpha" },
      save: vi.fn().mockResolvedValue(true),
      populate: vi.fn().mockImplementation(function () {
        return Promise.resolve(this);
      }),
    };
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockInvoice),
    });

    const result = await resolver(
      null,
      { id: "inv-1", workspaceId, status: "CANCELED" },
      mockContext,
    );

    expect(result.status).toBe("CANCELED");
  });

  it("should throw on invalid transition COMPLETED to PENDING", async () => {
    const mockInvoice = {
      _id: "inv-1",
      status: "COMPLETED",
      workspaceId,
      createdBy: { _id: "user-1" },
    };
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(mockInvoice),
    });

    await expect(
      resolver(
        null,
        { id: "inv-1", workspaceId, status: "PENDING" },
        mockContext,
      ),
    ).rejects.toThrow();
  });

  it("should throw NOT_FOUND when invoice does not exist", async () => {
    Invoice.findOne.mockReturnValue({
      populate: vi.fn().mockResolvedValue(null),
    });

    await expect(
      resolver(
        null,
        { id: "nonexistent", workspaceId, status: "COMPLETED" },
        mockContext,
      ),
    ).rejects.toThrow();
  });
});
