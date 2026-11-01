/**
 * Lien public de paiement d'une facture : comportement attendu, NON
 * IMPLÉMENTÉ.
 *
 * Test ROUGE volontaire (décision produit en attente). GET /pay/invoice/:id
 * crée une session de paiement pour toute facture payable à partir de son
 * seul identifiant : la page de paiement affiche le numéro, le client et le
 * montant. Attendu : un lien porteur d'un jeton signé (celui des e-mails et
 * du tableau de bord), et sans jeton valide la même réponse qu'une facture
 * inconnue, sans session de paiement créée.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

import { redirectToInvoicePayment } from "../../src/controllers/invoicePaymentController.js";

const workspaceId = new mongoose.Types.ObjectId();
const invoiceId = new mongoose.Types.ObjectId();

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
  await db.collection("invoices").insertOne({
    _id: invoiceId,
    workspaceId,
    status: "PENDING",
    number: "F-0001",
    finalTotalTTC: 120,
  });
  await db.collection("stripeconnectaccounts").insertOne({
    organizationId: workspaceId.toString(),
    accountId: "acct_test",
    chargesEnabled: true,
  });
});

afterAll(async () => {
  await stopMongo();
});

describe("GET /pay/invoice/:invoiceId sans jeton", () => {
  // Défaut connu, en attente d'une décision : passe tant qu'il existe,
  // échoue le jour où il est corrigé (remettre alors `it`).
  it.fails("répond comme pour une facture inconnue, sans créer de session de paiement", async () => {
    const res = buildRes();
    await redirectToInvoicePayment(
      { params: { invoiceId: invoiceId.toString() }, query: {} },
      res,
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(stripeSession.create).not.toHaveBeenCalled();
  });
});
