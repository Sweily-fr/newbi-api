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
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

// Mock fire-and-forget automations
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userId = buildUserId();
const organizationId = buildOrganizationId();

function buildPOInput(overrides = {}) {
  return {
    items: [
      { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
    ],
    client: {
      name: "Fournisseur Test",
      email: "fournisseur@test.fr",
      address: {
        street: "10 avenue Fournisseur",
        city: "Lyon",
        postalCode: "69001",
        country: "France",
      },
    },
    issueDate: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  // requireCompanyInfo validates capitalSocial + rcs for SASU
  const db = mongoose.connection.db;
  await db.collection("organization").updateOne(
    { _id: organizationId },
    {
      $set: {
        capitalSocial: "10000",
        rcs: "Paris B 123 456 789",
        vatNumber: "FR12345678901",
      },
    },
  );
});

const ctx = () => buildContext({ userId, organizationId });

// ---------------------------------------------------------------------------
// Tests — createPurchaseOrder
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — createPurchaseOrder", () => {
  const resolver = purchaseOrderResolvers.Mutation.createPurchaseOrder;

  it("calculates totals correctly from items", async () => {
    const input = buildPOInput();
    const result = await resolver(null, { input }, ctx());

    expect(result).toBeDefined();
    // 2 × 500 = 1000 HT, 20% VAT = 200, TTC = 1200
    expect(result.finalTotalHT).toBeCloseTo(1000, 0);
    expect(result.finalTotalVAT).toBeCloseTo(200, 0);
    expect(result.finalTotalTTC).toBeCloseTo(1200, 0);
  });

  it("stores shipping info when billShipping is true", async () => {
    const input = buildPOInput({
      prefix: "BC-SHIP",
      shipping: {
        billShipping: true,
        shippingAmountHT: 50,
        shippingVatRate: 20,
        shippingAddress: {
          fullName: "Dest",
          street: "5 rue Livraison",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
    });
    const result = await resolver(null, { input }, ctx());

    expect(result).toBeDefined();
    expect(result.shipping).toBeDefined();
    expect(result.shipping.billShipping).toBe(true);
    expect(result.shipping.shippingAmountHT).toBe(50);
    // Totals include shipping in the calculation
    expect(result.finalTotalTTC).toBeGreaterThan(0);
  });

  it("generates a prefix starting with BC-", async () => {
    const input = buildPOInput();
    const result = await resolver(null, { input }, ctx());

    expect(result.prefix).toMatch(/^BC-/);
  });
});

// ---------------------------------------------------------------------------
// Tests — updatePurchaseOrder
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — updatePurchaseOrder", () => {
  it("recalculates totals when items change", async () => {
    const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
    const po = await create(null, { input: buildPOInput() }, ctx());

    const update = purchaseOrderResolvers.Mutation.updatePurchaseOrder;
    const updated = await update(
      null,
      {
        id: po._id.toString(),
        input: {
          items: [
            { description: "New", quantity: 3, unitPrice: 100, vatRate: 10 },
          ],
        },
      },
      ctx(),
    );

    // 3 × 100 = 300 HT, 10% = 30 VAT, TTC = 330
    expect(updated.finalTotalHT).toBeCloseTo(300, 0);
    expect(updated.finalTotalTTC).toBeCloseTo(330, 0);
  });

  it("blocks update when status is DELIVERED", async () => {
    const _id = new mongoose.Types.ObjectId();
    await PurchaseOrder.collection.insertOne({
      _id,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: "BC-202605",
      status: "DELIVERED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
    });

    const update = purchaseOrderResolvers.Mutation.updatePurchaseOrder;
    await expect(
      update(null, { id: _id.toString(), input: { items: [] } }, ctx()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — deletePurchaseOrder
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — deletePurchaseOrder", () => {
  it("deletes a DRAFT purchase order", async () => {
    const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
    const po = await create(null, { input: buildPOInput() }, ctx());

    const del = purchaseOrderResolvers.Mutation.deletePurchaseOrder;
    const result = await del(null, { id: po._id.toString() }, ctx());

    expect(result).toBe(true);
    expect(await PurchaseOrder.findById(po._id)).toBeNull();
  });

  it("blocks deletion of DELIVERED purchase order", async () => {
    const _id = new mongoose.Types.ObjectId();
    await PurchaseOrder.collection.insertOne({
      _id,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: "BC-202605",
      status: "DELIVERED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
    });

    const del = purchaseOrderResolvers.Mutation.deletePurchaseOrder;
    await expect(del(null, { id: _id.toString() }, ctx())).rejects.toThrow();

    expect(await PurchaseOrder.findById(_id)).not.toBeNull();
  });

  it("blocks deletion when linkedInvoices exist", async () => {
    const _id = new mongoose.Types.ObjectId();
    await PurchaseOrder.collection.insertOne({
      _id,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0002",
      prefix: "BC-202605",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      linkedInvoices: [new mongoose.Types.ObjectId()],
    });

    const del = purchaseOrderResolvers.Mutation.deletePurchaseOrder;
    await expect(del(null, { id: _id.toString() }, ctx())).rejects.toThrow();

    expect(await PurchaseOrder.findById(_id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — changePurchaseOrderStatus
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — changePurchaseOrderStatus", () => {
  // DRAFT→CONFIRMED uses MongoDB transactions (atomic number generation)
  // which require a replica set — MongoMemoryServer standalone cannot run them.
  it.skip("transitions DRAFT → CONFIRMED (requires replica set)", async () => {
    const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-CONF" }) },
      ctx(),
    );

    expect(po.status).toBe("DRAFT");

    const change = purchaseOrderResolvers.Mutation.changePurchaseOrderStatus;
    const updated = await change(
      null,
      { id: po._id.toString(), status: "CONFIRMED" },
      ctx(),
    );

    expect(updated.status).toBe("CONFIRMED");
  });

  it("rejects invalid transition (DRAFT → DELIVERED)", async () => {
    const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-INV" }) },
      ctx(),
    );

    const change = purchaseOrderResolvers.Mutation.changePurchaseOrderStatus;
    await expect(
      change(null, { id: po._id.toString(), status: "DELIVERED" }, ctx()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — convertPurchaseOrderToInvoice
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — convertPurchaseOrderToInvoice", () => {
  // Conversion requires CONFIRMED status which uses transactions (replica set).
  it.skip("creates a DRAFT invoice from a CONFIRMED PO (requires replica set)", async () => {
    const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-CONV" }) },
      ctx(),
    );

    // Transition to CONFIRMED first
    const change = purchaseOrderResolvers.Mutation.changePurchaseOrderStatus;
    await change(null, { id: po._id.toString(), status: "CONFIRMED" }, ctx());

    const convert =
      purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice;
    const invoice = await convert(null, { id: po._id.toString() }, ctx());

    expect(invoice).toBeDefined();
    expect(invoice.status).toBe("DRAFT");
    expect(invoice.prefix).toMatch(/^F-/);

    // PO should now have the invoice in linkedInvoices
    const updatedPO = await PurchaseOrder.findById(po._id);
    expect(updatedPO.linkedInvoices).toHaveLength(1);
  });

  it("rejects conversion of a DRAFT purchase order", async () => {
    const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-DRAF" }) },
      ctx(),
    );

    const convert =
      purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice;
    await expect(
      convert(null, { id: po._id.toString() }, ctx()),
    ).rejects.toThrow();
  });

  it("rejects re-conversion when the PO already has a linked invoice", async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    await Invoice.collection.insertOne({
      _id: invoiceId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "001",
      prefix: "F-RECONV",
      status: "DRAFT",
      finalTotalTTC: 1200,
      createdAt: new Date(),
    });

    const { insertedId: poId } = await PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "300",
      prefix: "BC-RECONV",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      linkedInvoices: [invoiceId],
    });

    const convert =
      purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice;
    await expect(convert(null, { id: poId.toString() }, ctx())).rejects.toThrow(
      /déjà été converti en facture/i,
    );
  });

  it("rejects conversion when the source quote was already invoiced directly", async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    await Invoice.collection.insertOne({
      _id: invoiceId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "002",
      prefix: "F-DIRECT",
      status: "PENDING",
      finalTotalTTC: 1200,
      createdAt: new Date(),
    });

    const { insertedId: quoteId } = await Quote.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0010",
      prefix: "D-GUARD",
      status: "COMPLETED",
      items: [],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      linkedInvoices: [invoiceId],
    });

    const { insertedId: poId } = await PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "301",
      prefix: "BC-GUARD",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      sourceQuoteId: quoteId,
    });

    const convert =
      purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice;
    await expect(convert(null, { id: poId.toString() }, ctx())).rejects.toThrow(
      /devis à l'origine/i,
    );
  });

  it("rejects conversion when the source quote was already invoiced via another PO", async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    await Invoice.collection.insertOne({
      _id: invoiceId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "003",
      prefix: "F-SIBLING",
      status: "PENDING",
      finalTotalTTC: 1200,
      createdAt: new Date(),
    });

    const { insertedId: quoteId } = await Quote.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0011",
      prefix: "D-SIBL",
      status: "COMPLETED",
      items: [],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
    });

    // Premier BC issu du devis, déjà converti en facture
    await PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "302",
      prefix: "BC-SIBL",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      sourceQuoteId: quoteId,
      linkedInvoices: [invoiceId],
    });

    // Second BC issu du même devis, sans facture
    const { insertedId: poId } = await PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "303",
      prefix: "BC-SIBL",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      sourceQuoteId: quoteId,
    });

    const convert =
      purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice;
    await expect(convert(null, { id: poId.toString() }, ctx())).rejects.toThrow(
      /autre bon de commande/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — Queries
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — Queries", () => {
  it("purchaseOrders returns paginated list with status filter", async () => {
    // Insert via raw collection to avoid number collision
    for (let i = 0; i < 2; i++) {
      await PurchaseOrder.collection.insertOne({
        _id: new mongoose.Types.ObjectId(),
        workspaceId: organizationId,
        createdBy: userId,
        number: String(100 + i),
        prefix: "BC-LIST",
        status: "DRAFT",
        items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
        client: { name: "Test", email: "t@t.fr" },
        issueDate: new Date(),
        createdAt: new Date(),
        finalTotalTTC: 120,
      });
    }

    const list = purchaseOrderResolvers.Query.purchaseOrders;
    const result = await list(
      null,
      { page: 1, limit: 10, status: "DRAFT" },
      ctx(),
    );

    expect(result.purchaseOrders).toHaveLength(2);
    expect(result.totalCount).toBe(2);
  });

  it("purchaseOrderStats returns correct aggregation", async () => {
    for (let i = 0; i < 2; i++) {
      await PurchaseOrder.collection.insertOne({
        _id: new mongoose.Types.ObjectId(),
        workspaceId: organizationId,
        createdBy: userId,
        number: String(200 + i),
        prefix: "BC-STATS",
        status: "DRAFT",
        items: [{ description: "X", quantity: 1, unitPrice: 500, vatRate: 20 }],
        client: { name: "Test", email: "t@t.fr" },
        issueDate: new Date(),
        createdAt: new Date(),
        finalTotalTTC: 600,
      });
    }

    const stats = purchaseOrderResolvers.Query.purchaseOrderStats;
    const result = await stats(null, {}, ctx());

    expect(result.totalCount).toBe(2);
    expect(result.draftCount).toBe(2);
    expect(result.totalAmount).toBeGreaterThan(0);
  });
});
