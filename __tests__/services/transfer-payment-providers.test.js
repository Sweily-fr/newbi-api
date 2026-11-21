/**
 * Transferts payants : prestataires et déblocage.
 *
 * - PayPal : commande au bénéfice du compte du vendeur, capturée par l'API ;
 * - webhook des comptes connectés : seule une session du compte du vendeur
 *   débloque le transfert (un autre compte connecté ne peut pas payer chez
 *   lui-même le transfert d'un autre) ;
 * - second paiement d'un transfert déjà payé : remboursé ;
 * - « Marquer comme payé », moyens d'encaissement de l'espace, connexion
 *   d'un compte Stripe par OAuth.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

const stripeApi = vi.hoisted(() => ({
  checkout: {
    sessions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      expire: vi.fn(),
    },
  },
  refunds: { create: vi.fn() },
  accounts: { retrieve: vi.fn() },
  oauth: { token: vi.fn(), deauthorize: vi.fn() },
}));
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      return stripeApi;
    }
  },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const mailer = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));
vi.mock("../../src/utils/trialEmails.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendRenderedEmail: (...args) => mailer.send(...args),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import PaypalMerchantAccount from "../../src/models/PaypalMerchantAccount.js";
import {
  getBankTransferDetails,
  getPaymentConnections,
  markTransferPaidManually,
  prepareTransferPayment,
  refreshTransferPayment,
  startOnlinePayment,
} from "../../src/services/transferPaymentService.js";
import { resetPaypalTokenCache } from "../../src/services/paypalService.js";
import { saveOAuthConnection } from "../../src/services/stripeConnectService.js";
import { dispatchConnectEvent } from "../../src/controllers/stripeConnectWebhookController.js";

const fichier = {
  originalName: "photos.zip",
  fileName: "photos.zip",
  filePath: "https://r2.example/photos.zip",
  mimeType: "application/zip",
  size: 10,
};

const transfert = (extra = {}) =>
  FileTransfer.create({
    userId: new mongoose.Types.ObjectId(),
    workspaceId: new mongoose.Types.ObjectId().toString(),
    shareLink: `lien-${new mongoose.Types.ObjectId()}`,
    accessKey: "c".repeat(32),
    files: [fichier],
    expiryDate: new Date(Date.now() + 86_400_000),
    totalSize: 10,
    status: "active",
    isPaymentRequired: true,
    paymentAmount: 19.99,
    paymentCurrency: "EUR",
    paymentMethods: ["stripe", "paypal"],
    ...extra,
  });

const compteStripe = (t, extra = {}) =>
  StripeConnectAccount.create({
    organizationId: t.workspaceId,
    accountId: `acct_${t._id}`,
    connectionType: "oauth",
    chargesEnabled: true,
    ...extra,
  });

const sessionPayee = (t, extra = {}) => ({
  id: "cs_test_webhook",
  status: "complete",
  payment_status: "paid",
  amount_total: 1999,
  currency: "eur",
  payment_intent: "pi_test_webhook",
  customer_details: { email: "client@exemple.fr" },
  metadata: { type: "file_transfer", fileTransferId: String(t._id) },
  ...extra,
});

const evenement = (type, object, account) => ({
  id: `evt_${type}`,
  type,
  account,
  data: { object },
});

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
});

describe("webhook des comptes connectés", () => {
  it("session payée du compte du vendeur : transfert débloqué", async () => {
    const t = await transfert();
    await compteStripe(t);

    const result = await dispatchConnectEvent(
      evenement("checkout.session.completed", sessionPayee(t), `acct_${t._id}`),
    );

    expect(result.status).toBe("success");
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "stripe",
      paymentId: "pi_test_webhook",
    });
  });

  it("session payée sur un autre compte connecté : transfert non débloqué", async () => {
    const t = await transfert();
    await compteStripe(t);

    const result = await dispatchConnectEvent(
      evenement(
        "checkout.session.completed",
        sessionPayee(t),
        "acct_quelqu_un_d_autre",
      ),
    );

    expect(result.status).toBe("ignored");
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });

  it("second paiement d'un transfert déjà payé : remboursé sur le compte du vendeur", async () => {
    const t = await transfert({
      isPaid: true,
      paymentId: "pi_premier",
      paymentProvider: "stripe",
    });
    await compteStripe(t);

    await dispatchConnectEvent(
      evenement(
        "checkout.session.completed",
        sessionPayee(t, { payment_intent: "pi_second" }),
        `acct_${t._id}`,
      ),
    );

    expect(stripeApi.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_second",
        reason: "duplicate",
      }),
      expect.objectContaining({ stripeAccount: `acct_${t._id}` }),
    );
    // Le premier paiement reste celui du transfert
    expect((await FileTransfer.findById(t._id).lean()).paymentId).toBe(
      "pi_premier",
    );
  });

  it("événement rejoué : appliqué une seule fois, aucun remboursement", async () => {
    const t = await transfert();
    await compteStripe(t);
    const event = evenement(
      "checkout.session.completed",
      sessionPayee(t),
      `acct_${t._id}`,
    );

    await dispatchConnectEvent(event);
    await dispatchConnectEvent(event);

    expect(stripeApi.refunds.create).not.toHaveBeenCalled();
  });

  it("account.updated : état du compte tenu à jour", async () => {
    const t = await transfert();
    await compteStripe(t, { chargesEnabled: false });

    await dispatchConnectEvent(
      evenement("account.updated", {
        id: `acct_${t._id}`,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        email: "vendeur@exemple.fr",
        business_profile: { name: "Studio Photo" },
      }),
    );

    const compte = await StripeConnectAccount.findOne({
      accountId: `acct_${t._id}`,
    }).lean();
    expect(compte).toMatchObject({
      chargesEnabled: true,
      isOnboarded: true,
      displayName: "Studio Photo",
      accountEmail: "vendeur@exemple.fr",
    });
  });

  it("accès retiré depuis Stripe : connexion supprimée", async () => {
    const t = await transfert();
    await compteStripe(t);

    await dispatchConnectEvent(
      evenement("account.application.deauthorized", {}, `acct_${t._id}`),
    );

    expect(await StripeConnectAccount.countDocuments()).toBe(0);
  });
});

describe("PayPal", () => {
  const PAYEE = "vendeur@paypal.fr";
  let calls;

  const reponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  function stubPaypal(t, { captureStatus = "COMPLETED", customId } = {}) {
    calls = [];
    const unit = {
      custom_id: customId || String(t._id),
      amount: { currency_code: "EUR", value: "19.99" },
      payee: { email_address: PAYEE },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method || "GET", init });
        if (path === "/v1/oauth2/token") {
          return reponse({ access_token: "jeton", expires_in: 3600 });
        }
        if (path === "/v2/checkout/orders" && init.method === "POST") {
          return reponse({
            id: "ORDER123",
            status: "PAYER_ACTION_REQUIRED",
            links: [
              {
                rel: "payer-action",
                href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
              },
            ],
          });
        }
        if (path === "/v2/checkout/orders/ORDER123/capture") {
          return reponse({
            id: "ORDER123",
            status: captureStatus === "COMPLETED" ? "COMPLETED" : "COMPLETED",
            payer: { email_address: "client@exemple.fr" },
            purchase_units: [
              {
                ...unit,
                payments: {
                  captures: [
                    {
                      id: "CAPTURE1",
                      status: captureStatus,
                      amount: { currency_code: "EUR", value: "19.99" },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (path === "/v2/checkout/orders/ORDER123") {
          return reponse({
            id: "ORDER123",
            status: "APPROVED",
            purchase_units: [unit],
          });
        }
        if (path === "/v2/payments/captures/CAPTURE1") {
          return reponse({
            id: "CAPTURE1",
            status: "COMPLETED",
            custom_id: String(t._id),
            amount: { currency_code: "EUR", value: "19.99" },
          });
        }
        return reponse({ name: "NOT_FOUND" }, 404);
      }),
    );
  }

  beforeEach(() => {
    process.env.PAYPAL_CLIENT_ID = "client-test";
    process.env.PAYPAL_CLIENT_SECRET = "secret-test";
    resetPaypalTokenCache();
  });

  afterEach(() => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    vi.unstubAllGlobals();
  });

  it("commande créée au bénéfice du compte PayPal du vendeur", async () => {
    const t = await transfert();
    await PaypalMerchantAccount.create({
      organizationId: t.workspaceId,
      email: PAYEE,
    });
    stubPaypal(t);

    const res = await startOnlinePayment(t, "paypal");

    expect(res).toMatchObject({
      success: true,
      sessionUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
    });
    const creation = calls.find((c) => c.path === "/v2/checkout/orders");
    const body = JSON.parse(creation.init.body);
    expect(body.purchase_units[0].payee).toEqual({ email_address: PAYEE });
    expect(body.purchase_units[0].amount).toEqual({
      currency_code: "EUR",
      value: "19.99",
    });
    expect(body.purchase_units[0].custom_id).toBe(String(t._id));
    const retour = body.payment_source.paypal.experience_context.return_url;
    expect(retour).toContain("provider=paypal");
    expect(retour).not.toContain(t.accessKey);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.paymentAttempt).toMatchObject({
      provider: "paypal",
      reference: "ORDER123",
    });
  });

  it("commande approuvée : capturée au retour, transfert débloqué", async () => {
    const t = await transfert({
      paymentAttempt: {
        provider: "paypal",
        reference: "ORDER123",
        status: "open",
      },
    });
    stubPaypal(t);

    const res = await refreshTransferPayment(t, {
      force: true,
      provider: "paypal",
      orderId: "ORDER123",
    });

    expect(res.status).toBe("paid");
    expect(calls.some((c) => c.path.endsWith("/capture"))).toBe(true);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "paypal",
      paymentId: "CAPTURE1",
      payerEmail: "client@exemple.fr",
    });
  });

  it("capture en attente chez PayPal : débloqué quand elle aboutit", async () => {
    const t = await transfert({
      paymentAttempt: {
        provider: "paypal",
        reference: "ORDER123",
        status: "open",
      },
    });
    stubPaypal(t, { captureStatus: "PENDING" });

    const premier = await refreshTransferPayment(t, {
      force: true,
      orderId: "ORDER123",
    });
    expect(premier.status).toBe("pending");
    let relu = await FileTransfer.findById(t._id);
    expect(relu.paymentAttempt).toMatchObject({
      status: "pending",
      captureId: "CAPTURE1",
    });

    // Visite suivante (après l'intervalle de vérification)
    relu.paymentAttempt.checkedAt = new Date(Date.now() - 60_000);
    await relu.save();
    const second = await refreshTransferPayment(relu);
    expect(second.status).toBe("paid");
    relu = await FileTransfer.findById(t._id).lean();
    expect(relu.isPaid).toBe(true);
  });

  it("commande d'un autre transfert : jamais capturée", async () => {
    const t = await transfert({
      paymentAttempt: {
        provider: "paypal",
        reference: "ORDER123",
        status: "open",
      },
    });
    stubPaypal(t, { customId: new mongoose.Types.ObjectId().toString() });

    const res = await refreshTransferPayment(t, {
      force: true,
      orderId: "ORDER123",
    });

    expect(res.status).toBe("unpaid");
    expect(calls.some((c) => c.path.endsWith("/capture"))).toBe(false);
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });
});

describe("Marquer comme payé", () => {
  it("débloque sans prévenir le vendeur et ferme la session Stripe ouverte", async () => {
    const t = await transfert({
      paymentAttempt: {
        provider: "stripe",
        reference: "cs_test_ouverte",
        accountId: "acct_vendeur",
        status: "open",
      },
    });
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_ouverte",
      status: "open",
    });
    const vendeur = new mongoose.Types.ObjectId();

    const res = await markTransferPaidManually(t, vendeur);

    expect(res.status).toBe("paid");
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "manual",
      paidAmount: 19.99,
    });
    expect(String(relu.paymentMarkedBy)).toBe(String(vendeur));
    expect(mailer.send).not.toHaveBeenCalled();
    expect(stripeApi.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_test_ouverte",
      { stripeAccount: "acct_vendeur" },
    );
  });
});

describe("moyens d'encaissement de l'espace", () => {
  const organisation = async (fields = {}) => {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db
      .collection("organization")
      .insertOne({ _id, name: "Espace", ...fields });
    return _id.toString();
  };

  it("ancien compte Express : connecté mais pas prêt pour les transferts", async () => {
    const ws = await organisation();
    await StripeConnectAccount.create({
      organizationId: ws,
      accountId: "acct_express",
      chargesEnabled: true,
    });

    const { stripe } = await getPaymentConnections(ws);

    expect(stripe).toMatchObject({
      connected: true,
      ready: false,
      legacy: true,
    });
  });

  it("compte du client par OAuth, PayPal non configuré, IBAN renseigné", async () => {
    const ws = await organisation({
      bankIban: "FR76 3000 6000 0112 3456 7890 189",
    });
    await StripeConnectAccount.create({
      organizationId: ws,
      accountId: "acct_oauth",
      connectionType: "oauth",
      chargesEnabled: true,
      displayName: "Studio",
    });

    const connections = await getPaymentConnections(ws);

    expect(connections.stripe).toMatchObject({
      ready: true,
      legacy: false,
      displayName: "Studio",
    });
    expect(connections.paypal.available).toBe(false);
    expect(connections.bankTransfer).toEqual({
      available: true,
      ibanLast4: "0189",
    });
  });

  it("virement : référence générée, coordonnées montrées tant que non payé", async () => {
    const ws = await organisation({
      companyName: "Studio Photo",
      bankIban: "FR7630006000011234567890189",
      bankBic: "AGRIFRPP",
    });
    const { paymentMethods, paymentReference } = await prepareTransferPayment({
      workspaceId: ws,
      isPaymentRequired: true,
      paymentMethods: ["bank_transfer"],
    });
    expect(paymentMethods).toEqual(["bank_transfer"]);
    expect(paymentReference).toMatch(/^NB-[A-HJ-NP-Z2-9]{6}$/);

    const t = await transfert({
      workspaceId: ws,
      paymentMethods,
      paymentReference,
    });
    expect(await getBankTransferDetails(t)).toEqual({
      holder: "Studio Photo",
      iban: "FR76 3000 6000 0112 3456 7890 189",
      bic: "AGRIFRPP",
      bankName: null,
      reference: paymentReference,
    });

    t.isPaid = true;
    expect(await getBankTransferDetails(t)).toBeNull();
  });
});

describe("connexion d'un compte Stripe par OAuth", () => {
  beforeEach(() => {
    stripeApi.accounts.retrieve.mockResolvedValue({
      id: "acct_client",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      email: "client@exemple.fr",
      settings: { dashboard: { display_name: "Studio Photo" } },
    });
  });

  it("remplace l'ancien compte Express de l'espace (gardé en trace)", async () => {
    const ws = new mongoose.Types.ObjectId().toString();
    await StripeConnectAccount.create({
      organizationId: ws,
      accountId: "acct_express",
      chargesEnabled: true,
    });

    const saved = await saveOAuthConnection({
      organizationId: ws,
      userId: new mongoose.Types.ObjectId(),
      accountId: "acct_client",
      livemode: false,
    });

    expect(saved.ok).toBe(true);
    const comptes = await StripeConnectAccount.find().lean();
    expect(comptes).toHaveLength(1);
    expect(comptes[0]).toMatchObject({
      organizationId: ws,
      accountId: "acct_client",
      connectionType: "oauth",
      replacedAccountId: "acct_express",
      displayName: "Studio Photo",
      chargesEnabled: true,
    });
  });

  it("compte déjà rattaché à un autre espace : refusé", async () => {
    await StripeConnectAccount.create({
      organizationId: new mongoose.Types.ObjectId().toString(),
      accountId: "acct_client",
      connectionType: "oauth",
    });

    const saved = await saveOAuthConnection({
      organizationId: new mongoose.Types.ObjectId().toString(),
      accountId: "acct_client",
    });

    expect(saved).toEqual({ ok: false, error: "already_connected" });
  });
});
