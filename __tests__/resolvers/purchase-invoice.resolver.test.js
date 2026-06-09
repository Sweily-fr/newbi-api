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

// External side effects we don't exercise here
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    uploadImage: vi.fn().mockResolvedValue({
      url: "https://test.r2.dev/test.pdf",
      key: "test.pdf",
    }),
  },
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: {
    getReceivedInvoices: vi.fn(),
    transformReceivedInvoiceToPurchaseInvoice: vi.fn(),
    submitInvoiceEvent: vi.fn(),
  },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { isEInvoicingEnabled: vi.fn() },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Supplier from "../../src/models/Supplier.js";
import superPdpService from "../../src/services/superPdpService.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";

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

const insertPurchaseInvoice = (overrides = {}) =>
  PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    supplierName: "Acme Supplier",
    invoiceNumber: "PI-001",
    issueDate: new Date(),
    amountTTC: 1200,
    amountHT: 1000,
    vatAmount: 200,
    status: "TO_PAY",
    files: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

describe("PurchaseInvoice Resolver - Query.purchaseInvoice", () => {
  const resolver = purchaseInvoiceResolvers.Query.purchaseInvoice;

  it("returns a purchase invoice by id", async () => {
    const { insertedId } = await insertPurchaseInvoice({
      invoiceNumber: "PI-042",
    });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(result.invoiceNumber).toBe("PI-042");
  });

  it("throws NOT_FOUND when document does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      /non trouvée/i,
    );
  });

  it("does not leak across workspaces", async () => {
    const otherOrg = buildOrganizationId();
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: otherOrg,
      createdBy: userId,
      supplierName: "Other Supplier",
      invoiceNumber: "PI-9999",
      issueDate: new Date(),
      amountTTC: 100,
      status: "TO_PAY",
      files: [],
    });

    await expect(
      resolver(null, { id: insertedId.toString() }, ctx()),
    ).rejects.toThrow(/non trouvée/i);
  });
});

