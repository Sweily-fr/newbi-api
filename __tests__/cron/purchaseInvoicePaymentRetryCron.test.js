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

const submitInvoiceEvent = vi.fn();
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { submitInvoiceEvent: (...a) => submitInvoiceEvent(...a) },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import { retryPurchaseInvoicePayments } from "../../src/cron/purchaseInvoicePaymentRetryCron.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

const insert = (over = {}) =>
  PurchaseInvoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    supplierName: "Acme",
    amountTTC: 1200,
    currency: "EUR",
    status: "PAID",
    source: "SUPERPDP",
    superPdpInvoiceId: "sp-1",
    eInvoiceStatus: "ACCEPTED",
    eInvoicePaymentReportStatus: "ERROR",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

const reload = (id) => PurchaseInvoice.findById(id).lean();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  submitInvoiceEvent.mockReset();
});

describe("purchaseInvoicePaymentRetryCron.retryPurchaseInvoicePayments", () => {
  it("relance un signalement en ERROR et le passe à REPORTED si succès", async () => {
    submitInvoiceEvent.mockResolvedValue({ success: true });
    const { insertedId } = await insert();

    const { checked, updated } = await retryPurchaseInvoicePayments();

    expect(checked).toBe(1);
    expect(updated).toBe(1);
    const doc = await reload(insertedId);
    expect(doc.eInvoicePaymentReportStatus).toBe("REPORTED");
    expect(doc.eInvoiceStatus).toBe("PAID");
  });

  it("reste en ERROR si la ré-émission échoue encore", async () => {
    submitInvoiceEvent.mockResolvedValue({ success: false, error: "boom" });
    const { insertedId } = await insert();

    const { updated } = await retryPurchaseInvoicePayments();

    expect(updated).toBe(0);
    const doc = await reload(insertedId);
    expect(doc.eInvoicePaymentReportStatus).toBe("ERROR");
  });

  it("ignore les factures sans erreur de signalement", async () => {
    await insert({ eInvoicePaymentReportStatus: "REPORTED" });

    const { checked } = await retryPurchaseInvoicePayments();

    expect(checked).toBe(0);
    expect(submitInvoiceEvent).not.toHaveBeenCalled();
  });
});
