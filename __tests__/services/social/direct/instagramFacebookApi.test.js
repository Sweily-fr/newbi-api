import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import instagramFacebookApi, {
  metaAppCredentials,
} from "../../../../src/services/social/direct/instagramFacebookApi.js";
import { timing } from "../../../../src/services/social/direct/directHttp.js";
import { targetErrorMessage } from "../../../../src/services/social/socialPostMessages.js";
import { callsTo, jsonOf, jsonResponse, on, stubFetch } from "./fetchStub.js";

const NOW = new Date("2026-11-02T08:00:00.000Z");
const account = {
  _id: "acc_ig",
  platform: "instagram",
  connector: "facebook",
  externalAccountId: "17841400000000001",
};
const VIDEO_URL =
  "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4";
const video = { kind: "video", url: VIDEO_URL, durationMs: 30000 };
const sound = (fields = {}) => ({
  soundId: "audio_42",
  title: "Titre",
  volume: 80,
  videoVolume: 50,
  ...fields,
});

beforeEach(() => {
  vi.unstubAllGlobals();
  timing.sleep = async () => {};
  process.env.META_APP_ID = "meta_app";
  process.env.META_APP_SECRET = "meta_secret";
  delete process.env.META_INSTAGRAM_FB_APP_ID;
  delete process.env.META_INSTAGRAM_FB_APP_SECRET;
  delete process.env.META_INSTAGRAM_LOGIN_CONFIG_ID;
  delete process.env.META_GRAPH_VERSION;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Instagram via Facebook : appli et connexion", () => {
  it("identifiants : appli dédiée si la paire est complète, sinon celle des Pages", () => {
    expect(metaAppCredentials()).toEqual({
      appId: "meta_app",
      appSecret: "meta_secret",
    });
    // Paire incomplète : ignorée
    process.env.META_INSTAGRAM_FB_APP_ID = "ig_fb_app";
    expect(metaAppCredentials().appId).toBe("meta_app");
    process.env.META_INSTAGRAM_FB_APP_SECRET = "ig_fb_secret";
    expect(metaAppCredentials()).toEqual({
      appId: "ig_fb_app",
      appSecret: "ig_fb_secret",
    });
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    expect(instagramFacebookApi.isConfigured()).toBe(true);
    delete process.env.META_INSTAGRAM_FB_APP_ID;
    expect(instagramFacebookApi.isConfigured()).toBe(false);
  });

  it("fenêtre Facebook Login : configuration dédiée, sinon permissions Instagram par scope", () => {
    const redirectUri =
      "https://api.newbi.test/social-connect/instagram_facebook/callback";
    const withScope = new URL(
      instagramFacebookApi.buildAuthorizeUrl({ state: "etat", redirectUri }),
    );
    expect(withScope.origin + withScope.pathname).toBe(
      "https://www.facebook.com/v26.0/dialog/oauth",
    );
    expect(withScope.searchParams.get("client_id")).toBe("meta_app");
    expect(withScope.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(withScope.searchParams.get("scope")).toBe(
      "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement",
    );

    process.env.META_INSTAGRAM_LOGIN_CONFIG_ID = "cfg_ig";
    process.env.META_INSTAGRAM_FB_APP_ID = "ig_fb_app";
    process.env.META_INSTAGRAM_FB_APP_SECRET = "ig_fb_secret";
    const withConfig = new URL(
      instagramFacebookApi.buildAuthorizeUrl({ state: "etat", redirectUri }),
    );
    expect(withConfig.searchParams.get("config_id")).toBe("cfg_ig");
    expect(withConfig.searchParams.get("scope")).toBeNull();
    expect(withConfig.searchParams.get("client_id")).toBe("ig_fb_app");
  });

  it("code → jeton utilisateur longue durée → un compte Instagram par Page publiable", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "fb_exchange_token",
        jsonResponse({ access_token: "user_long", expires_in: 5184000 }),
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
              id: "p1",
              name: "Boulangerie",
              tasks: ["CREATE_CONTENT"],
              instagram_business_account: {
                id: "17841400000000001",
                username: "boulangerie",
                name: "La Boulangerie",
                profile_picture_url: "https://cdn/ig.jpg",
              },
            },
            // Page sans compte Instagram
            { id: "p2", name: "Sans Insta", tasks: ["MANAGE"] },
            // Analyste seulement
            {
              id: "p3",
              name: "Autre",
              tasks: ["ANALYZE"],
              instagram_business_account: { id: "17841400000000003" },
            },
          ],
        }),
      ),
    ]);
    const { accounts } = await instagramFacebookApi.exchangeCode({
      code: "code_1",
      redirectUri:
        "https://api.newbi.test/social-connect/instagram_facebook/callback",
      now: NOW,
    });
    expect(accounts).toEqual([
      {
        platform: "instagram",
        externalAccountId: "17841400000000001",
        username: "boulangerie",
        displayName: "La Boulangerie",
        avatarUrl: "https://cdn/ig.jpg",
        credentials: {
          accessToken: "user_long",
          tokenExpiresAt: new Date(NOW.getTime() + 5184000 * 1000),
          scopes: [],
        },
        credentialGroup: "meta-user:meta_user_7",
        platformData: {
          pageId: "p1",
          pageName: "Boulangerie",
          metaUserId: "meta_user_7",
        },
      },
    ]);
    const pages = new URL(callsTo(fetchMock, "GET", "/me/accounts")[0][0]);
    expect(pages.searchParams.get("fields")).toContain(
      "instagram_business_account{id,username,name,profile_picture_url}",
    );
    expect(pages.searchParams.get("access_token")).toBe("user_long");
  });

  it("aucune Page avec un compte Instagram : liste vide", async () => {
    stubFetch([
      on("GET", "fb_exchange_token", jsonResponse({ access_token: "l" })),
      on("GET", "/oauth/access_token", jsonResponse({ access_token: "s" })),
      on("GET", "/me?fields=id", jsonResponse({ id: "u" })),
      on("GET", "/me/accounts", jsonResponse({ data: [] })),
    ]);
    const { accounts } = await instagramFacebookApi.exchangeCode({
      code: "c",
      redirectUri: "https://x",
      now: NOW,
    });
    expect(accounts).toEqual([]);
  });

  it("rafraîchissement par fb_exchange_token ; sans expires_in : pas d'expiration", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "fb_exchange_token",
        jsonResponse({ access_token: "user_new" }),
      ),
    ]);
    const fresh = await instagramFacebookApi.refreshCredentials({
      accessToken: "user_old",
      now: NOW,
    });
    expect(fresh).toEqual({ accessToken: "user_new", tokenExpiresAt: null });
    const url = new URL(callsTo(fetchMock, "GET", "fb_exchange_token")[0][0]);
    expect(url.searchParams.get("fb_exchange_token")).toBe("user_old");
    expect(url.searchParams.get("client_secret")).toBe("meta_secret");
  });
});