describe("PurchaseInvoice Resolver - Query.purchaseInvoices", () => {
  const resolver = purchaseInvoiceResolvers.Query.purchaseInvoices;

  it("returns paginated list", async () => {
    for (let i = 0; i < 25; i++) {
      await insertPurchaseInvoice({ invoiceNumber: `PI-${i}` });
    }

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx(),
    );

    expect(result.totalCount).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.items).toHaveLength(10);
  });

  it("filters by status", async () => {
    await insertPurchaseInvoice({ status: "TO_PAY" });
    await insertPurchaseInvoice({ status: "PAID" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        status: "PAID",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("filters by amount range", async () => {
    await insertPurchaseInvoice({ amountTTC: 100 });
    await insertPurchaseInvoice({ amountTTC: 500 });
    await insertPurchaseInvoice({ amountTTC: 1000 });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        minAmount: 200,
        maxAmount: 800,
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("supports search on supplierName/invoiceNumber", async () => {
    await insertPurchaseInvoice({
      supplierName: "Acme Co",
      invoiceNumber: "X1",
    });
    await insertPurchaseInvoice({
      supplierName: "Beta Inc",
      invoiceNumber: "Y1",
    });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        search: "Acme",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });
});

describe("PurchaseInvoice Resolver - Mutation.deletePurchaseInvoice", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.deletePurchaseInvoice;

  it("deletes a purchase invoice", async () => {
    const { insertedId } = await insertPurchaseInvoice();

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(result).toEqual({
      success: true,
      message: "Facture d'achat supprimée",
    });
    expect(
      await PurchaseInvoice.collection.findOne({ _id: insertedId }),
    ).toBeNull();
  });

  it("throws when document does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      /non trouvée/i,
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
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: viewerOrg,
      createdBy: viewerUserId,
      supplierName: "x",
      invoiceNumber: "x",
      issueDate: new Date(),
      amountTTC: 1,
      status: "TO_PAY",
      files: [],
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

describe("PurchaseInvoice Resolver - Mutation.markPurchaseInvoiceAsPaid", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.markPurchaseInvoiceAsPaid;

  it("marks invoice as paid with payment date and method", async () => {
    const { insertedId } = await insertPurchaseInvoice({ status: "TO_PAY" });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        paymentDate: "2026-03-10",
        paymentMethod: "BANK_TRANSFER",
      },
      ctx(),
    );

    expect(result.status).toBe("PAID");
    expect(result.paymentMethod).toBe("BANK_TRANSFER");
  });
});

describe("PurchaseInvoice Resolver - Mutation.bulkUpdatePurchaseInvoiceStatus", () => {
  const resolver =
    purchaseInvoiceResolvers.Mutation.bulkUpdatePurchaseInvoiceStatus;

  it("bulk updates statuses for ids in workspace", async () => {
    const { insertedId: a } = await insertPurchaseInvoice({ status: "TO_PAY" });
    const { insertedId: b } = await insertPurchaseInvoice({ status: "TO_PAY" });
    const { insertedId: c } = await insertPurchaseInvoice({ status: "TO_PAY" });

    const result = await resolver(
      null,
      { ids: [a.toString(), b.toString(), c.toString()], status: "PAID" },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.updatedCount).toBe(3);

    const remaining = await PurchaseInvoice.collection.countDocuments({
      _id: { $in: [a, b, c] },
      status: "PAID",
    });
    expect(remaining).toBe(3);
  });
});

describe("PurchaseInvoice Resolver - submitPurchaseInvoiceEInvoiceEvent", () => {
  const resolver =
    purchaseInvoiceResolvers.Mutation.submitPurchaseInvoiceEInvoiceEvent;

  it("émet fr:207 et passe l'e-facture en DISPUTED", async () => {
    superPdpService.submitInvoiceEvent.mockReset();
    superPdpService.submitInvoiceEvent.mockResolvedValue({ success: true });
    const { insertedId } = await insertPurchaseInvoice({
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-77",
      eInvoiceStatus: "RECEIVED",
    });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        statusCode: "fr:207",
        reason: "Montant erroné",
      },
      ctx(),
    );

    const call = superPdpService.submitInvoiceEvent.mock.calls[0];
    expect(call[1]).toBe("sp-77");
    expect(call[2]).toBe("fr:207");
    expect(call[3]).toEqual({ reason: "Montant erroné" });
    expect(result.eInvoiceStatus).toBe("DISPUTED");
  });

  it("rejette un code de statut non supporté", async () => {
    const { insertedId } = await insertPurchaseInvoice({
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-78",
      eInvoiceStatus: "RECEIVED",
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), statusCode: "fr:999" },
        ctx(),
      ),
    ).rejects.toThrow(/non supporté/i);
  });

  it("rejette une facture non liée à SuperPDP", async () => {
    const { insertedId } = await insertPurchaseInvoice();
    await expect(
      resolver(
        null,
        { id: insertedId.toString(), statusCode: "fr:205" },
        ctx(),
      ),
    ).rejects.toThrow(/SuperPDP/i);
  });
});

describe("PurchaseInvoice Resolver - markPurchaseInvoiceAsPaid (e-invoicing)", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.markPurchaseInvoiceAsPaid;

  it("signale le paiement à SuperPDP et passe l'e-facture en PAID", async () => {
    superPdpService.submitInvoiceEvent.mockReset();
    superPdpService.submitInvoiceEvent.mockResolvedValue({ success: true });
    const { insertedId } = await insertPurchaseInvoice({
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-90",
      eInvoiceStatus: "ACCEPTED",
    });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    const call = superPdpService.submitInvoiceEvent.mock.calls[0];
    expect(call[1]).toBe("sp-90");
    expect(call[2]).toBe("fr:211");
    expect(result.status).toBe("PAID");
    expect(result.eInvoiceStatus).toBe("PAID");
  });

  it("ne touche pas SuperPDP pour une facture saisie manuellement", async () => {
    superPdpService.submitInvoiceEvent.mockReset();
    const { insertedId } = await insertPurchaseInvoice({ source: "MANUAL" });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(superPdpService.submitInvoiceEvent).not.toHaveBeenCalled();
    expect(result.status).toBe("PAID");
  });
});
