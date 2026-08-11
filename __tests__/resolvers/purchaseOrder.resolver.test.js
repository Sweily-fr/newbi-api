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
// Tests — createPurchaseOrder (conflits de brouillons)
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — createPurchaseOrder (conflits de brouillons)", () => {
  const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;

  // Brouillon qui occupe un numéro définitif : c'est l'état d'un BC finalisé
  // repassé en brouillon (il conserve son numéro), invisible pour
  // nextPurchaseOrderNumber et validateNumberSequence mais présent dans
  // l'index unique.
  const insertNumberedDraft = (data = {}) =>
    PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: "BC-202607",
      status: "DRAFT",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: {
        name: "Test",
        email: "t@t.fr",
        address: {
          street: "1 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      issueDate: new Date(),
      issueYear: new Date().getFullYear(),
      createdAt: new Date(),
      ...data,
    });

  it("crée un BC finalisé sur un numéro occupé par un brouillon (le brouillon est renommé)", async () => {
    const { insertedId } = await insertNumberedDraft();

    const created = await create(
      null,
      {
        input: buildPOInput({
          prefix: "BC-202607",
          number: "0001",
          status: "CONFIRMED",
        }),
      },
      ctx(),
    );

    expect(created.status).toBe("CONFIRMED");
    expect(created.number).toBe("0001");

    const renamedDraft = await PurchaseOrder.findById(insertedId);
    expect(renamedDraft.status).toBe("DRAFT");
    expect(renamedDraft.number).not.toBe("0001");
    expect(renamedDraft.number).toMatch(/^0001-\d+$/);
  });

  it("renomme le brouillon avec un numéro qui reste éditable (≤ 20 caractères)", async () => {
    const { insertedId } = await insertNumberedDraft();

    await create(
      null,
      {
        input: buildPOInput({
          prefix: "BC-202607",
          number: "0001",
          status: "CONFIRMED",
        }),
      },
      ctx(),
    );

    const renamedDraft = await PurchaseOrder.findById(insertedId);
    expect(renamedDraft.number.length).toBeLessThanOrEqual(20);
    // Le brouillon renommé doit rester sauvegardable (validateur du modèle)
    renamedDraft.headerNotes = "édition après renommage";
    await expect(renamedDraft.save()).resolves.toBeDefined();
  });

  it("libère aussi le numéro sur le chemin séquentiel (sans numéro fourni)", async () => {
    const { insertedId } = await insertNumberedDraft();

    const created = await create(
      null,
      { input: buildPOInput({ prefix: "BC-202607", status: "CONFIRMED" }) },
      ctx(),
    );

    expect(created.status).toBe("CONFIRMED");
    expect(created.number).toBe("0001");

    const renamedDraft = await PurchaseOrder.findById(insertedId);
    expect(renamedDraft.number).toMatch(/^0001-\d+$/);
  });

  it("finalise un brouillon (DRAFT → CONFIRMED sans numéro fourni) malgré un brouillon squatteur", async () => {
    const { insertedId } = await insertNumberedDraft();
    const update = purchaseOrderResolvers.Mutation.updatePurchaseOrder;

    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-202607" }) },
      ctx(),
    );
    expect(po.number).toMatch(/^DRAFT-/);

    const finalized = await update(
      null,
      { id: po._id.toString(), input: { status: "CONFIRMED" } },
      ctx(),
    );

    expect(finalized.status).toBe("CONFIRMED");
    expect(finalized.number).toBe("0001");

    const renamedDraft = await PurchaseOrder.findById(insertedId);
    expect(renamedDraft.number).toMatch(/^0001-\d+$/);
  });

  it("convertit un devis en BC malgré un brouillon squatteur", async () => {
    const now = new Date();
    const convertPrefix = `BC-${now.getFullYear()}${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}`;
    const { insertedId } = await insertNumberedDraft({
      prefix: convertPrefix,
    });

    const quoteId = new mongoose.Types.ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0100",
      prefix: "D-CONV",
      status: "COMPLETED",
      items: [
        { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
      ],
      client: {
        name: "Client Test",
        email: "c@test.fr",
        address: {
          street: "1 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      issueDate: new Date(),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      finalTotalTTC: 1200,
    });

    const convertQuote =
      purchaseOrderResolvers.Mutation.convertQuoteToPurchaseOrder;
    const converted = await convertQuote(null, { quoteId }, ctx());

    expect(converted.status).toBe("CONFIRMED");
    expect(converted.number).toBe("0001");

    const renamedDraft = await PurchaseOrder.findById(insertedId);
    expect(renamedDraft.number).toMatch(/^0001-\d+$/);
  });

  it("ne touche pas aux brouillons d'un autre préfixe", async () => {
    const { insertedId } = await insertNumberedDraft({ prefix: "BC-202606" });

    await create(
      null,
      {
        input: buildPOInput({
          prefix: "BC-202607",
          number: "0001",
          status: "CONFIRMED",
        }),
      },
      ctx(),
    );

    const untouched = await PurchaseOrder.findById(insertedId);
    expect(untouched.number).toBe("0001");
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
// Tests — updatePurchaseOrder (numérotation)
// ---------------------------------------------------------------------------

describe("PurchaseOrder Resolver — updatePurchaseOrder (numérotation)", () => {
  const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
  const update = purchaseOrderResolvers.Mutation.updatePurchaseOrder;

  const insertConfirmedPO = (data = {}) =>
    PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: "BC-202607",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
      ...data,
    });

  it("conserve le numéro provisoire d'un brouillon (le numéro prévisualisé n'est pas persisté)", async () => {
    const po = await create(null, { input: buildPOInput() }, ctx());
    expect(po.number).toMatch(/^DRAFT-/);

    const updated = await update(
      null,
      {
        id: po._id.toString(),
        input: { number: "0002", status: "DRAFT" },
      },
      ctx(),
    );

    expect(updated.status).toBe("DRAFT");
    expect(updated.number).toBe(po.number);
  });

  it("verrouille le numéro d'un bon de commande finalisé", async () => {
    const { insertedId } = await insertConfirmedPO();

    await expect(
      update(
        null,
        { id: insertedId.toString(), input: { number: "0009" } },
        ctx(),
      ),
    ).rejects.toThrow(/verrouillé/i);
  });

  it("verrouille le préfixe d'un bon de commande finalisé", async () => {
    const { insertedId } = await insertConfirmedPO();

    await expect(
      update(
        null,
        { id: insertedId.toString(), input: { prefix: "BC-202608" } },
        ctx(),
      ),
    ).rejects.toThrow(/verrouillé/i);
  });

  it("rejette la finalisation DRAFT → CONFIRMED avec un numéro hors séquence", async () => {
    await insertConfirmedPO({ number: "0001", prefix: "BC-202607" });
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-202607" }) },
      ctx(),
    );

    await expect(
      update(
        null,
        {
          id: po._id.toString(),
          input: { status: "CONFIRMED", number: "0005", prefix: "BC-202607" },
        },
        ctx(),
      ),
    ).rejects.toThrow(/0002/);
  });

  it("accepte la finalisation DRAFT → CONFIRMED avec le numéro séquentiel suivant", async () => {
    await insertConfirmedPO({ number: "0001", prefix: "BC-202607" });
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-202607" }) },
      ctx(),
    );

    const updated = await update(
      null,
      {
        id: po._id.toString(),
        input: { status: "CONFIRMED", number: "0002", prefix: "BC-202607" },
      },
      ctx(),
    );

    expect(updated.status).toBe("CONFIRMED");
    expect(updated.number).toBe("0002");
    expect(updated.prefix).toBe("BC-202607");
  });

  it("génère le numéro séquentiel quand la finalisation ne fournit pas de numéro", async () => {
    await insertConfirmedPO({ number: "0003", prefix: "BC-202607" });
    const po = await create(
      null,
      { input: buildPOInput({ prefix: "BC-202607" }) },
      ctx(),
    );

    const updated = await update(
      null,
      { id: po._id.toString(), input: { status: "CONFIRMED" } },
      ctx(),
    );

    expect(updated.status).toBe("CONFIRMED");
    expect(updated.number).toBe("0004");
  });

  it("REJETTE une transition interdite via updatePurchaseOrder (DRAFT → CANCELED)", async () => {
    const po = await create(null, { input: buildPOInput() }, ctx());
    expect(po.number).toMatch(/^DRAFT-/);

    await expect(
      update(
        null,
        { id: po._id.toString(), input: { status: "CANCELED" } },
        ctx(),
      ),
    ).rejects.toThrow(/statut non autorisé/i);

    const untouched = await PurchaseOrder.findById(po._id);
    expect(untouched.status).toBe("DRAFT");
    expect(untouched.number).toMatch(/^DRAFT-/);
  });

  it("REJETTE la rétrogradation d'un BC finalisé en brouillon", async () => {
    const { insertedId } = await PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: "BC-202607",
      status: "CONFIRMED",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { name: "Test", email: "t@t.fr" },
      issueDate: new Date(),
      createdAt: new Date(),
    });

    await expect(
      update(
        null,
        { id: insertedId.toString(), input: { status: "DRAFT" } },
        ctx(),
      ),
    ).rejects.toThrow(/statut non autorisé/i);
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
  // La transition DRAFT → CONFIRMED s'exécute dans une transaction MongoDB,
  // impossible sur le mongod standalone de ce fichier. Elle est couverte par
  // purchaseOrder.simulation.test.js, qui tourne sur un replica set.
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
  // La conversion depuis un BC CONFIRMED est couverte plus bas par le bloc
  // « convertPurchaseOrderToInvoice & devis source », qui part d'un BC
  // finalisé inséré directement et n'a donc pas besoin de la transaction de
  // changePurchaseOrderStatus.
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
});

