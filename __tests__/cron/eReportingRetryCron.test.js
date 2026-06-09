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

const submitB2cTransaction = vi.fn();
const submitB2cPayment = vi.fn();
vi.mock("../../src/services/superPdpService.js", () => ({
  default: {
    submitB2cTransaction: (...a) => submitB2cTransaction(...a),
    submitB2cPayment: (...a) => submitB2cPayment(...a),
  },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import { retryEReportings } from "../../src/cron/eReportingRetryCron.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

const insertInvoice = (over = {}) =>
  Invoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    number: "0001",
    prefix: "F-202710",
    status: "PENDING",
    eInvoiceFlowType: "E_REPORTING_TRANSACTION",
    items: [
      { description: "Service", quantity: 1, unitPrice: 1000, vatRate: 20 },
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
    ...over,
  });

const reload = (id) => Invoice.findById(id).lean();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  submitB2cTransaction.mockReset();
  submitB2cPayment.mockReset();
});

describe("eReportingRetryCron.retryEReportings", () => {
  it("relance une transaction en ERROR et la passe à REPORTED si succès", async () => {
    const { insertedId } = await insertInvoice({ eReportingStatus: "ERROR" });
    submitB2cTransaction.mockResolvedValue({ success: true, id: "tx-1" });

    const { checked, updated } = await retryEReportings();

    expect(checked).toBe(1);
    expect(updated).toBe(1);
    const doc = await reload(insertedId);
    expect(doc.eReportingStatus).toBe("REPORTED");
    expect(doc.eReportingTransactionId).toBe("tx-1");
    expect(doc.eReportingError).toBeNull();
  });

  it("garde le statut ERROR si la re-soumission échoue encore", async () => {
    const { insertedId } = await insertInvoice({ eReportingStatus: "ERROR" });
    submitB2cTransaction.mockResolvedValue({ success: false, error: "boom" });

    const { updated } = await retryEReportings();

    expect(updated).toBe(0);
    const doc = await reload(insertedId);
    expect(doc.eReportingStatus).toBe("ERROR");
    expect(doc.eReportingError).toBe("boom");
  });

  it("relance un paiement en ERROR (avec date) et le passe à REPORTED", async () => {
    const { insertedId } = await insertInvoice({
      eReportingStatus: "REPORTED",
      eReportingPaymentStatus: "ERROR",
      paymentDate: new Date("2026-05-10"),
    });
    submitB2cPayment.mockResolvedValue({ success: true, id: "pay-1" });

    const { updated } = await retryEReportings();

    expect(updated).toBe(1);
    expect(submitB2cPayment).toHaveBeenCalledTimes(1);
    const doc = await reload(insertedId);
    expect(doc.eReportingPaymentStatus).toBe("REPORTED");
    expect(doc.eReportingPaymentId).toBe("pay-1");
  });

  it("ne relance PAS un paiement en ERROR sans date de paiement", async () => {
    const { insertedId } = await insertInvoice({
      eReportingStatus: "REPORTED",
      eReportingPaymentStatus: "ERROR",
    });

    await retryEReportings();

    expect(submitB2cPayment).not.toHaveBeenCalled();
    const doc = await reload(insertedId);
    expect(doc.eReportingPaymentStatus).toBe("ERROR");
  });

  it("ignore les factures sans erreur e-reporting", async () => {
    await insertInvoice({ eReportingStatus: "REPORTED" });

    const { checked, updated } = await retryEReportings();

    expect(checked).toBe(0);
    expect(updated).toBe(0);
    expect(submitB2cTransaction).not.toHaveBeenCalled();
  });
});
