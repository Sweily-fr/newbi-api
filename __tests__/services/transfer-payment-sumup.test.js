/**
 * Transferts payants : carte avec SumUp.
 *
 * - paiement (checkout) créé sur le compte marchand SumUp du vendeur, page de
 *   paiement hébergée par SumUp, rien dans l'adresse de retour qui ouvre le
 *   transfert ;
 * - déblocage après relecture du paiement auprès de SumUp : référence du
 *   transfert, compte du vendeur, montant et devise contrôlés ;
 * - notification de SumUp (non signée) : simple déclencheur de relecture ;
 * - jeton d'accès renouvelé, accès retiré côté SumUp : compte à reconnecter ;
 * - devise du compte marchand, second paiement remboursé, « Marquer comme
 *   payé » qui ferme le paiement ouvert.
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

vi.hoisted(() => {
  process.env.DATA_ENCRYPTION_KEY ||= "cle-de-test-sumup";
});
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      return {
        checkout: { sessions: { retrieve: vi.fn(), expire: vi.fn() } },
        refunds: { create: vi.fn() },
      };
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
import SumupMerchantAccount from "../../src/models/SumupMerchantAccount.js";
import { decrypt, encrypt } from "../../src/utils/encryption.js";
import {
  getPaymentConnections,
  handleSumupNotification,
  markTransferPaidManually,
  prepareTransferPayment,
  refreshTransferPayment,
  startOnlinePayment,
  sweepOpenTransferPayments,
} from "../../src/services/transferPaymentService.js";
import {
  buildSumupOAuthUrl,
  saveSumupConnection,
  tokenAllowsPayments,
} from "../../src/services/sumupService.js";

const MARCHAND = "MCODE123";
const CHECKOUT = "4e425463-3e1b-431d-83fa-1e51c2925e99";

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
    paymentMethods: ["sumup"],
    ...extra,
  });

const compteSumup = (workspaceId, extra = {}) =>
  SumupMerchantAccount.create({
    organizationId: String(workspaceId),
    merchantCode: MARCHAND,
    businessName: "Studio Lumière",
    email: "studio@exemple.fr",
    currency: "EUR",
    accessToken: encrypt("jeton-acces"),
    accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    refreshToken: encrypt("jeton-renouvellement"),
    scope: "payments user.profile_readonly",
    status: "active",
    ...extra,
  });

const reponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === null ? "" : JSON.stringify(body)),
});

let calls;
let checkoutState;

/** Faux SumUp : création, lecture, fermeture, remboursement, jetons. */
function stubSumup(t, overrides = {}) {
  calls = [];
  checkoutState = {
    id: CHECKOUT,
    status: "PENDING",
    checkout_reference: null,
    merchant_code: MARCHAND,
    amount: 19.99,
    currency: "EUR",
    transactions: [],
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      const { pathname } = new URL(url);
      const method = init.method || "GET";
      calls.push({ path: pathname, method, init });
      if (pathname === "/token") {
        if (overrides.tokenError) {
          return reponse(
            { error: "invalid_grant", error_description: "expired" },
            400,
          );
        }
        return reponse({
          access_token: "jeton-neuf",
          refresh_token: "renouvellement-neuf",
          expires_in: 3600,
          scope: "payments user.profile_readonly",
        });
      }
      if (pathname === "/v0.1/checkouts" && method === "POST") {
        const body = JSON.parse(init.body);
        checkoutState.checkout_reference = body.checkout_reference;
        return reponse({
          ...checkoutState,
          hosted_checkout_url: `https://checkout.sumup.com/pay/${CHECKOUT}`,
        });
      }
      if (pathname === `/v0.1/checkouts/${CHECKOUT}` && method === "GET") {
        return reponse(checkoutState);
      }
      if (pathname === `/v0.1/checkouts/${CHECKOUT}` && method === "DELETE") {
        return reponse({ ...checkoutState, status: "EXPIRED" });
      }
      if (pathname.startsWith("/v0.1/me/refund/") && method === "POST") {
        return reponse(null, 204);
      }
      return reponse({ message: "Not found" }, 404);
    }),
  );
}

const paye = (t, extra = {}) => ({
  status: "PAID",
  checkout_reference: `newbi-${t._id}-abcdef123456`,
  transactions: [
    {
      id: "txn-1",
      transaction_code: "TCODE1",
      status: "SUCCESSFUL",
      amount: 19.99,
    },
  ],
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
  process.env.SUMUP_CLIENT_ID = "client-sumup";
  process.env.SUMUP_CLIENT_SECRET = "secret-sumup";
});

afterEach(() => {
  delete process.env.SUMUP_CLIENT_ID;
  delete process.env.SUMUP_CLIENT_SECRET;
  vi.unstubAllGlobals();
});

