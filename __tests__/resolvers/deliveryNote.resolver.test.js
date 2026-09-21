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

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

import DeliveryNote from "../../src/models/DeliveryNote.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import Product from "../../src/models/Product.js";
import deliveryNoteResolvers from "../../src/resolvers/deliveryNote.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherUserId = buildUserId();
const otherOrganizationId = buildOrganizationId();

const buildClient = () => ({
  name: "Client Livraison",
  email: "client@test.fr",
  type: "COMPANY",
  siret: "12345678901234",
  address: {
    street: "10 avenue Client",
    city: "Lyon",
    postalCode: "69001",
    country: "France",
  },
});

function buildDNInput(overrides = {}) {
  return {
    items: [
      { description: "Palette de carrelage", quantity: 3, unit: "palette" },
      { description: "Sac de colle", quantity: 12, unit: "sac" },
    ],
    client: buildClient(),
    issueDate: new Date().toISOString(),
    carrier: "Geodis",
    trackingNumber: "GEO-123456",
    ...overrides,
  };
}

const currentPrefix = () => {
  const now = new Date();
  return `BL-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
};

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
  await seedOrgMembership({
    userId: otherUserId,
    organizationId: otherOrganizationId,
    role: "owner",
    organizationName: "Other Org",
  });
  const db = mongoose.connection.db;
  for (const orgId of [organizationId, otherOrganizationId]) {
    await db.collection("organization").updateOne(
      { _id: orgId },
      {
        $set: {
          capitalSocial: "10000",
          rcs: "Paris B 123 456 789",
          vatNumber: "FR12345678901",
        },
      },
    );
  }
});

const ctx = () => buildContext({ userId, organizationId });
const otherCtx = () =>
  buildContext({ userId: otherUserId, organizationId: otherOrganizationId });

const { Mutation, Query, DeliveryNote: fieldResolvers } = deliveryNoteResolvers;

// ---------------------------------------------------------------------------
// Tests — création / numérotation
// ---------------------------------------------------------------------------

describe("DeliveryNote Resolver — createDeliveryNote", () => {
  it("crée un brouillon avec un numéro provisoire et sans montant", async () => {
    const dn = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput() },
      ctx(),
    );

    expect(dn.status).toBe("DRAFT");
    expect(dn.number).toMatch(/^DRAFT-/);
    expect(dn.prefix).toBe(currentPrefix());
    expect(dn.totalHT).toBeUndefined();
    expect(dn.finalTotalTTC).toBeUndefined();
    // MVP : quantité livrée = quantité
    expect(dn.items[0].deliveredQuantity).toBe(3);
    expect(dn.items[0].orderedQuantity).toBe(3);
    // Adresse de livraison par défaut : adresse du client
    expect(dn.deliveryAddress.street).toBe("10 avenue Client");
  });

  it("crée un BL « À expédier » avec un numéro séquentiel BL-YYYYMM-0001", async () => {
    const first = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput({ status: "PENDING" }) },
      ctx(),
    );
    const second = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput({ status: "PENDING" }) },
      ctx(),
    );

    expect(first.number).toBe("0001");
    expect(second.number).toBe("0002");
    expect(first.companyInfo?.name).toBeTruthy();
  });

  it("refuse un statut de création autre que DRAFT / PENDING", async () => {
    await expect(
      Mutation.createDeliveryNote(
        null,
        { input: buildDNInput({ status: "DELIVERED" }) },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it("finalise un brouillon via updateDeliveryNote (DRAFT → PENDING)", async () => {
    const draft = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput() },
      ctx(),
    );

    const finalized = await Mutation.updateDeliveryNote(
      null,
      { id: draft._id.toString(), input: { status: "PENDING" } },
      ctx(),
    );

    expect(finalized.status).toBe("PENDING");
    expect(finalized.number).toBe("0001");
    expect(finalized.companyInfo?.name).toBeTruthy();
  });

  it("verrouille le numéro d'un BL finalisé", async () => {
    const dn = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput({ status: "PENDING" }) },
      ctx(),
    );

    await expect(
      Mutation.updateDeliveryNote(
        null,
        { id: dn._id.toString(), input: { number: "0042" } },
        ctx(),
      ),
    ).rejects.toThrow(/verrouillé/);
  });
});

// ---------------------------------------------------------------------------
// Tests — statuts
// ---------------------------------------------------------------------------

describe("DeliveryNote Resolver — changeDeliveryNoteStatus", () => {
  // La transition DRAFT → PENDING de changeDeliveryNoteStatus s'exécute dans
  // une transaction MongoDB, impossible sur le mongod standalone de ce
  // fichier (même limite que purchaseOrder.resolver.test.js). On finalise
  // ici via updateDeliveryNote, puis on déroule le reste du cycle.
  it("suit le cycle PENDING → SHIPPED → DELIVERED", async () => {
    const draft = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput() },
      ctx(),
    );
    const id = draft._id.toString();

    const pending = await Mutation.updateDeliveryNote(
      null,
      { id, input: { status: "PENDING" } },
      ctx(),
    );
    expect(pending.status).toBe("PENDING");
    expect(pending.number).toBe("0001");

    const shipped = await Mutation.changeDeliveryNoteStatus(
      null,
      { id, status: "SHIPPED" },
      ctx(),
    );
    expect(shipped.status).toBe("SHIPPED");

    const delivered = await Mutation.changeDeliveryNoteStatus(
      null,
      { id, status: "DELIVERED" },
      ctx(),
    );
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.receivedAt).toBeInstanceOf(Date);
  });

  it("refuse une transition interdite (DRAFT → SHIPPED)", async () => {
    const draft = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput() },
      ctx(),
    );
    await expect(
      Mutation.changeDeliveryNoteStatus(
        null,
        { id: draft._id.toString(), status: "SHIPPED" },
        ctx(),
      ),
    ).rejects.toThrow();
  });

  it("enregistre la réception (réceptionnaire + signature) et passe en DELIVERED", async () => {
    const dn = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput({ status: "PENDING" }) },
      ctx(),
    );

    const received = await Mutation.recordDeliveryNoteReception(
      null,
      {
        id: dn._id.toString(),
        input: {
          receivedBy: "Jean Dupont",
          signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        },
      },
      ctx(),
    );

    expect(received.status).toBe("DELIVERED");
    expect(received.receivedBy).toBe("Jean Dupont");
    expect(received.receivedAt).toBeInstanceOf(Date);
    expect(received.signatureDataUrl).toMatch(/^data:image\/png/);

    // Livré : plus modifiable, plus supprimable
    await expect(
      Mutation.updateDeliveryNote(
        null,
        { id: dn._id.toString(), input: { carrier: "DHL" } },
        ctx(),
      ),
    ).rejects.toThrow();
    await expect(
      Mutation.deleteDeliveryNote(null, { id: dn._id.toString() }, ctx()),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — génération croisée
// ---------------------------------------------------------------------------

describe("DeliveryNote Resolver — génération croisée", () => {
  const insertQuote = async (overrides = {}) => {
    const quoteId = new mongoose.Types.ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0100",
      prefix: "D-202609",
      status: "COMPLETED",
      items: [
        {
          description: "Widget",
          quantity: 2,
          unitPrice: 500,
          vatRate: 20,
          unit: "pièce",
        },
      ],
      client: buildClient(),
      issueDate: new Date(),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      finalTotalTTC: 1200,
      linkedInvoices: [],
      ...overrides,
    });
    return quoteId;
  };

  it("crée un BL brouillon depuis un devis (lignes + client, prix cachés)", async () => {
    const quoteId = await insertQuote();

    const dn = await Mutation.createDeliveryNoteFromQuote(
      null,
      { quoteId: quoteId.toString() },
      ctx(),
    );

    expect(dn.status).toBe("DRAFT");
    expect(dn.sourceQuote.toString()).toBe(quoteId.toString());
    expect(dn.client.name).toBe("Client Livraison");
    expect(dn.items).toHaveLength(1);
    expect(dn.items[0].description).toBe("Widget");
    expect(dn.items[0].quantity).toBe(2);
    // Prix conservé en base pour la facturation, jamais exposé par le schéma
    expect(dn.items[0].unitPrice).toBe(500);

    const linked = await deliveryNoteResolvers.DeliveryNote.sourceQuote(dn);
    expect(linked._id.toString()).toBe(quoteId.toString());
  });

  it("génère une facture pré-remplie (prix réinjectés) depuis un BL livré", async () => {
    const quoteId = await insertQuote();
    const draft = await Mutation.createDeliveryNoteFromQuote(
      null,
      { quoteId: quoteId.toString() },
      ctx(),
    );
    const id = draft._id.toString();
    await Mutation.updateDeliveryNote(null, { id, input: { status: "PENDING" } }, ctx());
    await Mutation.changeDeliveryNoteStatus(null, { id, status: "DELIVERED" }, ctx());

    const invoice = await Mutation.createInvoiceFromDeliveryNote(
      null,
      { deliveryNoteId: id },
      ctx(),
    );

    expect(invoice.status).toBe("DRAFT");
    expect(invoice.items[0].unitPrice).toBe(500);
    expect(invoice.items[0].vatRate).toBe(20);
    expect(invoice.finalTotalTTC).toBeCloseTo(1200, 0);
    expect(invoice.purchaseOrderNumber).toMatch(/^BL-\d{6}-0001$/);

    const dn = await DeliveryNote.findById(id);
    expect(dn.linkedInvoices.map(String)).toContain(invoice._id.toString());

    // Le devis source connaît la facture (anti-doublon de facturation)
    const quote = await Quote.findById(quoteId);
    expect(quote.linkedInvoices.map(String)).toContain(invoice._id.toString());

    // Une seule facture par BL
    await expect(
      Mutation.createInvoiceFromDeliveryNote(null, { deliveryNoteId: id }, ctx()),
    ).rejects.toThrow();
  });

  it("récupère le tarif catalogue pour un BL saisi à la main avec productId", async () => {
    const product = await Product.create({
      name: "Vis 4x40",
      unitPrice: 0.25,
      vatRate: 20,
      unit: "boîte",
      workspaceId: organizationId,
      createdBy: userId,
    });

    const dn = await Mutation.createDeliveryNote(
      null,
      {
        input: buildDNInput({
          status: "PENDING",
          items: [
            {
              description: "Vis 4x40",
              quantity: 10,
              unit: "boîte",
              productId: product._id.toString(),
            },
          ],
        }),
      },
      ctx(),
    );

    const invoice = await Mutation.createInvoiceFromDeliveryNote(
      null,
      { deliveryNoteId: dn._id.toString() },
      ctx(),
    );
    expect(invoice.items[0].unitPrice).toBe(0.25);
    expect(invoice.finalTotalHT).toBeCloseTo(2.5, 2);
  });

  it("crée un BL depuis une facture et l'expose via Invoice.linkedDeliveryNotes", async () => {
    const invoiceId = new mongoose.Types.ObjectId();
    await Invoice.collection.insertOne({
      _id: invoiceId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0007",
      prefix: "F-202609",
      status: "PENDING",
      items: [
        { description: "Table", quantity: 1, unitPrice: 300, vatRate: 20 },
      ],
      client: buildClient(),
      issueDate: new Date(),
      dueDate: new Date(),
      createdAt: new Date(),
      finalTotalTTC: 360,
    });

    const dn = await Mutation.createDeliveryNoteFromInvoice(
      null,
      { invoiceId: invoiceId.toString() },
      ctx(),
    );
    expect(dn.status).toBe("DRAFT");
    expect(dn.sourceInvoice.toString()).toBe(invoiceId.toString());

    // Un BL issu d'une facture ne peut pas re-générer une facture
    await Mutation.updateDeliveryNote(
      null,
      { id: dn._id.toString(), input: { status: "PENDING" } },
      ctx(),
    );
    await expect(
      Mutation.createInvoiceFromDeliveryNote(
        null,
        { deliveryNoteId: dn._id.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/existe déjà/);
  });
});

// ---------------------------------------------------------------------------
// Tests — lecture, stats, isolation workspace
// ---------------------------------------------------------------------------

describe("DeliveryNote Resolver — lecture et isolation", () => {
  it("liste, filtre par statut et calcule les stats", async () => {
    await Mutation.createDeliveryNote(null, { input: buildDNInput() }, ctx());
    await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput({ status: "PENDING" }) },
      ctx(),
    );

    const all = await Query.deliveryNotes(null, {}, ctx());
    expect(all.totalCount).toBe(2);

    const pending = await Query.deliveryNotes(null, { status: "PENDING" }, ctx());
    expect(pending.totalCount).toBe(1);

    const search = await Query.deliveryNotes(null, { search: "GEO-123" }, ctx());
    expect(search.totalCount).toBe(2);

    const stats = await Query.deliveryNoteStats(null, {}, ctx());
    expect(stats.totalCount).toBe(2);
    expect(stats.draftCount).toBe(1);
    expect(stats.pendingCount).toBe(1);

    const next = await Query.nextDeliveryNumber(
      null,
      { prefix: currentPrefix() },
      ctx(),
    );
    expect(next).toBe("0002");
  });

  it("ne laisse jamais un autre workspace lire ou modifier un BL", async () => {
    const dn = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput() },
      ctx(),
    );
    const id = dn._id.toString();

    await expect(Query.deliveryNote(null, { id }, otherCtx())).rejects.toThrow();
    await expect(
      Mutation.updateDeliveryNote(null, { id, input: { carrier: "X" } }, otherCtx()),
    ).rejects.toThrow();
    await expect(
      Mutation.deleteDeliveryNote(null, { id }, otherCtx()),
    ).rejects.toThrow();

    const otherList = await Query.deliveryNotes(null, {}, otherCtx());
    expect(otherList.totalCount).toBe(0);
  });

  it("résout companyInfo dynamiquement pour un brouillon", async () => {
    const dn = await Mutation.createDeliveryNote(
      null,
      { input: buildDNInput() },
      ctx(),
    );
    const info = await fieldResolvers.companyInfo(dn);
    expect(info.name).toBe("Test Org");
  });
});
