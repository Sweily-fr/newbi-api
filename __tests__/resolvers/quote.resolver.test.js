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

// Side effects we don't want to exercise in unit tests
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/utils/documentNumbers.js", async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    generateQuoteNumber: vi.fn().mockResolvedValue("000001"),
    generateInvoiceNumber: vi.fn().mockResolvedValue("001"),
  };
});

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Quote from "../../src/models/Quote.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import { calculateQuoteTotals } from "../../src/resolvers/quote.js";

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

const ctx = (overrides = {}) =>
  buildContext({ userId, organizationId, ...overrides });

const insertQuote = (data) =>
  Quote.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    status: "PENDING",
    number: "0001",
    prefix: "D-202604",
    issueDate: new Date(),
    items: [],
    totalHT: 0,
    totalVAT: 0,
    totalTTC: 0,
    finalTotalHT: 0,
    finalTotalVAT: 0,
    finalTotalTTC: 0,
    discount: 0,
    discountType: "FIXED",
    client: { id: "client-1", name: "Acme" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  });

describe("Quote Resolver - Query.quote", () => {
  const resolver = quoteResolvers.Query.quote;

  it("returns a quote by id", async () => {
    const { insertedId } = await insertQuote({ number: "0042" });

    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result.number).toBe("0042");
  });

  it("throws NOT_FOUND when quote does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(
        null,
        { id: fakeId, workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé/i);
  });

  it("does not leak quotes across workspaces", async () => {
    const otherOrg = buildOrganizationId();
    const { insertedId } = await Quote.collection.insertOne({
      workspaceId: otherOrg,
      createdBy: userId,
      status: "PENDING",
      number: "9999",
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

describe("Quote Resolver - Query.quotes", () => {
  const resolver = quoteResolvers.Query.quotes;

  it("returns paginated quote list", async () => {
    for (let i = 0; i < 25; i++) {
      await insertQuote({ number: String(i).padStart(4, "0") });
    }

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx(),
    );

    expect(result.totalCount).toBe(25);
    expect(result.hasNextPage).toBe(true);
    expect(result.quotes).toHaveLength(10);
  });

  it("filters by status", async () => {
    await insertQuote({ status: "PENDING", number: "P1" });
    await insertQuote({ status: "PENDING", number: "P2" });
    await insertQuote({ status: "COMPLETED", number: "C1" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        status: "PENDING",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(2);
    expect(result.quotes.every((q) => q.status === "PENDING")).toBe(true);
  });

  it("supports text search on number/client.name/client.email", async () => {
    await insertQuote({
      number: "ALPHA-001",
      client: { id: "c1", name: "Alpha Corp" },
    });
    await insertQuote({
      number: "BETA-001",
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
    expect(result.quotes[0].number).toBe("ALPHA-001");
  });

  it("filters by date range", async () => {
    await insertQuote({ createdAt: new Date("2026-02-01") });
    await insertQuote({ createdAt: new Date("2026-06-01") });
    await insertQuote({ createdAt: new Date("2026-11-01") });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        startDate: "2026-05-01",
        endDate: "2026-09-01",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("scopes results to the active workspace", async () => {
    await insertQuote();
    await Quote.collection.insertOne({
      workspaceId: buildOrganizationId(),
      createdBy: userId,
      status: "PENDING",
      number: "9999",
    });

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });
});

describe("Quote Resolver - Mutation.deleteQuote (RBAC + status guard)", () => {
  const resolver = quoteResolvers.Mutation.deleteQuote;

  it("deletes a PENDING quote", async () => {
    const { insertedId } = await insertQuote({ status: "PENDING" });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(result).toBe(true);
    expect(await Quote.collection.findOne({ _id: insertedId })).toBeNull();
  });

  it("blocks deletion of a COMPLETED quote", async () => {
    const { insertedId } = await insertQuote({ status: "COMPLETED" });

    await expect(
      resolver(null, { id: insertedId.toString() }, ctx()),
    ).rejects.toThrow(/terminé|completed/i);
  });

  it("blocks deletion of a quote already converted to invoice", async () => {
    const { insertedId } = await insertQuote({
      status: "PENDING",
      convertedToInvoice: new mongoose.Types.ObjectId(),
    });

    await expect(
      resolver(null, { id: insertedId.toString() }, ctx()),
    ).rejects.toThrow(/converti|invoice/i);
  });

  it("throws NOT_FOUND when quote does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      /non trouvé/i,
    );
  });

  it("blocks viewer role from deleting", async () => {
    const viewerUserId = buildUserId();
    const viewerOrg = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrg,
      role: "viewer",
    });
    const { insertedId } = await Quote.collection.insertOne({
      workspaceId: viewerOrg,
      createdBy: viewerUserId,
      status: "PENDING",
      number: "0001",
    });

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrg,
    });

    await expect(
      resolver(null, { id: insertedId.toString() }, viewerCtx),
    ).rejects.toThrow(/permission|delete/i);
  });
});

describe("Quote totals — real calculator", () => {
  it("computes simple totals", () => {
    const totals = calculateQuoteTotals([
      { quantity: 2, unitPrice: 100, vatRate: 20 },
    ]);
    expect(totals.totalHT).toBe(200);
    expect(totals.totalVAT).toBe(40);
    expect(totals.totalTTC).toBe(240);
  });

  it("applies item-level percentage discount", () => {
    const totals = calculateQuoteTotals([
      {
        quantity: 1,
        unitPrice: 1000,
        vatRate: 20,
        discount: 10,
        discountType: "PERCENTAGE",
      },
    ]);
    expect(totals.totalHT).toBe(900);
  });

  it("applies item-level fixed discount", () => {
    const totals = calculateQuoteTotals([
      {
        quantity: 1,
        unitPrice: 500,
        vatRate: 20,
        discount: 50,
        discountType: "FIXED",
      },
    ]);
    expect(totals.totalHT).toBe(450);
  });

  it("adds shipping when billShipping is true", () => {
    const totals = calculateQuoteTotals(
      [{ quantity: 1, unitPrice: 100, vatRate: 20 }],
      0,
      "FIXED",
      { billShipping: true, shippingAmountHT: 50, shippingVatRate: 20 },
    );
    expect(totals.totalHT).toBe(150);
    expect(totals.totalVAT).toBe(30);
  });

  it("applies global percentage discount", () => {
    const totals = calculateQuoteTotals(
      [{ quantity: 1, unitPrice: 1000, vatRate: 20 }],
      15,
      "PERCENTAGE",
    );
    expect(totals.discountAmount).toBe(150);
    expect(totals.finalTotalHT).toBe(850);
  });
});
