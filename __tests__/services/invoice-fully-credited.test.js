/**
 * Facture dont les avoirs couvrent tout le montant : plus de lien de
 * paiement en ligne, plus de bouton de paiement, plus de relance (manuelle
 * ou automatique). Un avoir partiel ne change rien.
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

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { transporter: { sendMail } },
}));
vi.mock("axios", () => ({
  default: { post: vi.fn().mockRejectedValue(new Error("pas de PDF")) },
}));
vi.mock("stripe", () => {
  function StripeMock() {
    return { webhooks: { constructEvent: vi.fn() } };
  }
  return { default: StripeMock };
});
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import CreditNote from "../../src/models/CreditNote.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import { redirectToInvoicePayment } from "../../src/controllers/invoicePaymentController.js";
import {
  processWorkspaceReminders,
  sendManualReminder,
} from "../../src/services/invoiceReminderService.js";
import {
  fullyCreditedInvoiceIds,
  isInvoiceFullyCredited,
} from "../../src/utils/invoiceCredit.js";

const { ObjectId } = mongoose.Types;
const workspaceId = buildOrganizationId();
const userId = buildUserId();

async function seedInvoice(fields = {}) {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    prefix: "F-202610",
    number: `00${Math.floor(Math.random() * 90 + 10)}`,
    status: "PENDING",
    finalTotalTTC: 1080,
    dueDate: new Date("2026-10-01T00:00:00Z"),
    client: {
      id: new ObjectId().toString(),
      name: "Atelier Lumière",
      email: "compta@atelier.fr",
      type: "COMPANY",
    },
    companyInfo: { name: "Studio Test", email: "studio@test.fr" },
    ...fields,
  });
  return Invoice.findById(insertedId);
}

const credit = (invoice, amount, ws = workspaceId) =>
  CreditNote.collection.insertOne({
    workspaceId: ws,
    originalInvoice: invoice._id,
    number: `AV-${Math.random().toString(36).slice(2, 7)}`,
    finalTotalTTC: -amount,
  });

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.redirect = vi.fn().mockReturnValue(res);
  return res;
};

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: "message-1" });
  await mongoose.connection.db.collection("stripeconnectaccounts").insertOne({
    organizationId: workspaceId.toString(),
    userId,
    accountId: "acct_test",
    chargesEnabled: true,
  });
});

describe("isInvoiceFullyCredited", () => {
  it("avoir total : soldée ; avoir partiel ou d'un autre espace : non", async () => {
    const total = await seedInvoice();
    await credit(total, 1000);
    await credit(total, 80);
    const partial = await seedInvoice();
    await credit(partial, 500);
    const foreign = await seedInvoice();
    await credit(foreign, 1080, buildOrganizationId());

    expect(await isInvoiceFullyCredited(total)).toBe(true);
    expect(await isInvoiceFullyCredited(partial)).toBe(false);
    expect(await isInvoiceFullyCredited(foreign)).toBe(false);
    expect(
      await fullyCreditedInvoiceIds([total, partial, foreign], workspaceId),
    ).toEqual(new Set([String(total._id)]));
  });
});

describe("paiement en ligne", () => {
  it("lien de paiement : null pour une facture soldée par avoir", async () => {
    const total = await seedInvoice();
    await credit(total, 1080);
    const partial = await seedInvoice();
    await credit(partial, 100);
    const context = {};

    expect(
      await invoiceResolvers.Invoice.paymentLink(total, {}, context),
    ).toBeNull();
    expect(
      await invoiceResolvers.Invoice.paymentLink(partial, {}, context),
    ).toMatch(new RegExp(`/pay/invoice/${partial._id}$`));
  });

  it("GET /pay/invoice/:id : 409 « Facture soldée par avoir »", async () => {
    const total = await seedInvoice();
    await credit(total, 1080);
    const res = buildRes();

    await redirectToInvoicePayment(
      { params: { invoiceId: total._id.toString() } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.send.mock.calls[0][0]).toContain("Facture soldée par avoir");
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

describe("relances", () => {
  it("relance manuelle refusée avec un message", async () => {
    const total = await seedInvoice({ status: "OVERDUE" });
    await credit(total, 1080);

    const result = await sendManualReminder(total._id, workspaceId);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/entièrement annulée par un avoir/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("relances automatiques : seule la facture encore due est relancée", async () => {
    const total = await seedInvoice({ status: "OVERDUE" });
    await credit(total, 1080);
    const due = await seedInvoice({
      status: "OVERDUE",
      client: {
        id: new ObjectId().toString(),
        name: "Client dû",
        email: "du@client.fr",
        type: "COMPANY",
      },
    });

    await processWorkspaceReminders({
      workspaceId,
      firstReminderDays: 0,
      secondReminderDays: 30,
      excludedClientIds: [],
      useCustomSender: false,
    });

    const recipients = sendMail.mock.calls.map(([mail]) => mail.to);
    expect(recipients).toEqual(["du@client.fr"]);
    expect(String(due._id)).not.toBe(String(total._id));
  });
});
