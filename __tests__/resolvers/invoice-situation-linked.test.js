/**
 * Factures de situation et factures liées à un devis : une facture annulée
 * n'est plus facturée. Elle ne compte ni dans le cumul des situations
 * (plafond du contrat), ni dans le reste à facturer du devis, ni comme
 * acompte existant.
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
import mongoose from "mongoose";

vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/utils/eInvoiceRoutingHelper.js", () => ({
  evaluateAndRouteInvoice: vi.fn().mockResolvedValue(undefined),
  reportPaymentIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/invoiceFacturXArchiveService.js", () => ({
  triggerInvoiceFacturXArchive: vi.fn(),
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  autoPushEventToConnections: vi.fn().mockResolvedValue(undefined),
  updateEventInExternalCalendars: vi.fn().mockResolvedValue(undefined),
  deleteEventFromExternalCalendars: vi.fn().mockResolvedValue(undefined),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
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
  await mongoose.connection.db.collection("clients").insertOne({
    _id: clientId,
    workspaceId: organizationId,
    createdBy: userId,
    ...client,
  });
  await mongoose.connection.db.collection("organization").updateOne(
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

const ctx = () =>
  buildContext({ userId, organizationId, extra: { userRole: "owner" } });

const clientId = new mongoose.Types.ObjectId();
const client = {
  name: "Maître d'ouvrage",
  email: "mo@test.fr",
  type: "COMPANY",
  address: {
    street: "1 rue du Chantier",
    city: "Lyon",
    postalCode: "69001",
    country: "France",
  },
};

/** Devis accepté de 10 000 € TTC (8 333,33 € HT à 20 %), référence D-2026-0001. */
const seedQuote = async () => {
  const { insertedId } = await Quote.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "D-2026",
    number: "0001",
    status: "COMPLETED",
    client,
    items: [
      {
        description: "Chantier",
        quantity: 1,
        unitPrice: 8333.33,
        vatRate: 20,
      },
    ],
    finalTotalHT: 8333.33,
    finalTotalVAT: 1666.67,
    finalTotalTTC: 10000,
    linkedInvoices: [],
    issueDate: new Date(),
  });
  return Quote.findById(insertedId);
};

const situation = (montantHT, status = "PENDING", numero = "0001") =>
  Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-2026",
    number: numero,
    status,
    invoiceType: "situation",
    purchaseOrderNumber: "D-2026-0001",
    client,
    items: [
      {
        description: "Situation",
        quantity: 1,
        unitPrice: montantHT,
        vatRate: 20,
      },
    ],
    finalTotalHT: montantHT,
    finalTotalVAT: montantHT * 0.2,
    finalTotalTTC: montantHT * 1.2,
    issueDate: new Date(),
  });

const createSituation = (montantHT) =>
  invoiceResolvers.Mutation.createInvoice(
    null,
    {
      workspaceId: organizationId.toString(),
      input: {
        status: "DRAFT",
        invoiceType: "situation",
        purchaseOrderNumber: "D-2026-0001",
        issueDate: new Date().toISOString().slice(0, 10),
        dueDate: new Date(Date.now() + 30 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        client: { ...client, id: clientId.toString() },
        items: [
          {
            description: "Situation",
            quantity: 1,
            unitPrice: montantHT,
            vatRate: 20,
          },
        ],
      },
    },
    ctx(),
  );

describe("Factures de situation : une situation annulée ne compte plus", () => {
  it("contrat de 10 000 € : 8 000 € déjà facturés, une nouvelle situation de 3 000 € est refusée", async () => {
    await seedQuote();
    await situation(8000 / 1.2);

    await expect(createSituation(3000 / 1.2)).rejects.toThrow(
      /dépasserait le montant du contrat/,
    );
  });

  it("la situation de 8 000 € annulée, une situation de 8 000 € passe", async () => {
    await seedQuote();
    await situation(8000 / 1.2, "CANCELED");

    const created = await createSituation(8000 / 1.2);

    expect(created.finalTotalTTC).toBeCloseTo(8000, 1);
  });
});

describe("Factures liées à un devis : une facture liée annulée ne compte plus", () => {
  const linked = (quote, amount, isDeposit) =>
    invoiceResolvers.Mutation.createLinkedInvoice(
      null,
      {
        quoteId: quote._id.toString(),
        amount,
        isDeposit,
        workspaceId: organizationId.toString(),
      },
      ctx(),
    );

  it("acompte annulé : un nouvel acompte est accepté et le reste à facturer redevient entier", async () => {
    const quote = await seedQuote();
    const { invoice } = await linked(quote, 3000, true);
    await Invoice.collection.updateOne(
      { _id: invoice._id },
      { $set: { status: "CANCELED" } },
    );

    const second = await linked(await Quote.findById(quote._id), 3000, true);
    expect(second.invoice.isDeposit).toBe(true);

    // 10 000 € de devis, seul le second acompte (3 000 €) est facturé
    await expect(
      linked(await Quote.findById(quote._id), 7000.01, false),
    ).rejects.toThrow(/Montant de facture invalide/);
    const solde = await linked(await Quote.findById(quote._id), 7000, false);
    expect(solde.invoice.items[0].description).toMatch(/Facture de solde/);
  });
});
