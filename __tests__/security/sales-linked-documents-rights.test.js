/**
 * Documents liés entre devis, bons de commande, bons de livraison et
 * factures : chacun suit « Voir » de sa propre page, comme ses requêtes.
 *
 *   - un rôle limité aux bons de livraison ne lit ni le devis d'origine (ses
 *     prix), ni la facture d'origine, ni les factures du bon ;
 *   - un rôle limité aux devis ne lit ni leurs factures, ni leurs bons de
 *     commande et de livraison ; un rôle limité aux bons de commande, ni le
 *     devis d'origine ni les factures ;
 *   - un bon de livraison recopié d'une facture exige « Voir » sur les
 *     factures en plus de « Créer » sur les bons de livraison.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Quote from "../../src/models/Quote.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";
import deliveryNoteResolvers from "../../src/resolvers/deliveryNote.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const ROLE = "role_lecture_limitee";

const ctx = (userId = member) =>
  buildContext({ userId, organizationId: String(workspaceId) });

async function grantActions(actions) {
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne({ organizationId: workspaceId, role: ROLE }, { $set: { actions } });
  invalidateOrganizationRoles();
  invalidateOrgCache();
}

const client = {
  name: "Client Lié",
  email: "lie@test.fr",
  type: "COMPANY",
  address: { street: "1 rue du Lien", city: "Lyon", postalCode: "69001", country: "France" },
};
const ids = {
  quote: new mongoose.Types.ObjectId(),
  invoiceFromQuote: new mongoose.Types.ObjectId(),
  invoiceFromPo: new mongoose.Types.ObjectId(),
  invoiceFromDn: new mongoose.Types.ObjectId(),
  po: new mongoose.Types.ObjectId(),
  dn: new mongoose.Types.ObjectId(),
};

async function seedLinkedDocuments() {
  const base = { workspaceId, createdBy: owner, client, issueDate: new Date(), createdAt: new Date() };
  const invoice = (_id, number) => ({
    ...base,
    _id,
    prefix: "F-202610",
    number,
    status: "PENDING",
    items: [{ description: "Prestation", quantity: 1, unitPrice: 700, vatRate: 20 }],
    finalTotalTTC: 840,
  });
  await Invoice.collection.insertMany([
    invoice(ids.invoiceFromQuote, "0001"),
    invoice(ids.invoiceFromPo, "0002"),
    invoice(ids.invoiceFromDn, "0003"),
  ]);
  await Quote.collection.insertOne({
    ...base,
    _id: ids.quote,
    prefix: "D-202610",
    number: "0001",
    status: "COMPLETED",
    items: [{ description: "Prestation", quantity: 1, unitPrice: 700, vatRate: 20 }],
    finalTotalTTC: 840,
    linkedInvoices: [ids.invoiceFromQuote],
    convertedToInvoice: ids.invoiceFromQuote,
  });
  await PurchaseOrder.collection.insertOne({
    ...base,
    _id: ids.po,
    prefix: "BC-202610",
    number: "0001",
    status: "DELIVERED",
    items: [{ description: "Prestation", quantity: 1, unitPrice: 700, vatRate: 20 }],
    sourceQuoteId: ids.quote,
    linkedInvoices: [ids.invoiceFromPo],
  });
  await DeliveryNote.collection.insertOne({
    ...base,
    _id: ids.dn,
    prefix: "BL-202610",
    number: "0001",
    status: "DELIVERED",
    items: [{ description: "Prestation", quantity: 1, unitPrice: 700, vatRate: 20 }],
    sourceQuote: ids.quote,
    sourceInvoice: ids.invoiceFromQuote,
    linkedInvoices: [ids.invoiceFromDn],
  });
}

const doc = async (Model, _id) => Model.findById(_id);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({ userId: member, organizationId: workspaceId, role: ROLE });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Lecture limitée",
    permission: "{}",
    actions: {},
    createdAt: new Date(),
  });
  invalidateOrganizationRoles();
  invalidateOrgCache();
  await seedLinkedDocuments();
});

describe("bon de livraison : documents liés", () => {
  const { DeliveryNote: fields } = deliveryNoteResolvers;

  it("rôle limité aux bons de livraison : ni devis d'origine, ni factures", async () => {
    await grantActions({ deliveryNotes: ["view"] });
    const dn = await doc(DeliveryNote, ids.dn);
    const context = ctx();
    expect(await fields.sourceQuote(dn, {}, context)).toBeNull();
    expect(await fields.sourceInvoice(dn, {}, context)).toBeNull();
    expect(await fields.linkedInvoices(dn, {}, context)).toEqual([]);
  });

  it("avec « Voir » sur les devis et les factures : documents liés renvoyés", async () => {
    await grantActions({ deliveryNotes: ["view"], quotes: ["view"], invoices: ["view"] });
    const dn = await doc(DeliveryNote, ids.dn);
    const context = ctx();
    expect(String((await fields.sourceQuote(dn, {}, context))._id)).toBe(String(ids.quote));
    expect(String((await fields.sourceInvoice(dn, {}, context))._id)).toBe(String(ids.invoiceFromQuote));
    expect((await fields.linkedInvoices(dn, {}, context)).map((i) => String(i._id))).toEqual([String(ids.invoiceFromDn)]);
  });

  it("propriétaire : tout est renvoyé", async () => {
    const dn = await doc(DeliveryNote, ids.dn);
    expect(await fields.sourceQuote(dn, {}, ctx(owner))).not.toBeNull();
    expect(await fields.linkedInvoices(dn, {}, ctx(owner))).toHaveLength(1);
  });

  it("sans utilisateur dans le contexte : rien", async () => {
    const dn = await doc(DeliveryNote, ids.dn);
    expect(await fields.sourceQuote(dn, {}, {})).toBeNull();
    expect(await fields.linkedInvoices(dn, {}, {})).toEqual([]);
  });
});

describe("devis : documents liés", () => {
  const { Quote: fields } = quoteResolvers;

  it("rôle limité aux devis : ni factures, ni bons de commande, ni bons de livraison", async () => {
    await grantActions({ quotes: ["view"] });
    const quote = await doc(Quote, ids.quote);
    const context = ctx();
    expect(await fields.convertedToInvoice(quote, {}, context)).toBeNull();
    expect(await fields.linkedInvoices(quote, {}, context)).toEqual([]);
    expect(await fields.linkedPurchaseOrders(quote, {}, context)).toEqual([]);
    expect(await fields.linkedDeliveryNotes(quote, {}, context)).toEqual([]);
  });

  it("chaque document lié suit sa propre page", async () => {
    await grantActions({ quotes: ["view"], deliveryNotes: ["view"] });
    const quote = await doc(Quote, ids.quote);
    const context = ctx();
    expect(await fields.linkedInvoices(quote, {}, context)).toEqual([]);
    expect(await fields.linkedPurchaseOrders(quote, {}, context)).toEqual([]);
    expect(await fields.linkedDeliveryNotes(quote, {}, context)).toHaveLength(1);
  });
});

describe("bon de commande : documents liés", () => {
  const { PurchaseOrder: fields } = purchaseOrderResolvers;

  it("rôle limité aux bons de commande : ni devis d'origine, ni factures", async () => {
    await grantActions({ purchaseOrders: ["view"] });
    const po = await doc(PurchaseOrder, ids.po);
    const context = ctx();
    expect(await fields.sourceQuote(po, {}, context)).toBeNull();
    expect(await fields.linkedInvoices(po, {}, context)).toEqual([]);
  });

  it("avec « Voir » sur les devis et les factures : renvoyés", async () => {
    await grantActions({ purchaseOrders: ["view"], quotes: ["view"], invoices: ["view"] });
    const po = await doc(PurchaseOrder, ids.po);
    const context = ctx();
    expect(await fields.sourceQuote(po, {}, context)).not.toBeNull();
    expect(await fields.linkedInvoices(po, {}, context)).toHaveLength(1);
  });
});

describe("bon de livraison recopié d'une facture", () => {
  const create = deliveryNoteResolvers.Mutation.createDeliveryNoteFromInvoice;

  it("refusé sans « Voir » sur les factures, aucun bon créé", async () => {
    await grantActions({ deliveryNotes: ["view", "create", "edit"] });
    await expect(
      create(null, { invoiceId: String(ids.invoiceFromQuote), workspaceId: String(workspaceId) }, ctx()),
    ).rejects.toThrow(/permission/i);
    expect(await DeliveryNote.countDocuments({ sourceInvoice: ids.invoiceFromQuote, createdBy: member })).toBe(0);
  });

  it("permis avec « Voir » sur les factures", async () => {
    await grantActions({ deliveryNotes: ["view", "create", "edit"], invoices: ["view"] });
    const dn = await create(
      null,
      { invoiceId: String(ids.invoiceFromQuote), workspaceId: String(workspaceId) },
      ctx(),
    );
    expect(String(dn.sourceInvoice)).toBe(String(ids.invoiceFromQuote));
  });
});
