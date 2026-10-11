/**
 * Usage unique du state OAuth (Gmail, agendas Google et Microsoft) selon
 * l'état de Redis.
 *
 * - hors production, sans Redis configuré (dev local) : repli en mémoire du
 *   processus, la connexion fonctionne et le state reste à usage unique ;
 * - Redis configuré (REDIS_URL / REDIS_HOST) mais sans connexion, ou en
 *   erreur : refus, quel que soit l'environnement ;
 * - en production sans Redis : refus.
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
import express from "express";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
  process.env.FRONTEND_URL = "https://app.test";
  process.env.CALENDAR_ENCRYPTION_KEY ||= "a".repeat(64);
});

// État simulé de Redis : "absent" (aucun client), "error" (client en échec)
const redis = vi.hoisted(() => ({ mode: "absent" }));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () =>
    redis.mode === "error"
      ? {
          set: async () => {
            throw new Error("Connection is closed.");
          },
        }
      : null,
}));

// Utilisateur de la requête /authorize (aucune session au retour OAuth)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: async (req) =>
    req.headers.authorization ? auth.user : null,
}));

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

const ENV_KEYS = ["NODE_ENV", "REDIS_URL", "REDIS_HOST"];
let savedEnv;
const setEnv = (values) => {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
};

let server;
let baseUrl;

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
  return new URL(authUrl).searchParams.get("state");
};

const callback = async (flow, state) => {
  const res = await fetch(
    `${baseUrl}${flow.base}/callback?code=code-oauth&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
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
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  redis.mode = "absent";
  await seedOrgMembership({ userId, organizationId: workspaceId });
});

afterEach(() => {
  setEnv(savedEnv);
});

describe("State OAuth selon l'état de Redis", () => {
  for (const flow of FLOWS) {
    it(`${flow.name} : hors production sans Redis configuré, repli en mémoire à usage unique`, async () => {
      setEnv({ NODE_ENV: "development" });
      const state = await authorize(flow);

      const [first, second] = await Promise.all([
        callback(flow, state),
        callback(flow, state),
      ]);
      expect(
        [first, second].filter((l) => l.includes(flow.success)),
      ).toHaveLength(1);
      expect(
        [first, second].filter((l) => l.includes(flow.error)),
      ).toHaveLength(1);
      // Rejeu ultérieur : toujours refusé
      expect(await callback(flow, state)).toContain(flow.error);
      expect(await flow.count()).toBe(1);
    });

    it(`${flow.name} : Redis configuré mais sans connexion, refusé même hors production`, async () => {
      for (const env of [
        { NODE_ENV: "development", REDIS_URL: "redis://redis.test:6379" },
        { NODE_ENV: "development", REDIS_HOST: "redis.test" },
      ]) {
        setEnv(env);
        const state = await authorize(flow);
        const location = await callback(flow, state);
        expect(location).toContain(flow.error);
        expect(location).not.toContain(flow.success);
      }
      expect(await flow.count()).toBe(0);
    });

    it(`${flow.name} : erreur Redis, refusé dans tous les environnements`, async () => {
      redis.mode = "error";
      for (const env of [
        { NODE_ENV: "development" },
        { NODE_ENV: "production", REDIS_URL: "redis://redis.test:6379" },
      ]) {
        setEnv(env);
        const state = await authorize(flow);
        expect(await callback(flow, state)).toContain(flow.error);
      }
      expect(await flow.count()).toBe(0);
    });

    it(`${flow.name} : en production sans Redis, refusé`, async () => {
      setEnv({ NODE_ENV: "production" });
      const state = await authorize(flow);
      expect(await callback(flow, state)).toContain(flow.error);
      expect(await flow.count()).toBe(0);
    });
  }
});