// ---------------------------------------------------------------------------
// Tests — anti-doublon devis→BC→facture vs devis→facture directe
// convertPurchaseOrderToInvoice n'utilise pas de transaction : on insère
// directement un BC CONFIRMED lié à un devis pour exercer la synchro/garde.
// ---------------------------------------------------------------------------

// Insère un BC CONFIRMED rattaché à un devis, prêt à être converti
async function seedConfirmedPO({ sourceQuoteId, prefix, number }) {
  const _id = new mongoose.Types.ObjectId();
  await PurchaseOrder.collection.insertOne({
    _id,
    workspaceId: organizationId,
    createdBy: userId,
    number,
    prefix,
    status: "CONFIRMED",
    sourceQuoteId,
    items: [
      { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
    ],
    client: {
      name: "Client Test",
      email: "c@test.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    issueDate: new Date(),
    createdAt: new Date(),
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalVAT: 200,
    finalTotalTTC: 1200,
  });
  return _id;
}

describe("PurchaseOrder Resolver — convertPurchaseOrderToInvoice & devis source", () => {
  const convert = purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice;

  it("synchronise le devis source : sourceQuote + linkedInvoices", async () => {
    const quoteId = new mongoose.Types.ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "200",
      prefix: "D-SYNC",
      status: "COMPLETED",
      items: [
        { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
      ],
      client: {
        name: "Client Test",
        email: "c@test.fr",
        address: {
          street: "1 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      linkedInvoices: [],
    });

    const poId = await seedConfirmedPO({
      sourceQuoteId: quoteId,
      prefix: "BC-SYNC",
      number: "201",
    });

    const invoice = await convert(null, { id: poId.toString() }, ctx());

    expect(invoice).toBeDefined();
    expect(String(invoice.sourceQuote)).toBe(String(quoteId));

    // Le devis n'est plus « vierge » : la facture y est rattachée
    const updatedQuote = await Quote.findById(quoteId);
    expect(updatedQuote.linkedInvoices.map(String)).toContain(
      String(invoice._id),
    );
    expect(String(updatedQuote.convertedToInvoice)).toBe(String(invoice._id));

    // Le BC référence aussi la facture
    const updatedPO = await PurchaseOrder.findById(poId);
    expect(updatedPO.linkedInvoices.map(String)).toContain(String(invoice._id));
  });

  it("bloque la conversion si le devis source est déjà entièrement facturé", async () => {
    const existingInvoiceId = new mongoose.Types.ObjectId();
    await Invoice.collection.insertOne({
      _id: existingInvoiceId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "1",
      prefix: "F-EXIST",
      status: "DRAFT",
      finalTotalTTC: 1200,
      createdAt: new Date(),
    });

    const quoteId = new mongoose.Types.ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "300",
      prefix: "D-FULL",
      status: "COMPLETED",
      items: [
        { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
      ],
      client: {
        name: "Client Test",
        email: "c@test.fr",
        address: {
          street: "1 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      issueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      linkedInvoices: [existingInvoiceId],
    });

    const poId = await seedConfirmedPO({
      sourceQuoteId: quoteId,
      prefix: "BC-FULL",
      number: "301",
    });

    await expect(
      convert(null, { id: poId.toString() }, ctx()),
    ).rejects.toThrow();

    // Aucune nouvelle facture ne doit avoir été créée
    const invoiceCount = await Invoice.countDocuments({
      workspaceId: organizationId,
    });
    expect(invoiceCount).toBe(1);
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
