/**
 * Webhook Stripe d'encaissement des factures (POST /webhook/invoice-payment).
 * Signatures réelles (bibliothèque Stripe, secret de test, sans réseau) :
 *   - sans signature ou signature fausse : 400, facture inchangée ;
 *   - paiement signé : facture payée par carte, date et identifiants Stripe ;
 *   - événement rejoué : sans effet ; session d'un autre type : ignorée ;
 *   - facture annulée après l'ouverture du paiement : reste annulée,
 *     anomalie signalée ; second paiement d'une facture payée : signalé.
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
import Stripe from "stripe";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: { sendPaymentReceivedNotification: vi.fn() },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    isFirstPaidInvoice: vi.fn().mockResolvedValue(false),
    executeAutomations: vi.fn().mockResolvedValue(undefined),
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
const { reportPaymentIfNeeded } = vi.hoisted(() => ({
  reportPaymentIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/utils/eInvoiceRoutingHelper.js", () => ({
  evaluateAndRouteInvoice: vi.fn(),
  reportPaymentIfNeeded,
}));

const SECRET = "whsec_test_factures_e2e";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_INVOICE_WEBHOOK_SECRET = SECRET;

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import logger from "../../src/utils/logger.js";
import { handleInvoicePaymentWebhook } from "../../src/controllers/invoicePaymentController.js";

const stripe = new Stripe("sk_test_dummy");
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
  reportPaymentIfNeeded.mockClear();
});

const seedInvoice = async (fields = {}) => {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    prefix: "F-102026",
    number: "0042",
    status: "PENDING",
    items: [
      { description: "Service", quantity: 1, unitPrice: 900, vatRate: 20 },
    ],
    finalTotalTTC: 1080,
    client: {
      name: "Atelier Lumière",
      email: "compta@atelier.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    ...fields,
  });
  return insertedId;
};

const event = (invoiceId, { sessionId = "cs_test_1", type } = {}) =>
  JSON.stringify({
    id: `evt_${sessionId}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_intent: `pi_${sessionId}`,
        metadata: {
          type: type ?? "invoice_payment",
          invoiceId: invoiceId.toString(),
        },
      },
    },
  });

const signed = (payload, secret = SECRET) =>
  stripe.webhooks.generateTestHeaderString({ payload, secret });

const call = async (payload, signature) => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  await handleInvoicePaymentWebhook(
    {
      body: Buffer.from(payload),
      headers: signature ? { "stripe-signature": signature } : {},
    },
    res,
  );
  return res;
};

const stored = (id) => Invoice.collection.findOne({ _id: id });

describe("Webhook d'encaissement des factures", () => {
  it("sans signature ou avec une signature fausse : 400, facture inchangée", async () => {
    const id = await seedInvoice();
    const payload = event(id);

    for (const signature of [
      null,
      "t=1,v1=faux",
      signed(payload, "whsec_autre_secret"),
    ]) {
      const res = await call(payload, signature);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    const apres = await stored(id);
    expect(apres.status).toBe("PENDING");
    expect(apres.paymentDate ?? null).toBeNull();
  });

  it("paiement signé : facture payée par carte, date du jour et identifiants Stripe", async () => {
    const id = await seedInvoice();
    const payload = event(id);

    const res = await call(payload, signed(payload));

    expect(res.json.mock.calls[0][0].result.status).toBe("success");
    const apres = await stored(id);
    expect(apres.status).toBe("COMPLETED");
    expect(apres.paymentMethod).toBe("CARD");
    expect(apres.stripePaymentStatus).toBe("paid");
    expect(apres.stripeCheckoutSessionId).toBe("cs_test_1");
    expect(apres.stripePaymentIntentId).toBe("pi_cs_test_1");
    expect(new Date(apres.paymentDate).toDateString()).toBe(
      new Date().toDateString(),
    );
  });

  it("événement rejoué par Stripe : sans effet", async () => {
    const id = await seedInvoice();
    const payload = event(id);
    await call(payload, signed(payload));
    const premiere = await stored(id);

    const res = await call(payload, signed(payload));

    expect(res.json.mock.calls[0][0].result.status).toBe("ignored");
    expect(await stored(id)).toEqual(premiere);
    expect(reportPaymentIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("session d'un autre type (transfert de fichiers) : ignorée", async () => {
    const id = await seedInvoice();
    const payload = event(id, { type: "file_transfer" });

    await call(payload, signed(payload));

    expect((await stored(id)).status).toBe("PENDING");
  });

  it("facture annulée après l'ouverture du paiement : reste annulée, anomalie signalée", async () => {
    const id = await seedInvoice({ status: "CANCELED" });
    const payload = event(id);
    const erreur = vi.spyOn(logger, "error");

    const res = await call(payload, signed(payload));

    expect(res.json.mock.calls[0][0].result.status).toBe("anomaly");
    const apres = await stored(id);
    expect(apres.status).toBe("CANCELED");
    expect(apres.paymentDate ?? null).toBeNull();
    expect(
      erreur.mock.calls.some(([m]) => /ANOMALIE.*F-102026-0042/.test(m)),
    ).toBe(true);
    erreur.mockRestore();
  });

  it("second paiement d'une facture déjà payée : signalé, la facture garde son premier paiement", async () => {
    const id = await seedInvoice();
    const premier = event(id, { sessionId: "cs_premier" });
    await call(premier, signed(premier));
    const second = event(id, { sessionId: "cs_second" });
    const erreur = vi.spyOn(logger, "error");

    const res = await call(second, signed(second));

    expect(res.json.mock.calls[0][0].result.status).toBe("anomaly");
    expect((await stored(id)).stripeCheckoutSessionId).toBe("cs_premier");
    expect(
      erreur.mock.calls.some(([m]) => /second paiement.*F-102026-0042/.test(m)),
    ).toBe(true);
    erreur.mockRestore();
  });
});
