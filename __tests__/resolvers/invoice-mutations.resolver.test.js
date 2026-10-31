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
  reportPaymentIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));
// Archivage Factur-X (Puppeteer côté NewbiV2) : on vérifie seulement l'appel
vi.mock("../../src/services/invoiceFacturXArchiveService.js", () => ({
  triggerInvoiceFacturXArchive: vi.fn(),
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  autoPushEventToConnections: vi.fn().mockResolvedValue(undefined),
  updateEventInExternalCalendars: vi.fn().mockResolvedValue(undefined),
  deleteEventFromExternalCalendars: vi.fn().mockResolvedValue(undefined),
  pushEventToCalendar: vi.fn().mockResolvedValue(undefined),
  syncConnection: vi.fn().mockResolvedValue(undefined),
  syncAllForUser: vi.fn().mockResolvedValue(undefined),
  disconnectCalendar: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import { triggerInvoiceFacturXArchive } from "../../src/services/invoiceFacturXArchiveService.js";
import { reportPaymentIfNeeded } from "../../src/utils/eInvoiceRoutingHelper.js";
import documentAutomationService from "../../src/services/documentAutomationService.js";
import { automationService } from "../../src/resolvers/clientAutomation.js";

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

describe("Invoice Resolver - Invoice.paymentLink", () => {
  it("donne le lien de paiement à chaque facture en attente de la liste (compte lu une fois)", async () => {
    await mongoose.connection.db.collection("stripeconnectaccounts").insertOne({
      organizationId: organizationId.toString(),
      userId,
      accountId: "acct_test",
      chargesEnabled: true,
    });
    const context = ctx();
    const factures = [1, 2, 3].map(() => ({
      _id: new mongoose.Types.ObjectId(),
      status: "PENDING",
      workspaceId: organizationId,
    }));

    const liens = await Promise.all(
      factures.map((f) => invoiceResolvers.Invoice.paymentLink(f, {}, context)),
    );
    // Une facture plus tard dans la même requête (après la première lecture)
    const dernier = await invoiceResolvers.Invoice.paymentLink(
      { ...factures[0], _id: new mongoose.Types.ObjectId() },
      {},
      context,
    );

    liens.forEach((lien, i) =>
      expect(lien).toMatch(new RegExp(`/pay/invoice/${factures[i]._id}$`)),
    );
    expect(dernier).toMatch(/\/pay\/invoice\/[0-9a-f]{24}$/);
  });
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

describe("Invoice Resolver - Query.invoiceBalances (avoirs déduits)", () => {
  const balances = () =>
    invoiceResolvers.Query.invoiceBalances(
      null,
      { workspaceId: organizationId.toString() },
      ctx(),
    );
  const credit = (invoiceId, ht) =>
    mongoose.connection.db.collection("creditnotes").insertOne({
      workspaceId: organizationId,
      originalInvoice: invoiceId,
      number: `AV-${Math.random().toString(36).slice(2, 7)}`,
      finalTotalHT: -ht,
      finalTotalTTC: -ht * 1.2,
    });
  const echue = { dueDate: new Date(Date.now() - 10 * 86_400_000) };

  it("facture échue de 1 000 € HT et avoir de 400 € : 600 € facturés et en retard", async () => {
    const { insertedId } = await insertInvoice(echue);
    await credit(insertedId, 400);

    const result = await balances();

    expect(result.totalBilled).toBeCloseTo(600, 2);
    expect(result.overdueAmount).toBeCloseTo(600, 2);
    expect(result.overdueCount).toBe(1);
  });

  it("facture échue entièrement créditée : plus en retard", async () => {
    const { insertedId } = await insertInvoice(echue);
    await credit(insertedId, 1000);
    await insertInvoice({ ...echue, number: "0002" });

    const result = await balances();

    expect(result.totalBilled).toBeCloseTo(1000, 2);
    expect(result.overdueAmount).toBeCloseTo(1000, 2);
    expect(result.overdueCount).toBe(1);
  });

  it("facture payée créditée en partie : facturé et encaissé nets de l'avoir", async () => {
    const { insertedId } = await insertInvoice({
      status: "COMPLETED",
      paymentDate: new Date(),
    });
    await credit(insertedId, 250);

    const result = await balances();

    expect(result.totalBilled).toBeCloseTo(750, 2);
    expect(result.totalPaid).toBeCloseTo(750, 2);
    expect(result.overdueAmount).toBe(0);
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

  it("refuse de supprimer une facture en attente (trou dans la numérotation)", async () => {
    const { insertedId } = await insertInvoice({ status: "PENDING" });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    expect(
      await Invoice.collection.findOne({ _id: insertedId }),
    ).not.toBeNull();
  });

  it("refuse de supprimer une facture annulée", async () => {
    const { insertedId } = await insertInvoice({ status: "CANCELED" });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/Seul un brouillon peut être supprimé/);
    expect(
      await Invoice.collection.findOne({ _id: insertedId }),
    ).not.toBeNull();
  });

  it("refuse de supprimer une facture transmise en e-facturation", async () => {
    const { insertedId } = await insertInvoice({
      status: "PENDING",
      superPdpInvoiceId: "spdp-789",
      eInvoiceStatus: "SENT_TO_RECIPIENT",
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(
      "Cette facture a été transmise en facturation électronique : elle ne peut pas être supprimée. Créez un avoir pour l'annuler.",
    );
    expect(
      await Invoice.collection.findOne({ _id: insertedId }),
    ).not.toBeNull();
  });

  it("refuse aussi une facture en attente dont l'envoi e-invoicing a échoué (facture émise)", async () => {
    const { insertedId } = await insertInvoice({
      status: "PENDING",
      eInvoiceStatus: "ERROR",
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/Seul un brouillon peut être supprimé/);
  });

  it("blocks deletion of a COMPLETED invoice", async () => {
    const { insertedId } = await insertInvoice({ status: "COMPLETED" });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/Seul un brouillon peut être supprimé/);
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

  it("facture déjà payée : changer la date ne rejoue ni déclaration, ni notification, ni automatisations", async () => {
    const { insertedId } = await insertInvoice({
      status: "COMPLETED",
      paymentDate: new Date("2026-10-01T00:00:00.000Z"),
      eInvoiceFlowType: "E_REPORTING_TRANSACTION",
      eReportingPaymentStatus: "REPORTED",
    });
    reportPaymentIfNeeded.mockClear();
    documentAutomationService.executeAutomations.mockClear();
    automationService.executeAutomations.mockClear();

    await resolver(
      null,
      {
        id: insertedId.toString(),
        workspaceId: organizationId.toString(),
        paymentDate: "2026-10-02",
      },
      ctx(),
    );

    const saved = await Invoice.collection.findOne({ _id: insertedId });
    expect(saved.paymentDate.toISOString().slice(0, 10)).toBe("2026-10-02");
    expect(reportPaymentIfNeeded).not.toHaveBeenCalled();
    expect(documentAutomationService.executeAutomations).not.toHaveBeenCalled();
    expect(automationService.executeAutomations).not.toHaveBeenCalled();
  });

  it("facture payée par carte en ligne : sa date de paiement ne se modifie pas", async () => {
    const paidAt = new Date("2026-10-01T10:00:00.000Z");
    const { insertedId } = await insertInvoice({
      status: "COMPLETED",
      paymentDate: paidAt,
      paymentMethod: "CARD",
      stripePaymentStatus: "paid",
    });

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          workspaceId: organizationId.toString(),
          paymentDate: "2026-09-15",
        },
        ctx(),
      ),
    ).rejects.toThrow(/payée par carte/);

    const saved = await Invoice.collection.findOne({ _id: insertedId });
    expect(saved.paymentDate.toISOString()).toBe(paidAt.toISOString());
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
    // Même chemin que « Marquer comme payée » : la date de paiement est posée
    const saved = await Invoice.collection.findOne({ _id: insertedId });
    expect(saved.paymentDate).toBeInstanceOf(Date);
  });

  for (const target of ["COMPLETED", "CANCELED"]) {
    it(`refuse de passer un brouillon à ${target} : il reste brouillon, sans numéro légal`, async () => {
      const { insertedId } = await insertInvoice({
        status: "DRAFT",
        number: "DRAFT-0006",
      });

      await expect(
        resolver(
          null,
          {
            id: insertedId.toString(),
            workspaceId: organizationId.toString(),
            status: target,
          },
          ctx(),
        ),
      ).rejects.toThrow(/brouillon doit d'abord être validé/);

      const untouched = await Invoice.collection.findOne({ _id: insertedId });
      expect(untouched.status).toBe("DRAFT");
      expect(untouched.number).toBe("DRAFT-0006");
      expect(untouched.paymentDate ?? null).toBeNull();
    });
  }

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

  for (const [cas, fields, message] of [
    [
      "transmise en facturation électronique",
      {
        superPdpInvoiceId: "spdp-123",
        eInvoiceStatus: "VALIDATED",
        eInvoiceFlowType: "E_INVOICING",
      },
      /transmise en facturation électronique.*Créez un avoir/,
    ],
    [
      "déposée sans identifiant mais au statut transmis",
      { eInvoiceStatus: "SENT_TO_RECIPIENT" },
      /transmise en facturation électronique.*Créez un avoir/,
    ],
    [
      "déclarée en e-reporting",
      {
        eInvoiceFlowType: "E_REPORTING_TRANSACTION",
        eReportingStatus: "REPORTED",
      },
      /déclarée à l'administration.*Créez un avoir/,
    ],
  ]) {
    it(`refuse d'annuler une facture ${cas} : elle s'annule par un avoir`, async () => {
      const { insertedId } = await insertInvoice({
        status: "PENDING",
        ...fields,
      });

      await expect(
        resolver(
          null,
          {
            id: insertedId.toString(),
            workspaceId: organizationId.toString(),
            status: "CANCELED",
          },
          ctx(),
        ),
      ).rejects.toThrow(message);

      const untouched = await Invoice.collection.findOne({ _id: insertedId });
      expect(untouched.status).toBe("PENDING");
    });
  }

  it("laisse annuler une facture dont l'envoi e-invoicing a échoué avant dépôt", async () => {
    const { insertedId } = await insertInvoice({
      status: "PENDING",
      eInvoiceStatus: "ERROR",
      eReportingStatus: "ERROR",
    });

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

  it("REJETTE le passage manuel au statut OVERDUE (état dérivé, hors séquence)", async () => {
    const { insertedId } = await insertInvoice({ status: "PENDING" });

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          workspaceId: organizationId.toString(),
          status: "OVERDUE",
        },
        ctx(),
      ),
    ).rejects.toThrow(/en retard|OVERDUE/i);

    const untouched = await Invoice.collection.findOne({ _id: insertedId });
    expect(untouched.status).toBe("PENDING");
  });
});

describe("Invoice Resolver - Query.nextInvoiceNumber (lecture seule)", () => {
  it("l'aperçu d'un numéro de brouillon ne change ni le compteur ni les brouillons", async () => {
    await insertInvoice({ status: "PENDING", number: "0001" });
    await insertInvoice({
      _id: new mongoose.Types.ObjectId(),
      status: "DRAFT",
      number: "DRAFT-0002",
    });
    const db = mongoose.connection.db;
    await db.collection("documentcounters").insertOne({
      documentType: "invoice",
      prefix: "F-202604",
      workspaceId: organizationId.toString(),
      lastNumber: 1,
    });
    const photo = async () =>
      JSON.stringify([
        await db.collection("documentcounters").find().toArray(),
        await db.collection("invoices").find().sort({ _id: 1 }).toArray(),
      ]);
    const avant = await photo();

    const read = () =>
      invoiceResolvers.Query.nextInvoiceNumber(
        null,
        {
          workspaceId: organizationId.toString(),
          prefix: "F-202604",
          isDraft: true,
        },
        ctx(),
      );
    const lectures = [await read(), await read(), await read()];

    expect(lectures).toEqual(["DRAFT-0002", "DRAFT-0002", "DRAFT-0002"]);
    expect(await photo()).toBe(avant);
  });
});

describe("Invoice Resolver - Mutation.createInvoice (statut de création)", () => {
  const resolver = invoiceResolvers.Mutation.createInvoice;
  const input = (status) => ({
    status,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    client: {
      name: "Acme",
      email: "client@test.fr",
      type: "COMPANY",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    items: [
      { description: "Service", quantity: 1, unitPrice: 100, vatRate: 20 },
    ],
  });

  for (const status of ["COMPLETED", "CANCELED", "OVERDUE"]) {
    it(`refuse une facture créée au statut ${status} : rien n'est enregistré`, async () => {
      await expect(
        resolver(
          null,
          { workspaceId: organizationId.toString(), input: input(status) },
          ctx(),
        ),
      ).rejects.toThrow(/se crée en brouillon ou en attente/);

      expect(
        await Invoice.countDocuments({ workspaceId: organizationId }),
      ).toBe(0);
      const counters = await mongoose.connection.db
        .collection("documentcounters")
        .find({ workspaceId: organizationId.toString() })
        .toArray();
      expect(counters.every((c) => c.lastNumber === 0)).toBe(true);
    });
  }
});

// Brouillon : entièrement modifiable (articles, remise, client)
const BROUILLON = { status: "DRAFT", number: "DRAFT-0001" };

describe("Invoice Resolver - Mutation.updateInvoice (facture émise figée)", () => {
  const resolver = invoiceResolvers.Mutation.updateInvoice;
  const items = [
    { description: "Service", quantity: 1, unitPrice: 9999, vatRate: 20 },
  ];

  it("refuse de changer les articles d'une facture en attente : montant intact", async () => {
    const { insertedId } = await insertInvoice();

    await expect(
      resolver(null, { id: insertedId.toString(), input: { items } }, ctx()),
    ).rejects.toThrow(/Corrigez-la par un avoir/);

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.finalTotalTTC).toBe(1200);
    expect(stored.items[0].unitPrice).toBe(1000);
  });

  it("refuse la remise d'une facture payée, même à un administrateur", async () => {
    const { insertedId } = await insertInvoice({ status: "COMPLETED" });

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          input: { discount: 50, discountType: "PERCENTAGE" },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.finalTotalTTC).toBe(1200);
  });

  it("laisse modifier les notes d'une facture en attente", async () => {
    const { insertedId } = await insertInvoice();

    const result = await resolver(
      null,
      { id: insertedId.toString(), input: { footerNotes: "Merci" } },
      ctx(),
    );

    expect(result.footerNotes).toBe("Merci");
    expect(result.finalTotalTTC).toBe(1200);
  });

  it("refuse de changer l'IBAN d'une facture en attente : coordonnées intactes", async () => {
    const bankDetails = {
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPP",
      bankName: "Banque d'origine",
    };
    const { insertedId } = await insertInvoice({
      showBankDetails: true,
      bankDetails,
    });

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          input: {
            showBankDetails: true,
            bankDetails: {
              iban: "FR7612739000706541765734534",
              bic: "BNPAFRPP",
              bankName: "Autre",
            },
          },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
      details: expect.objectContaining({
        fields: ["showBankDetails", "bankDetails"],
      }),
    });

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.bankDetails).toEqual(bankDetails);
  });

  it("refuse de déplacer la date d'émission d'une facture émise", async () => {
    const issueDate = new Date("2026-10-15T00:00:00.000Z");
    const { insertedId } = await insertInvoice({ issueDate });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), input: { issueDate: "2026-01-01" } },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.issueDate).toEqual(issueDate);
  });

  it("laisse modifier l'échéance et la présentation d'une facture en attente", async () => {
    const { insertedId } = await insertInvoice();

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        input: { dueDate: "2026-12-31", clientPositionRight: true },
      },
      ctx(),
    );

    expect(result.clientPositionRight).toBe(true);
  });

  it("laisse un brouillon changer ses articles", async () => {
    const { insertedId } = await insertInvoice(BROUILLON);

    const result = await resolver(
      null,
      { id: insertedId.toString(), input: { items } },
      ctx(),
    );

    expect(result.finalTotalHT).toBe(9999);
  });
});

