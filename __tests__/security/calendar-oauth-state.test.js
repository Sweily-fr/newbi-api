/**
 * Connexion d'un agenda Google ou Microsoft : state OAuth.
 *
 * Le state était un JSON en base64, sans signature : n'importe qui pouvait
 * en fabriquer un avec l'utilisateur et l'espace d'un autre, puis terminer
 * le parcours avec son propre compte. Le callback remplaçait alors l'agenda
 * connecté de la victime par celui de l'attaquant. Il est désormais signé,
 * lié au fournisseur, valable 10 minutes et à usage unique (même solution
 * que la connexion Gmail).
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

// Redis partagé simulé (state à usage unique)
const cache = new Map();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async (key) => cache.get(key) ?? null,
  cacheSet: async (key, value) => {
    cache.set(key, value);
  },
  cacheDel: async (key) => {
    cache.delete(key);
  },
  // Client brut : consommation atomique du state (SET … NX)
  getCacheClient: () => ({
    set: async (key, value, ...options) => {
      if (options.includes("NX") && cache.has(key)) return null;
      cache.set(key, value);
      return "OK";
    },
  }),
}));

// Utilisateur de la requête /authorize (aucune session au retour OAuth)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: async (req) =>
    req.headers.authorization ? auth.user : null,
}));

// Fournisseur simulé : le compte qui termine le parcours
const account = vi.hoisted(() => ({ email: "attaquant@exemple.fr" }));
vi.mock("../../src/services/calendar/CalendarProviderFactory.js", () => ({
  getCalendarProvider: () => ({
    getAuthUrl: (state) =>
      `https://oauth.test/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: async () => ({
      accessToken: "jeton-acces",
      refreshToken: "jeton-renouvellement",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    }),
    getUserInfo: async () => ({ email: account.email, name: "Agenda" }),
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
import CalendarConnection from "../../src/models/CalendarConnection.js";
import calendarConnectRoutes from "../../src/routes/calendar-connect.js";
import { createSignedState } from "../../src/utils/signedOAuthState.js";

const victimId = buildUserId();
const victimOrg = buildOrganizationId();
const attackerId = buildUserId();
const attackerOrg = buildOrganizationId();

let server;
let baseUrl;

const callback = async (provider, state) => {
  const res = await fetch(
    `${baseUrl}/calendar-connect/${provider}/callback?code=code-oauth&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  return res.headers.get("location") || "";
};

const authorize = async (provider, userId, workspaceId) => {
  auth.user = { _id: userId, id: String(userId), email: "x@exemple.fr" };
  const res = await fetch(`${baseUrl}/calendar-connect/${provider}/authorize`, {
    headers: {
      authorization: "Bearer jeton",
      "x-workspace-id": String(workspaceId),
    },
  });
  const { authUrl } = await res.json();
  auth.user = null;
  return new URL(authUrl).searchParams.get("state");
};

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/calendar-connect", calendarConnectRoutes);
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
  cache.clear();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  account.email = "attaquant@exemple.fr";
  await seedOrgMembership({ userId: victimId, organizationId: victimOrg });
  await seedOrgMembership({ userId: attackerId, organizationId: attackerOrg });
});

describe("Connexion d'un agenda : state OAuth", () => {
  for (const provider of ["google", "microsoft"]) {
    it(`${provider} : refuse un state fabriqué avec l'utilisateur et l'espace d'un autre`, async () => {
      // Ancien format : JSON en base64, sans signature
      const forged = Buffer.from(
        JSON.stringify({
          userId: String(victimId),
          workspaceId: String(victimOrg),
          issuedAt: Date.now(),
        }),
      ).toString("base64");

      const location = await callback(provider, forged);

      expect(location).toContain("calendar_error=invalid_state");
      expect(await CalendarConnection.countDocuments()).toBe(0);
    });

    it(`${provider} : refuse un state signé dont l'utilisateur a été modifié`, async () => {
      const state = await authorize(provider, attackerId, attackerOrg);
      const [encoded, signature] = state.split(".");
      const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
      const tampered = Buffer.from(
        JSON.stringify({
          ...data,
          userId: String(victimId),
          workspaceId: String(victimOrg),
        }),
      ).toString("base64url");

      const location = await callback(provider, `${tampered}.${signature}`);

      expect(location).toContain("calendar_error=invalid_state");
      expect(await CalendarConnection.countDocuments()).toBe(0);
    });

    it(`${provider} : refuse un state émis pour un autre parcours`, async () => {
      const other = provider === "google" ? "microsoft" : "google";
      const foreign = [
        // Autre fournisseur d'agenda
        await authorize(other, victimId, victimOrg),
        // Connexion Gmail (même secret de signature)
        createSignedState(
          "gmail-connect",
          { userId: String(victimId), workspaceId: String(victimOrg) },
          60_000,
        ),
      ];
      for (const state of foreign) {
        expect(await callback(provider, state)).toContain(
          "calendar_error=invalid_state",
        );
      }
      expect(await CalendarConnection.countDocuments()).toBe(0);
    });

    it(`${provider} : connecte l'agenda de celui qui a lancé la connexion, une seule fois`, async () => {
      account.email = "victime@exemple.fr";
      const state = await authorize(provider, victimId, victimOrg);

      expect(await callback(provider, state)).toContain(
        `calendar_connected=${provider}`,
      );
      const connection = await CalendarConnection.findOne({ provider }).lean();
      expect(String(connection.userId)).toBe(String(victimId));
      expect(connection.accountEmail).toBe("victime@exemple.fr");

      // Rejeu du même state (lien de retour récupéré) : refusé
      account.email = "attaquant@exemple.fr";
      expect(await callback(provider, state)).toContain(
        "calendar_error=invalid_state",
      );
      const after = await CalendarConnection.findOne({ provider }).lean();
      expect(after.accountEmail).toBe("victime@exemple.fr");
    });

    it(`${provider} : refuse un state expiré`, async () => {
      const expired = createSignedState(
        `calendar-connect:${provider}`,
        { userId: String(victimId), workspaceId: String(victimOrg) },
        -1000,
      );
      expect(await callback(provider, expired)).toContain(
        "calendar_error=state_expired",
      );
      expect(await CalendarConnection.countDocuments()).toBe(0);
    });

    it(`${provider} : le state expire au bout de 10 minutes`, async () => {
      const state = await authorize(provider, victimId, victimOrg);
      const data = JSON.parse(
        Buffer.from(state.split(".")[0], "base64url").toString(),
      );
      expect(data.expiresAt - data.issuedAt).toBe(10 * 60 * 1000);
      expect(data).toMatchObject({
        userId: String(victimId),
        workspaceId: String(victimOrg),
      });
    });

    it(`${provider} : refuse si l'utilisateur n'a plus le droit sur l'espace au retour`, async () => {
      const state = await authorize(provider, victimId, victimOrg);
      await CalendarConnection.db
        .collection("member")
        .deleteMany({ userId: victimId });
      invalidateOrgCache();

      const location = await callback(provider, state);

      expect(location).toContain("calendar_error=forbidden");
      expect(await CalendarConnection.countDocuments()).toBe(0);
    });
  }
});
