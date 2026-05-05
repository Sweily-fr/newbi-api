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
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";

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
  buildContext({
    userId,
    organizationId,
    extra: { userRole: "owner", ...overrides },
  });

// Note: Mongoose schema requires description on items + email/address on client
// Even when inserting via raw collection, the doc must satisfy validation when later
// loaded and re-saved by mutations like markInvoiceAsPaid / changeInvoiceStatus.
const insertInvoice = (overrides = {}) =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    number: "0001",
    prefix: "F-202604",
    status: "PENDING",
    items: [
      {
        description: "Service",
        quantity: 1,
        unitPrice: 1000,
        vatRate: 20,
      },
    ],
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalVAT: 200,
    finalTotalTTC: 1200,
    discount: 0,
    discountType: "FIXED",
    issueDate: new Date(),
    client: {
      id: "client-1",
      name: "Acme",
      email: "client@test.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

describe("Invoice Resolver - Query.invoiceStats", () => {
  const resolver = invoiceResolvers.Query.invoiceStats;

  it("aggregates real invoice stats", async () => {
    await insertInvoice({ status: "DRAFT", finalTotalTTC: 100 });
    await insertInvoice({ status: "PENDING", finalTotalTTC: 200 });
    await insertInvoice({ status: "PENDING", finalTotalTTC: 300 });
    await insertInvoice({ status: "COMPLETED", finalTotalTTC: 500 });

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result.totalCount).toBeGreaterThanOrEqual(4);
  });

  it("returns zeroes when there are no invoices", async () => {
    const result = await resolver(
      null,
      { workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result.totalCount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });
});

describe("Invoice Resolver - Mutation.deleteInvoice", () => {
  const resolver = invoiceResolvers.Mutation.deleteInvoice;

  it("deletes a DRAFT invoice", async () => {
    const { insertedId } = await insertInvoice({ status: "DRAFT" });

    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result).toBe(true);
    expect(await Invoice.collection.findOne({ _id: insertedId })).toBeNull();
  });

  it("deletes a PENDING invoice", async () => {
    const { insertedId } = await insertInvoice({ status: "PENDING" });

    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result).toBe(true);
  });

  it("blocks deletion of a COMPLETED invoice", async () => {
    const { insertedId } = await insertInvoice({ status: "COMPLETED" });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/finalisée|completed/i);
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

  it("blocks viewer role from deleting", async () => {
    const viewerUserId = buildUserId();
    const viewerOrg = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrg,
      role: "viewer",
    });
    const { insertedId } = await Invoice.collection.insertOne({
      workspaceId: viewerOrg,
      createdBy: viewerUserId,
      number: "0001",
      status: "PENDING",
    });

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrg,
      extra: { userRole: "viewer" },
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: viewerOrg.toString() },
        viewerCtx,
      ),
    ).rejects.toThrow(/permission|delete/i);
  });
});

describe("Invoice Resolver - Mutation.markInvoiceAsPaid", () => {
  const resolver = invoiceResolvers.Mutation.markInvoiceAsPaid;

  it("marks a PENDING invoice as paid", async () => {
    const { insertedId } = await insertInvoice({ status: "PENDING" });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        workspaceId: organizationId.toString(),
        paymentDate: "2026-03-15",
      },
      ctx(),
    );

    expect(result.status).toBe("COMPLETED");
  });

  it("blocks marking a DRAFT invoice as paid", async () => {
    const { insertedId } = await insertInvoice({ status: "DRAFT" });

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          workspaceId: organizationId.toString(),
          paymentDate: "2026-03-15",
        },
        ctx(),
      ),
    ).rejects.toThrow(/brouillon|DRAFT/i);
  });

  it("blocks marking a CANCELED invoice as paid", async () => {
    const { insertedId } = await insertInvoice({ status: "CANCELED" });

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          workspaceId: organizationId.toString(),
          paymentDate: "2026-03-15",
        },
        ctx(),
      ),
    ).rejects.toThrow(/annulée|CANCELED/i);
  });

  it("throws NOT_FOUND when invoice does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(
        null,
        {
          id: fakeId,
          workspaceId: organizationId.toString(),
          paymentDate: "2026-03-15",
        },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé/i);
  });
});

describe("Invoice Resolver - Mutation.changeInvoiceStatus", () => {
  const resolver = invoiceResolvers.Mutation.changeInvoiceStatus;

  it("transitions PENDING to COMPLETED", async () => {
    const { insertedId } = await insertInvoice({ status: "PENDING" });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        workspaceId: organizationId.toString(),
        status: "COMPLETED",
      },
      ctx(),
    );

    expect(result.status).toBe("COMPLETED");
  });

  it("transitions PENDING to CANCELED", async () => {
    const { insertedId } = await insertInvoice({ status: "PENDING" });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        workspaceId: organizationId.toString(),
        status: "CANCELED",
      },
      ctx(),
    );

    expect(result.status).toBe("CANCELED");
  });

  it("throws NOT_FOUND when invoice does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(
        null,
        {
          id: fakeId,
          workspaceId: organizationId.toString(),
          status: "COMPLETED",
        },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé/i);
  });
});