describe("Invoice Resolver - Mutation.updateInvoice (facture modifiée)", () => {
  const resolver = invoiceResolvers.Mutation.updateInvoice;
  const items = [
    { description: "Service", quantity: 1, unitPrice: 1000, vatRate: 20 },
  ];
  const shipping = {
    billShipping: true,
    shippingAmountHT: 50,
    shippingVatRate: 20,
    shippingAddress: {
      fullName: "Jean Dupont",
      street: "3 rue de la Livraison",
      city: "Lyon",
      postalCode: "69001",
      country: "France",
    },
  };

  it("une remise remise à 0 n'est plus reprise de l'ancienne valeur", async () => {
    const { insertedId } = await insertInvoice({
      ...BROUILLON,
      discount: 10,
      discountType: "PERCENTAGE",
      finalTotalHT: 900,
      finalTotalVAT: 180,
      finalTotalTTC: 1080,
    });

    const result = await resolver(
      null,
      { id: insertedId.toString(), input: { items, discount: 0 } },
      ctx(),
    );

    expect(result.discount).toBe(0);
    expect(result.finalTotalHT).toBe(1000);
    expect(result.finalTotalTTC).toBe(1200);
  });

  it("recalcule les totaux quand seule la remise change", async () => {
    const { insertedId } = await insertInvoice(BROUILLON);

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        input: { discount: 10, discountType: "PERCENTAGE" },
      },
      ctx(),
    );

    expect(result.finalTotalHT).toBe(900);
    expect(result.finalTotalTTC).toBe(1080);
  });

  it("n'applique pas la remise en % aux frais de port", async () => {
    const { insertedId } = await insertInvoice(BROUILLON);

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        input: { items, discount: 10, discountType: "PERCENTAGE", shipping },
      },
      ctx(),
    );

    expect(result.finalTotalHT).toBe(950);
    expect(result.finalTotalVAT).toBeCloseTo(190, 10);
    expect(result.finalTotalTTC).toBeCloseTo(1140, 10);
  });

  it("oublie le PDF en cache des envois quand la facture est modifiée", async () => {
    const { insertedId } = await insertInvoice({
      cachedPdf: {
        key: "cache/invoice.pdf",
        url: "https://r2.example/invoice.pdf",
        generatedAt: new Date(),
      },
    });

    await resolver(
      null,
      { id: insertedId.toString(), input: { headerNotes: "Modifiée" } },
      ctx(),
    );

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.cachedPdf?.url ?? null).toBeNull();
    expect(stored.cachedPdf?.key ?? null).toBeNull();
  });

  it("réarchive une facture en attente modifiée, non transmise", async () => {
    triggerInvoiceFacturXArchive.mockClear();
    const { insertedId } = await insertInvoice({
      archivedPdfKey: "invoices/ws/2026/10/old.pdf",
      archivedPdfStoredAt: new Date("2026-10-01"),
      archivedPdfSource: "NEWBI",
    });

    await resolver(
      null,
      { id: insertedId.toString(), input: { headerNotes: "Notes corrigées" } },
      ctx(),
    );

    // Ancienne archive oubliée : aperçu et envois ne la servent plus
    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.archivedPdfKey ?? null).toBeNull();
    expect(stored.archivedPdfStoredAt ?? null).toBeNull();
    expect(stored.archivedPdfSource ?? null).toBeNull();

    // Nouvelle archive générée depuis la facture modifiée
    expect(triggerInvoiceFacturXArchive).toHaveBeenCalledTimes(1);
    const [archived, workspaceId] = triggerInvoiceFacturXArchive.mock.calls[0];
    expect(archived._id.toString()).toBe(insertedId.toString());
    expect(archived.headerNotes).toBe("Notes corrigées");
    expect(archived.finalTotalHT).toBe(1000);
    expect(workspaceId.toString()).toBe(organizationId.toString());
  });

  it("refuse la modification d'une facture transmise en e-facturation", async () => {
    triggerInvoiceFacturXArchive.mockClear();
    const { insertedId } = await insertInvoice({
      superPdpInvoiceId: "spdp-123",
      eInvoiceStatus: "SENT_TO_RECIPIENT",
      archivedPdfKey: "invoices/ws/2026/10/transmise.pdf",
      archivedPdfSource: "NEWBI",
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), input: { headerNotes: "Modifiée" } },
        ctx(),
      ),
    ).rejects.toThrow(
      "Cette facture a été transmise en facturation électronique : elle ne peut plus être modifiée. Créez un avoir pour la corriger.",
    );

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.headerNotes).toBeUndefined();
    expect(stored.archivedPdfKey).toBe("invoices/ws/2026/10/transmise.pdf");
    expect(triggerInvoiceFacturXArchive).not.toHaveBeenCalled();
  });

  it("refuse aussi sur un statut e-invoicing transmis sans identifiant", async () => {
    const { insertedId } = await insertInvoice({ eInvoiceStatus: "ACCEPTED" });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), input: { headerNotes: "Modifiée" } },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
  });

  it("laisse modifier une facture dont l'envoi e-invoicing a échoué avant dépôt", async () => {
    const { insertedId } = await insertInvoice({
      eInvoiceStatus: "ERROR",
      eInvoiceError: "SIREN destinataire inconnu",
    });

    const result = await resolver(
      null,
      { id: insertedId.toString(), input: { headerNotes: "Corrigée" } },
      ctx(),
    );

    expect(result.headerNotes).toBe("Corrigée");
  });

  it("laisse marquer payée une facture transmise (autre chemin)", async () => {
    const { insertedId } = await insertInvoice({
      superPdpInvoiceId: "spdp-456",
      eInvoiceStatus: "SENT_TO_RECIPIENT",
    });

    const result = await invoiceResolvers.Mutation.markInvoiceAsPaid(
      null,
      {
        id: insertedId.toString(),
        workspaceId: organizationId.toString(),
        paymentDate: "2026-10-10",
      },
      ctx(),
    );

    expect(result.status).toBe("COMPLETED");
  });

  it("n'archive pas un brouillon qui reste brouillon", async () => {
    triggerInvoiceFacturXArchive.mockClear();
    const { insertedId } = await insertInvoice({
      status: "DRAFT",
      number: "DRAFT-0001",
    });

    await resolver(
      null,
      { id: insertedId.toString(), input: { headerNotes: "Brouillon" } },
      ctx(),
    );

    expect(triggerInvoiceFacturXArchive).not.toHaveBeenCalled();
  });

  it("refuse de remplacer le client d'une facture émise", async () => {
    const { insertedId } = await insertInvoice();

    await expect(
      resolver(
        null,
        {
          id: insertedId.toString(),
          input: {
            client: {
              id: "client-2",
              name: "Beta",
              email: "beta@test.fr",
              address: {
                street: "2 rue Test",
                city: "Paris",
                postalCode: "75002",
                country: "France",
              },
            },
          },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    const stored = await Invoice.collection.findOne({ _id: insertedId });
    expect(stored.client.name).toBe("Acme");
  });
});
