import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import metaApi, {
  classifyMetaError,
} from "../../../../src/services/social/direct/metaApi.js";
import instagramApi from "../../../../src/services/social/direct/instagramApi.js";
import { timing } from "../../../../src/services/social/direct/directHttp.js";
import {
  callsTo,
  formOf,
  jsonOf,
  jsonResponse,
  on,
  sequence,
  stubFetch,
} from "./fetchStub.js";

const NOW = new Date("2026-11-02T08:00:00.000Z");
const page = {
  _id: "acc_fb",
  platform: "facebook",
  externalAccountId: "1001",
};
const igAccount = {
  _id: "acc_ig",
  platform: "instagram",
  externalAccountId: "17841400000000001",
};
const image = (n) => ({
  url: `https://api.newbi.test/social-media/${n}.jpg`,
  width: 1080,
  height: 1080,
});
const graphError = (code, subcode, status = 400, message = "Erreur") =>
  jsonResponse(
    {
      error: { message, type: "OAuthException", code, error_subcode: subcode },
    },
    status,
  );

beforeEach(() => {
  vi.unstubAllGlobals();
  timing.sleep = async () => {};
  process.env.META_APP_ID = "meta_app";
  process.env.META_APP_SECRET = "meta_secret";
  process.env.INSTAGRAM_APP_ID = "ig_app";
  process.env.INSTAGRAM_APP_SECRET = "ig_secret";
  delete process.env.META_LOGIN_CONFIG_ID;
  delete process.env.META_GRAPH_VERSION;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Facebook : connexion", () => {
  it("adresse d'autorisation : version épinglée, scope ou configuration Login for Business", () => {
    process.env.META_GRAPH_VERSION = "v27.0";
    const withScope = new URL(
      metaApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: "https://api.newbi.test/social-connect/facebook/callback",
      }),
    );
    expect(withScope.origin + withScope.pathname).toBe(
      "https://www.facebook.com/v27.0/dialog/oauth",
    );
    expect(withScope.searchParams.get("client_id")).toBe("meta_app");
    expect(withScope.searchParams.get("state")).toBe("etat");
    expect(withScope.searchParams.get("scope")).toBe(
      "pages_show_list,pages_read_engagement,pages_manage_posts",
    );

    process.env.META_LOGIN_CONFIG_ID = "cfg_123";
    const withConfig = new URL(
      metaApi.buildAuthorizeUrl({ state: "etat", redirectUri: "https://x" }),
    );
    expect(withConfig.searchParams.get("config_id")).toBe("cfg_123");
    expect(withConfig.searchParams.get("scope")).toBeNull();
  });

  it("code → jeton longue durée → une page par page publiable (jeton de page)", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "fb_exchange_token",
        jsonResponse({ access_token: "user_long", expires_in: 5183944 }),
      ),
      on(
        "GET",
        "/oauth/access_token",
        jsonResponse({ access_token: "user_short", expires_in: 3600 }),
      ),
      on("GET", "/me?fields=id", jsonResponse({ id: "meta_user_7" })),
      on(
        "GET",
        "/me/accounts",
        jsonResponse({
          data: [
            {
              id: "1001",
              name: "Boulangerie",
              access_token: "page_token_1",
              tasks: ["CREATE_CONTENT", "ANALYZE"],
              picture: { data: { url: "https://cdn/p.jpg" } },
            },
            // Analyste seulement : ne peut pas publier
            {
              id: "1002",
              name: "Autre",
              access_token: "page_token_2",
              tasks: ["ANALYZE"],
            },
          ],
        }),
      ),
    ]);
    const { accounts } = await metaApi.exchangeCode({
      code: "code_1",
      redirectUri: "https://api.newbi.test/social-connect/facebook/callback",
    });
    expect(accounts).toEqual([
      expect.objectContaining({
        platform: "facebook",
        externalAccountId: "1001",
        displayName: "Boulangerie",
        avatarUrl: "https://cdn/p.jpg",
        credentials: { accessToken: "page_token_1", tokenExpiresAt: null },
        // Identifiant de l'utilisateur pour notre appli (rappels de Meta)
        platformData: { metaUserId: "meta_user_7" },
      }),
    ]);
    // Le jeton longue durée sert à lire les pages
    const pagesCall = callsTo(fetchMock, "GET", "/me/accounts")[0];
    expect(new URL(pagesCall[0]).searchParams.get("access_token")).toBe(
      "user_long",
    );
  });
});

