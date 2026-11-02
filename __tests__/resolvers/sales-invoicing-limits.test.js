/**
 * Facturation d'un devis par tous les chemins : jamais au-delà de son
 * montant, conditions du devis reprises, une seule facture pour deux
 * demandes simultanées.
 *
 *   - facture d'un bon de livraison : reste à facturer du devis, TVA
 *     (autoliquidation), remise globale et port du devis ; devis en attente
 *     toujours acceptable ou refusable ensuite ;
 *   - facture d'un bon de commande : reste à facturer (après un acompte),
 *     statuts facturables comme à l'écran (validé, en cours, livré) ;
 *   - conversion par répartition : pourcentages bornés, aucune facture
 *     orpheline en cas de refus ;
 *   - demandes simultanées (bon de livraison, conversion, facture liée) ;
 *   - facturation de situation : une situation annulée ne compte pas.
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
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Quote from "../../src/models/Quote.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";
import deliveryNoteResolvers from "../../src/resolvers/deliveryNote.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);
const ctx = () => buildContext({ userId, organizationId: ws });

const client = {
  name: "Client Facturation",
  email: "facturation@test.fr",
  type: "COMPANY",
  siret: "12345678901234",
  address: { street: "1 rue du Devis", city: "Paris", postalCode: "75001", country: "France" },
};

let numero = 0;
const prochain = () => String(++numero).padStart(4, "0");

/** Devis accepté de 1 000 € HT (1 200 € TTC) sauf indication contraire. */
async function insertQuote(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Quote.collection.insertOne({
    _id,
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "D-202610",
    number: prochain(),
    status: "COMPLETED",
    client,
    issueDate: new Date(),
    validUntil: new Date(Date.now() + 30 * 86_400_000),
    items: [{ description: "Prestation", quantity: 1, unitPrice: 1000, vatRate: 20, unit: "" }],
    discount: 0,
    discountType: "PERCENTAGE",
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalVAT: 200,
    finalTotalTTC: 1200,
    discountAmount: 0,
    linkedInvoices: [],
    convertedToInvoice: null,
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

/** Bon de livraison émis, lignes (prix cachés) reprises du devis. */
async function insertDeliveryNote(quoteId, overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await DeliveryNote.collection.insertOne({
    _id,
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "BL-202610",
    number: prochain(),
    status: "PENDING",
    client,
    issueDate: new Date(),
    items: [{ description: "Prestation", quantity: 1, unitPrice: 1000, vatRate: 20, unit: "" }],
    sourceQuote: quoteId,
    linkedInvoices: [],
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

async function insertInvoice(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-202610",
    number: prochain(),
    status: "PENDING",
    client,
    issueDate: new Date(),
    dueDate: new Date(),
    items: [{ description: "Prestation", quantity: 1, unitPrice: 1000, vatRate: 20 }],
    finalTotalTTC: 1200,
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

const invoicesOf = (quoteId) => Invoice.find({ sourceQuote: quoteId });
const total = (invoices) => Math.round(invoices.reduce((t, i) => t + (i.finalTotalTTC || 0), 0) * 100) / 100;

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
  await mongoose.connection.db.collection("organization").updateOne(
    { _id: organizationId },
    { $set: { capitalSocial: "10000", rcs: "Paris B 123 456 789", vatNumber: "FR12345678901" } },
  );
});

describe("facture d'un bon de livraison", () => {
  const invoiceDn = (id) =>
    deliveryNoteResolvers.Mutation.createInvoiceFromDeliveryNote(null, { deliveryNoteId: String(id), workspaceId: ws }, ctx());

  it("refuse un bon d'un devis déjà entièrement facturé", async () => {
    const existing = await insertInvoice();
    const quoteId = await insertQuote({ linkedInvoices: [existing], convertedToInvoice: existing });
    await Invoice.updateOne({ _id: existing }, { $set: { sourceQuote: quoteId } });
    const dnId = await insertDeliveryNote(quoteId);

    await expect(invoiceDn(dnId)).rejects.toThrow(/déjà entièrement facturé/);
    expect(await invoicesOf(quoteId)).toHaveLength(1);
    expect((await DeliveryNote.findById(dnId)).linkedInvoices).toHaveLength(0);
  });

  it("deux bons d'un même devis : le second, au-delà du devis, est refusé", async () => {
    const quoteId = await insertQuote();
    const first = await insertDeliveryNote(quoteId);
    const second = await insertDeliveryNote(quoteId);

    const invoice = await invoiceDn(first);
    expect(invoice.finalTotalTTC).toBe(1200);
    await expect(invoiceDn(second)).rejects.toThrow(/déjà entièrement facturé/);
    expect(total(await invoicesOf(quoteId))).toBe(1200);
  });

  it("refuse un bon qui dépasse le reste à facturer (livraison partielle déjà facturée)", async () => {
    const quoteId = await insertQuote();
    const half = await insertDeliveryNote(quoteId, {
      items: [{ description: "Prestation", quantity: 0.5, unitPrice: 1000, vatRate: 20 }],
    });
    const full = await insertDeliveryNote(quoteId);
    await invoiceDn(half);
    await expect(invoiceDn(full)).rejects.toThrow(/reste à facturer/);
    expect(total(await invoicesOf(quoteId))).toBe(600);
  });

  it("reprend l'autoliquidation, la remise globale et le port du devis", async () => {
    const quoteId = await insertQuote({
      isReverseCharge: true,
      discount: 10,
      discountType: "PERCENTAGE",
      shipping: { billShipping: true, shippingAmountHT: 50, shippingVatRate: 20 },
      totalHT: 1050,
      totalVAT: 0,
      totalTTC: 1050,
      finalTotalHT: 950,
      finalTotalVAT: 0,
      finalTotalTTC: 950,
      discountAmount: 100,
    });
    const dnId = await insertDeliveryNote(quoteId);

    const invoice = await invoiceDn(dnId);
    expect(invoice.isReverseCharge).toBe(true);
    expect(invoice.discount).toBe(10);
    expect(invoice.discountType).toBe("PERCENTAGE");
    expect(invoice.shipping.billShipping).toBe(true);
    expect(invoice.shipping.shippingAmountHT).toBe(50);
    expect(invoice.finalTotalVAT).toBe(0);
    expect(invoice.finalTotalHT).toBe(950);
    expect(invoice.finalTotalTTC).toBe(950);
  });

  it("devis en attente facturé par son bon : il reste acceptable, puis refusable", async () => {
    const accepted = await insertQuote({ status: "PENDING" });
    const refused = await insertQuote({ status: "PENDING" });
    await invoiceDn(await insertDeliveryNote(accepted));
    await invoiceDn(await insertDeliveryNote(refused));

    const quote = await Quote.findById(accepted);
    expect(quote.linkedInvoices).toHaveLength(1);
    expect(quote.convertedToInvoice).toBeFalsy();

    const changeStatus = quoteResolvers.Mutation.changeQuoteStatus;
    expect((await changeStatus(null, { id: String(accepted), status: "COMPLETED" }, ctx())).status).toBe("COMPLETED");
    expect((await changeStatus(null, { id: String(refused), status: "CANCELED" }, ctx())).status).toBe("CANCELED");
  });

  it("deux « Facturer » simultanés sur le même bon : une seule facture", async () => {
    const dnId = await insertDeliveryNote(null, { sourceQuote: null });
    const results = await Promise.allSettled([invoiceDn(dnId), invoiceDn(dnId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await Invoice.countDocuments({ workspaceId: organizationId })).toBe(1);
    expect((await DeliveryNote.findById(dnId)).linkedInvoices).toHaveLength(1);
  });

  it("deux bons d'un même devis facturés en même temps : jamais au-delà du devis", async () => {
    const quoteId = await insertQuote();
    const [a, b] = [await insertDeliveryNote(quoteId), await insertDeliveryNote(quoteId)];
    const results = await Promise.allSettled([invoiceDn(a), invoiceDn(b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(total(await invoicesOf(quoteId))).toBe(1200);
    expect((await Quote.findById(quoteId)).linkedInvoices).toHaveLength(1);
  });
});

describe("facture d'un bon de commande", () => {
  const convert = (id) => purchaseOrderResolvers.Mutation.convertPurchaseOrderToInvoice(null, { id: String(id), workspaceId: ws }, ctx());

  async function insertPurchaseOrder(quoteId, status = "VALIDATED") {
    const _id = new mongoose.Types.ObjectId();
    await PurchaseOrder.collection.insertOne({
      _id,
      workspaceId: organizationId,
      createdBy: userId,
      prefix: "BC-202610",
      number: prochain(),
      status,
      client,
      issueDate: new Date(),
      items: [{ description: "Prestation", quantity: 1, unitPrice: 1000, vatRate: 20 }],
      sourceQuoteId: quoteId,
      totalHT: 1000,
      totalVAT: 200,
      totalTTC: 1200,
      finalTotalHT: 1000,
      finalTotalVAT: 200,
      finalTotalTTC: 1200,
      linkedInvoices: [],
      createdAt: new Date(),
    });
    return _id;
  }

  it("après un acompte de 30 %, la facture du bon (100 %) dépasse le reste à facturer : refusée", async () => {
    const quoteId = await insertQuote();
    await invoiceResolvers.Mutation.createLinkedInvoice(
      null,
      { quoteId: String(quoteId), amount: 360, isDeposit: true, workspaceId: ws },
      ctx(),
    );
    const poId = await insertPurchaseOrder(quoteId);
    await expect(convert(poId)).rejects.toThrow(/reste à facturer/);
    expect(total(await invoicesOf(quoteId))).toBe(360);
  });

  it("mêmes statuts qu'à l'écran : validé facturé, seulement confirmé refusé", async () => {
    const validated = await insertPurchaseOrder(null, "VALIDATED");
    const confirmed = await insertPurchaseOrder(null, "CONFIRMED");
    await expect(convert(validated)).resolves.toBeTruthy();
    await expect(convert(confirmed)).rejects.toThrow(/validés, en cours ou livrés/);
  });
});

describe("conversion d'un devis par répartition", () => {
  const convert = (id, distribution, skipValidation = false) =>
    quoteResolvers.Mutation.convertQuoteToInvoice(null, { id: String(id), distribution, skipValidation }, ctx());

  for (const [label, distribution, skip] of [
    ["150 % et -50 %", [150, -50], false],
    ["0 %", [0], false],
    ["200 % sans contrôle", [200], true],
    ["NaN", [Number.NaN], false],
  ]) {
    it(`refuse la répartition ${label}, sans facture créée ni liée`, async () => {
      const quoteId = await insertQuote();
      await expect(convert(quoteId, distribution, skip)).rejects.toThrow();
      expect(await invoicesOf(quoteId)).toHaveLength(0);
      const quote = await Quote.findById(quoteId);
      expect(quote.linkedInvoices).toHaveLength(0);
      expect(quote.convertedToInvoice).toBeFalsy();
    });
  }

  it("une conversion complète crée une facture liée au devis", async () => {
    const quoteId = await insertQuote();
    const invoice = await convert(quoteId, null);
    const quote = await Quote.findById(quoteId);
    expect(quote.linkedInvoices.map(String)).toEqual([String(invoice._id)]);
    expect(String(quote.convertedToInvoice)).toBe(String(invoice._id));
  });

  it("deux conversions simultanées : une seule facture", async () => {
    const quoteId = await insertQuote();
    const results = await Promise.allSettled([convert(quoteId, null), convert(quoteId, null)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await invoicesOf(quoteId)).toHaveLength(1);
    expect((await Quote.findById(quoteId)).linkedInvoices).toHaveLength(1);
  });
});

describe("facture liée à un devis", () => {
  it("deux demandes simultanées pour tout le reste : une seule facture", async () => {
    const quoteId = await insertQuote();
    const create = () =>
      invoiceResolvers.Mutation.createLinkedInvoice(
        null,
        { quoteId: String(quoteId), amount: 1200, isDeposit: false, workspaceId: ws },
        ctx(),
      );
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(total(await invoicesOf(quoteId))).toBe(1200);
    expect((await Quote.findById(quoteId)).linkedInvoices).toHaveLength(1);
  });
});

describe("facturation de situation", () => {
  it("une situation annulée ne compte pas dans le déjà facturé du devis", async () => {
    const quoteId = await insertQuote({ finalTotalTTC: 10000 });
    const quote = await Quote.findById(quoteId);
    const reference = `${quote.prefix}-${quote.number}`;
    await insertInvoice({ invoiceType: "situation", purchaseOrderNumber: reference, status: "CANCELED", finalTotalTTC: 10000 });
    await insertInvoice({ invoiceType: "situation", purchaseOrderNumber: reference, status: "PENDING", finalTotalTTC: 3000 });
    // Même référence dans une autre organisation : ignorée
    await Invoice.collection.insertOne({
      workspaceId: buildOrganizationId(),
      invoiceType: "situation",
      purchaseOrderNumber: reference,
      status: "PENDING",
      finalTotalTTC: 5000,
    });

    expect(await quoteResolvers.Quote.situationInvoicedTotal(quote)).toBe(3000);
  });
});
