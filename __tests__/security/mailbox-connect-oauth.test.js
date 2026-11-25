/**
 * Connexion de la boîte d'envoi de la prospection (routes REST
 * /mailbox-connect, Google et Microsoft simulés : aucun appel réel) :
 *   - autorisation : membre avec l'action « create » de la prospection,
 *     fonctionnalité ouverte à l'espace, fournisseur configuré ; state signé
 *     et cookie liant le retour au navigateur ;
 *   - retour : state signé, non expiré, à usage unique, même navigateur,
 *     droit toujours présent, droit d'envoi accordé ; boîte créée (jetons
 *     chiffrés, réglages par défaut) ou remplacée (reconnexion : ACTIVE,
 *     réglages gardés ; autre adresse : montée progressive repartie,
 *     prospections en pause, ancien accès Google révoqué) ;
 *   - redirection vers la page Prospection, ?boite=connectee ou
 *     ?boite_erreur=<message en français>.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "secret-de-test";
  process.env.CALENDAR_ENCRYPTION_KEY ||= "cle-de-test-boites";
});

// Redis partagé simulé (state à usage unique, SET … NX)
const cache = vi.hoisted(() => new Map());
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => ({
    set: async (key, value, ...options) => {
      if (options.includes("NX") && cache.has(key)) return null;
      cache.set(key, value);
      return "OK";
    },
  }),
}));

// Utilisateur de la requête /authorize (en-tête Authorization simulé)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: async (req) =>
    req.headers.authorization ? auth.user : null,
}));

// Google et Microsoft simulés : la boîte qui termine le parcours
const fake = vi.hoisted(() => ({
  revoked: [],
  GOOGLE: {},
  MICROSOFT: {},
}));
vi.mock(
  "../../src/services/prospecting/providers/index.js",
  async (importOriginal) => {
    const original = await importOriginal();
    return {
      ...original,
      mailProvider: (provider) => ({
        getAuthUrl: async (state) =>
          `https://${provider.toLowerCase()}.oauth.test/auth?state=${encodeURIComponent(state)}`,
        exchangeCode: async () => ({
          accessToken: `acces-${provider}`,
          refreshToken: fake[provider].refreshToken,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          scopes: fake[provider].scopes,
        }),
        getUserInfo: async () => ({
          email: fake[provider].email,
          name: fake[provider].name,
        }),
        revokeToken: async (token) => {
          fake.revoked.push(token);
          return true;
        },
      }),
    };
  },
);

import express from "express";
import mongoose from "mongoose";
import { browserCookieFor } from "../helpers/oauthBrowser.js";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import MailboxConnection, {
  decryptToken,
} from "../../src/models/MailboxConnection.js";
import ProspectingSequence from "../../src/models/ProspectingSequence.js";
import mailboxConnectRoutes, {
  CALLBACK_ERRORS,
  MAILBOX_STATE_TTL_MS,
  mailboxStatePurpose,
} from "../../src/routes/mailbox-connect.js";
import {
  createSignedState,
  verifySignedState,
} from "../../src/utils/signedOAuthState.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();
const outsider = buildUserId();
const GOOGLE_SEND = "https://www.googleapis.com/auth/gmail.send";
const PAGE = "https://app.exemple.test/dashboard/outils/prospection";

let server;
let baseUrl;

const authorize = (provider, userId = owner, headers = {}) => {
  auth.user = { _id: userId, id: String(userId), email: "x@exemple.fr" };
  return fetch(`${baseUrl}/mailbox-connect/${provider}/authorize`, {
    headers: {
      authorization: "Bearer jeton",
      "x-organization-id": String(workspaceId),
      ...headers,
    },
  });
};

const stateFrom = async (res) => {
  const { authUrl } = await res.json();
  return new URL(authUrl).searchParams.get("state");
};

const callback = async (provider, state, { cookie, query } = {}) => {
  const res = await fetch(
    `${baseUrl}/mailbox-connect/${provider}/callback?${
      query ?? `code=code-test&state=${encodeURIComponent(state)}`
    }`,
    {
      redirect: "manual",
      headers: { cookie: cookie ?? browserCookieFor(state) },
    },
  );
  return res.headers.get("location") || "";
};

const errorOf = (location) =>
  new URL(location).searchParams.get("boite_erreur");

beforeAll(async () => {
  await startMongo();
  await Promise.all([MailboxConnection.init(), ProspectingSequence.init()]);
  const app = express();
  app.use("/mailbox-connect", mailboxConnectRoutes);
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
  fake.revoked = [];
  fake.GOOGLE = {
    email: "Jean@Atelier-Durand.fr",
    name: "Jean Dupont",
    scopes: ["openid", "email", GOOGLE_SEND],
    refreshToken: "rafraichissement-google",
  };
  fake.MICROSOFT = {
    email: "jean@atelier-durand.onmicrosoft.com",
    name: "Jean Dupont",
    scopes: ["Mail.Send", "User.Read"],
    refreshToken: "rafraichissement-ms",
  };
  vi.stubEnv("FRONTEND_URL", "https://app.exemple.test");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_ID", "");
  vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_SECRET", "");
  vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_ID", "cal-id");
  vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_SECRET", "cal-secret");
  for (const [userId, role] of [
    [owner, "owner"],
    [viewer, "viewer"],
    [accountant, "accountant"],
  ]) {
    await seedOrgMembership({
      userId,
      organizationId: workspaceId,
      role,
      organizationName: "Atelier Durand",
    });
  }
  await seedOrgMembership({
    userId: outsider,
    organizationId: buildOrganizationId(),
    role: "owner",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("autorisation", () => {
  it("membre avec le droit d'ajouter : adresse d'autorisation, state signé, cookie du navigateur", async () => {
    const res = await authorize("google");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toMatch(/^nb_oauth_[0-9a-f]{16}=/);
    expect(cookie).toContain("Path=/mailbox-connect");
    expect(cookie).toContain("HttpOnly");
    const state = await stateFrom(res);
    const verified = verifySignedState(mailboxStatePurpose("GOOGLE"), state);
    expect(verified.ok).toBe(true);
    expect(verified.data).toMatchObject({
      userId: String(owner),
      workspaceId: String(workspaceId),
    });
    // Un state Google ne vaut pas pour Microsoft
    expect(verifySignedState(mailboxStatePurpose("MICROSOFT"), state).ok).toBe(
      false,
    );
  });

  it("refus : Membre (lecture seule), Comptable, non-membre, non connecté", async () => {
    expect((await authorize("google", viewer)).status).toBe(403);
    expect((await authorize("google", accountant)).status).toBe(403);
    expect((await authorize("google", outsider)).status).toBe(403);
    auth.user = null;
    const anonymous = await fetch(
      `${baseUrl}/mailbox-connect/google/authorize`,
      {
        headers: { "x-organization-id": String(workspaceId) },
      },
    );
    expect(anonymous.status).toBe(401);
  });

  it("fonctionnalité fermée à l'espace : refus", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "prospecting");
    vi.stubEnv("BETA_WORKSPACE_IDS", String(buildOrganizationId()));
    const res = await authorize("google");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Cette fonctionnalité n'est pas encore disponible pour votre espace.",
    );
  });

  it("fournisseur sans identifiants : bouton désactivé côté site, refus ici ; Outlook avec l'appli du calendrier", async () => {
    vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "");
    const google = await authorize("google");
    expect(google.status).toBe(503);
    expect((await google.json()).error).toBe(
      "La connexion Gmail n'est pas disponible pour le moment.",
    );
    expect((await authorize("microsoft")).status).toBe(200);
    expect((await authorize("yahoo")).status).toBe(404);
  });
});

describe("retour", () => {
  it("rattache la boîte au membre et à l'espace : jetons chiffrés, réglages par défaut", async () => {
    const state = await stateFrom(await authorize("google"));
    const location = await callback("google", state);
    expect(location).toBe(`${PAGE}?boite=connectee`);
    const mailbox = await MailboxConnection.findOne().lean();
    expect(mailbox).toMatchObject({
      provider: "GOOGLE",
      accountEmail: "jean@atelier-durand.fr",
      accountName: "Jean Dupont",
      status: "ACTIVE",
      dailyLimit: 30,
      sendWindow: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
      signatureId: null,
    });
    expect(String(mailbox.userId)).toBe(String(owner));
    expect(String(mailbox.workspaceId)).toBe(String(workspaceId));
    expect(mailbox.scopes).toContain(GOOGLE_SEND);
    expect(mailbox.accessToken).toMatch(/^encrypted:/);
    expect(mailbox.refreshToken).toMatch(/^encrypted:/);
    expect(decryptToken(mailbox.accessToken)).toBe("acces-GOOGLE");
    expect(decryptToken(mailbox.refreshToken)).toBe("rafraichissement-google");
    expect(mailbox.connectedAt).toBeInstanceOf(Date);
  });

  it("rejeu du même retour : refusé, la boîte n'est pas remplacée", async () => {
    const state = await stateFrom(await authorize("google"));
    expect(await callback("google", state)).toBe(`${PAGE}?boite=connectee`);
    fake.GOOGLE.email = "attaquant@gmail.com";
    expect(errorOf(await callback("google", state))).toBe(
      CALLBACK_ERRORS.invalid,
    );
    expect((await MailboxConnection.findOne().lean()).accountEmail).toBe(
      "jean@atelier-durand.fr",
    );
  });

  it("state fabriqué, modifié ou expiré : refusé avant tout échange", async () => {
    const forged = Buffer.from(
      JSON.stringify({
        userId: String(owner),
        workspaceId: String(workspaceId),
      }),
    ).toString("base64url");
    expect(errorOf(await callback("google", forged))).toBe(
      CALLBACK_ERRORS.invalid,
    );

    const state = await stateFrom(await authorize("google"));
    const [encoded, signature] = state.split(".");
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    const tampered = `${Buffer.from(
      JSON.stringify({ ...data, workspaceId: String(buildOrganizationId()) }),
    ).toString("base64url")}.${signature}`;
    expect(errorOf(await callback("google", tampered))).toBe(
      CALLBACK_ERRORS.invalid,
    );

    const expired = createSignedState(
      mailboxStatePurpose("GOOGLE"),
      { userId: String(owner), workspaceId: String(workspaceId) },
      -1000,
    );
    expect(errorOf(await callback("google", expired))).toBe(
      CALLBACK_ERRORS.expired,
    );
    expect(await MailboxConnection.countDocuments()).toBe(0);
  });

  it("terminé dans un autre navigateur (sans le cookie) : refusé", async () => {
    const state = await stateFrom(await authorize("google"));
    expect(errorOf(await callback("google", state, { cookie: "" }))).toBe(
      CALLBACK_ERRORS.otherBrowser,
    );
    expect(await MailboxConnection.countDocuments()).toBe(0);
  });

  it("droit retiré entre l'autorisation et le retour : refusé", async () => {
    const state = await stateFrom(await authorize("google"));
    await mongoose.connection.db
      .collection("member")
      .updateOne({ userId: owner }, { $set: { role: "viewer" } });
    expect(errorOf(await callback("google", state))).toBe(
      CALLBACK_ERRORS.forbidden,
    );
    expect(await MailboxConnection.countDocuments()).toBe(0);
  });

  it("droit d'envoi décoché à l'écran de Google : refusé avec un message clair", async () => {
    fake.GOOGLE.scopes = ["openid", "email", "profile"];
    const state = await stateFrom(await authorize("google"));
    expect(errorOf(await callback("google", state))).toBe(
      "Autorisez l'envoi d'e-mails pour connecter votre boîte",
    );
    expect(await MailboxConnection.countDocuments()).toBe(0);
  });

  it("connexion annulée par le membre, paramètres manquants", async () => {
    expect(
      errorOf(
        await callback("google", "", { query: "error=access_denied&state=x" }),
      ),
    ).toBe("Connexion annulée");
    expect(errorOf(await callback("google", "", { query: "state=x" }))).toBe(
      CALLBACK_ERRORS.incomplete,
    );
  });

  it("adresse déjà connectée par un autre membre de l'espace : refusée", async () => {
    await MailboxConnection.create({
      workspaceId,
      userId: viewer,
      provider: "GOOGLE",
      accountEmail: "jean@atelier-durand.fr",
      status: "ACTIVE",
    });
    const state = await stateFrom(await authorize("google"));
    expect(errorOf(await callback("google", state))).toBe(
      "Cette adresse est déjà connectée par un autre membre de l'espace",
    );
    expect(await MailboxConnection.countDocuments({ userId: owner })).toBe(0);
    // Déconnectée chez l'autre membre : l'adresse est libre
    await MailboxConnection.updateOne(
      { userId: viewer },
      { $set: { status: "DISCONNECTED" } },
    );
    const again = await stateFrom(await authorize("google"));
    expect(await callback("google", again)).toBe(`${PAGE}?boite=connectee`);
  });

  it("Outlook : boîte MICROSOFT créée", async () => {
    const state = await stateFrom(await authorize("microsoft"));
    expect(await callback("microsoft", state)).toBe(`${PAGE}?boite=connectee`);
    expect(await MailboxConnection.findOne().lean()).toMatchObject({
      provider: "MICROSOFT",
      accountEmail: "jean@atelier-durand.onmicrosoft.com",
      status: "ACTIVE",
    });
  });
});

describe("reconnexion", () => {
  it("même adresse : ACTIVE de nouveau, réglages et montée progressive gardés", async () => {
    const connectedAt = new Date("2026-09-01T08:00:00Z");
    const existing = await MailboxConnection.create({
      workspaceId,
      userId: owner,
      provider: "GOOGLE",
      accountEmail: "jean@atelier-durand.fr",
      status: "EXPIRED",
      dailyLimit: 12,
      sendWindow: { days: [2, 4], startHour: 10, endHour: 12 },
      connectedAt,
      expiredNotifiedAt: new Date(),
      lastError: "invalid_grant",
    });
    const sequence = await ProspectingSequence.create({
      workspaceId,
      mailboxId: existing._id,
      name: "En cours",
      status: "ACTIVE",
    });
    const state = await stateFrom(await authorize("google"));
    expect(await callback("google", state)).toBe(`${PAGE}?boite=connectee`);
    const mailbox = await MailboxConnection.findById(existing._id).lean();
    expect(mailbox).toMatchObject({
      status: "ACTIVE",
      dailyLimit: 12,
      sendWindow: { days: [2, 4], startHour: 10, endHour: 12 },
      expiredNotifiedAt: null,
      lastError: null,
    });
    expect(mailbox.connectedAt.getTime()).toBe(connectedAt.getTime());
    expect(await MailboxConnection.countDocuments()).toBe(1);
    // Les prospections en attente repartent d'elles-mêmes
    expect((await ProspectingSequence.findById(sequence._id)).status).toBe(
      "ACTIVE",
    );
    expect(fake.revoked).toEqual([]);
  });

  it("autre adresse : montée progressive repartie, prospections en pause, ancien accès révoqué", async () => {
    const existing = await MailboxConnection.create({
      workspaceId,
      userId: owner,
      provider: "GOOGLE",
      accountEmail: "ancienne@atelier-durand.fr",
      refreshToken: "ancien-rafraichissement",
      status: "ACTIVE",
      connectedAt: new Date("2026-09-01T08:00:00Z"),
    });
    const sequence = await ProspectingSequence.create({
      workspaceId,
      mailboxId: existing._id,
      name: "En cours",
      status: "ACTIVE",
    });
    const state = await stateFrom(await authorize("google"));
    expect(await callback("google", state)).toBe(`${PAGE}?boite=connectee`);
    const mailbox = await MailboxConnection.findById(existing._id).lean();
    expect(mailbox.accountEmail).toBe("jean@atelier-durand.fr");
    expect(mailbox.connectedAt.getTime()).toBeGreaterThan(
      Date.now() - 60 * 1000,
    );
    expect(
      await ProspectingSequence.findById(sequence._id).lean(),
    ).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
    expect(fake.revoked).toEqual(["ancien-rafraichissement"]);
  });
});

describe("constantes", () => {
  it("state valable 10 minutes", () => {
    expect(MAILBOX_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
