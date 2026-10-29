import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import tiktokApi from "../../../../src/services/social/direct/tiktokApi.js";
import xApi from "../../../../src/services/social/direct/xApi.js";
import storage from "../../../../src/services/social/socialMediaStorage.js";
import { timing } from "../../../../src/services/social/direct/directHttp.js";
import { targetErrorMessage } from "../../../../src/services/social/socialPostMessages.js";
import {
  callsTo,
  formOf,
  jsonOf,
  jsonResponse,
  on,
  stubFetch,
} from "./fetchStub.js";

const NOW = new Date("2026-11-02T08:00:00.000Z");
const ok = { code: "ok", message: "", log_id: "log" };
const tiktokFail = (code, status = 400) =>
  jsonResponse(
    { data: {}, error: { code, message: code, log_id: "log" } },
    status,
  );
const creatorInfo = (fields = {}) =>
  jsonResponse({
    data: {
      creator_nickname: "La Boulangerie",
      creator_username: "boulangerie",
      privacy_level_options: [
        "PUBLIC_TO_EVERYONE",
        "MUTUAL_FOLLOW_FRIENDS",
        "SELF_ONLY",
      ],
      comment_disabled: false,
      ...fields,
    },
    error: ok,
  });
const tiktokAccount = {
  platform: "tiktok",
  externalAccountId: "open_1",
  username: "boulangerie",
};
const xAccount = {
  platform: "twitter",
  externalAccountId: "42",
  username: "acme",
};
const image = (n) => ({
  url: `https://api.newbi.test/social-media/${n}.jpg`,
  width: 2048,
  height: 2048,
});
const settings = {
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  brandOrganic: true,
  brandContent: false,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  timing.sleep = async () => {};
  process.env.TIKTOK_CLIENT_KEY = "tt_key";
  process.env.TIKTOK_CLIENT_SECRET = "tt_secret";
  process.env.X_CLIENT_ID = "x_client";
  process.env.X_CLIENT_SECRET = "x_secret";
  vi.spyOn(storage, "prepareTikTokImage").mockImplementation(
    async (media) => `${media.url}?tiktok`,
  );
  vi.spyOn(storage, "fetchImage").mockResolvedValue({
    buffer: Buffer.from("jpeg"),
    contentType: "image/jpeg",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TikTok : connexion et jetons", () => {
  it("adresse d'autorisation : client_key, permissions séparées par des virgules, sans PKCE", () => {
    const url = new URL(
      tiktokApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: "https://api.newbi.test/social-connect/tiktok/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.tiktok.com/v2/auth/authorize/",
    );
    expect(url.searchParams.get("client_key")).toBe("tt_key");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });

  it("code → jetons (24 h / 1 an), compte, pseudo lu dans creator_info", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/oauth/token/",
        jsonResponse({
          access_token: "act.1",
          expires_in: 86400,
          refresh_token: "rft.1",
          refresh_expires_in: 31536000,
          open_id: "open_1",
          scope: "user.info.basic,video.publish",
          token_type: "Bearer",
        }),
      ),
      on(
        "GET",
        "/user/info/",
        jsonResponse({
          data: {
            user: {
              open_id: "open_1",
              display_name: "Boulangerie",
              avatar_url: "https://a",
            },
          },
          error: ok,
        }),
      ),
      on("POST", "/creator_info/query/", creatorInfo()),
    ]);
    const { accounts } = await tiktokApi.exchangeCode({
      code: "code%2A",
      redirectUri: "https://api.newbi.test/social-connect/tiktok/callback",
      now: NOW,
    });
    expect(accounts[0]).toMatchObject({
      platform: "tiktok",
      externalAccountId: "open_1",
      username: "boulangerie",
      displayName: "Boulangerie",
      credentials: {
        accessToken: "act.1",
        refreshToken: "rft.1",
        tokenExpiresAt: new Date(NOW.getTime() + 86400 * 1000),
      },
    });
    expect(accounts[0].credentials.openId).toBeUndefined();
    expect(
      formOf(callsTo(fetchMock, "POST", "/oauth/token/")[0]),
    ).toMatchObject({
      client_key: "tt_key",
      client_secret: "tt_secret",
      grant_type: "authorization_code",
      code: "code*",
    });
  });

  it("rafraîchissement : nouveau jeton de rafraîchissement gardé ; refusé → reconnexion", async () => {
    stubFetch([
      on(
        "POST",
        "/oauth/token/",
        jsonResponse({
          access_token: "act.2",
          expires_in: 86400,
          refresh_token: "rft.2",
        }),
      ),
    ]);
    const fresh = await tiktokApi.refreshCredentials({
      refreshToken: "rft.1",
      now: NOW,
    });
    expect(fresh).toMatchObject({
      accessToken: "act.2",
      refreshToken: "rft.2",
    });

    stubFetch([
      on(
        "POST",
        "/oauth/token/",
        jsonResponse(
          {
            error: "invalid_grant",
            error_description: "Refresh token is invalid",
          },
          400,
        ),
      ),
    ]);
    await expect(
      tiktokApi.refreshCredentials({ refreshToken: "rft.revoked" }),
    ).rejects.toMatchObject({ authInvalid: true, category: "auth_expired" });
  });
});

