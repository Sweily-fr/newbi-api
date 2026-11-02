/**
 * Lien public de paiement d'une facture : GET /pay/invoice/:id crée une
 * session de paiement (la page Stripe affiche le numéro, le client et le
 * montant). Le lien porte un jeton signé (celui des e-mails et du tableau de
 * bord) ; sans jeton valide, même réponse qu'une facture inconnue, sans
 * session créée. Les liens déjà envoyés sans jeton restent valables pour les
 * factures créées avant la mise en service des jetons.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo } from "../helpers/mongo.js";

vi.mock("stripe", () => {
  function StripeMock() {
    return { webhooks: { constructEvent: vi.fn() } };
  }
  return { default: StripeMock };
});

const stripeSession = vi.hoisted(() => ({ create: null }));
vi.mock("../../src/services/stripeConnectService.js", () => ({
  default: {
    createInvoicePaymentSession: (...args) => stripeSession.create(...args),
  },
}));

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.BETTER_AUTH_SECRET ??= "secret-de-test-liens";

import { redirectToInvoicePayment } from "../../src/controllers/invoicePaymentController.js";
import {
  buildInvoicePaymentUrl,
  invoicePaymentToken,
  resetPaymentLinkTokensSinceCache,
} from "../../src/utils/invoicePaymentLink.js";

const workspaceId = new mongoose.Types.ObjectId();
const invoiceId = new mongoose.Types.ObjectId();
// Facture créée avant la mise en service des liens signés
const ancienneId = mongoose.Types.ObjectId.createFromTime(
  Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
);

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.redirect = vi.fn().mockReturnValue(res);
  return res;
};

beforeAll(async () => {
  await startMongo();
  stripeSession.create = vi.fn(async () => ({
    success: true,
    sessionUrl: "https://checkout.stripe.test/session",
  }));
  const db = mongoose.connection.db;
  // Liens signés en service depuis une semaine (posé au démarrage de l'API)
  await db.collection("app_settings").insertOne({
    _id: "invoicePaymentLinkTokens",
    since: new Date(Date.now() - 7 * 24 * 3600 * 1000),
  });
  resetPaymentLinkTokensSinceCache();
  await db.collection("invoices").insertMany([
    {
      _id: invoiceId,
      workspaceId,
      status: "PENDING",
      number: "F-0001",
      finalTotalTTC: 120,
    },
    {
      _id: ancienneId,
      workspaceId,
      status: "PENDING",
      number: "F-0000",
      finalTotalTTC: 80,
    },
  ]);
  await db.collection("stripeconnectaccounts").insertOne({
    organizationId: workspaceId.toString(),
    accountId: "acct_test",
    chargesEnabled: true,
  });
});

afterAll(async () => {
  await stopMongo();
});

describe("GET /pay/invoice/:invoiceId", () => {
  beforeEach(() => stripeSession.create.mockClear());

  it("sans jeton : répond comme pour une facture inconnue, sans créer de session de paiement", async () => {
    const res = buildRes();
    await redirectToInvoicePayment(
      { params: { invoiceId: invoiceId.toString() }, query: {} },
      res,
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(stripeSession.create).not.toHaveBeenCalled();
  });

  it("jeton d'une autre facture, jeton modifié ou d'un autre type : 404", async () => {
    const autre = invoicePaymentToken(new mongoose.Types.ObjectId());
    const bon = invoicePaymentToken(invoiceId);
    for (const t of [autre, `${bon.slice(0, -1)}x`, ["a"], { $ne: null }, ""]) {
      const res = buildRes();
      await redirectToInvoicePayment(
        { params: { invoiceId: invoiceId.toString() }, query: { t } },
        res,
      );
      expect(res.status).toHaveBeenCalledWith(404);
    }
    expect(stripeSession.create).not.toHaveBeenCalled();
  });

  it("lien signé (e-mail, tableau de bord) : session de paiement, retour d'annulation signé", async () => {
    const url = new URL(buildInvoicePaymentUrl("https://api.test", invoiceId));
    const res = buildRes();
    await redirectToInvoicePayment(
      {
        params: { invoiceId: invoiceId.toString() },
        query: { t: url.searchParams.get("t") },
      },
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      303,
      "https://checkout.stripe.test/session",
    );
    const cancelUrl = stripeSession.create.mock.calls[0][3];
    expect(cancelUrl).toMatch(/\/cancel\?t=[A-Za-z0-9_-]{32}$/);
  });

  it("ancien lien sans jeton d'une facture créée avant les liens signés : toujours payable", async () => {
    const res = buildRes();
    await redirectToInvoicePayment(
      { params: { invoiceId: ancienneId.toString() }, query: {} },
      res,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      303,
      "https://checkout.stripe.test/session",
    );
  });
});