describe("Facebook : publication", () => {
  it("texte seul, une photo, plusieurs photos (attached_media) et permalien", async () => {
    const fetchMock = stubFetch([
      on("POST", "/1001/feed", jsonResponse({ id: "1001_9" })),
      on(
        "POST",
        "/1001/photos",
        sequence(
          jsonResponse({ id: "ph_1", post_id: "1001_8" }),
          jsonResponse({ id: "ph_2" }),
          jsonResponse({ id: "ph_3" }),
        ),
      ),
      on(
        "GET",
        "fields=permalink_url",
        jsonResponse({ permalink_url: "https://facebook.com/1001/posts/9" }),
      ),
    ]);
    const text = await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "Bonjour",
      media: [],
    });
    expect(text).toEqual({
      status: "published",
      externalPostId: "1001_9",
      platformPostUrl: "https://facebook.com/1001/posts/9",
    });
    expect(formOf(callsTo(fetchMock, "POST", "/1001/feed")[0])).toMatchObject({
      message: "Bonjour",
      access_token: "page_token",
    });

    const single = await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "Photo",
      media: [image(1)],
    });
    expect(single.externalPostId).toBe("1001_8");
    expect(formOf(callsTo(fetchMock, "POST", "/1001/photos")[0])).toMatchObject(
      {
        url: image(1).url,
        caption: "Photo",
      },
    );

    await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "Album",
      media: [image(2), image(3)],
    });
    const photos = callsTo(fetchMock, "POST", "/1001/photos").slice(1);
    expect(photos.map((call) => formOf(call).published)).toEqual([
      "false",
      "false",
    ]);
    const feed = formOf(callsTo(fetchMock, "POST", "/1001/feed")[1]);
    expect(JSON.parse(feed["attached_media[0]"])).toEqual({
      media_fbid: "ph_2",
    });
    expect(JSON.parse(feed["attached_media[1]"])).toEqual({
      media_fbid: "ph_3",
    });
  });

  it("permalien illisible : publié quand même, sans adresse", async () => {
    stubFetch([
      on("POST", "/1001/feed", jsonResponse({ id: "1001_9" })),
      on("GET", "fields=permalink_url", graphError(1, null, 500)),
    ]);
    const result = await metaApi.publish({
      account: page,
      accessToken: "t",
      content: "Bonjour",
      media: [],
    });
    expect(result).toMatchObject({
      status: "published",
      platformPostUrl: null,
    });
  });

  it("erreurs : jeton révoqué, limite de débit (délai annoncé), doublon, image refusée", async () => {
    stubFetch([on("POST", "/1001/feed", graphError(190, 460, 401))]);
    await expect(
      metaApi.publish({
        account: page,
        accessToken: "t",
        content: "x",
        media: [],
      }),
    ).rejects.toMatchObject({
      authInvalid: true,
      category: "auth_expired",
      transient: false,
    });

    stubFetch([
      on(
        "POST",
        "/1001/feed",
        jsonResponse({ error: { message: "Limite", code: 32 } }, 400, {
          "x-business-use-case-usage": JSON.stringify({
            1001: [{ type: "pages", estimated_time_to_regain_access: 7 }],
          }),
        }),
      ),
    ]);
    await expect(
      metaApi.publish({
        account: page,
        accessToken: "t",
        content: "x",
        media: [],
      }),
    ).rejects.toMatchObject({
      transient: true,
      category: "platform_rate_limit",
      retryAfterMs: 7 * 60 * 1000,
    });

    stubFetch([on("POST", "/1001/feed", graphError(506, null))]);
    await expect(
      metaApi.publish({
        account: page,
        accessToken: "t",
        content: "x",
        media: [],
      }),
    ).rejects.toMatchObject({ category: "user_content", transient: false });

    stubFetch([on("POST", "/1001/photos", graphError(324, null))]);
    await expect(
      metaApi.publish({
        account: page,
        accessToken: "t",
        content: "x",
        media: [image(1)],
      }),
    ).rejects.toMatchObject({ category: "user_content" });
  });

  it("classement : erreur serveur passagère, permission retirée à reconnecter", () => {
    expect(
      classifyMetaError({ ok: false, status: 500 }, { error: { code: 2 } }),
    ).toMatchObject({ transient: true });
    expect(
      classifyMetaError({ ok: false, status: 403 }, { error: { code: 200 } }),
    ).toMatchObject({ authInvalid: true });
    expect(
      classifyMetaError({ ok: true, status: 200 }, { id: "1" }),
    ).toBeNull();
  });

  it("jeton de page non rafraîchissable : reconnexion", async () => {
    await expect(metaApi.refreshCredentials({})).rejects.toMatchObject({
      authInvalid: true,
    });
  });
});

