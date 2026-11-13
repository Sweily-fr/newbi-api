/**
 * Automatisations des documents partagés depuis l'éditeur : « Créer la
 * facture » (création déjà finalisée) et la validation d'un brouillon passent
 * par createInvoice / updateInvoice, pas par changeInvoiceStatus. Jusqu'au
 * 13/11/2026, seule cette dernière déclenchait « Facture envoyée » : la
 * facture n'arrivait jamais dans son dossier sans lancement manuel. Même
 * chose pour les devis et les bons de commande.
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

const executeAutomations = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncPurchaseOrderIfNeeded: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
    onQuoteAccepted: vi.fn().mockResolvedValue(undefined),
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

import mongoose from "mongoose";
import { buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  startReplicaSet,
  resetWorkspace,
  buildClient,
} from "../helpers/numberingSimulation.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);
const clientId = new mongoose.Types.ObjectId();
const ctx = () => buildContext({ userId, organizationId });

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("automation_editeur");
}, 180000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  invalidateOrgCache();
  executeAutomations.mockClear();
  await resetWorkspace({ userId, organizationId });
  await mongoose.connection.db.collection("clients").insertOne({
    _id: clientId,
    workspaceId: organizationId,
    createdBy: userId,
    type: "COMPANY",
    ...buildClient(),
    createdAt: new Date(),
  });
  await mongoose.connection.db
    .collection("users")
    .updateOne(
      { _id: userId },
      { $setOnInsert: { _id: userId, email: "test@test.com" } },
      { upsert: true },
    );
});

function documentInput(overrides = {}) {
  const now = new Date();
  return {
    items: [
      { description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20 },
    ],
    client: { id: clientId.toString(), type: "COMPANY", ...buildClient() },
    issueDate: now.toISOString(),
    dueDate: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    validUntil: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    ...overrides,
  };
}

/** Déclencheurs passés à executeAutomations, avec le document concerné */
const triggers = () =>
  executeAutomations.mock.calls.map(([trigger, workspaceId, document]) => ({
    trigger,
    workspaceId: String(workspaceId),
    documentId: document?.documentId,
  }));

describe("factures", () => {
  const create = (input) =>
    invoiceResolvers.Mutation.createInvoice(
      null,
      { workspaceId: ws, input },
      ctx(),
    );
  const update = (id, input) =>
    invoiceResolvers.Mutation.updateInvoice(
      null,
      { id, workspaceId: ws, input },
      ctx(),
    );

  it("« Créer la facture » (créée finalisée) : Facture envoyée", async () => {
    const invoice = await create(documentInput({ status: "PENDING" }));

    expect(triggers()).toEqual([
      {
        trigger: "INVOICE_SENT",
        workspaceId: ws,
        documentId: String(invoice._id),
      },
    ]);
  });

  it("brouillon validé dans l'éditeur : Facture envoyée", async () => {
    const draft = await create(documentInput({ status: "DRAFT" }));
    executeAutomations.mockClear();

    await update(String(draft._id), documentInput({ status: "PENDING" }));

    expect(triggers()).toEqual([
      {
        trigger: "INVOICE_SENT",
        workspaceId: ws,
        documentId: String(draft._id),
      },
    ]);
  });

  it("brouillon modifié sans validation : rien", async () => {
    const draft = await create(documentInput({ status: "DRAFT" }));
    executeAutomations.mockClear();

    await update(String(draft._id), documentInput({ status: "DRAFT" }));

    expect(triggers()).toEqual([]);
  });
});

describe("devis", () => {
  const create = (input) =>
    quoteResolvers.Mutation.createQuote(
      null,
      { workspaceId: ws, input },
      ctx(),
    );
  const update = (id, input) =>
    quoteResolvers.Mutation.updateQuote(
      null,
      { id, workspaceId: ws, input },
      ctx(),
    );

  it("devis créé directement envoyé : Devis envoyé", async () => {
    const quote = await create(documentInput({ status: "PENDING" }));

    expect(triggers()).toEqual([
      { trigger: "QUOTE_SENT", workspaceId: ws, documentId: String(quote._id) },
    ]);
  });

  it("brouillon validé dans l'éditeur : Devis envoyé", async () => {
    const draft = await create(documentInput({ status: "DRAFT" }));
    executeAutomations.mockClear();

    await update(String(draft._id), documentInput({ status: "PENDING" }));

    expect(triggers()).toEqual([
      { trigger: "QUOTE_SENT", workspaceId: ws, documentId: String(draft._id) },
    ]);
  });
});

describe("bons de commande", () => {
  it("brouillon confirmé dans l'éditeur : Bon de commande confirmé", async () => {
    const draft = await purchaseOrderResolvers.Mutation.createPurchaseOrder(
      null,
      { workspaceId: ws, input: documentInput({ status: "DRAFT" }) },
      ctx(),
    );
    executeAutomations.mockClear();

    await purchaseOrderResolvers.Mutation.updatePurchaseOrder(
      null,
      {
        id: String(draft._id),
        workspaceId: ws,
        input: documentInput({ status: "CONFIRMED" }),
      },
      ctx(),
    );

    expect(triggers()).toEqual([
      {
        trigger: "PURCHASE_ORDER_CONFIRMED",
        workspaceId: ws,
        documentId: String(draft._id),
      },
    ]);
  });
});
