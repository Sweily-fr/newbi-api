/**
 * Connexion d'un agenda Google ou Microsoft (routes REST /calendar-connect) :
 * droit « Modifier » du calendrier exigé dans l'espace actif, à
 * l'autorisation comme au retour OAuth (espace transporté dans le state).
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

vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
  process.env.FRONTEND_URL = "https://app.test";
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
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

// Fournisseur factice : aucun appel à Google ni à Microsoft
vi.mock("../../src/services/calendar/CalendarProviderFactory.js", () => ({
  getCalendarProvider: () => ({
    getAuthUrl: (state) => `https://oauth.test/authorize?state=${state}`,
    exchangeCode: async () => ({
      accessToken: "jeton-acces",
      refreshToken: "jeton-renouvellement",
      expiresAt: new Date(Date.now() + 3600 * 1000),
    }),
    getUserInfo: async () => ({ email: "agenda@test.fr", name: "Agenda" }),
    listCalendars: async () => [],
  }),
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  syncConnection: vi.fn(async () => {}),
}));
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  registerWebhookForConnection: vi.fn(async () => {}),
}));
vi.mock(
  "../../src/services/calendar/providers/GoogleCalendarProvider.js",
  () => ({
    translateGoogleError: (error) => error?.message || "erreur",
  }),
);
vi.mock(
  "../../src/services/calendar/providers/MicrosoftCalendarProvider.js",
  () => ({ translateMicrosoftError: (error) => error?.message || "erreur" }),
);

import express from "express";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import calendarConnectRoutes, {
  CALENDAR_STATE_TTL_MS,
  calendarStatePurpose,
} from "../../src/routes/calendar-connect.js";
import { createSignedState } from "../../src/utils/signedOAuthState.js";

let server;
let baseUrl;
let workspaceId;
let editor;
let viewer;

const asUser = (userId) => {
  auth.user = { _id: userId, id: String(userId) };
};

const authorize = (provider, headers = {}) =>
  fetch(`${baseUrl}/calendar-connect/${provider}/authorize`, { headers });

// State signé comme celui de /authorize (voir calendar-oauth-state.test.js
// pour les states fabriqués, modifiés, expirés ou rejoués)
const callback = (provider, stateData) =>
  fetch(
    `${baseUrl}/calendar-connect/${provider}/callback?code=code-test&state=${encodeURIComponent(
      createSignedState(
        calendarStatePurpose(provider),
        stateData,
        CALENDAR_STATE_TTL_MS,
      ),
    )}`,
    { redirect: "manual" },
  );

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
  invalidateOrgCache();
  invalidateOrganizationRoles();
  workspaceId = buildOrganizationId();
  editor = buildUserId();
  viewer = buildUserId();
  // Éditeur : « Modifier » le calendrier ; Membre : « Voir » seulement
  await seedOrgMembership({
    userId: editor,
    organizationId: workspaceId,
    role: "member",
  });
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
});

describe("Connexion d'un agenda Google ou Microsoft", () => {
  for (const provider of ["google", "microsoft"]) {
    it(`${provider} : autorisation refusée sans « Modifier » le calendrier`, async () => {
      asUser(viewer);
      const res = await authorize(provider, {
        "x-workspace-id": String(workspaceId),
      });
      expect(res.status).toBe(403);
    });

    it(`${provider} : espace actif exigé`, async () => {
      asUser(editor);
      const res = await authorize(provider);
      expect(res.status).toBe(400);
    });

    it(`${provider} : autorisation accordée avec le droit, espace dans le state`, async () => {
      asUser(editor);
      const res = await authorize(provider, {
        "x-workspace-id": String(workspaceId),
      });
      expect(res.status).toBe(200);
      const { authUrl } = await res.json();
      const state = new URL(authUrl).searchParams.get("state");
      const decoded = JSON.parse(
        Buffer.from(state.split(".")[0], "base64url").toString(),
      );
      expect(decoded).toMatchObject({
        userId: String(editor),
        workspaceId: String(workspaceId),
      });
    });

    it(`${provider} : retour OAuth refusé sans le droit ou sans espace`, async () => {
      // Pas de session au retour (redirection du fournisseur)
      auth.user = null;
      for (const stateData of [
        { userId: String(viewer), workspaceId: String(workspaceId) },
        { userId: String(editor) },
      ]) {
        const res = await callback(provider, stateData);
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain(
          "calendar_error=forbidden",
        );
      }
      expect(await CalendarConnection.countDocuments()).toBe(0);
    });

    it(`${provider} : retour OAuth accepté avec le droit`, async () => {
      auth.user = null;
      const res = await callback(provider, {
        userId: String(editor),
        workspaceId: String(workspaceId),
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(
        `calendar_connected=${provider}`,
      );
      expect(
        await CalendarConnection.countDocuments({ userId: editor, provider }),
      ).toBe(1);
    });
  }
});
