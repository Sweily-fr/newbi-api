import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getReceivedInvoices = vi.fn();
const transformReceivedInvoiceToPurchaseInvoice = vi.fn();
vi.mock("../../src/services/superPdpService.js", () => ({
  default: {
    getReceivedInvoices: (...a) => getReceivedInvoices(...a),
    transformReceivedInvoiceToPurchaseInvoice: (...a) =>
      transformReceivedInvoiceToPurchaseInvoice(...a),
  },
}));

const publishNotification = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/resolvers/notification.js", () => ({
  publishNotification: (...a) => publishNotification(...a),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Notification from "../../src/models/Notification.js";
import { importReceivedInvoices } from "../../src/services/purchaseInvoiceReceptionService.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  getReceivedInvoices.mockReset();
  transformReceivedInvoiceToPurchaseInvoice.mockReset();
  publishNotification.mockClear();
});

describe("importReceivedInvoices — notification d'arrivée", () => {
  it("importe la facture, crée le fournisseur et notifie l'utilisateur", async () => {
    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1" }],
      hasAfter: false,
    });
    transformReceivedInvoiceToPurchaseInvoice.mockReturnValue({
      supplierName: "Acme Telecom",
      invoiceNumber: "FA-2026-001",
      amountTTC: 1200,
      currency: "EUR",
      status: "TO_PROCESS",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
      eInvoiceReceivedAt: new Date(),
      ocrMetadata: {},
      workspaceId,
      createdBy: userId,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(1);

    const pi = await PurchaseInvoice.findOne({ superPdpInvoiceId: "sp-1" });
    expect(pi).toBeTruthy();
    expect(pi.supplierName).toBe("Acme Telecom");

    const notif = await Notification.findOne({
      type: "PURCHASE_INVOICE_RECEIVED",
    });
    expect(notif).toBeTruthy();
    expect(notif.data.supplierName).toBe("Acme Telecom");
    expect(notif.data.purchaseInvoiceId).toBe(pi._id.toString());
    expect(publishNotification).toHaveBeenCalledTimes(1);
  });

  it("est idempotent : ignore une facture déjà importée (pas de doublon ni notif)", async () => {
    await PurchaseInvoice.create({
      workspaceId,
      createdBy: userId,
      supplierName: "Acme Telecom",
      amountTTC: 1200,
      currency: "EUR",
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-1",
      eInvoiceStatus: "RECEIVED",
    });

    getReceivedInvoices.mockResolvedValue({
      invoices: [{ id: "sp-1" }],
      hasAfter: false,
    });

    const res = await importReceivedInvoices(
      workspaceId.toString(),
      userId.toString(),
    );

    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect(publishNotification).not.toHaveBeenCalled();
    expect(
      await Notification.countDocuments({ type: "PURCHASE_INVOICE_RECEIVED" }),
    ).toBe(0);
  });
});