describe("Instagram (Instagram Login)", () => {
  it("adresse d'autorisation : identifiant Instagram, permissions business", () => {
    const url = new URL(
      instagramApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: "https://api.newbi.test/social-connect/instagram/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.instagram.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("ig_app");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_content_publish",
    );
  });

  it("code → jeton longue durée de 60 jours → compte professionnel", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "api.instagram.com/oauth/access_token",
        jsonResponse({
          data: [
            {
              access_token: "ig_short",
              user_id: "999",
              permissions:
                "instagram_business_basic,instagram_business_content_publish",
            },
          ],
        }),
      ),
      on(
        "GET",
        "graph.instagram.com/access_token",
        jsonResponse({ access_token: "ig_long", expires_in: 5184000 }),
      ),
      on(
        "GET",
        "/me?",
        jsonResponse({
          user_id: "17841400000000001",
          username: "boulangerie",
          name: "La Boulangerie",
          profile_picture_url: "https://cdn/ig.jpg",
          account_type: "BUSINESS",
        }),
      ),
    ]);
    const { accounts } = await instagramApi.exchangeCode({
      code: "code_1#_",
      redirectUri: "https://api.newbi.test/social-connect/instagram/callback",
      now: NOW,
    });
    expect(accounts[0]).toMatchObject({
      platform: "instagram",
      externalAccountId: "17841400000000001",
      username: "boulangerie",
      credentials: {
        accessToken: "ig_long",
        tokenExpiresAt: new Date(NOW.getTime() + 5184000 * 1000),
      },
    });
    // « #_ » retiré du code
    expect(
      formOf(callsTo(fetchMock, "POST", "oauth/access_token")[0]).code,
    ).toBe("code_1");
  });

  it("rafraîchit le jeton lui-même (ig_refresh_token)", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "refresh_access_token",
        jsonResponse({ access_token: "ig_new", expires_in: 5184000 }),
      ),
    ]);
    const fresh = await instagramApi.refreshCredentials({
      accessToken: "ig_old",
      now: NOW,
    });
    expect(fresh.accessToken).toBe("ig_new");
    const url = new URL(
      callsTo(fetchMock, "GET", "refresh_access_token")[0][0],
    );
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
  });

  it("carrousel : conteneurs, attente FINISHED, publication, permalien", async () => {
    const fetchMock = stubFetch([
      on("POST", "/media_publish", jsonResponse({ id: "ig_media_1" })),
      on(
        "POST",
        "/17841400000000001/media",
        sequence(
          jsonResponse({ id: "c1" }),
          jsonResponse({ id: "c2" }),
          jsonResponse({ id: "carousel" }),
        ),
      ),
      on(
        "GET",
        "/carousel?",
        sequence(
          jsonResponse({ status_code: "IN_PROGRESS" }),
          jsonResponse({ status_code: "FINISHED" }),
        ),
      ),
      on(
        "GET",
        "/ig_media_1?",
        jsonResponse({ permalink: "https://www.instagram.com/p/abc/" }),
      ),
    ]);
    const result = await instagramApi.publish({
      account: igAccount,
      accessToken: "ig_token",
      content: "Nouveautés",
      media: [image(1), image(2)],
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "ig_media_1",
      platformPostUrl: "https://www.instagram.com/p/abc/",
    });
    const creates = callsTo(fetchMock, "POST", "/17841400000000001/media");
    expect(jsonOf(creates[0])).toEqual({
      image_url: image(1).url,
      is_carousel_item: true,
    });
    expect(jsonOf(creates[2])).toEqual({
      media_type: "CAROUSEL",
      children: "c1,c2",
      caption: "Nouveautés",
    });
    expect(creates[0][1].headers.Authorization).toBe("Bearer ig_token");
    expect(jsonOf(callsTo(fetchMock, "POST", "/media_publish")[0])).toEqual({
      creation_id: "carousel",
    });
  });

  it("image refusée (conteneur en erreur, format) : erreur de contenu définitive", async () => {
    stubFetch([
      on("POST", "/media", jsonResponse({ id: "c1" })),
      on(
        "GET",
        "/c1?",
        jsonResponse({ status_code: "ERROR", status: "Error: 2207009" }),
      ),
    ]);
    await expect(
      instagramApi.publish({
        account: igAccount,
        accessToken: "t",
        content: "x",
        media: [image(1)],
      }),
    ).rejects.toMatchObject({
      category: "user_content",
      transient: false,
      subcode: 2207009,
    });
  });

  it("jeton expiré : reconnexion ; quota de 24 h atteint : quota_exhausted", async () => {
    stubFetch([on("POST", "/media", graphError(190, 463, 400))]);
    await expect(
      instagramApi.publish({
        account: igAccount,
        accessToken: "t",
        content: "x",
        media: [image(1)],
      }),
    ).rejects.toMatchObject({ authInvalid: true, network: "instagram" });

    stubFetch([
      on("POST", "/media_publish", graphError(9, 2207042, 400)),
      on("POST", "/media", jsonResponse({ id: "c1" })),
      on("GET", "/c1?", jsonResponse({ status_code: "FINISHED" })),
    ]);
    await expect(
      instagramApi.publish({
        account: igAccount,
        accessToken: "t",
        content: "x",
        media: [image(1)],
      }),
    ).rejects.toMatchObject({ category: "quota_exhausted" });
  });
});
