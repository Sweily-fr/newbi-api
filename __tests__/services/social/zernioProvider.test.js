import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import provider, {
  SocialProviderError,
  buildPostPayload,
  normalizePost,
} from "../../../src/services/social/providers/zernioProvider.js";
import { toUserError } from "../../../src/services/social/socialPostMessages.js";

const jsonResponse = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
  headers: new Map(Object.entries(headers)),
});

const stubFetch = (impl) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

const remotePost = (overrides = {}) => ({
  _id: "zp_1",
  status: "scheduled",
  scheduledFor: "2026-11-02T08:00:00.000Z",
  platforms: [
    { platform: "instagram", accountId: "za_ig", status: "pending" },
    {
      platform: "twitter",
      accountId: { _id: "za_x", username: "acme" },
      status: "pending",
    },
  ],
  ...overrides,
});

const createFields = {
  idempotencyKey: "key-123",
  content: "Bonjour",
  mediaUrls: ["https://media.zernio.com/a.jpg"],
  targets: [
    { platform: "instagram", externalAccountId: "za_ig" },
    { platform: "twitter", externalAccountId: "za_x" },
  ],
  scheduledFor: new Date("2026-11-02T08:00:00.000Z"),
  timezone: "Europe/Paris",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.ZERNIO_API_KEY = "sk_test_zernio";
  delete process.env.ZERNIO_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZERNIO_API_KEY;
});

describe("transport", () => {
  it("refuse tout appel sans clé (fonctionnalité désactivée)", async () => {
    delete process.env.ZERNIO_API_KEY;
    const fetchMock = stubFetch(async () => jsonResponse({}));
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.getPost("zp_1")).rejects.toMatchObject({
      kind: "config",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envoie la clé en Bearer sur l'URL configurée", async () => {
    process.env.ZERNIO_API_URL = "https://sandbox.zernio.test/api/v1/";
    const fetchMock = stubFetch(async () =>
      jsonResponse({ post: remotePost() }),
    );
    await provider.getPost("zp_1");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox.zernio.test/api/v1/posts/zp_1");
    expect(options.headers.Authorization).toBe("Bearer sk_test_zernio");
    expect(options.signal).toBeDefined();
  });
});

describe("createPost", () => {
  it("201 : post créé, cibles normalisées", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ post: remotePost() }, 201),
    );
    const result = await provider.createPost(createFields);

    expect(result.httpStatus).toBe(201);
    expect(result.incomplete).toBe(false);
    expect(result.post.externalPostId).toBe("zp_1");
    expect(result.post.targets).toEqual([
      expect.objectContaining({
        externalAccountId: "za_ig",
        status: "pending",
      }),
      expect.objectContaining({ externalAccountId: "za_x", status: "pending" }),
    ]);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://zernio.com/api/v1/posts");
    expect(options.method).toBe("POST");
    expect(options.headers["Idempotency-Key"]).toBe("key-123");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      content: "Bonjour",
      mediaItems: [{ type: "image", url: "https://media.zernio.com/a.jpg" }],
      platforms: [
        { platform: "instagram", accountId: "za_ig" },
        { platform: "twitter", accountId: "za_x" },
      ],
      scheduledFor: "2026-11-02T08:00:00.000Z",
      timezone: "Europe/Paris",
    });
  });

  it("207 : 2xx mais publication immédiate incomplète, statut lu dans le post", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          post: remotePost({
            status: "partial",
            platforms: [
              {
                platform: "instagram",
                accountId: "za_ig",
                status: "failed",
                errorCategory: "account_issue",
                errorMessage: "Not a business account",
              },
              {
                platform: "twitter",
                accountId: "za_x",
                status: "published",
                platformPostUrl: "https://x.com/acme/status/1",
              },
            ],
          }),
        },
        207,
      ),
    );
    const result = await provider.createPost({
      ...createFields,
      publishNow: true,
    });
    expect(result.httpStatus).toBe(207);
    expect(result.incomplete).toBe(true);
    expect(result.post.status).toBe("partial");
    expect(result.post.targets[0]).toMatchObject({
      status: "failed",
      errorCategory: "account_issue",
    });
    expect(result.post.targets[1]).toMatchObject({
      status: "published",
      platformPostUrl: "https://x.com/acme/status/1",
    });
  });

  it("409 doublon : erreur normalisée, message français", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(
        {
          error:
            "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
          details: { existingPostId: "zp_old", platform: "instagram" },
        },
        409,
      ),
    );
    const error = await provider
      .createPost(createFields, { retryDelayMs: 0 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SocialProviderError);
    expect(error.status).toBe(409);
    expect(error.details.existingPostId).toBe("zp_old");
    // Pas de rejeu sur un doublon de contenu
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUserError(error, "create").message).toMatch(
      /déjà été programmé ou publié sur ce compte/,
    );
  });

  it("400 : refus de validation, pas de rejeu", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(
        {
          error: "Instagram requires media",
          type: "invalid_request_error",
          code: "invalid_field_value",
        },
        400,
      ),
    );
    const error = await provider
      .createPost(createFields, { retryDelayMs: 0 })
      .catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_field_value");
    expect(error.transient).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toUserError(error, "create").message).toBe(
      "Publication refusée : Instagram requires media",
    );
  });

  it("402 : barrière de facturation, message support Newbi", async () => {
    stubFetch(async () =>
      jsonResponse(
        {
          error: "X requires a payment method",
          code: "PAYMENT_REQUIRED",
          reason: "twitter_passthrough",
        },
        402,
      ),
    );
    const error = await provider
      .getConnectUrl({
        platform: "twitter",
        externalProfileId: "prof_1",
        redirectUrl: "https://api.newbi.fr/social-connect/callback?state=abc",
      })
      .catch((e) => e);
    expect(error.status).toBe(402);
    expect(error.reason).toBe("twitter_passthrough");
    expect(toUserError(error, "connect").message).toBe(
      "Connexion momentanément indisponible, contactez le support Newbi",
    );
  });

  it("délai dépassé : rejoué avec la même Idempotency-Key, puis erreur passagère", async () => {
    const fetchMock = stubFetch(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("This operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const error = await provider
      .createPost(createFields, { retryDelayMs: 0, timeoutMs: 20 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SocialProviderError);
    expect(error.kind).toBe("timeout");
    expect(error.transient).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map(
      ([, options]) => options.headers["Idempotency-Key"],
    );
    expect(new Set(keys)).toEqual(new Set(["key-123"]));
    expect(toUserError(error, "create").message).toBe(
      "Le service de publication ne répond pas. Réessayez dans quelques minutes.",
    );
  });

  it("coupure puis succès : le post déjà créé est repris (pas de doublon)", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse({ post: remotePost() }, 200);
    });
    const result = await provider.createPost(createFields, {
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(result.post.externalPostId).toBe("zp_1");
  });
});

