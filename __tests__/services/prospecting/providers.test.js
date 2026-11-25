/**
 * Prospection, fournisseurs de boîte (aucun appel réel : fetch et MSAL
 * simulés) : adresse d'autorisation Google (client dédié, gmail.send,
 * accès hors ligne, consentement), échange du code, envoi Gmail
 * (users.messages.send, MIME en base64url, identifiants gardés) et Graph
 * (/me/sendMail, MIME en base64, 202), classement des erreurs (jeton
 * refusé, quota, adresse refusée, erreur passagère), droit d'envoi accordé.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const msal = vi.hoisted(() => ({
  config: null,
  authUrlRequest: null,
  codeRequest: null,
  refreshRequest: null,
  result: null,
  error: null,
  cache: {},
}));
vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    constructor(config) {
      msal.config = config;
    }
    async getAuthCodeUrl(request) {
      msal.authUrlRequest = request;
      return `https://login.microsoftonline.test/authorize?state=${request.state}`;
    }
    async acquireTokenByCode(request) {
      msal.codeRequest = request;
      if (msal.error) throw msal.error;
      return msal.result;
    }
    async acquireTokenByRefreshToken(request) {
      msal.refreshRequest = request;
      if (msal.error) throw msal.error;
      return msal.result;
    }
    getTokenCache() {
      return { serialize: () => JSON.stringify(msal.cache) };
    }
  },
}));

import * as google from "../../../src/services/prospecting/providers/google.js";
import * as microsoft from "../../../src/services/prospecting/providers/microsoft.js";
import {
  hasSendScope,
  mailProvider,
} from "../../../src/services/prospecting/providers/index.js";

const calls = [];
let responder = null;
const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

beforeEach(() => {
  calls.length = 0;
  responder = null;
  vi.stubGlobal("fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!responder) throw new Error("appel réseau inattendu");
    return responder(String(url), options);
  });
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "calendar-id");
  vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_ID", "ms-id");
  vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_SECRET", "ms-secret");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.exemple.test");
  Object.assign(msal, {
    result: null,
    error: null,
    cache: {},
    authUrlRequest: null,
    codeRequest: null,
    refreshRequest: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const MIME =
  "From: <jean@atelier.fr>\r\nTo: x@y.fr\r\nSubject: Bonjour\r\n\r\nCorps é";

describe("Google", () => {
  it("adresse d'autorisation : client dédié, gmail.send, hors ligne, consentement", () => {
    const url = new URL(google.getAuthUrl("etat-signe"));
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      client_id: "google-id",
      redirect_uri: "https://api.exemple.test/mailbox-connect/google/callback",
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      state: "etat-signe",
    });
    expect(params.scope.split(" ")).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "openid",
      "email",
      "profile",
    ]);
  });

  it("sans identifiants dédiés : refus, jamais le client du calendrier", () => {
    vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "");
    expect(() => google.getAuthUrl("x")).toThrow(/non configurée/);
  });

  it("échange du code : jetons, expiration et droits accordés", async () => {
    responder = () =>
      json(200, {
        access_token: "acces",
        refresh_token: "rafraichissement",
        expires_in: 3599,
        scope: "openid https://www.googleapis.com/auth/gmail.send email",
      });
    const before = Date.now();
    const tokens = await google.exchangeCode("code-google");
    expect(tokens).toMatchObject({
      accessToken: "acces",
      refreshToken: "rafraichissement",
    });
    expect(tokens.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 3599 * 1000,
    );
    const body = new URLSearchParams(calls[0].options.body);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(body)).toMatchObject({
      code: "code-google",
      client_id: "google-id",
      client_secret: "google-secret",
      grant_type: "authorization_code",
    });
  });

  it("jeton de rafraîchissement refusé (invalid_grant) : AUTH", async () => {
    responder = () =>
      json(400, { error: "invalid_grant", error_description: "Token revoked" });
    await expect(google.refreshAccessToken("ancien")).rejects.toMatchObject({
      kind: "AUTH",
      code: "invalid_grant",
    });
  });

  it("envoi : MIME en base64url, identifiant et conversation gardés", async () => {
    responder = () => json(200, { id: "msg-1", threadId: "thread-1" });
    const result = await google.sendMessage({
      accessToken: "acces",
      mime: MIME,
    });
    expect(result).toEqual({
      providerMessageId: "msg-1",
      threadId: "thread-1",
    });
    expect(calls[0].url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    expect(calls[0].options.headers.Authorization).toBe("Bearer acces");
    const { raw } = JSON.parse(calls[0].options.body);
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, "base64url").toString("utf8")).toBe(MIME);
  });

  it("erreurs classées : 401, quota, 429, adresse refusée, 5xx, réseau", async () => {
    const kindOf = async (response) => {
      responder = () => response;
      return google
        .sendMessage({ accessToken: "a", mime: MIME })
        .catch((error) => error.kind);
    };
    expect(
      await kindOf(json(401, { error: { message: "Invalid Credentials" } })),
    ).toBe("AUTH");
    expect(
      await kindOf(
        json(403, {
          error: {
            message: "Daily user sending limit exceeded",
            errors: [{ reason: "dailyLimitExceeded" }],
          },
        }),
      ),
    ).toBe("QUOTA");
    expect(await kindOf(json(429, { error: { message: "Too many" } }))).toBe(
      "QUOTA",
    );
    expect(
      await kindOf(
        json(403, {
          error: {
            message: "Request had insufficient authentication scopes.",
            errors: [{ reason: "insufficientPermissions" }],
          },
        }),
      ),
    ).toBe("AUTH");
    expect(
      await kindOf(json(400, { error: { message: "Invalid To header" } })),
    ).toBe("RECIPIENT");
    expect(
      await kindOf(json(503, { error: { message: "Backend Error" } })),
    ).toBe("TEMPORARY");
    responder = () => {
      throw new Error("ECONNRESET");
    };
    const network = await google
      .sendMessage({ accessToken: "a", mime: MIME })
      .catch((error) => error);
    expect(network.kind).toBe("TEMPORARY");
  });

  it("révocation au mieux (sans erreur si Google ne répond pas)", async () => {
    responder = () => json(200, {});
    expect(await google.revokeToken("jeton")).toBe(true);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    responder = () => {
      throw new Error("réseau");
    };
    expect(await google.revokeToken("jeton")).toBe(false);
  });
});

describe("Microsoft", () => {
  it("adresse d'autorisation MSAL : autorité common, Mail.Send, User.Read, offline_access", async () => {
    const url = await microsoft.getAuthUrl("etat");
    expect(url).toContain("state=etat");
    expect(msal.config.auth).toMatchObject({
      clientId: "ms-id",
      clientSecret: "ms-secret",
      authority: "https://login.microsoftonline.com/common",
    });
    expect(msal.authUrlRequest).toMatchObject({
      scopes: [
        "https://graph.microsoft.com/Mail.Send",
        "https://graph.microsoft.com/User.Read",
        "offline_access",
      ],
      redirectUri:
        "https://api.exemple.test/mailbox-connect/microsoft/callback",
      prompt: "consent",
    });
  });

  it("repli sur l'appli du calendrier sans identifiants dédiés", async () => {
    vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_ID", "");
    vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_SECRET", "");
    vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_ID", "cal-id");
    vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_SECRET", "cal-secret");
    await microsoft.getAuthUrl("etat");
    expect(msal.config.auth.clientId).toBe("cal-id");
  });

  it("échange du code : jeton de rafraîchissement lu dans le cache MSAL", async () => {
    msal.result = {
      accessToken: "acces-ms",
      expiresOn: new Date("2026-11-25T11:00:00Z"),
      scopes: ["Mail.Send", "User.Read"],
    };
    msal.cache = { RefreshToken: { cle: { secret: "rafraichissement-ms" } } };
    expect(await microsoft.exchangeCode("code")).toEqual({
      accessToken: "acces-ms",
      refreshToken: "rafraichissement-ms",
      expiresAt: new Date("2026-11-25T11:00:00Z"),
      scopes: ["Mail.Send", "User.Read"],
    });
  });

  it("rafraîchissement refusé (invalid_grant) : AUTH ; panne : TEMPORARY", async () => {
    msal.error = Object.assign(new Error("AADSTS70008: expired"), {
      errorCode: "invalid_grant",
    });
    await expect(microsoft.refreshAccessToken("ancien")).rejects.toMatchObject({
      kind: "AUTH",
    });
    msal.error = Object.assign(new Error("network_error"), {
      errorCode: "network_error",
    });
    await expect(microsoft.refreshAccessToken("ancien")).rejects.toMatchObject({
      kind: "TEMPORARY",
    });
  });

  it("envoi Graph : MIME en base64, texte brut, 202 sans identifiant", async () => {
    responder = () => new Response(null, { status: 202 });
    expect(
      await microsoft.sendMessage({ accessToken: "acces-ms", mime: MIME }),
    ).toEqual({ providerMessageId: null, threadId: null });
    expect(calls[0].url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(calls[0].options.headers).toMatchObject({
      Authorization: "Bearer acces-ms",
      "Content-Type": "text/plain",
    });
    expect(Buffer.from(calls[0].options.body, "base64").toString("utf8")).toBe(
      MIME,
    );
  });

  it("erreurs Graph classées", async () => {
    const kindOf = async (response) => {
      responder = () => response;
      return microsoft
        .sendMessage({ accessToken: "a", mime: MIME })
        .catch((error) => error.kind);
    };
    expect(
      await kindOf(
        json(401, { error: { code: "InvalidAuthenticationToken" } }),
      ),
    ).toBe("AUTH");
    expect(
      await kindOf(json(429, { error: { code: "ApplicationThrottled" } })),
    ).toBe("QUOTA");
    expect(
      await kindOf(
        json(403, {
          error: { code: "ErrorExceededMessageLimit", message: "x" },
        }),
      ),
    ).toBe("QUOTA");
    expect(
      await kindOf(json(400, { error: { code: "ErrorInvalidRecipients" } })),
    ).toBe("RECIPIENT");
    expect(
      await kindOf(json(503, { error: { code: "ServiceUnavailable" } })),
    ).toBe("TEMPORARY");
  });
});

describe("droit d'envoi accordé", () => {
  it("Google : gmail.send exigé ; Microsoft : Mail.Send (liste vide acceptée)", () => {
    expect(hasSendScope("GOOGLE", ["openid", "email"])).toBe(false);
    expect(
      hasSendScope("GOOGLE", ["https://www.googleapis.com/auth/gmail.send"]),
    ).toBe(true);
    expect(hasSendScope("MICROSOFT", ["User.Read"])).toBe(false);
    expect(
      hasSendScope("MICROSOFT", ["https://graph.microsoft.com/Mail.Send"]),
    ).toBe(true);
    expect(hasSendScope("MICROSOFT", [])).toBe(true);
    expect(() => mailProvider("YAHOO")).toThrow(/inconnu/);
  });
});
