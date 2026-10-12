/**
 * Stripe Connect : le repli par userId ne vaut que pour les anciens comptes
 * sans organizationId.
 *
 * Quand l'espace actif n'avait pas de compte, les résolveurs (et
 * createConnectAccount) se repliaient sur le compte créé par l'utilisateur,
 * quel que soit son espace. Retiré de l'espace B où il avait connecté Stripe,
 * un utilisateur obtenait depuis son espace A le compte de B, un lien vers
 * son tableau de bord Stripe, son statut, un lien d'onboarding, et pouvait le
 * déconnecter.
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

// API Stripe simulée
const stripeApi = vi.hoisted(() => ({
  accounts: {
    create: vi.fn(async () => ({
      id: "acct_nouveau_A",
      charges_enabled: false,
      payouts_enabled: false,
    })),
    retrieve: vi.fn(async (id) => ({
      id,
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
    })),
    createLoginLink: vi.fn(async (id) => ({
      url: `https://connect.stripe.test/${id}`,
    })),
  },
  accountLinks: {
    create: vi.fn(async ({ account }) => ({
      url: `https://connect.stripe.test/onboarding/${account}`,
    })),
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
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import stripeConnectResolvers from "../../src/resolvers/stripeConnectResolvers.js";

const Q = stripeConnectResolvers.Query;
const M = stripeConnectResolvers.Mutation;

const userId = buildUserId();
const orgA = buildOrganizationId(); // espace actuel de l'utilisateur
const orgB = buildOrganizationId(); // espace qu'il a quitté
const ctx = () => buildContext({ userId, organizationId: orgA });

const ACCOUNT_B = "acct_espace_B";
const LEGACY = "acct_ancien";

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  vi.clearAllMocks();
  // Membre de A seulement : il a quitté B, où il avait connecté Stripe
  await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
});

const insertAccountOfB = () =>
  StripeConnectAccount.collection.insertOne({
    organizationId: orgB.toString(),
    userId,
    accountId: ACCOUNT_B,
    isOnboarded: true,
    chargesEnabled: true,
    payoutsEnabled: true,
  });

describe("compte Stripe Connect d'un autre espace", () => {
  beforeEach(insertAccountOfB);

  it("myStripeConnectAccount ne renvoie pas le compte de B", async () => {
    expect(await Q.myStripeConnectAccount(null, {}, ctx())).toBeNull();
    expect(stripeApi.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("generateStripeDashboardLink refuse le compte de B", async () => {
    const result = await M.generateStripeDashboardLink(
      null,
      { accountId: ACCOUNT_B },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(stripeApi.accounts.createLoginLink).not.toHaveBeenCalled();
  });

  it("checkStripeConnectAccountStatus refuse le compte de B", async () => {
    const result = await M.checkStripeConnectAccountStatus(
      null,
      { accountId: ACCOUNT_B },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(stripeApi.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("generateStripeOnboardingLink refuse le compte de B", async () => {
    const result = await M.generateStripeOnboardingLink(
      null,
      { accountId: ACCOUNT_B, returnUrl: "https://app.test/retour" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(stripeApi.accountLinks.create).not.toHaveBeenCalled();
  });

  it("disconnectStripe ne supprime pas le compte de B", async () => {
    const result = await M.disconnectStripe(null, {}, ctx());
    expect(result.success).toBe(false);
    expect(
      await StripeConnectAccount.countDocuments({ accountId: ACCOUNT_B }),
    ).toBe(1);
  });

  it("createStripeConnectAccount crée le compte de A au lieu de renvoyer celui de B", async () => {
    const result = await M.createStripeConnectAccount(null, {}, ctx());
    expect(result.success).toBe(true);
    expect(result.accountId).toBe("acct_nouveau_A");
    const created = await StripeConnectAccount.findOne({
      organizationId: orgA.toString(),
    });
    expect(created.accountId).toBe("acct_nouveau_A");
  });
});

describe("ancien compte sans organizationId (compatibilité)", () => {
  beforeEach(async () => {
    await StripeConnectAccount.collection.insertOne({
      userId,
      accountId: LEGACY,
      isOnboarded: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
  });

  it("reste accessible à l'utilisateur qui l'a créé", async () => {
    const account = await Q.myStripeConnectAccount(null, {}, ctx());
    expect(account.accountId).toBe(LEGACY);

    const link = await M.generateStripeDashboardLink(
      null,
      { accountId: LEGACY },
      ctx(),
    );
    expect(link.success).toBe(true);
  });

  it("disconnectStripe supprime l'ancien compte, pas celui de B", async () => {
    await insertAccountOfB();
    const result = await M.disconnectStripe(null, {}, ctx());
    expect(result.success).toBe(true);
    expect(
      await StripeConnectAccount.countDocuments({ accountId: LEGACY }),
    ).toBe(0);
    expect(
      await StripeConnectAccount.countDocuments({ accountId: ACCOUNT_B }),
    ).toBe(1);
  });
});

describe("compte de l'espace actif", () => {
  it("reste utilisable par un membre de l'espace", async () => {
    await StripeConnectAccount.collection.insertOne({
      organizationId: orgA.toString(),
      userId: buildUserId(), // connecté par un autre membre
      accountId: "acct_espace_A",
      isOnboarded: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    const link = await M.generateStripeDashboardLink(
      null,
      { accountId: "acct_espace_A" },
      ctx(),
    );
    expect(link.success).toBe(true);
    const result = await M.disconnectStripe(null, {}, ctx());
    expect(result.success).toBe(true);
    expect(await StripeConnectAccount.countDocuments({})).toBe(0);
  });
});
