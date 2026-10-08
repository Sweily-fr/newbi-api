/**
 * Factures récurrentes : génération d'une facture à chaque échéance à partir
 * d'une facture modèle, numérotée à la suite de la séquence, puis envoyée par
 * email au client.
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

import { buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  startReplicaSet,
  ensureIndexes,
  resetWorkspace,
  buildClient,
} from "../helpers/numberingSimulation.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/qontoSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/abbySyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/invoiceFacturXArchiveService.js", () => ({
  triggerInvoiceFacturXArchive: vi.fn(),
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
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  autoPushEventToConnections: vi.fn().mockResolvedValue(undefined),
  updateEventInExternalCalendars: vi.fn().mockResolvedValue(undefined),
  deleteEventFromExternalCalendars: vi.fn().mockResolvedValue(undefined),
  pushEventToCalendar: vi.fn().mockResolvedValue(undefined),
  syncConnection: vi.fn().mockResolvedValue(undefined),
  syncAllForUser: vi.fn().mockResolvedValue(undefined),
  disconnectCalendar: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/documentEmailService.js", () => ({
  DOCUMENT_TYPES: { INVOICE: "invoice" },
  sendDocumentEmail: vi.fn(),
}));

import Invoice from "../../src/models/Invoice.js";
import InvoiceRecurrence from "../../src/models/InvoiceRecurrence.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import invoiceRecurrenceResolvers from "../../src/resolvers/invoiceRecurrence.js";
import { sendDocumentEmail } from "../../src/services/documentEmailService.js";
import { evaluateAndRouteInvoice } from "../../src/utils/eInvoiceRoutingHelper.js";
import {
  processDueRecurrences,
  runRecurrence,
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_EMAIL_BODY,
} from "../../src/services/invoiceRecurrenceService.js";

const createInvoice = invoiceResolvers.Mutation.createInvoice;
const { saveInvoiceRecurrence, setInvoiceRecurrenceStatus } =
  invoiceRecurrenceResolvers.Mutation;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const clientId = new mongoose.Types.ObjectId();

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("invoice_recurrence");
  await ensureIndexes(Invoice, "prefix_number_workspaceId_year_unique");
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
  sendDocumentEmail.mockImplementation(async ({ documentId }) => {
    await Invoice.updateOne(
      { _id: documentId },
      { $set: { "emailTracking.emailSentAt": new Date() } },
    );
    return { success: true };
  });
  invalidateOrgCache();
  await resetWorkspace({ userId, organizationId });
  await mongoose.connection.db.collection("clients").insertOne({
    _id: clientId,
    workspaceId: organizationId,
    createdBy: userId,
    type: "COMPANY",
    ...buildClient(),
    createdAt: new Date(),
  });
  await mongoose.connection.db.collection("user").updateOne(
    { _id: userId },
    {
      $setOnInsert: {
        _id: userId,
        email: "owner@test.com",
        name: "Owner Test",
      },
    },
    { upsert: true },
  );
});

const ctx = () => buildContext({ userId, organizationId });

async function createSource(overrides = {}) {
  return createInvoice(
    null,
    {
      workspaceId: organizationId.toString(),
      input: {
        status: "PENDING",
        prefix: "F-012030",
        number: "0001",
        issueDate: "2030-01-10",
        dueDate: "2030-02-09",
        items: [
          {
            description: "Abonnement maintenance",
            quantity: 1,
            unitPrice: 300,
            vatRate: 20,
          },
        ],
        client: {
          id: clientId.toString(),
          type: "COMPANY",
          ...buildClient(),
        },
        footerNotes: "Merci pour votre confiance",
        ...overrides,
      },
    },
    ctx(),
  );
}

async function addRecurrence(source, overrides = {}) {
  return InvoiceRecurrence.create({
    workspaceId: organizationId,
    sourceInvoiceId: source._id,
    userId,
    frequency: "MONTHLY",
    interval: 1,
    startDate: "2030-01-15",
    nextRunDate: "2030-01-15",
    ...overrides,
  });
}

const run = async (recurrenceId, today) =>
  runRecurrence(await InvoiceRecurrence.findById(recurrenceId).lean(), today);

const generated = (recurrenceId) =>
  Invoice.find({ "recurrenceOrigin.recurrenceId": recurrenceId })
    .sort({ createdAt: 1 })
    .lean();

describe("génération d'une facture récurrente", () => {
  it("crée la facture suivante dans la séquence et l'envoie au client", async () => {
    const source = await createSource();
    const recurrence = await addRecurrence(source);

    const result = await run(recurrence._id, "2030-01-15");
    expect(result.status).toBe("generated");

    const [invoice] = await generated(recurrence._id);
    expect(invoice).toMatchObject({
      status: "PENDING",
      prefix: "F-012030",
      number: "0002",
      footerNotes: "Merci pour votre confiance",
      recurrenceOrigin: { occurrenceDate: "2030-01-15" },
    });
    expect(String(invoice.recurrenceOrigin.sourceInvoiceId)).toBe(
      String(source._id),
    );
    expect(invoice.items[0].description).toBe("Abonnement maintenance");
    expect(invoice.finalTotalTTC).toBe(360);
    // Délai de paiement du modèle conservé (30 jours)
    expect(invoice.issueDate.toISOString().slice(0, 10)).toBe("2030-01-15");
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe("2030-02-14");
    expect(invoice.companyInfo?.name).toBeTruthy();

    expect(sendDocumentEmail).toHaveBeenCalledTimes(1);
    expect(sendDocumentEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: invoice._id.toString(),
        documentType: "invoice",
        recipientEmail: "contrepartie@test.fr",
        emailSubject: DEFAULT_EMAIL_SUBJECT,
        emailBody: DEFAULT_EMAIL_BODY,
        senderEmail: "owner@test.com",
      }),
    );

    const after = await InvoiceRecurrence.findById(recurrence._id).lean();
    expect(after).toMatchObject({
      status: "ACTIVE",
      nextRunDate: "2030-02-15",
      lastRunDate: "2030-01-15",
      generatedCount: 1,
      failureCount: 0,
      lastError: null,
      lockedUntil: null,
    });
  });

  it("suit la séquence malgré des brouillons et des factures créées entre-temps", async () => {
    const source = await createSource();
    // Brouillon : ne doit pas créer de trou dans la séquence
    await createInvoice(
      null,
      {
        workspaceId: organizationId.toString(),
        input: {
          status: "DRAFT",
          prefix: "F-012030",
          issueDate: "2030-01-12",
          dueDate: "2030-02-12",
          items: [{ description: "x", quantity: 1, unitPrice: 1, vatRate: 20 }],
          client: {
            id: clientId.toString(),
            type: "COMPANY",
            ...buildClient(),
          },
        },
      },
      ctx(),
    );
    await createSource({ number: "0002", issueDate: "2030-01-12" });
    const recurrence = await addRecurrence(source);

    await run(recurrence._id, "2030-01-15");

    const [invoice] = await generated(recurrence._id);
    expect(invoice.number).toBe("0003");
  });

  it("prend le préfixe du mois et le numéro de départ des paramètres comme l'éditeur", async () => {
    await mongoose.connection.db
      .collection("organization")
      .updateOne(
        { _id: organizationId },
        { $set: { invoicePrefix: "F-012030", invoiceStartNumber: "0100" } },
      );
    const source = await createSource();
    const recurrence = await addRecurrence(source, {
      startDate: "2030-02-15",
      nextRunDate: "2030-02-15",
    });

    await run(recurrence._id, "2030-02-15");

    const [invoice] = await generated(recurrence._id);
    expect(invoice.prefix).toBe("F-022030");
    expect(invoice.number).toBe("0100");
  });

  it("suit la séquence continue tous préfixes confondus", async () => {
    await mongoose.connection.db
      .collection("organization")
      .updateOne(
        { _id: organizationId },
        { $set: { invoiceAutoNumbering: true } },
      );
    const source = await createSource();
    const recurrence = await addRecurrence(source, {
      startDate: "2030-02-15",
      nextRunDate: "2030-02-15",
    });

    await run(recurrence._id, "2030-02-15");

    const [invoice] = await generated(recurrence._id);
    expect(invoice.prefix).toBe("F-022030");
    expect(invoice.number).toBe("0002");
  });

  it("ne recrée ni ne renvoie une échéance déjà facturée", async () => {
    const source = await createSource();
    const recurrence = await addRecurrence(source);
    await run(recurrence._id, "2030-01-15");

    // Crash simulé entre la création et la mise à jour de la récurrence
    await InvoiceRecurrence.updateOne(
      { _id: recurrence._id },
      { $set: { nextRunDate: "2030-01-15" } },
    );
    await run(recurrence._id, "2030-01-15");

    expect(await generated(recurrence._id)).toHaveLength(1);
    expect(sendDocumentEmail).toHaveBeenCalledTimes(1);
  });

  it("garde la facture et avance l'échéance si l'email échoue", async () => {
    sendDocumentEmail.mockRejectedValueOnce(new Error("SMTP indisponible"));
    const source = await createSource();
    const recurrence = await addRecurrence(source);

    await run(recurrence._id, "2030-01-15");

    expect(await generated(recurrence._id)).toHaveLength(1);
    const after = await InvoiceRecurrence.findById(recurrence._id).lean();
    expect(after.nextRunDate).toBe("2030-02-15");
    expect(after.lastError).toMatch(/F-012030-0002 créée mais non envoyée/);
  });

  it("ne laisse pas de brouillon si SuperPDP refuse la facture, et réessaie", async () => {
    const source = await createSource();
    const recurrence = await addRecurrence(source);
    evaluateAndRouteInvoice.mockResolvedValueOnce({
      flowType: "E_INVOICING",
      sendFailed: true,
      error: "SIREN destinataire inconnu",
    });

    const failed = await run(recurrence._id, "2030-01-15");
    expect(failed.status).toBe("failed");
    expect(
      await Invoice.countDocuments({
        "recurrenceOrigin.recurrenceId": recurrence._id,
      }),
    ).toBe(0);
    const afterFailure = await InvoiceRecurrence.findById(
      recurrence._id,
    ).lean();
    expect(afterFailure).toMatchObject({
      status: "ACTIVE",
      nextRunDate: "2030-01-15",
      failureCount: 1,
    });
    expect(afterFailure.lastError).toMatch(/SuperPDP/);
    expect(sendDocumentEmail).not.toHaveBeenCalled();

    // Passage suivant du cron : la facture part avec le même numéro
    await run(recurrence._id, "2030-01-15");
    const [invoice] = await generated(recurrence._id);
    expect(invoice).toMatchObject({ status: "PENDING", number: "0002" });
  });

  it("suspend la récurrence après plusieurs échecs consécutifs", async () => {
    const source = await createSource();
    const recurrence = await addRecurrence(source);
    // L'utilisateur a quitté l'organisation : plus le droit de facturer
    await mongoose.connection.db
      .collection("member")
      .deleteMany({ userId: userId.toString() });
    await mongoose.connection.db.collection("member").deleteMany({ userId });
    invalidateOrgCache();

    for (let i = 0; i < 3; i++) {
      const result = await run(recurrence._id, "2030-01-15");
      expect(result.status).toBe("failed");
    }

    const after = await InvoiceRecurrence.findById(recurrence._id).lean();
    expect(after.status).toBe("PAUSED");
    expect(after.failureCount).toBe(3);
    expect(after.lastError).toBeTruthy();
    expect(await generated(recurrence._id)).toHaveLength(0);
    expect(sendDocumentEmail).not.toHaveBeenCalled();
  });

  it("termine la récurrence après la dernière échéance", async () => {
    const source = await createSource();
    const recurrence = await addRecurrence(source, { endDate: "2030-02-01" });

    await run(recurrence._id, "2030-01-15");

    const after = await InvoiceRecurrence.findById(recurrence._id).lean();
    expect(after.status).toBe("ENDED");
    expect(after.nextRunDate).toBeNull();
  });

  it("ne traite que les récurrences actives arrivées à échéance", async () => {
    const source = await createSource();
    const other = await createSource({ number: "0002" });
    const due = await addRecurrence(source);
    await addRecurrence(other, {
      startDate: "2030-01-20",
      nextRunDate: "2030-01-20",
    });

    const stats = await processDueRecurrences({
      now: new Date("2030-01-15T09:05:00+01:00"),
    });

    expect(stats).toEqual({ due: 1, generated: 1, failed: 0 });
    expect(await generated(due._id)).toHaveLength(1);
  });
});

describe("programmation d'une récurrence (GraphQL)", () => {
  const ws = () => organizationId.toString();

  it("refuse un brouillon comme modèle", async () => {
    const draft = await createInvoice(
      null,
      {
        workspaceId: ws(),
        input: {
          status: "DRAFT",
          issueDate: "2030-01-12",
          dueDate: "2030-02-12",
          items: [{ description: "x", quantity: 1, unitPrice: 1, vatRate: 20 }],
          client: {
            id: clientId.toString(),
            type: "COMPANY",
            ...buildClient(),
          },
        },
      },
      ctx(),
    );

    await expect(
      saveInvoiceRecurrence(
        null,
        {
          workspaceId: ws(),
          invoiceId: draft._id.toString(),
          input: { frequency: "MONTHLY", startDate: "2099-01-01" },
        },
        ctx(),
      ),
    ).rejects.toThrow(/brouillon/);
  });

  it("programme, suspend puis reprend une récurrence", async () => {
    const source = await createSource();

    const saved = await saveInvoiceRecurrence(
      null,
      {
        workspaceId: ws(),
        invoiceId: source._id.toString(),
        input: {
          frequency: "WEEKLY",
          interval: 2,
          startDate: "2099-03-02",
          emailSubject: "Votre facture {documentNumber}",
        },
      },
      ctx(),
    );
    expect(saved).toMatchObject({
      status: "ACTIVE",
      frequency: "WEEKLY",
      interval: 2,
      nextRunDate: "2099-03-02",
      emailSubject: "Votre facture {documentNumber}",
      emailBody: null,
      sourceInvoice: { prefix: "F-012030", number: "0001" },
    });

    const paused = await setInvoiceRecurrenceStatus(
      null,
      { workspaceId: ws(), id: saved.id, status: "PAUSED" },
      ctx(),
    );
    expect(paused.status).toBe("PAUSED");

    const resumed = await setInvoiceRecurrenceStatus(
      null,
      { workspaceId: ws(), id: saved.id, status: "ACTIVE" },
      ctx(),
    );
    expect(resumed).toMatchObject({
      status: "ACTIVE",
      nextRunDate: "2099-03-02",
    });

    const list = await invoiceRecurrenceResolvers.Query.invoiceRecurrences(
      null,
      { workspaceId: ws() },
      ctx(),
    );
    expect(list).toHaveLength(1);
    expect(list[0].sourceInvoice.clientEmail).toBe("contrepartie@test.fr");
  });

  it("refuse une première facture dans le passé", async () => {
    const source = await createSource();
    await expect(
      saveInvoiceRecurrence(
        null,
        {
          workspaceId: ws(),
          invoiceId: source._id.toString(),
          input: { frequency: "MONTHLY", startDate: "2020-01-01" },
        },
        ctx(),
      ),
    ).rejects.toThrow(/erreurs de validation/);
  });
});
