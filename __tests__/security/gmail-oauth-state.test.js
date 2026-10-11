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
  process.env.CALENDAR_ENCRYPTION_KEY ||= "cle-de-test-agenda";
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

// Utilisateur de la requête /authorize (en-tête Authorization simulé)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: async (req) =>
    req.headers.authorization ? auth.user : null,
}));

// Google simulé : la boîte Gmail qui termine le parcours
const google = vi.hoisted(() => ({ email: "attaquant@gmail.com" }));
vi.mock("../../src/services/gmail/GmailOAuthProvider.js", () => ({
  default: class {
    getAuthUrl(state) {
      return `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`;
    }
    async exchangeCode() {
      return {
        accessToken: "jeton-acces",
        refreshToken: "jeton-rafraichissement",
        expiresAt: new Date(Date.now() + 3600 * 1000),
      };
    }
    async getUserInfo() {
      return { email: google.email, name: "Boîte Gmail" };
    }
  },
  translateGmailError: (error) => error.message,
}));
vi.mock("../../src/services/gmail/GmailScannerService.js", () => ({
  scanGmailConnection: async () => {},
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership } from "../helpers/auth.js";
import GmailConnection from "../../src/models/GmailConnection.js";
import gmailConnectRouter from "../../src/routes/gmail-connect.js";
import { createSignedState } from "../../src/utils/signedOAuthState.js";

const victimId = buildUserId();
const victimOrg = buildOrganizationId();
const attackerId = buildUserId();
const attackerOrg = buildOrganizationId();

let server;
let baseUrl;

const callback = async (state) => {
  const res = await fetch(
    `${baseUrl}/gmail-connect/callback?code=code-google&state=${encodeURIComponent(state)}`,
    { redirect: "manual" },
  );
  return res.headers.get("location") || "";
};

const authorize = async (userId, workspaceId) => {
  auth.user = { _id: userId, id: String(userId), email: "x@exemple.fr" };
  const res = await fetch(`${baseUrl}/gmail-connect/authorize`, {
    headers: {
      authorization: "Bearer jeton",
      "x-organization-id": String(workspaceId),
    },
  });
  const { authUrl } = await res.json();
  return new URL(authUrl).searchParams.get("state");
};

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/gmail-connect", gmailConnectRouter);
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
  google.email = "attaquant@gmail.com";
  await seedOrgMembership({ userId: victimId, organizationId: victimOrg });
  await seedOrgMembership({ userId: attackerId, organizationId: attackerOrg });
});

describe("Connexion Gmail : state OAuth", () => {
  it("refuse un state fabriqué avec l'utilisateur et l'espace d'un autre", async () => {
    // Ancien format : JSON en base64, sans signature
    const forged = Buffer.from(
      JSON.stringify({
        userId: String(victimId),
        workspaceId: String(victimOrg),
        scanPeriodMonths: 3,
        issuedAt: Date.now(),
      }),
    ).toString("base64");

    const location = await callback(forged);

    expect(location).toContain("gmail_error=invalid_state");
    expect(await GmailConnection.countDocuments()).toBe(0);
  });

  it("refuse un state signé dont l'espace a été modifié", async () => {
    const state = await authorize(attackerId, attackerOrg);
    const [encoded, signature] = state.split(".");
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString());
    const tampered = Buffer.from(
      JSON.stringify({ ...data, workspaceId: String(victimOrg) }),
    ).toString("base64url");

    const location = await callback(`${tampered}.${signature}`);

    expect(location).toContain("gmail_error=invalid_state");
    expect(await GmailConnection.countDocuments()).toBe(0);
  });

  it("rattache la boîte à l'espace de celui qui a lancé la connexion, une seule fois", async () => {
    google.email = "victime@gmail.com";
    const state = await authorize(victimId, victimOrg);

    expect(await callback(state)).toContain("gmail_connected=true");
    const connection = await GmailConnection.findOne().lean();
    expect(String(connection.userId)).toBe(String(victimId));
    expect(String(connection.workspaceId)).toBe(String(victimOrg));
    expect(connection.accountEmail).toBe("victime@gmail.com");

    // Rejeu du même state (lien de retour récupéré) : refusé
    google.email = "attaquant@gmail.com";
    expect(await callback(state)).toContain("gmail_error=invalid_state");
    const after = await GmailConnection.findOne().lean();
    expect(after.accountEmail).toBe("victime@gmail.com");
  });

  it("refuse un state expiré", async () => {
    const expired = createSignedState(
      "gmail-connect",
      {
        userId: String(victimId),
        workspaceId: String(victimOrg),
        scanPeriodMonths: 3,
      },
      -1000,
    );
    expect(await callback(expired)).toContain("gmail_error=state_expired");
    expect(await GmailConnection.countDocuments()).toBe(0);
  });

  it("refuse si l'utilisateur n'a plus le droit sur l'espace au retour", async () => {
    const state = await authorize(victimId, victimOrg);
    await GmailConnection.db
      .collection("member")
      .deleteMany({ userId: victimId });

    const location = await callback(state);

    expect(location).toContain("gmail_error=");
    expect(location).not.toContain("gmail_connected");
    expect(await GmailConnection.countDocuments()).toBe(0);
  });
});
