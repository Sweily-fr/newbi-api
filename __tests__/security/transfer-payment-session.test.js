/**
 * Transfert payant : session de paiement, retour du payeur et jeton de retour.
 *
 * Le jeton de retour placé dans les URL de Stripe (succès comme annulation)
 * ramène au transfert : confirmTransferPayment (et l'ancien
 * consumePaymentReturnToken) renvoie son lien et sa clé d'accès. Il ne doit
 * donc être remis qu'à qui détient déjà la clé : sans elle, n'importe qui
 * connaissant l'identifiant d'un transfert payant obtenait lien et clé en
 * abandonnant le paiement.
 *
 * Le paiement est créé sur le compte Stripe de l'espace du transfert,
 * connecté par OAuth (compte du client) : sans commission ni passage par le
 * compte de Newbi. Le compte de l'auteur dans un autre espace, ou un ancien
 * compte Express, ne servent pas.
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

const stripeApi = vi.hoisted(() => ({
  checkout: {
    sessions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      expire: vi.fn(),
    },
  },
  refunds: { create: vi.fn() },
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
import { buildUserDoc } from "../factories/index.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import Notification from "../../src/models/Notification.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import stripeConnectResolvers from "../../src/resolvers/stripeConnectResolvers.js";

const { Mutation } = stripeConnectResolvers;

const fichier = {
  originalName: "plan.pdf",
  fileName: "plan.pdf",
  filePath: "https://r2.example/plan.pdf",
  mimeType: "application/pdf",
  size: 10,
};

let compteur = 0;
// Une IP par appel : le plafond par IP ne doit pas fausser les cas
const ctx = () => ({
  req: { headers: {}, ip: `10.0.0.${++compteur % 250}`, socket: {} },
});

const transfertPayant = (paymentAmount = 19.99, extra = {}) =>
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
    paymentAmount,
    paymentCurrency: "EUR",
    paymentMethods: ["stripe"],
    ...extra,
  });

const session = (transfer, accessKey, provider) =>
  Mutation.createPaymentSessionForFileTransfer(
    {},
    { transferId: transfer._id.toString(), accessKey, provider },
    ctx(),
  );

const compteDe = (transfer) => `acct_${transfer._id}`;

// Compte Stripe du client, connecté par OAuth à l'espace du transfert
const avecCompteStripe = (transfer, extra = {}) =>
  StripeConnectAccount.create({
    organizationId: transfer.workspaceId,
    userId: transfer.userId,
    accountId: compteDe(transfer),
    connectionType: "oauth",
    chargesEnabled: true,
    isOnboarded: true,
    ...extra,
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
  stripeApi.checkout.sessions.create.mockImplementation(async () => ({
    id: "cs_test_1",
    url: "https://checkout.stripe.test/cs_test_1",
  }));
});

describe("createPaymentSessionForFileTransfer : clé d'accès exigée", () => {
  it("sans clé : refusé, aucun jeton de retour ni session Stripe", async () => {
    const t = await transfertPayant();
    await avecCompteStripe(t);

    const res = await session(t, undefined);

    expect(res.success).toBe(false);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.paymentReturnToken ?? null).toBeNull();
  });

  it("mauvaise clé : refusé sans jeton de retour", async () => {
    const t = await transfertPayant();
    await avecCompteStripe(t);

    const res = await session(t, "x".repeat(32));

    expect(res.success).toBe(false);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.paymentReturnToken ?? null).toBeNull();
  });

  it("transfert inconnu, identifiant mal formé ou mauvaise clé : même réponse", async () => {
    const t = await transfertPayant();
    const mauvaiseCle = await session(t, "x".repeat(32));
    const inconnu = await Mutation.createPaymentSessionForFileTransfer(
      {},
      {
        transferId: new mongoose.Types.ObjectId().toString(),
        accessKey: "c".repeat(32),
      },
      ctx(),
    );
    const malForme = await Mutation.createPaymentSessionForFileTransfer(
      {},
      { transferId: "pas-un-identifiant", accessKey: "c".repeat(32) },
      ctx(),
    );
    expect(inconnu).toEqual(mauvaiseCle);
    expect(malForme).toEqual(mauvaiseCle);
  });

  it("bonne clé : session créée sur le compte du vendeur, sans commission", async () => {
    const t = await transfertPayant(19.99);
    await avecCompteStripe(t);

    const res = await session(t, "c".repeat(32));

    expect(res.success).toBe(true);
    expect(res.sessionUrl).toBe("https://checkout.stripe.test/cs_test_1");
    const [params, options] = stripeApi.checkout.sessions.create.mock.calls[0];
    // Paiement direct sur le compte du client : rien ne passe par Newbi
    expect(options.stripeAccount).toBe(compteDe(t));
    expect(params.payment_intent_data.application_fee_amount).toBeUndefined();
    expect(params.payment_intent_data.transfer_data).toBeUndefined();
    const prix = params.line_items[0].price_data;
    expect(prix.unit_amount).toBe(1999);
    // La description vue par le payeur ne contient pas d'identifiant interne
    expect(prix.product_data.description).not.toContain(t.userId.toString());
    // Le jeton de retour est dans les deux URL, jamais le lien ni la clé
    expect(params.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect(params.success_url).toContain("provider=stripe");
    expect(params.success_url).not.toContain(t.accessKey);
    expect(params.cancel_url).not.toContain(t.shareLink);
    expect(params.cancel_url).toContain("canceled=1");
    // Session gardée pour vérifier le paiement plus tard
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.paymentAttempt).toMatchObject({
      provider: "stripe",
      reference: "cs_test_1",
      accountId: compteDe(t),
      status: "open",
    });
    expect(relu.paymentReturnToken).toMatch(/^[a-f0-9]{32}$/);
    expect(params.success_url).toContain(`rt=${relu.paymentReturnToken}`);
  });

  it.each([
    [0.29, 29],
    [4.35, 435],
    [0.5, 50],
  ])("montant %s € : %s centimes", async (montant, centimes) => {
    const t = await transfertPayant(montant);
    await avecCompteStripe(t);

    await session(t, "c".repeat(32));

    const [params] = stripeApi.checkout.sessions.create.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(centimes);
  });

  it("compte Stripe de l'auteur dans un autre espace : non utilisé", async () => {
    const t = await transfertPayant();
    await StripeConnectAccount.create({
      organizationId: new mongoose.Types.ObjectId().toString(),
      userId: t.userId,
      accountId: "acct_autre_espace",
      connectionType: "oauth",
      chargesEnabled: true,
    });

    const res = await session(t, "c".repeat(32));

    expect(res.success).toBe(false);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("ancien compte Express de l'espace : carte indisponible", async () => {
    const t = await transfertPayant();
    await avecCompteStripe(t, { connectionType: "express" });

    const res = await session(t, "c".repeat(32));

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/carte n'est pas disponible/);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("transfert expiré ou supprimé : refusé même avec la bonne clé", async () => {
    const expire = await transfertPayant(10, {
      expiryDate: new Date(Date.now() - 1000),
    });
    const supprime = await transfertPayant(10, { status: "deleted" });
    await avecCompteStripe(expire);
    await avecCompteStripe(supprime);

    expect((await session(expire, "c".repeat(32))).success).toBe(false);
    expect((await session(supprime, "c".repeat(32))).success).toBe(false);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("moyen non proposé par le transfert : refusé", async () => {
    const t = await transfertPayant(10, { paymentMethods: ["bank_transfer"] });
    await avecCompteStripe(t);

    const carte = await session(t, "c".repeat(32), "stripe");
    const paypal = await session(t, "c".repeat(32), "paypal");

    expect(carte.success).toBe(false);
    expect(paypal.success).toBe(false);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("confirmTransferPayment : retour du payeur", () => {
  const confirmer = (args) => Mutation.confirmTransferPayment({}, args);

  // Transfert dont le paiement a été lancé (jeton de retour, session)
  async function transfertEnPaiement(extra = {}) {
    const owner = buildUserDoc({ email: "vendeur@exemple.fr" });
    await mongoose.connection.db.collection("user").insertOne(owner);
    const t = await transfertPayant(19.99, { userId: owner._id, ...extra });
    await avecCompteStripe(t);
    await session(t, "c".repeat(32));
    const relu = await FileTransfer.findById(t._id);
    return { t: relu, token: relu.paymentReturnToken, owner };
  }

  const sessionPayee = (t, extra = {}) => ({
    id: "cs_test_1",
    status: "complete",
    payment_status: "paid",
    amount_total: 1999,
    currency: "eur",
    payment_intent: "pi_test_1",
    customer_details: { email: "client@exemple.fr" },
    metadata: { type: "file_transfer", fileTransferId: String(t._id) },
    ...extra,
  });

  it("jeton inconnu ou mal formé : ni lien ni clé", async () => {
    const inconnu = await confirmer({ token: "a".repeat(32) });
    const malForme = await confirmer({ token: "pas-un-jeton" });
    for (const res of [inconnu, malForme]) {
      expect(res.success).toBe(false);
      expect(res.shareLink ?? null).toBeNull();
      expect(res.accessKey ?? null).toBeNull();
    }
  });

  it("session payée sur le compte du vendeur : transfert débloqué, vendeur prévenu une fois", async () => {
    const { t, token, owner } = await transfertEnPaiement();
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(sessionPayee(t));

    const res = await confirmer({
      token,
      provider: "stripe",
      sessionId: "cs_test_1",
    });

    expect(res).toMatchObject({
      success: true,
      status: "paid",
      shareLink: t.shareLink,
      accessKey: t.accessKey,
    });
    // Session relue sur le compte du vendeur
    expect(stripeApi.checkout.sessions.retrieve).toHaveBeenCalledWith(
      "cs_test_1",
      { stripeAccount: compteDe(t) },
    );
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "stripe",
      paymentId: "pi_test_1",
      paidAmount: 19.99,
      paidCurrency: "EUR",
      payerEmail: "client@exemple.fr",
    });
    const notifications = await Notification.find({
      userId: owner._id,
    }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("TRANSFER_PAID");
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send.mock.calls[0][0].to).toBe("vendeur@exemple.fr");

    // Rechargement de la page de retour : même réponse, rien en double
    const encore = await confirmer({
      token,
      provider: "stripe",
      sessionId: "cs_test_1",
    });
    expect(encore.status).toBe("paid");
    expect(await Notification.countDocuments({ userId: owner._id })).toBe(1);
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });

  it("session d'un autre montant : transfert non débloqué", async () => {
    const { t, token } = await transfertEnPaiement();
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      sessionPayee(t, { amount_total: 50 }),
    );

    const res = await confirmer({
      token,
      provider: "stripe",
      sessionId: "cs_test_1",
    });

    expect(res.status).toBe("unpaid");
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });

  it("session d'un autre transfert : transfert non débloqué", async () => {
    const { t, token } = await transfertEnPaiement();
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      sessionPayee(t, {
        metadata: {
          type: "file_transfer",
          fileTransferId: new mongoose.Types.ObjectId().toString(),
        },
      }),
    );

    const res = await confirmer({
      token,
      provider: "stripe",
      sessionId: "cs_test_1",
    });

    expect(res.status).toBe("unpaid");
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });

  it("paiement différé (prélèvement) : en attente, lien et clé renvoyés", async () => {
    const { t, token } = await transfertEnPaiement();
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      sessionPayee(t, { payment_status: "unpaid" }),
    );

    const res = await confirmer({
      token,
      provider: "stripe",
      sessionId: "cs_test_1",
    });

    expect(res).toMatchObject({
      success: true,
      status: "pending",
      shareLink: t.shareLink,
    });
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.isPaid).toBe(false);
    expect(relu.paymentAttempt.status).toBe("pending");
  });

  it("paiement annulé : non payé, lien et clé renvoyés pour revenir au transfert", async () => {
    const { t, token } = await transfertEnPaiement();
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      sessionPayee(t, { status: "open", payment_status: "unpaid" }),
    );

    const res = await confirmer({ token, provider: "stripe" });

    expect(res).toMatchObject({
      success: true,
      status: "unpaid",
      shareLink: t.shareLink,
      accessKey: t.accessKey,
    });
  });

  it("jeton expiré : ni lien ni clé", async () => {
    const { t, token } = await transfertEnPaiement();
    await FileTransfer.updateOne(
      { _id: t._id },
      { $set: { paymentReturnTokenExpiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await confirmer({ token, provider: "stripe" });

    expect(res.success).toBe(false);
    expect(res.shareLink ?? null).toBeNull();
  });
});

describe("consumePaymentReturnToken (anciens retours)", () => {
  const consommer = (token) =>
    Mutation.consumePaymentReturnToken({}, { token });

  it("jeton valide : lien et clé renvoyés une seule fois", async () => {
    const t = await transfertPayant(10, {
      paymentReturnToken: "jeton-valide",
      paymentReturnTokenExpiresAt: new Date(Date.now() + 60_000),
      paymentReturnTokenConsumed: false,
    });

    const premier = await consommer("jeton-valide");
    expect(premier).toMatchObject({
      success: true,
      shareLink: t.shareLink,
      accessKey: t.accessKey,
      paymentStatus: "pending",
    });

    const second = await consommer("jeton-valide");
    expect(second.success).toBe(false);
    expect(second.message).toBe("Invalid or already used token");
    expect(second.shareLink ?? null).toBeNull();
    expect(second.accessKey ?? null).toBeNull();
  });

  it("jeton expiré : ni lien ni clé", async () => {
    await transfertPayant(10, {
      paymentReturnToken: "jeton-expire",
      paymentReturnTokenExpiresAt: new Date(Date.now() - 60_000),
      paymentReturnTokenConsumed: false,
    });

    const res = await consommer("jeton-expire");
    expect(res.success).toBe(false);
    expect(res.message).toBe("Token expired");
    expect(res.shareLink ?? null).toBeNull();
    expect(res.accessKey ?? null).toBeNull();
  });

  it("jeton inconnu : ni lien ni clé", async () => {
    const res = await consommer("jeton-inconnu");
    expect(res.success).toBe(false);
    expect(res.shareLink ?? null).toBeNull();
  });
});
