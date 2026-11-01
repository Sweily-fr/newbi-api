/**
 * Transfert payant : session de paiement et jeton de retour.
 *
 * Le jeton de retour placé dans les URL de Stripe (succès comme annulation)
 * ramène au transfert : consumePaymentReturnToken renvoie son lien et sa clé
 * d'accès. Il ne doit donc être remis qu'à qui détient déjà la clé : sans
 * elle, n'importe qui connaissant l'identifiant d'un transfert payant
 * obtenait lien et clé en abandonnant le paiement.
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
      create: vi.fn(async () => ({
        id: "cs_test_1",
        url: "https://checkout.stripe.test/cs_test_1",
      })),
    },
  },
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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import FileTransfer from "../../src/models/FileTransfer.js";
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
    shareLink: `lien-${new mongoose.Types.ObjectId()}`,
    accessKey: "c".repeat(32),
    files: [fichier],
    expiryDate: new Date(Date.now() + 86_400_000),
    totalSize: 10,
    status: "active",
    isPaymentRequired: true,
    paymentAmount,
    paymentCurrency: "EUR",
    ...extra,
  });

const session = (transfer, accessKey) =>
  Mutation.createPaymentSessionForFileTransfer(
    {},
    { transferId: transfer._id.toString(), accessKey },
    ctx(),
  );

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  stripeApi.checkout.sessions.create.mockClear();
});

const avecCompteStripe = (transfer) =>
  StripeConnectAccount.create({
    userId: transfer.userId,
    accountId: `acct_${transfer._id}`,
    chargesEnabled: true,
    isOnboarded: true,
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

  it("bonne clé : session créée, montant en centimes entiers", async () => {
    const t = await transfertPayant(19.99);
    await avecCompteStripe(t);

    const res = await session(t, "c".repeat(32));

    expect(res.success).toBe(true);
    expect(res.sessionUrl).toBe("https://checkout.stripe.test/cs_test_1");
    const [params] = stripeApi.checkout.sessions.create.mock.calls[0];
    const prix = params.line_items[0].price_data;
    expect(prix.unit_amount).toBe(1999);
    expect(Number.isInteger(params.payment_intent_data.application_fee_amount)).toBe(true);
    // La description vue par le payeur ne contient pas d'identifiant interne
    expect(prix.product_data.description).not.toContain(t.userId.toString());
    // Le jeton de retour est dans les deux URL, jamais le lien ni la clé
    expect(params.success_url).not.toContain(t.accessKey);
    expect(params.cancel_url).not.toContain(t.shareLink);
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

  it("transfert expiré : refusé même avec la bonne clé", async () => {
    const t = await transfertPayant(10, {
      expiryDate: new Date(Date.now() - 1000),
    });
    await avecCompteStripe(t);

    const res = await session(t, "c".repeat(32));

    expect(res.success).toBe(false);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("consumePaymentReturnToken", () => {
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