describe("lancement du paiement SumUp", () => {
  it("checkout créé sur le compte du vendeur, page hébergée par SumUp", async () => {
    const t = await transfert();
    await compteSumup(t.workspaceId);
    stubSumup(t);

    const res = await startOnlinePayment(t, "sumup");

    expect(res).toMatchObject({
      success: true,
      sessionId: CHECKOUT,
      sessionUrl: `https://checkout.sumup.com/pay/${CHECKOUT}`,
    });
    const creation = calls.find((c) => c.path === "/v0.1/checkouts");
    expect(creation.init.headers.Authorization).toBe("Bearer jeton-acces");
    const body = JSON.parse(creation.init.body);
    expect(body).toMatchObject({
      amount: 19.99,
      currency: "EUR",
      merchant_code: MARCHAND,
      hosted_checkout: { enabled: true },
    });
    expect(body.checkout_reference).toMatch(
      new RegExp(`^newbi-${t._id}-[a-f0-9]{12}$`),
    );
    expect(body.redirect_url).toContain("/transfer/return?rt=");
    expect(body.redirect_url).toContain("provider=sumup");
    expect(body.redirect_url).not.toContain(t.accessKey);
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.paymentAttempt).toMatchObject({
      provider: "sumup",
      reference: CHECKOUT,
      accountId: MARCHAND,
      status: "open",
    });
  });

  it("SumUp non proposé par le transfert : refusé sans appel à SumUp", async () => {
    const t = await transfert({ paymentMethods: ["bank_transfer"] });
    await compteSumup(t.workspaceId);
    stubSumup(t);

    const res = await startOnlinePayment(t, "sumup");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/SumUp n'est pas proposé/);
    expect(calls).toHaveLength(0);
  });

  it("jeton expiré : renouvelé (chiffré en base) avant de créer le paiement", async () => {
    const t = await transfert();
    await compteSumup(t.workspaceId, {
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    stubSumup(t);

    const res = await startOnlinePayment(t, "sumup");

    expect(res.success).toBe(true);
    const renouvellement = calls.find((c) => c.path === "/token");
    expect(renouvellement.init.body).toContain("grant_type=refresh_token");
    expect(renouvellement.init.body).toContain(
      "refresh_token=jeton-renouvellement",
    );
    const creation = calls.find((c) => c.path === "/v0.1/checkouts");
    expect(creation.init.headers.Authorization).toBe("Bearer jeton-neuf");
    const compte = await SumupMerchantAccount.findOne().lean();
    expect(compte.accessToken).not.toContain("jeton-neuf");
    expect(decrypt(compte.accessToken)).toBe("jeton-neuf");
    expect(decrypt(compte.refreshToken)).toBe("renouvellement-neuf");
  });

  it("accès retiré côté SumUp : compte à reconnecter, paiement indisponible", async () => {
    const t = await transfert();
    await compteSumup(t.workspaceId, {
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    stubSumup(t, { tokenError: true });

    const res = await startOnlinePayment(t, "sumup");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/SumUp n'est pas disponible/);
    const compte = await SumupMerchantAccount.findOne().lean();
    expect(compte.status).toBe("reconnect");
    const connexions = await getPaymentConnections(t.workspaceId);
    expect(connexions.sumup).toMatchObject({
      connected: true,
      needsReconnect: true,
    });
  });
});

describe("vérification du paiement SumUp", () => {
  const tentative = () => ({
    provider: "sumup",
    reference: CHECKOUT,
    accountId: MARCHAND,
    status: "open",
  });

  it("paiement payé : transfert débloqué, vendeur prévenu", async () => {
    const t = await transfert();
    await t.updateOne({ paymentAttempt: tentative(t) });
    await compteSumup(t.workspaceId);
    const courant = await FileTransfer.findById(t._id);
    stubSumup(courant, paye(courant));

    const res = await refreshTransferPayment(courant, {
      force: true,
      provider: "sumup",
    });

    expect(res.status).toBe("paid");
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu).toMatchObject({
      isPaid: true,
      paymentProvider: "sumup",
      paymentId: CHECKOUT,
      paidAmount: 19.99,
      paidCurrency: "EUR",
    });
  });

  it("paiement d'un autre transfert : jamais appliqué", async () => {
    const t = await transfert();
    await t.updateOne({ paymentAttempt: tentative(t) });
    await compteSumup(t.workspaceId);
    const courant = await FileTransfer.findById(t._id);
    stubSumup(
      courant,
      paye(courant, {
        checkout_reference: `newbi-${new mongoose.Types.ObjectId()}-abcdef123456`,
      }),
    );

    const res = await refreshTransferPayment(courant, { force: true });

    expect(res.status).toBe("unpaid");
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });

  it("montant différent : non appliqué", async () => {
    const t = await transfert();
    await t.updateOne({ paymentAttempt: tentative(t) });
    await compteSumup(t.workspaceId);
    const courant = await FileTransfer.findById(t._id);
    stubSumup(courant, paye(courant, { amount: 1 }));

    const res = await refreshTransferPayment(courant, { force: true });

    expect(res.status).toBe("unpaid");
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(false);
  });

  it("paiement échoué : tentative marquée en échec, transfert verrouillé", async () => {
    const t = await transfert();
    await t.updateOne({ paymentAttempt: tentative(t) });
    await compteSumup(t.workspaceId);
    const courant = await FileTransfer.findById(t._id);
    stubSumup(courant, {
      status: "FAILED",
      checkout_reference: `newbi-${t._id}-abcdef123456`,
    });

    const res = await refreshTransferPayment(courant, { force: true });

    expect(res.status).toBe("unpaid");
    const relu = await FileTransfer.findById(t._id).lean();
    expect(relu.isPaid).toBe(false);
    expect(relu.paymentAttempt.status).toBe("failed");
  });

  it("notification de SumUp : paiement relu puis transfert débloqué", async () => {
    const t = await transfert();
    await t.updateOne({ paymentAttempt: tentative(t) });
    await compteSumup(t.workspaceId);
    stubSumup(t, paye(t));

    const res = await handleSumupNotification({
      event_type: "CHECKOUT_STATUS_CHANGED",
      id: CHECKOUT,
    });

    expect(res.status).toBe("paid");
    expect(calls.some((c) => c.path === `/v0.1/checkouts/${CHECKOUT}`)).toBe(
      true,
    );
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(true);
  });

  it("notification d'un paiement inconnu : ignorée sans appel à SumUp", async () => {
    stubSumup({ _id: "x" });

    const res = await handleSumupNotification({
      event_type: "CHECKOUT_STATUS_CHANGED",
      id: "11111111-2222-3333-4444-555555555555",
    });

    expect(res.status).toBe("ignored");
    expect(calls).toHaveLength(0);
  });

  it("second paiement d'un transfert déjà payé : remboursé sur le compte SumUp", async () => {
    const t = await transfert({
      isPaid: true,
      paymentProvider: "sumup",
      paymentId: "autre-checkout",
    });
    await t.updateOne({
      paymentAttempt: tentative(t),
      isPaid: false,
    });
    await compteSumup(t.workspaceId);
    const courant = await FileTransfer.findById(t._id);
    stubSumup(courant, paye(courant));
    // Payé entre-temps par un autre paiement
    await FileTransfer.updateOne({ _id: t._id }, { $set: { isPaid: true } });

    await refreshTransferPayment(courant, { force: true });

    expect(
      calls.some(
        (c) => c.path === "/v0.1/me/refund/txn-1" && c.method === "POST",
      ),
    ).toBe(true);
  });

  it("« Marquer comme payé » ferme le paiement SumUp encore ouvert", async () => {
    const t = await transfert();
    await t.updateOne({ paymentAttempt: tentative(t) });
    await compteSumup(t.workspaceId);
    const courant = await FileTransfer.findById(t._id);
    stubSumup(courant);

    await markTransferPaidManually(courant, new mongoose.Types.ObjectId());

    expect(
      calls.some(
        (c) =>
          c.path === `/v0.1/checkouts/${CHECKOUT}` && c.method === "DELETE",
      ),
    ).toBe(true);
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(true);
  });
});

describe("moyens d'encaissement avec SumUp", () => {
  it("SumUp non configuré côté Newbi : indisponible", async () => {
    delete process.env.SUMUP_CLIENT_ID;
    const workspaceId = new mongoose.Types.ObjectId().toString();
    await compteSumup(workspaceId);

    const connexions = await getPaymentConnections(workspaceId);

    expect(connexions.sumup).toMatchObject({
      available: false,
      connected: true,
    });
  });

  it("compte connecté : nom, devise, rien de secret", async () => {
    const workspaceId = new mongoose.Types.ObjectId().toString();
    await compteSumup(workspaceId);

    const connexions = await getPaymentConnections(workspaceId);

    expect(connexions.sumup).toEqual({
      available: true,
      connected: true,
      needsReconnect: false,
      businessName: "Studio Lumière",
      email: "studio@exemple.fr",
      merchantCode: MARCHAND,
      currency: "EUR",
    });
  });

  it("transfert dans une autre devise que celle du compte SumUp : refusé", async () => {
    const workspaceId = new mongoose.Types.ObjectId().toString();
    await compteSumup(workspaceId);

    await expect(
      prepareTransferPayment({
        workspaceId,
        isPaymentRequired: true,
        paymentMethods: ["sumup"],
        paymentCurrency: "USD",
        hasWatermark: false,
      }),
    ).rejects.toThrow(/uniquement en EUR/);

    await expect(
      prepareTransferPayment({
        workspaceId,
        isPaymentRequired: true,
        paymentMethods: ["sumup"],
        paymentCurrency: "EUR",
        hasWatermark: false,
      }),
    ).resolves.toMatchObject({ paymentMethods: ["sumup"] });
  });
});

describe("connexion OAuth du compte SumUp", () => {
  it("adresse d'autorisation : scopes, retour et state", () => {
    const url = new URL(buildSumupOAuthUrl({ state: "etat-signe" }));
    expect(url.origin + url.pathname).toBe("https://api.sumup.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-sumup");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("payments");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/sumup\/callback$/);
    expect(url.searchParams.get("state")).toBe("etat-signe");
  });

  it("scope « payments » exigé", () => {
    expect(
      tokenAllowsPayments({ scope: "payments user.profile_readonly" }),
    ).toBe(true);
    expect(tokenAllowsPayments({ scope: "user.profile_readonly" })).toBe(false);
  });

  it("jetons chiffrés en base, reconnexion qui remet le compte en service", async () => {
    const workspaceId = new mongoose.Types.ObjectId().toString();
    await compteSumup(workspaceId, { status: "reconnect" });

    const saved = await saveSumupConnection({
      organizationId: workspaceId,
      userId: new mongoose.Types.ObjectId(),
      token: {
        access_token: "acces-1",
        refresh_token: "renouv-1",
        expires_in: 3600,
        scope: "payments",
      },
      profile: {
        merchantCode: MARCHAND,
        businessName: "Studio Lumière",
        email: "studio@exemple.fr",
        currency: "EUR",
      },
    });

    expect(saved.ok).toBe(true);
    const compte = await SumupMerchantAccount.findOne().lean();
    expect(compte.status).toBe("active");
    expect(compte.accessToken).not.toBe("acces-1");
    expect(decrypt(compte.accessToken)).toBe("acces-1");
    expect(decrypt(compte.refreshToken)).toBe("renouv-1");
  });

  it("compte marchand déjà rattaché à un autre espace : refusé", async () => {
    await compteSumup(new mongoose.Types.ObjectId().toString());

    const saved = await saveSumupConnection({
      organizationId: new mongoose.Types.ObjectId().toString(),
      token: { access_token: "a", refresh_token: "b", expires_in: 3600 },
      profile: { merchantCode: MARCHAND },
    });

    expect(saved).toEqual({ ok: false, error: "already_connected" });
  });

  it("compte sans code marchand : refusé", async () => {
    const saved = await saveSumupConnection({
      organizationId: new mongoose.Types.ObjectId().toString(),
      token: { access_token: "a" },
      profile: { merchantCode: null },
    });

    expect(saved).toEqual({ ok: false, error: "no_merchant" });
  });
});

describe("rattrapage des paiements restés ouverts", () => {
  const ilYa = (ms) => new Date(Date.now() - ms);
  const MINUTE = 60 * 1000;

  const avecTentative = async (createdAt, status = "open") => {
    const t = await transfert();
    await t.updateOne({
      paymentAttempt: {
        provider: "sumup",
        reference: CHECKOUT,
        accountId: MARCHAND,
        status,
        createdAt,
      },
    });
    await compteSumup(t.workspaceId);
    return FileTransfer.findById(t._id);
  };

  it("paiement payé mais payeur jamais revenu : débloqué par le rattrapage", async () => {
    const t = await avecTentative(ilYa(10 * MINUTE));
    stubSumup(t, paye(t));

    const res = await sweepOpenTransferPayments();

    expect(res).toEqual({ checked: 1, unlocked: 1 });
    expect((await FileTransfer.findById(t._id).lean()).isPaid).toBe(true);
  });

  it("paiement tout juste ouvert ou trop ancien : laissé tranquille", async () => {
    const recent = await avecTentative(ilYa(30 * 1000));
    stubSumup(recent, paye(recent));
    await avecTentative(ilYa(5 * 60 * MINUTE));

    const res = await sweepOpenTransferPayments();

    expect(res.checked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("paiement en confirmation depuis deux jours : encore revérifié", async () => {
    const t = await avecTentative(ilYa(2 * 24 * 60 * MINUTE), "pending");
    stubSumup(t, paye(t));

    const res = await sweepOpenTransferPayments();

    expect(res).toEqual({ checked: 1, unlocked: 1 });
  });
});
