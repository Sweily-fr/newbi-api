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
import {
  buildOrganizationId,
  buildUserId,
  buildClientDoc,
} from "../factories/index.js";

// Mock side effects (clientAutomation imported by client.js + invoice.js)
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
    isFirstPaidInvoice: vi.fn().mockResolvedValue(false),
  },
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

// Models
import Client from "../../src/models/Client.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import CreditNote from "../../src/models/CreditNote.js";
import Product from "../../src/models/Product.js";
import Expense from "../../src/models/Expense.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import ImportedPurchaseOrder from "../../src/models/ImportedPurchaseOrder.js";
import ImportedQuote from "../../src/models/ImportedQuote.js";

// Resolvers
import clientResolvers from "../../src/resolvers/client.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import creditNoteResolvers from "../../src/resolvers/creditNote.js";
import productResolvers from "../../src/resolvers/product.js";
import expenseResolvers from "../../src/resolvers/expense.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";
import importedPurchaseOrderResolvers from "../../src/resolvers/importedPurchaseOrder.js";
import importedQuoteResolvers from "../../src/resolvers/importedQuote.js";

// ---------------------------------------------------------------------------
// Resource configuration table
// ---------------------------------------------------------------------------

const RESOURCES = [
  {
    name: "Client",
    model: Client,
    resolver: clientResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) =>
      buildClientDoc({ workspaceId, createdBy }),
    insertMode: "model.create",
    querySingle: {
      name: "client",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "clients",
      buildArgs: (workspaceId) => ({ page: 1, limit: 10, workspaceId }),
      itemsField: "items",
      totalField: "totalItems",
    },
    mutationDelete: {
      name: "deleteClient",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
  },

  {
    name: "Invoice",
    model: Invoice,
    resolver: invoiceResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      createdBy,
      number: `INV-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      items: [
        { description: "Test", quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
      status: "DRAFT",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "invoice",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "invoices",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "invoices",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deleteInvoice",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
  },

  {
    name: "Quote",
    model: Quote,
    resolver: quoteResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      createdBy,
      number: `QT-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      items: [
        { description: "Test", quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
      status: "PENDING",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "quote",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "quotes",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "quotes",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deleteQuote",
      buildArgs: (id) => ({ id }),
    },
  },

  {
    name: "CreditNote",
    model: CreditNote,
    resolver: creditNoteResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      createdBy,
      number: `CN-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      originalInvoice: new mongoose.Types.ObjectId(),
      originalInvoiceNumber: "INV-000001",
      creditType: "CORRECTION",
      issueDate: new Date(),
      items: [
        {
          description: "Test",
          quantity: 1,
          unitPrice: 100,
          vatRate: 20,
          total: 100,
        },
      ],
      companyInfo: {
        companyName: "Test Corp",
        companyEmail: "test@test.fr",
        siret: "12345678901234",
        addressStreet: "1 rue du Test",
        addressCity: "Paris",
        addressZipCode: "75001",
        addressCountry: "France",
        legalForm: "SASU",
      },
      client: {
        name: "Client Test",
        email: "client@test.fr",
        address: {
          street: "2 rue Client",
          city: "Lyon",
          postalCode: "69001",
          country: "France",
        },
      },
      status: "CREATED",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "creditNote",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "creditNotes",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "creditNotes",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deleteCreditNote",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
  },

  {
    name: "Product",
    model: Product,
    resolver: productResolvers,
    buildMinimalDoc: ({ workspaceId }) => ({
      workspaceId,
      name: `Product-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      unitPrice: 100,
      vatRate: 20,
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "product",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "products",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "products",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deleteProduct",
      buildArgs: (id) => ({ id }),
    },
  },

  {
    name: "Expense",
    model: Expense,
    resolver: expenseResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      createdBy,
      title: `Expense-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      amount: 100,
      currency: "EUR",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "expense",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "expenses",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "expenses",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deleteExpense",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
  },

  {
    name: "PurchaseInvoice",
    model: PurchaseInvoice,
    resolver: purchaseInvoiceResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      createdBy,
      totalTTC: 100,
      currency: "EUR",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "purchaseInvoice",
      buildArgs: (id) => ({ id }),
    },
    queryList: {
      name: "purchaseInvoices",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "items",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deletePurchaseInvoice",
      buildArgs: (id) => ({ id }),
    },
  },

  {
    name: "PurchaseOrder",
    model: PurchaseOrder,
    resolver: purchaseOrderResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      createdBy,
      number: `PO-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      issueDate: new Date(),
      client: {
        name: "Client Test",
        email: "client@test.fr",
        address: {
          street: "2 rue Client",
          city: "Lyon",
          postalCode: "69001",
          country: "France",
        },
      },
      items: [
        { description: "Test", quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
      status: "DRAFT",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "purchaseOrder",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
    queryList: {
      name: "purchaseOrders",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 10 }),
      itemsField: "purchaseOrders",
      totalField: "totalCount",
    },
    mutationDelete: {
      name: "deletePurchaseOrder",
      buildArgs: (id, workspaceId) => ({ id, workspaceId }),
    },
  },

  {
    name: "ImportedInvoice",
    model: ImportedInvoice,
    resolver: importedInvoiceResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      importedBy: createdBy,
      totalTTC: 0,
      status: "VALIDATED",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "importedInvoice",
      buildArgs: (id) => ({ id }),
    },
    queryList: {
      name: "importedInvoices",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 20 }),
      itemsField: "invoices",
      totalField: "total",
    },
    mutationDelete: {
      name: "deleteImportedInvoice",
      buildArgs: (id) => ({ id }),
    },
  },

  {
    name: "ImportedPurchaseOrder",
    model: ImportedPurchaseOrder,
    resolver: importedPurchaseOrderResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      importedBy: createdBy,
      totalTTC: 0,
      status: "VALIDATED",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "importedPurchaseOrder",
      buildArgs: (id) => ({ id }),
    },
    queryList: {
      name: "importedPurchaseOrders",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 20 }),
      itemsField: "purchaseOrders",
      totalField: "total",
    },
    mutationDelete: {
      name: "deleteImportedPurchaseOrder",
      buildArgs: (id) => ({ id }),
    },
  },

  {
    name: "ImportedQuote",
    model: ImportedQuote,
    resolver: importedQuoteResolvers,
    buildMinimalDoc: ({ workspaceId, createdBy }) => ({
      workspaceId,
      importedBy: createdBy,
      totalTTC: 0,
      status: "VALIDATED",
      createdAt: new Date(),
    }),
    insertMode: "collection.insertOne",
    querySingle: {
      name: "importedQuote",
      buildArgs: (id) => ({ id }),
    },
    queryList: {
      name: "importedQuotes",
      buildArgs: (workspaceId) => ({ workspaceId, page: 1, limit: 20 }),
      itemsField: "quotes",
      totalField: "total",
    },
    mutationDelete: {
      name: "deleteImportedQuote",
      buildArgs: (id) => ({ id }),
    },
  },
];

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let orgA, orgB, userA, userB;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();

  orgA = { _id: buildOrganizationId() };
  orgB = { _id: buildOrganizationId() };
  userA = { _id: buildUserId() };
  userB = { _id: buildUserId() };

  await seedOrgMembership({
    userId: userA._id,
    organizationId: orgA._id,
    role: "owner",
    organizationName: "Org A",
  });
  await seedOrgMembership({
    userId: userB._id,
    organizationId: orgB._id,
    role: "owner",
    organizationName: "Org B",
  });
});

