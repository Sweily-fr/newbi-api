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
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

// Side effects we don't exercise in unit tests
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { processInvoice: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { getOrCreateSettings: vi.fn().mockResolvedValue({}) },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import invoiceResolvers, {
  calculateInvoiceTotals,
} from "../../src/resolvers/invoice.js";

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
});

const ctx = () => buildContext({ userId, organizationId });

const insertInvoice = (overrides = {}) =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    number: "0001",
    prefix: "F-202604",
    status: "PENDING",
    items: [],
    totalHT: 0,
    totalVAT: 0,
    totalTTC: 0,
    finalTotalHT: 0,
    finalTotalVAT: 0,
    finalTotalTTC: 0,
    discount: 0,
    discountType: "FIXED",
    issueDate: new Date(),
    client: { id: "client-1", name: "Acme Corp" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

describe("Invoice Resolver - Query.invoice", () => {
  const resolver = invoiceResolvers.Query.invoice;

  it("returns an invoice by id", async () => {
    const { insertedId } = await insertInvoice({ number: "0042" });

    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result.number).toBe("0042");
  });

  it("throws NOT_FOUND when invoice does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(
        null,
        { id: fakeId, workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé/i);
  });

  it("does not leak invoices across workspaces", async () => {
    const otherOrg = buildOrganizationId();
    const { insertedId } = await Invoice.collection.insertOne({
      workspaceId: otherOrg,
      createdBy: userId,
      number: "9999",
      status: "PENDING",
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé/i);
  });
});

describe("Invoice Resolver - Query.invoices", () => {
  const resolver = invoiceResolvers.Query.invoices;

  it("returns paginated invoice list", async () => {
    for (let i = 0; i < 25; i++) {
      await insertInvoice({ number: String(i).padStart(4, "0") });
    }

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx(),
    );

    expect(result.totalCount).toBe(25);
    expect(result.hasNextPage).toBe(true);
    expect(result.invoices).toHaveLength(10);
  });

  it("filters by status (and groups COMPLETED with CANCELED)", async () => {
    await insertInvoice({ status: "COMPLETED", number: "1" });
    await insertInvoice({ status: "CANCELED", number: "2" });
    await insertInvoice({ status: "PENDING", number: "3" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        status: "COMPLETED",
        page: 1,
        limit: 10,
      },
      ctx(),
    );
    expect(result.totalCount).toBe(2);
  });

  it("supports text search", async () => {
    await insertInvoice({
      number: "ALPHA",
      client: { id: "c1", name: "Alpha Corp" },
    });
    await insertInvoice({
      number: "BETA",
      client: { id: "c2", name: "Beta Inc" },
    });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        search: "Alpha",
        page: 1,
        limit: 10,
      },
      ctx(),
    );
    expect(result.totalCount).toBe(1);
  });

  it("filters by date range on createdAt", async () => {
    await insertInvoice({ createdAt: new Date("2026-01-15") });
    await insertInvoice({ createdAt: new Date("2026-06-15") });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        startDate: "2026-05-01",
        endDate: "2026-12-31",
        page: 1,
        limit: 10,
      },
      ctx(),
    );
    expect(result.totalCount).toBe(1);
  });
});

describe("Invoice totals — real calculator", () => {
  it("computes a realistic multi-line invoice", () => {
    const result = calculateInvoiceTotals(
      [
        { quantity: 5, unitPrice: 200, vatRate: 20 },
        { quantity: 10, unitPrice: 50, vatRate: 5.5 },
        {
          quantity: 1,
          unitPrice: 3000,
          vatRate: 20,
          discount: 10,
          discountType: "PERCENTAGE",
        },
      ],
      5,
      "PERCENTAGE",
    );

    expect(result.totalHT).toBe(4200);
    expect(result.totalVAT).toBe(767.5);
    expect(result.discountAmount).toBe(210);
    expect(result.finalTotalHT).toBe(3990);
    expect(result.finalTotalVAT).toBeCloseTo(729.125, 2);
    expect(result.finalTotalTTC).toBeCloseTo(4719.125, 2);
  });

  it("handles combined item + global discount", () => {
    const result = calculateInvoiceTotals(
      [
        {
          quantity: 1,
          unitPrice: 1000,
          vatRate: 20,
          discount: 100,
          discountType: "FIXED",
        },
      ],
      50,
      "FIXED",
    );
    expect(result.totalHT).toBe(900);
    expect(result.finalTotalHT).toBe(850);
  });

  it("zeroes VAT under reverse charge with shipping", () => {
    const result = calculateInvoiceTotals(
      [{ quantity: 1, unitPrice: 500, vatRate: 20 }],
      0,
      "FIXED",
      { billShipping: true, shippingAmountHT: 50, shippingVatRate: 20 },
      true,
    );
    expect(result.totalHT).toBe(550);
    expect(result.totalVAT).toBe(0);
    expect(result.finalTotalVAT).toBe(0);
    expect(result.finalTotalTTC).toBe(550);
  });
});
