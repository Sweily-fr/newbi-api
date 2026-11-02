/**
 * Retour OAuth (connexion Gmail et des agendas Google et Microsoft) lié au
 * navigateur qui a lancé la connexion.
 *
 * Le state signé prouvait seulement qu'un utilisateur Newbi avait lancé le
 * parcours : son adresse d'autorisation, envoyée à quelqu'un d'autre,
 * rattachait la boîte Gmail ou l'agenda de cette personne à l'espace de
 * celui qui l'avait lancée. /authorize pose désormais un cookie propre au
 * parcours, exigé au retour.
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
import express from "express";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
  process.env.FRONTEND_URL = "https://app.test";
  process.env.CALENDAR_ENCRYPTION_KEY ||= "a".repeat(64);
});

// Redis simulé, avec la latence d'un aller-retour réseau. Le SET … NX est
// atomique côté serveur (vérification et écriture avant la réponse).
const redis = vi.hoisted(() => ({ available: true, store: new Map() }));
vi.mock("../../src/config/redis.js", () => {
  const latency = () => new Promise((resolve) => setTimeout(resolve, 30));
  return {
    getPubSub: () => ({ publish: async () => {} }),
    cacheGet: async (key) => {
      await latency();
      if (!redis.available) return null;
      const value = redis.store.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
    cacheSet: async (key, value) => {
      await latency();
      if (redis.available) redis.store.set(key, JSON.stringify(value));
    },
    cacheDel: async () => {},
    getCacheClient: () =>
      redis.available
        ? {
            set: async (key, value, ...options) => {
              const taken = options.includes("NX") && redis.store.has(key);
              if (!taken) redis.store.set(key, value);
              await latency();
              return taken ? null : "OK";
            },
          }
        : null,
  };
});

// Utilisateur de la requête /authorize (aucune session au retour OAuth)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: async (req) =>
    req.headers.authorization ? auth.user : null,
}));

// Fournisseurs simulés
const tokens = () => ({
  accessToken: "jeton-acces",
  refreshToken: "jeton-renouvellement",
  expiresAt: new Date(Date.now() + 3600 * 1000),
});
vi.mock("../../src/services/gmail/GmailOAuthProvider.js", () => ({
  default: class {
    getAuthUrl(state) {
      return `https://oauth.test/auth?state=${encodeURIComponent(state)}`;
    }
    async exchangeCode() {
      return tokens();
    }
    async getUserInfo() {
      return { email: "boite@exemple.fr", name: "Boîte" };
    }
  },
  translateGmailError: (error) => error.message,
}));
vi.mock("../../src/services/gmail/GmailScannerService.js", () => ({
  scanGmailConnection: async () => {},
}));
vi.mock("../../src/services/calendar/CalendarProviderFactory.js", () => ({
  getCalendarProvider: () => ({
    getAuthUrl: (state) =>
      `https://oauth.test/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: async () => tokens(),
    getUserInfo: async () => ({ email: "agenda@exemple.fr", name: "Agenda" }),
    listCalendars: async () => [],
  }),
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  syncConnection: async () => {},
}));
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  registerWebhookForConnection: async () => {},
}));
vi.mock(
  "../../src/services/calendar/providers/GoogleCalendarProvider.js",
  () => ({ translateGoogleError: (error) => error?.message || "erreur" }),
);
vi.mock(
  "../../src/services/calendar/providers/MicrosoftCalendarProvider.js",
  () => ({ translateMicrosoftError: (error) => error?.message || "erreur" }),
);

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import GmailConnection from "../../src/models/GmailConnection.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import gmailConnectRouter from "../../src/routes/gmail-connect.js";
import calendarConnectRouter from "../../src/routes/calendar-connect.js";

const userId = buildUserId();
const workspaceId = buildOrganizationId();

// Parcours testés : préfixe de route, paramètres de retour
const FLOWS = [
  {
    name: "Gmail",
    base: "/gmail-connect",
    header: "x-organization-id",
    success: "gmail_connected=true",
    error: "gmail_error=",
    count: () => GmailConnection.countDocuments(),
  },
  ...["google", "microsoft"].map((provider) => ({
    name: `agenda ${provider}`,
    base: `/calendar-connect/${provider}`,
    header: "x-workspace-id",
    success: `calendar_connected=${provider}`,
    error: "calendar_error=",
    count: () => CalendarConnection.countDocuments({ provider }),
  })),
];

let server;
let baseUrl;

// Cookie posé par /authorize dans le navigateur qui lance la connexion
const authorize = async (flow) => {
  auth.user = { _id: userId, id: String(userId), email: "x@exemple.fr" };
  const res = await fetch(`${baseUrl}${flow.base}/authorize`, {
    headers: {
      authorization: "Bearer jeton",
      [flow.header]: String(workspaceId),
    },
  });
  auth.user = null;
  const { authUrl } = await res.json();
  const cookies = res.headers.getSetCookie();
  return {
    state: new URL(authUrl).searchParams.get("state"),
    cookies,
    cookie: cookies.map((c) => c.split(";")[0]).join("; "),
  };
};

const callback = async (flow, state, cookie) => {
  const res = await fetch(
    `${baseUrl}${flow.base}/callback?code=code-oauth&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: cookie ? { cookie } : {} },
  );
  return res.headers.get("location") || "";
};

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/gmail-connect", gmailConnectRouter);
  app.use("/calendar-connect", calendarConnectRouter);
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
  redis.available = true;
  redis.store.clear();
  await seedOrgMembership({ userId, organizationId: workspaceId });
});

describe.each(FLOWS)("$name : retour lié au navigateur", (flow) => {
  it("/authorize pose un cookie HttpOnly, SameSite=Lax, limité au parcours", async () => {
    const { cookies } = await authorize(flow);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/HttpOnly/i);
    expect(cookies[0]).toMatch(/SameSite=Lax/i);
    expect(cookies[0]).toMatch(/Path=\/(gmail|calendar)-connect/);
  });

  it("terminé dans le même navigateur : connecté", async () => {
    const { state, cookie } = await authorize(flow);
    const location = await callback(flow, state, cookie);
    expect(location).toContain(flow.success);
    expect(await flow.count()).toBe(1);
  });

  it("adresse d'autorisation ouverte dans un autre navigateur : refusé, rien n'est rattaché", async () => {
    const { state } = await authorize(flow);
    const location = await callback(flow, state);
    expect(location).toContain(flow.error);
    expect(await flow.count()).toBe(0);
  });

  it("cookie d'un autre parcours : refusé", async () => {
    const mine = await authorize(flow);
    const other = await authorize(flow);
    const location = await callback(flow, mine.state, other.cookie);
    expect(location).toContain(flow.error);
    expect(await flow.count()).toBe(0);
  });
});
