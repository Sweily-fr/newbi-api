/**
 * Hooks de synchronisation externe (Qonto, Pennylane) sur les chemins de
 * finalisation d'une facture.
 *
 * L'éditeur envoie une facture via createInvoice (status PENDING direct) ou
 * updateInvoice (DRAFT → PENDING), pas seulement via changeInvoiceStatus :
 * les hooks doivent être posés sur les trois chemins (même piège que les
 * devis, PR #488).
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
vi.mock("../../src/services/invoiceFacturXArchiveService.js", () => ({
  triggerInvoiceFacturXArchive: vi.fn(),
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
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  autoPushEventToConnections: vi.fn().mockResolvedValue(undefined),
  updateEventInExternalCalendars: vi.fn().mockResolvedValue(undefined),
  deleteEventFromExternalCalendars: vi.fn().mockResolvedValue(undefined),
  pushEventToCalendar: vi.fn().mockResolvedValue(undefined),
  syncConnection: vi.fn().mockResolvedValue(undefined),
  syncAllForUser: vi.fn().mockResolvedValue(undefined),
  disconnectCalendar: vi.fn().mockResolvedValue(undefined),
}));

import Invoice from "../../src/models/Invoice.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import { syncInvoiceIfNeeded as syncQonto } from "../../src/services/qontoSyncHelper.js";
import { syncInvoiceIfNeeded as syncPennylane } from "../../src/services/pennylaneSyncHelper.js";

const create = invoiceResolvers.Mutation.createInvoice;
const update = invoiceResolvers.Mutation.updateInvoice;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const clientId = new mongoose.Types.ObjectId();
const PREFIX = "F-SYNC";

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("sync_invoice");
  await ensureIndexes(Invoice, "prefix_number_workspaceId_year_unique");
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  vi.clearAllMocks();
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
  await mongoose.connection.db
    .collection("users")
    .updateOne(
      { _id: userId },
      { $setOnInsert: { _id: userId, email: "test@test.com" } },
      { upsert: true },
    );
});

const ctx = () => buildContext({ userId, organizationId });

function buildInvoiceInput(overrides = {}) {
  const now = new Date();
  return {
    prefix: PREFIX,
    items: [
      { description: "Prestation", quantity: 2, unitPrice: 500, vatRate: 20 },
    ],
    client: { id: clientId.toString(), type: "COMPANY", ...buildClient() },
    issueDate: now.toISOString(),
    dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// Les hooks sont fire-and-forget : laisser la microtask se dérouler
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Facture → sync Qonto / Pennylane à la finalisation", () => {
  it("createInvoice en PENDING (bouton Envoyer) déclenche la sync", async () => {
    const invoice = await create(
      null,
      { input: buildInvoiceInput({ status: "PENDING" }) },
      ctx(),
    );
    await flush();

    expect(invoice.status).toBe("PENDING");
    expect(syncQonto).toHaveBeenCalledTimes(1);
    expect(String(syncQonto.mock.calls[0][0]._id)).toBe(String(invoice._id));
    expect(String(syncQonto.mock.calls[0][1])).toBe(String(organizationId));
    expect(syncPennylane).toHaveBeenCalledTimes(1);
  });

  it("createInvoice en DRAFT ne déclenche rien", async () => {
    const invoice = await create(
      null,
      { input: buildInvoiceInput({ status: "DRAFT" }) },
      ctx(),
    );
    await flush();

    expect(invoice.status).toBe("DRAFT");
    expect(syncQonto).not.toHaveBeenCalled();
    expect(syncPennylane).not.toHaveBeenCalled();
  });

  it("updateInvoice DRAFT → PENDING déclenche la sync", async () => {
    const draft = await create(
      null,
      { input: buildInvoiceInput({ status: "DRAFT" }) },
      ctx(),
    );
    await flush();
    vi.clearAllMocks();

    const finalized = await update(
      null,
      { id: draft._id.toString(), input: { status: "PENDING" } },
      ctx(),
    );
    await flush();

    expect(finalized.status).toBe("PENDING");
    expect(syncQonto).toHaveBeenCalledTimes(1);
    expect(String(syncQonto.mock.calls[0][0]._id)).toBe(String(draft._id));
    expect(syncPennylane).toHaveBeenCalledTimes(1);
  });

  it("updateInvoice d'un brouillon qui reste brouillon ne déclenche rien", async () => {
    const draft = await create(
      null,
      { input: buildInvoiceInput({ status: "DRAFT" }) },
      ctx(),
    );
    await flush();
    vi.clearAllMocks();

    const updated = await update(
      null,
      {
        id: draft._id.toString(),
        input: { status: "DRAFT", headerNotes: "Note" },
      },
      ctx(),
    );
    await flush();

    expect(updated.status).toBe("DRAFT");
    expect(syncQonto).not.toHaveBeenCalled();
    expect(syncPennylane).not.toHaveBeenCalled();
  });
});