describe("TikTok : publication photo", () => {
  it("creator_info relu, photos tirées de notre domaine, publication asynchrone", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/creator_info/query/",
        creatorInfo({ comment_disabled: true }),
      ),
      on(
        "POST",
        "/post/publish/content/init/",
        jsonResponse({ data: { publish_id: "p_1" }, error: ok }),
      ),
    ]);
    const result = await tiktokApi.publish({
      account: tiktokAccount,
      accessToken: "act.1",
      content: "Nouveau pain\nTous les matins",
      media: [image(1), image(2)],
      tiktokSettings: settings,
      workspaceId: "ws",
    });
    expect(result).toEqual({
      status: "publishing",
      externalPostId: "p_1",
      platformPostUrl: null,
      username: "boulangerie",
    });
    const body = jsonOf(callsTo(fetchMock, "POST", "/content/init/")[0]);
    expect(body).toEqual({
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        description: "Nouveau pain\nTous les matins",
        privacy_level: "PUBLIC_TO_EVERYONE",
        // Commentaires coupés par le créateur : forcés
        disable_comment: true,
        auto_add_music: true,
        brand_content_toggle: false,
        brand_organic_toggle: true,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: [`${image(1).url}?tiktok`, `${image(2).url}?tiktok`],
      },
    });
    expect(storage.prepareTikTokImage).toHaveBeenCalledWith(image(1), "ws");
  });

  it("confidentialité plus proposée : refus avant l'envoi", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/creator_info/query/",
        creatorInfo({ privacy_level_options: ["SELF_ONLY"] }),
      ),
    ]);
    await expect(
      tiktokApi.publish({
        account: tiktokAccount,
        accessToken: "t",
        content: "x",
        media: [image(1)],
        tiktokSettings: settings,
      }),
    ).rejects.toMatchObject({
      category: "user_content",
      code: "privacy_level_option_mismatch",
    });
    expect(callsTo(fetchMock, "POST", "/content/init/")).toHaveLength(0);
  });

  it("erreurs : jeton invalide, limite de débit, compte non audité, trop de posts (en HTTP 200)", async () => {
    const publish = () =>
      tiktokApi.publish({
        account: tiktokAccount,
        accessToken: "t",
        content: "x",
        media: [image(1)],
        tiktokSettings: settings,
      });
    stubFetch([
      on(
        "POST",
        "/creator_info/query/",
        tiktokFail("access_token_invalid", 401),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({ authInvalid: true });

    stubFetch([
      on("POST", "/creator_info/query/", creatorInfo()),
      on("POST", "/content/init/", tiktokFail("rate_limit_exceeded", 429)),
    ]);
    await expect(publish()).rejects.toMatchObject({
      transient: true,
      category: "platform_rate_limit",
    });

    stubFetch([
      on("POST", "/creator_info/query/", creatorInfo()),
      on(
        "POST",
        "/content/init/",
        tiktokFail("unaudited_client_can_only_post_to_private_accounts", 403),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      category: "account_issue",
    });

    stubFetch([
      on(
        "POST",
        "/creator_info/query/",
        tiktokFail("spam_risk_too_many_posts", 200),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      category: "quota_exhausted",
    });
  });

  it("suivi : en cours, publié avec adresse, échec (image refusée)", async () => {
    stubFetch([
      on(
        "POST",
        "/status/fetch/",
        jsonResponse({ data: { status: "PROCESSING_DOWNLOAD" }, error: ok }),
      ),
    ]);
    await expect(
      tiktokApi.checkPublication({
        account: tiktokAccount,
        accessToken: "t",
        externalPostId: "p_1",
      }),
    ).resolves.toMatchObject({ status: "publishing" });

    const fetchMock = stubFetch([
      on(
        "POST",
        "/status/fetch/",
        // Entier de 64 bits brut, comme TikTok le renvoie
        jsonResponse(
          '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}',
        ),
      ),
    ]);
    await expect(
      tiktokApi.checkPublication({
        account: tiktokAccount,
        accessToken: "t",
        externalPostId: "p_1",
      }),
    ).resolves.toEqual({
      status: "published",
      externalPostId: "7300000000000000001",
      platformPostUrl:
        "https://www.tiktok.com/@boulangerie/photo/7300000000000000001",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/status/fetch/")[0])).toEqual({
      publish_id: "p_1",
    });

    stubFetch([
      on(
        "POST",
        "/status/fetch/",
        jsonResponse({
          data: { status: "FAILED", fail_reason: "picture_size_check_failed" },
          error: ok,
        }),
      ),
    ]);
    await expect(
      tiktokApi.checkPublication({
        account: tiktokAccount,
        accessToken: "t",
        externalPostId: "p_1",
      }),
    ).rejects.toMatchObject({ category: "user_content", transient: false });
  });
});

describe("TikTok : message affiché", () => {
  it("appli pas encore auditée : posts privés seulement", () => {
    expect(
      targetErrorMessage({
        platform: "tiktok",
        status: "failed",
        errorCategory: "account_issue",
      }),
    ).toBe(
      "TikTok n'accepte pour l'instant que des posts « Moi uniquement » sur un compte privé.",
    );
  });
});

describe("X", () => {
  it("adresse d'autorisation avec PKCE S256 et offline.access", () => {
    const url = new URL(
      xApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: "http://127.0.0.1:4000/social-connect/twitter/callback",
        codeChallenge: "challenge",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      "tweet.read tweet.write users.read media.write offline.access",
    );
  });

  it("code + vérificateur → jetons (client confidentiel en Basic), compte", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/2/oauth2/token",
        jsonResponse({
          access_token: "x_access",
          refresh_token: "x_refresh",
          expires_in: 7200,
          scope: "tweet.read tweet.write users.read media.write offline.access",
        }),
      ),
      on(
        "GET",
        "/2/users/me",
        jsonResponse({
          data: {
            id: "42",
            username: "acme",
            name: "Acme",
            profile_image_url: "https://p",
          },
        }),
      ),
    ]);
    const { accounts } = await xApi.exchangeCode({
      code: "code",
      redirectUri: "http://127.0.0.1:4000/social-connect/twitter/callback",
      codeVerifier: "verifier",
      now: NOW,
    });
    expect(accounts[0]).toMatchObject({
      externalAccountId: "42",
      username: "acme",
      credentials: {
        accessToken: "x_access",
        refreshToken: "x_refresh",
        tokenExpiresAt: new Date(NOW.getTime() + 7200 * 1000),
      },
    });
    const tokenCall = callsTo(fetchMock, "POST", "/2/oauth2/token")[0];
    expect(tokenCall[1].headers.Authorization).toBe(
      `Basic ${Buffer.from("x_client:x_secret").toString("base64")}`,
    );
    expect(formOf(tokenCall)).toMatchObject({
      grant_type: "authorization_code",
      code_verifier: "verifier",
    });
  });

  it("image envoyée par l'API média v2 puis post, adresse publique", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/2/media/upload",
        jsonResponse({ data: { id: "m_1", media_key: "3_1" } }),
      ),
      on(
        "POST",
        "/2/tweets",
        jsonResponse(
          { data: { id: "1850000000000000000", text: "Bonjour" } },
          201,
        ),
      ),
    ]);
    const result = await xApi.publish({
      account: xAccount,
      accessToken: "x_access",
      content: "Bonjour",
      media: [image(1)],
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "1850000000000000000",
      platformPostUrl: "https://x.com/acme/status/1850000000000000000",
    });
    const upload = callsTo(fetchMock, "POST", "/2/media/upload")[0];
    expect(upload[1].body).toBeInstanceOf(FormData);
    expect(upload[1].body.get("media_category")).toBe("tweet_image");
    expect(jsonOf(callsTo(fetchMock, "POST", "/2/tweets")[0])).toEqual({
      text: "Bonjour",
      media: { media_ids: ["m_1"] },
    });
  });

  it("erreurs : jeton expiré, limite (reprise annoncée), doublon, crédits épuisés", async () => {
    const publish = () =>
      xApi.publish({
        account: xAccount,
        accessToken: "t",
        content: "x",
        media: [],
      });
    stubFetch([
      on(
        "POST",
        "/2/tweets",
        jsonResponse(
          { title: "Unauthorized", status: 401, detail: "Unauthorized" },
          401,
        ),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({ authInvalid: true });

    const reset = Math.floor(Date.now() / 1000) + 600;
    stubFetch([
      on(
        "POST",
        "/2/tweets",
        jsonResponse(
          { title: "Too Many Requests", type: "about:blank", status: 429 },
          429,
          { "x-rate-limit-reset": String(reset) },
        ),
      ),
    ]);
    const limited = await publish().catch((error) => error);
    expect(limited).toMatchObject({
      transient: true,
      category: "platform_rate_limit",
    });
    expect(limited.retryAfterMs).toBeGreaterThan(9 * 60 * 1000);

    stubFetch([
      on(
        "POST",
        "/2/tweets",
        jsonResponse(
          {
            detail:
              "You are not allowed to create a Tweet with duplicate content.",
            status: 403,
          },
          403,
        ),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      category: "user_content",
      authInvalid: false,
    });

    stubFetch([
      on(
        "POST",
        "/2/tweets",
        jsonResponse({ title: "CreditsDepleted", status: 402 }, 402),
      ),
    ]);
    await expect(publish()).rejects.toMatchObject({
      category: "quota_exhausted",
      transient: false,
    });
  });

  it("révocation à la déconnexion : jeton de rafraîchissement puis d'accès", async () => {
    const fetchMock = stubFetch([
      on("POST", "/2/oauth2/revoke", jsonResponse({ revoked: true })),
    ]);
    await xApi.revoke({ accessToken: "a", refreshToken: "r" });
    expect(callsTo(fetchMock, "POST", "/2/oauth2/revoke").map(formOf)).toEqual([
      { token: "r" },
      { token: "a" },
    ]);
  });
});