describe("réglages TikTok et autres appels", () => {
  it("ajoute tiktokSettings (carrousel photo, consentement) seulement si TikTok est visé", () => {
    const payload = buildPostPayload({
      content: "Texte complet du post",
      mediaUrls: ["https://media.zernio.com/a.jpg"],
      targets: [{ platform: "tiktok", externalAccountId: "za_tt" }],
      publishNow: true,
      tiktokSettings: {
        privacyLevel: "SELF_ONLY",
        allowComment: false,
        brandOrganic: true,
      },
    });
    expect(payload.publishNow).toBe(true);
    expect(payload.scheduledFor).toBeUndefined();
    expect(payload.tiktokSettings).toEqual({
      privacyLevel: "SELF_ONLY",
      allowComment: false,
      contentPreviewConfirmed: true,
      expressConsentGiven: true,
      mediaType: "photo",
      photoCoverIndex: 0,
      description: "Texte complet du post",
      commercialContentType: "brand_organic",
    });

    const withoutTikTok = buildPostPayload({
      content: "x",
      targets: [{ platform: "facebook", externalAccountId: "za_fb" }],
      tiktokSettings: { privacyLevel: "SELF_ONLY", allowComment: true },
    });
    expect(withoutTikTok.tiktokSettings).toBeUndefined();
  });

  it("suppression d'un post déjà supprimé (404) : succès", async () => {
    stubFetch(async () => jsonResponse({ error: "Not found" }, 404));
    await expect(provider.deletePost("zp_1")).resolves.toEqual({
      alreadyGone: true,
    });
  });

  it("comptes : avatar, jeton expiré et comptes non publiables", async () => {
    stubFetch(async () =>
      jsonResponse({
        accounts: [
          {
            _id: "za_ig",
            platform: "instagram",
            username: "acme",
            displayName: "Acme",
            profilePicture: "https://cdn/acme.jpg",
            isActive: true,
          },
          {
            _id: "za_fb",
            platform: "facebook",
            username: "acme",
            isActive: true,
            needsReconnection: true,
          },
          {
            _id: "za_ads",
            platform: "facebook",
            isActive: true,
            enabled: false,
          },
        ],
      }),
    );
    const accounts = await provider.listAccounts("prof_1");
    expect(accounts[0]).toMatchObject({
      externalAccountId: "za_ig",
      avatarUrl: "https://cdn/acme.jpg",
      active: true,
      enabled: true,
    });
    expect(accounts[1].active).toBe(false);
    expect(accounts[2].enabled).toBe(false);
  });

  it("normalise les statuts des cibles (processing → publishing)", () => {
    const post = normalizePost(
      remotePost({
        status: "publishing",
        platforms: [
          { platform: "tiktok", accountId: "za_tt", status: "processing" },
        ],
      }),
    );
    expect(post.status).toBe("publishing");
    expect(post.targets[0].status).toBe("publishing");
    expect(normalizePost({ _id: "d", status: "draft" }).status).toBeNull();
  });
});
