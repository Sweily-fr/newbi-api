/**
 * Connexion du compte SumUp d'un espace (routes REST /sumup) : droit
 * « Connecter et configurer » des applications exigé à l'autorisation comme
 * au retour OAuth, retour lié au navigateur qui a lancé la connexion, scope
 * « payments » exigé, jetons chiffrés. Notification de SumUp : toujours
 * acquittée, sans rien révéler.
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

vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://app.test";
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
  process.env.DATA_ENCRYPTION_KEY ||= "cle-de-test-sumup-connect";
});

// Redis simulé : consommation atomique du state OAuth (SET … NX)
const usedStates = new Set();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => ({
    set: async (key) => {
      if (usedStates.has(key)) return null;
      usedStates.add(key);
      return "OK";
    },
  }),
}));

// Session simulée : l'utilisateur renvoyé par le middleware d'authentification
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: vi.fn(async () => auth.user),
}));
// Abonnement : hors sujet ici
vi.mock("../../src/middlewares/rbac.js", async (importOriginal) => ({
  ...(await importOriginal()),
  checkSubscriptionActive: vi.fn(async () => {}),
}));

import express from "express";
import { browserCookieFor } from "../helpers/oauthBrowser.js";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import SumupMerchantAccount from "../../src/models/SumupMerchantAccount.js";
import sumupRoutes, {
  SUMUP_STATE_PURPOSE,
  SUMUP_STATE_TTL_MS,
  handleSumupWebhook,
} from "../../src/routes/sumup-oauth.js";
import { createSignedState } from "../../src/utils/signedOAuthState.js";
import { decrypt } from "../../src/utils/encryption.js";

const realFetch = globalThis.fetch;
let server;
let baseUrl;
let workspaceId;
let admin;
let member;
let tokenScope;

const asUser = (userId) => {
  auth.user = { _id: userId, id: String(userId) };
};

const authorize = (headers = {}) =>
  realFetch(`${baseUrl}/sumup/authorize`, { headers });

const callback = (stateData, { withCookie = true, query = "" } = {}) => {
  const state = createSignedState(
    SUMUP_STATE_PURPOSE,
    stateData,
    SUMUP_STATE_TTL_MS,
  );
  return realFetch(
    `${baseUrl}/sumup/callback?code=code-test&state=${encodeURIComponent(state)}${query}`,
    {
      redirect: "manual",
      headers: withCookie ? { cookie: browserCookieFor(state) } : {},
    },
  );
};

const outcome = (res) =>
  new URL(res.headers.get("location")).searchParams.get("sumup_connect");

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/sumup", sumupRoutes);
  app.post("/webhook/sumup", express.json(), handleSumupWebhook);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  process.env.SUMUP_CLIENT_ID = "client-sumup";
  process.env.SUMUP_CLIENT_SECRET = "secret-sumup";
  tokenScope = "payments user.profile_readonly";
  workspaceId = buildOrganizationId();
  admin = buildUserId();
  member = buildUserId();
  await seedOrgMembership({
    userId: admin,
    organizationId: workspaceId,
    role: "admin",
  });
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: "member",
  });
  // Faux SumUp ; les appels au serveur de test passent
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const target = new URL(url);
      if (target.hostname !== "api.sumup.com") return realFetch(url, init);
      const json = (body) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      });
      if (target.pathname === "/token") {
        return json({
          access_token: "jeton-acces",
          refresh_token: "jeton-renouvellement",
          expires_in: 3600,
          scope: tokenScope,
        });
      }
      if (target.pathname === "/v0.1/me") {
        return json({
          account: { username: "studio@exemple.fr" },
          merchant_profile: {
            merchant_code: "MCODE123",
            company_name: "Studio Lumière",
            default_currency: "EUR",
          },
        });
      }
      return { ok: false, status: 404, text: async () => "{}" };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUMUP_CLIENT_ID;
  delete process.env.SUMUP_CLIENT_SECRET;
});

describe("connexion d'un compte SumUp", () => {
  it("autorisation refusée sans « Connecter et configurer » les applications", async () => {
    asUser(member);
    const res = await authorize({ "x-workspace-id": String(workspaceId) });
    expect(res.status).toBe(403);
  });

  it("SumUp non configuré côté Newbi : indisponible", async () => {
    delete process.env.SUMUP_CLIENT_ID;
    asUser(admin);
    const res = await authorize({ "x-workspace-id": String(workspaceId) });
    expect(res.status).toBe(503);
  });

  it("autorisation : page SumUp, espace dans le state, navigateur lié", async () => {
    asUser(admin);
    const res = await authorize({ "x-workspace-id": String(workspaceId) });
    expect(res.status).toBe(200);
    const { authUrl } = await res.json();
    const url = new URL(authUrl);
    expect(url.hostname).toBe("api.sumup.com");
    const state = url.searchParams.get("state");
    const decoded = JSON.parse(
      Buffer.from(state.split(".")[0], "base64url").toString(),
    );
    expect(decoded).toMatchObject({
      userId: String(admin),
      workspaceId: String(workspaceId),
    });
    expect(res.headers.get("set-cookie")).toContain("Path=/sumup");
  });

  it("retour accepté : compte marchand rattaché, jetons chiffrés", async () => {
    auth.user = null;
    const res = await callback({
      userId: String(admin),
      workspaceId: String(workspaceId),
    });
    expect(res.status).toBe(302);
    expect(outcome(res)).toBe("success");
    const compte = await SumupMerchantAccount.findOne({
      organizationId: String(workspaceId),
    }).lean();
    expect(compte).toMatchObject({
      merchantCode: "MCODE123",
      businessName: "Studio Lumière",
      email: "studio@exemple.fr",
      currency: "EUR",
      status: "active",
    });
    expect(compte.accessToken).not.toContain("jeton-acces");
    expect(decrypt(compte.accessToken)).toBe("jeton-acces");
  });

  it("retour sans le droit : refusé, rien d'enregistré", async () => {
    auth.user = null;
    const res = await callback({
      userId: String(member),
      workspaceId: String(workspaceId),
    });
    expect(outcome(res)).toBe("forbidden");
    expect(await SumupMerchantAccount.countDocuments()).toBe(0);
  });

  it("retour dans un autre navigateur : refusé", async () => {
    auth.user = null;
    const res = await callback(
      { userId: String(admin), workspaceId: String(workspaceId) },
      { withCookie: false },
    );
    expect(outcome(res)).toBe("other_browser");
    expect(await SumupMerchantAccount.countDocuments()).toBe(0);
  });

  it("scope « payments » non accordé : refusé", async () => {
    auth.user = null;
    tokenScope = "user.profile_readonly";
    const res = await callback({
      userId: String(admin),
      workspaceId: String(workspaceId),
    });
    expect(outcome(res)).toBe("missing_scope");
    expect(await SumupMerchantAccount.countDocuments()).toBe(0);
  });

  it("autorisation annulée sur SumUp", async () => {
    const res = await realFetch(
      `${baseUrl}/sumup/callback?error=access_denied`,
      { redirect: "manual" },
    );
    expect(outcome(res)).toBe("access_denied");
  });

  it("notification d'un paiement inconnu : acquittée sans détail", async () => {
    const res = await realFetch(`${baseUrl}/webhook/sumup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "CHECKOUT_STATUS_CHANGED",
        id: "11111111-2222-3333-4444-555555555555",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});