const ctxA = () =>
  buildContext({ userId: userA._id, organizationId: orgA._id });

// ---------------------------------------------------------------------------
// Parameterized tests — 4 cases per resource
// ---------------------------------------------------------------------------

describe.each(RESOURCES)("Multi-tenant isolation - $name", (resource) => {
  async function insertDocIn({ workspaceId, createdBy }) {
    const doc = resource.buildMinimalDoc({ workspaceId, createdBy });
    const _id = doc._id || new mongoose.Types.ObjectId();

    if (resource.insertMode === "collection.insertOne") {
      await resource.model.collection.insertOne({ ...doc, _id });
      return { _id, ...doc };
    }
    return resource.model.create(doc);
  }

  // Test 1 — query single cross-tenant deny
  it("query single: user from org A cannot read doc from org B", async () => {
    const docB = await insertDocIn({
      workspaceId: orgB._id,
      createdBy: userB._id,
    });

    const resolver = resource.resolver.Query[resource.querySingle.name];
    const args = resource.querySingle.buildArgs(
      docB._id.toString(),
      orgA._id.toString(),
    );

    await expect(resolver(null, args, ctxA())).rejects.toThrow();
  });

  // Test 2 — query list scoping (own org only)
  it("query list: user from org A only sees own docs", async () => {
    await insertDocIn({ workspaceId: orgA._id, createdBy: userA._id });
    await insertDocIn({ workspaceId: orgB._id, createdBy: userB._id });

    const resolver = resource.resolver.Query[resource.queryList.name];
    const args = resource.queryList.buildArgs(orgA._id.toString());
    const result = await resolver(null, args, ctxA());

    const items = result[resource.queryList.itemsField];
    const total = result[resource.queryList.totalField];

    expect(items).toHaveLength(1);
    expect(total).toBe(1);
  });

  // Test 3 — query list spoof deny (no leak)
  it("query list: spoofing org B workspaceId from org A context does not leak data", async () => {
    // Insert a doc only in org B
    await insertDocIn({
      workspaceId: orgB._id,
      createdBy: userB._id,
    });

    const resolver = resource.resolver.Query[resource.queryList.name];
    const args = resource.queryList.buildArgs(orgB._id.toString());

    // The resolver may either:
    //   (a) throw FORBIDDEN (e.g. RBAC strict membership check)
    //   (b) silently reconcile workspaceId via resolveWorkspaceId,
    //       returning 0 docs scoped to user A's org
    // Both behaviors prevent the cross-tenant data leak. We assert
    // that NO doc from org B is returned.
    let result;
    try {
      result = await resolver(null, args, ctxA());
    } catch {
      // Accept the throw path — spoof was rejected
      return;
    }

    // Accept the silent-reconciliation path: no doc from org B leaked
    const items = result[resource.queryList.itemsField];
    const total = result[resource.queryList.totalField];

    expect(items).toHaveLength(0);
    expect(total).toBe(0);
  });

  // Test 4 — mutation delete cross-tenant deny
  it("mutation delete: user from org A cannot delete doc from org B", async () => {
    const docB = await insertDocIn({
      workspaceId: orgB._id,
      createdBy: userB._id,
    });

    const resolver = resource.resolver.Mutation[resource.mutationDelete.name];
    const args = resource.mutationDelete.buildArgs(
      docB._id.toString(),
      orgA._id.toString(),
    );

    await expect(resolver(null, args, ctxA())).rejects.toThrow();

    // Verify doc B still exists in DB
    const stillExists = await resource.model.findById(docB._id);
    expect(stillExists).not.toBeNull();
  });
});