describe("Instagram via Facebook : sons", () => {
  it("tendances : ig_audio sans search_query, jeton utilisateur, champs convertis", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/ig_audio",
        jsonResponse({
          audio: [
            {
              audio_id: "a1",
              title: "Été",
              display_artist: "Artiste",
              duration_in_ms: 31000,
              cover_artwork_thumbnail_uri: "https://cdn/cover.jpg",
              download_url: "https://cdn/a1.m4a",
              audio_type: "music",
            },
            { title: "Sans identifiant" },
          ],
        }),
      ),
    ]);
    const sounds = await instagramFacebookApi.listSounds({
      account,
      accessToken: "user_token",
    });
    expect(sounds).toEqual([
      {
        id: "a1",
        title: "Été",
        artist: "Artiste",
        coverUrl: "https://cdn/cover.jpg",
        previewUrl: "https://cdn/a1.m4a",
        durationMs: 31000,
        rank: null,
        kind: "music",
      },
    ]);
    const url = new URL(callsTo(fetchMock, "GET", "/ig_audio")[0][0]);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/ig_audio",
    );
    expect(url.searchParams.get("audio_type")).toBe("music");
    expect(url.searchParams.get("user_id")).toBe("17841400000000001");
    expect(url.searchParams.get("search_query")).toBeNull();
    expect(url.searchParams.get("access_token")).toBe("user_token");
  });

  it("recherche de sons originaux, 50 résultats au plus", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/ig_audio",
        jsonResponse({
          audio: Array.from({ length: 60 }, (_, i) => ({
            audio_id: `o${i}`,
            title: `Son ${i}`,
            ig_username: "createur",
            audio_type: "original_sound",
          })),
        }),
      ),
    ]);
    const sounds = await instagramFacebookApi.listSounds({
      account,
      accessToken: "t",
      search: "plage",
      kind: "original_sound",
    });
    expect(sounds).toHaveLength(50);
    expect(sounds[0]).toMatchObject({
      artist: "createur",
      kind: "original_sound",
    });
    const url = new URL(callsTo(fetchMock, "GET", "/ig_audio")[0][0]);
    expect(url.searchParams.get("search_query")).toBe("plage");
    expect(url.searchParams.get("audio_type")).toBe("original_sound");
  });

  it("Reel avec son : audio_configuration en JSON, volume 0 envoyé comme 1", async () => {
    const fetchMock = stubFetch([
      on("POST", "/17841400000000001/media", jsonResponse({ id: "c_r" })),
    ]);
    await instagramFacebookApi.publish({
      account,
      accessToken: "user_token",
      content: "Reel",
      media: [video],
      instagramSettings: {
        format: "post",
        sound: sound({ volume: 80, videoVolume: 0 }),
      },
    });
    const body = jsonOf(callsTo(fetchMock, "POST", "/media")[0]);
    expect(body).toMatchObject({ media_type: "REELS", caption: "Reel" });
    expect(JSON.parse(body.audio_configuration)).toEqual({
      audio_id: "audio_42",
      audio_volume: 80,
      video_volume: 1,
    });
  });

  it("son refusé par Meta : catégorie sound_rejected et message français", async () => {
    stubFetch([
      on(
        "POST",
        "/17841400000000001/media",
        jsonResponse(
          {
            error: {
              message: "Invalid parameter: audio_id is not available",
              code: 100,
            },
          },
          400,
        ),
      ),
    ]);
    const error = await instagramFacebookApi
      .publish({
        account,
        accessToken: "t",
        content: "",
        media: [video],
        instagramSettings: { format: "post", sound: sound() },
      })
      .catch((e) => e);
    expect(error).toMatchObject({
      category: "sound_rejected",
      transient: false,
    });
    expect(
      targetErrorMessage({
        status: "failed",
        platform: "instagram",
        errorCategory: error.category,
      }),
    ).toBe(
      "Le son choisi n'est plus disponible sur Instagram. Choisissez-en un autre.",
    );
  });

  it("Instagram Login : jamais de son (API Audio réservée à Facebook Login)", async () => {
    const { default: instagramApi } =
      await import("../../../../src/services/social/direct/instagramApi.js");
    const fetchMock = stubFetch([
      on("POST", "/17841400000000001/media", jsonResponse({ id: "c_r" })),
    ]);
    await instagramApi.publish({
      account,
      accessToken: "t",
      content: "",
      media: [video],
      instagramSettings: { format: "post", sound: sound() },
    });
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/media")[0]).audio_configuration,
    ).toBeUndefined();
  });
});
