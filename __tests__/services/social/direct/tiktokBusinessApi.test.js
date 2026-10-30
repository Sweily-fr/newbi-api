import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import tiktokBusinessApi, {
  classifyBusinessError,
  redirectUri,
} from "../../../../src/services/social/direct/tiktokBusinessApi.js";
import tiktokApi from "../../../../src/services/social/direct/tiktokApi.js";
import { timing } from "../../../../src/services/social/direct/directHttp.js";
import storage from "../../../../src/services/social/socialMediaStorage.js";
import { targetErrorMessage } from "../../../../src/services/social/socialPostMessages.js";
import {
  callsTo,
  jsonOf,
  jsonResponse,
  on,
  sequence,
  stubFetch,
} from "./fetchStub.js";

const NOW = new Date("2026-11-02T08:00:00.000Z");
const AUTH_URL =
  "https://www.tiktok.com/v2/auth/authorize?client_key=biz_key&scope=user.info.basic%2Cvideo.publish&response_type=code&redirect_uri=https%3A%2F%2Fapi.newbi.test%2Fsocial-connect%2Ftiktok_business%2Fcallback%2F";
const account = {
  _id: "acc_tt",
  platform: "tiktok",
  connector: "business",
  externalAccountId: "open_biz",
  username: "boulangerie",
  displayName: "La Boulangerie",
};
const VIDEO_URL =
  "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4";
const video = { kind: "video", url: VIDEO_URL, durationMs: 30000 };
const image = (n) => ({
  url: `https://api.newbi.test/social-media/${n}.jpg`,
  width: 1080,
  height: 1080,
});
const ok = (data = {}) =>
  jsonResponse({ code: 0, message: "OK", request_id: "r", data });
const fail = (code, message, status = 200) =>
  jsonResponse({ code, message, request_id: "r", data: {} }, status);
const settings = (fields = {}) =>
  ok({
    privacy_level_options: [
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "SELF_ONLY",
    ],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: true,
    max_video_post_duration_sec: 600,
    ...fields,
  });
const direct = (fields = {}) => ({
  mode: "direct",
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  brandOrganic: true,
  brandContent: false,
  ...fields,
});
const sound = { soundId: "clip_7", title: "Tube", volume: 80, videoVolume: 50 };

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  timing.sleep = async () => {};
  Object.assign(process.env, {
    NEXT_PUBLIC_API_URL: "https://api.newbi.test",
    TIKTOK_BUSINESS_APP_ID: "biz_app",
    TIKTOK_BUSINESS_APP_SECRET: "biz_secret",
    TIKTOK_BUSINESS_AUTH_URL: AUTH_URL,
    TIKTOK_CLIENT_KEY: "tt_key",
    TIKTOK_CLIENT_SECRET: "tt_secret",
  });
  vi.spyOn(storage, "prepareTikTokImage").mockImplementation(
    async (media) => `${media.url}?tiktok`,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TikTok Business : connexion et jetons", () => {
  it("adresse d'autorisation du portail, avec state et disable_auto_auth", () => {
    const url = new URL(tiktokBusinessApi.buildAuthorizeUrl({ state: "etat" }));
    expect(url.searchParams.get("client_key")).toBe("biz_key");
    expect(url.searchParams.get("state")).toBe("etat");
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
  });

  it("adresse de retour : celle de l'adresse d'autorisation, sinon la nôtre avec « / » final", () => {
    expect(redirectUri()).toBe(
      "https://api.newbi.test/social-connect/tiktok_business/callback/",
    );
    process.env.TIKTOK_BUSINESS_AUTH_URL =
      "https://www.tiktok.com/v2/auth/authorize?client_key=biz_key";
    expect(redirectUri()).toBe(
      "https://api.newbi.test/social-connect/tiktok_business/callback/",
    );
    process.env.TIKTOK_BUSINESS_AUTH_URL =
      "https://www.tiktok.com/v2/auth/authorize?redirect_uri=https%3A%2F%2Fautre.test%2Fcb%2F";
    expect(redirectUri()).toBe("https://autre.test/cb/");
    delete process.env.TIKTOK_BUSINESS_AUTH_URL;
    expect(tiktokBusinessApi.isConfigured()).toBe(false);
  });

  it("code → jeton (JSON, auth_code) → profil : compte open_id", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/tt_user/oauth2/token/",
        ok({
          access_token: "biz_access",
          expires_in: 86400,
          refresh_token: "biz_refresh",
          refresh_token_expires_in: 31536000,
          open_id: "open_biz",
          scope: "user.info.basic,video.publish,video.upload",
        }),
      ),
      on(
        "GET",
        "/business/get/",
        ok({
          username: "boulangerie",
          display_name: "La Boulangerie",
          profile_image: "https://cdn/p.jpg",
        }),
      ),
    ]);
    const { accounts } = await tiktokBusinessApi.exchangeCode({
      code: "code%2A1",
      redirectUri: redirectUri(),
      now: NOW,
    });
    expect(accounts).toEqual([
      {
        platform: "tiktok",
        externalAccountId: "open_biz",
        username: "boulangerie",
        displayName: "La Boulangerie",
        avatarUrl: "https://cdn/p.jpg",
        credentials: {
          accessToken: "biz_access",
          refreshToken: "biz_refresh",
          tokenExpiresAt: new Date(NOW.getTime() + 86400 * 1000),
          refreshTokenExpiresAt: new Date(NOW.getTime() + 31536000 * 1000),
          scopes: ["user.info.basic", "video.publish", "video.upload"],
        },
        credentialGroup: null,
        platformData: null,
      },
    ]);
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/tt_user/oauth2/token/")[0]),
    ).toEqual({
      client_id: "biz_app",
      client_secret: "biz_secret",
      grant_type: "authorization_code",
      auth_code: "code*1",
      redirect_uri:
        "https://api.newbi.test/social-connect/tiktok_business/callback/",
    });
    const profile = callsTo(fetchMock, "GET", "/business/get/")[0];
    expect(profile[1].headers["Access-Token"]).toBe("biz_access");
    const url = new URL(profile[0]);
    expect(url.searchParams.get("business_id")).toBe("open_biz");
    expect(JSON.parse(url.searchParams.get("fields"))).toEqual([
      "username",
      "display_name",
      "profile_image",
    ]);
  });

  it("profil illisible (permission absente) : compte connecté sans pseudo", async () => {
    stubFetch([
      on(
        "POST",
        "/tt_user/oauth2/token/",
        ok({ access_token: "a", open_id: "open_biz", expires_in: 86400 }),
      ),
      on("GET", "/business/get/", fail(40001, "No permission")),
    ]);
    const { accounts } = await tiktokBusinessApi.exchangeCode({
      code: "c",
      now: NOW,
    });
    expect(accounts[0]).toMatchObject({
      externalAccountId: "open_biz",
      username: null,
    });
  });

  it("rafraîchissement et révocation", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/tt_user/oauth2/refresh_token/",
        ok({ access_token: "new", refresh_token: "r2", expires_in: 86400 }),
      ),
      on("POST", "/tt_user/oauth2/revoke/", ok({})),
    ]);
    const fresh = await tiktokBusinessApi.refreshCredentials({
      refreshToken: "r1",
      now: NOW,
    });
    expect(fresh).toMatchObject({ accessToken: "new", refreshToken: "r2" });
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/refresh_token/")[0]),
    ).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1" });
    await tiktokBusinessApi.revoke({ accessToken: "new" });
    expect(jsonOf(callsTo(fetchMock, "POST", "/revoke/")[0])).toEqual({
      client_id: "biz_app",
      client_secret: "biz_secret",
      access_token: "new",
    });
  });

  it("réglages du compte lus dans /business/video/settings/", async () => {
    stubFetch([on("GET", "/business/video/settings/", settings())]);
    const info = await tiktokBusinessApi.getCreatorInfo({
      accessToken: "t",
      account,
    });
    expect(info).toMatchObject({
      username: "boulangerie",
      nickname: "La Boulangerie",
      commentDisabled: false,
      stitchDisabled: true,
      maxVideoPostDurationSec: 600,
      privacyLevels: [
        { value: "PUBLIC_TO_EVERYONE", label: "PUBLIC_TO_EVERYONE" },
        { value: "MUTUAL_FOLLOW_FRIENDS", label: "MUTUAL_FOLLOW_FRIENDS" },
        { value: "SELF_ONLY", label: "SELF_ONLY" },
      ],
    });
  });
});

describe("TikTok Business : publication", () => {
  it("vidéo avec son : music_sound_info avec les deux volumes, couverture, réglages coupés respectés", async () => {
    const fetchMock = stubFetch([
      on("GET", "/business/video/settings/", settings()),
      on(
        "POST",
        "/business/video/publish/",
        ok({ share_id: "v_pub_url~v1.1" }),
      ),
    ]);
    const result = await tiktokBusinessApi.publish({
      account,
      accessToken: "t",
      content: "Nouveauté #pain",
      media: [video],
      tiktokSettings: direct({ sound }),
    });
    expect(result).toMatchObject({
      status: "publishing",
      externalPostId: "v_pub_url~v1.1",
    });
    const call = callsTo(fetchMock, "POST", "/business/video/publish/")[0];
    expect(call[1].headers["Access-Token"]).toBe("t");
    expect(jsonOf(call)).toEqual({
      business_id: "open_biz",
      video_url: VIDEO_URL,
      post_info: {
        caption: "Nouveauté #pain",
        is_brand_organic: true,
        is_branded_content: false,
        disable_comment: false,
        disable_duet: false,
        // Coupé par le créateur
        disable_stitch: true,
        thumbnail_offset: 1000,
        music_sound_info: {
          music_sound_id: "clip_7",
          music_sound_volume: 80,
          video_original_sound_volume: 50,
        },
      },
    });
  });

  it("vidéo sans son : aucun volume envoyé (son d'origine gardé)", async () => {
    const fetchMock = stubFetch([
      on("GET", "/business/video/settings/", settings()),
      on("POST", "/business/video/publish/", ok({ share_id: "s" })),
    ]);
    await tiktokBusinessApi.publish({
      account,
      accessToken: "t",
      content: "",
      media: [video],
      tiktokSettings: direct(),
    });
    const { post_info: info } = jsonOf(
      callsTo(fetchMock, "POST", "/business/video/publish/")[0],
    );
    expect(info.music_sound_info).toBeUndefined();
    expect(info.caption).toBeUndefined();
  });

  it("vidéo : toujours publique ; durée maximale du compte contrôlée", async () => {
    stubFetch([on("GET", "/business/video/settings/", settings())]);
    await expect(
      tiktokBusinessApi.publish({
        account,
        accessToken: "t",
        content: "",
        media: [video],
        tiktokSettings: direct({ privacyLevel: "SELF_ONLY" }),
      }),
    ).rejects.toMatchObject({ category: "user_content" });

    stubFetch([
      on(
        "GET",
        "/business/video/settings/",
        settings({ max_video_post_duration_sec: 10 }),
      ),
    ]);
    await expect(
      tiktokBusinessApi.publish({
        account,
        accessToken: "t",
        content: "",
        media: [video],
        tiktokSettings: direct(),
      }),
    ).rejects.toMatchObject({ category: "video_too_long" });
  });

  it("vidéo en brouillon : upload_to_draft, sans lecture des réglages", async () => {
    const fetchMock = stubFetch([
      on("POST", "/business/video/publish/", ok({ share_id: "s" })),
    ]);
    await tiktokBusinessApi.publish({
      account,
      accessToken: "t",
      content: "Texte ignoré en brouillon",
      media: [video],
      tiktokSettings: { mode: "draft" },
    });
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/business/video/publish/")[0])
        .post_info,
    ).toEqual({
      upload_to_draft: true,
      is_brand_organic: false,
      is_branded_content: false,
    });
    expect(callsTo(fetchMock, "GET", "/business/video/settings/")).toHaveLength(
      0,
    );
  });

  it("photos avec son : music_sound_info, pas de musique automatique, confidentialité choisie", async () => {
    const fetchMock = stubFetch([
      on("GET", "/business/video/settings/", settings()),
      on("POST", "/business/photo/publish/", ok({ share_id: "p_pub" })),
    ]);
    await tiktokBusinessApi.publish({
      account,
      accessToken: "t",
      content: "Album",
      media: [image(1), image(2)],
      tiktokSettings: direct({ privacyLevel: "SELF_ONLY", sound }),
      workspaceId: "ws",
    });
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/business/photo/publish/")[0]),
    ).toEqual({
      business_id: "open_biz",
      photo_images: [`${image(1).url}?tiktok`, `${image(2).url}?tiktok`],
      photo_cover_index: 0,
      post_info: {
        caption: "Album",
        privacy_level: "SELF_ONLY",
        disable_comment: false,
        auto_add_music: false,
        is_brand_organic: true,
        is_branded_content: false,
        music_sound_info: { music_sound_id: "clip_7" },
      },
    });
  });

  it("photos sans son : musique proposée par TikTok ; confidentialité plus proposée refusée", async () => {
    const fetchMock = stubFetch([
      on("GET", "/business/video/settings/", settings()),
      on("POST", "/business/photo/publish/", ok({ share_id: "p_pub" })),
    ]);
    await tiktokBusinessApi.publish({
      account,
      accessToken: "t",
      content: "",
      media: [image(1)],
      tiktokSettings: direct({ privacyLevel: "MUTUAL_FOLLOW_FRIENDS" }),
    });
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/business/photo/publish/")[0])
        .post_info.auto_add_music,
    ).toBe(true);
    await expect(
      tiktokBusinessApi.publish({
        account,
        accessToken: "t",
        content: "",
        media: [image(1)],
        tiktokSettings: direct({ privacyLevel: "FOLLOWER_OF_CREATOR" }),
      }),
    ).rejects.toMatchObject({ code: "privacy_level_option_mismatch" });
  });

  it("photos en brouillon : is_draft avec le texte, sans lecture des réglages", async () => {
    const fetchMock = stubFetch([
      on("POST", "/business/photo/publish/", ok({ share_id: "p_pub" })),
    ]);
    await tiktokBusinessApi.publish({
      account,
      accessToken: "t",
      content: "Mon texte",
      media: [image(1)],
      tiktokSettings: { mode: "draft" },
    });
    expect(
      jsonOf(callsTo(fetchMock, "POST", "/business/photo/publish/")[0])
        .post_info,
    ).toMatchObject({ is_draft: true, caption: "Mon texte" });
    expect(callsTo(fetchMock, "GET", "/business/video/settings/")).toHaveLength(
      0,
    );
  });

  it("suivi : en cours, publié (adresse), brouillon livré, échec", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/business/publish/status/",
        sequence(
          ok({ status: "PROCESSING_DOWNLOAD" }),
          jsonResponse(
            '{"code":0,"message":"OK","data":{"status":"PUBLISH_COMPLETE","post_ids":["7300000000000000001"]}}',
          ),
          ok({ status: "SEND_TO_USER_INBOX" }),
          ok({ status: "FAILED", reason: "frame_rate_check_failed" }),
        ),
      ),
    ]);
    const check = () =>
      tiktokBusinessApi.checkPublication({
        account,
        accessToken: "t",
        externalPostId: "v_pub_url~v1.1",
        media: [video],
      });
    expect(await check()).toEqual({
      status: "publishing",
      externalPostId: "v_pub_url~v1.1",
      platformPostUrl: null,
    });
    expect(await check()).toEqual({
      status: "published",
      externalPostId: "7300000000000000001",
      platformPostUrl:
        "https://www.tiktok.com/@boulangerie/video/7300000000000000001",
    });
    expect(await check()).toEqual({
      status: "published",
      deliveredAs: "draft",
      externalPostId: "v_pub_url~v1.1",
      platformPostUrl: null,
    });
    await expect(check()).rejects.toMatchObject({
      category: "video_rejected",
    });
    const url = new URL(callsTo(fetchMock, "GET", "/publish/status/")[0][0]);
    expect(url.searchParams.get("business_id")).toBe("open_biz");
    expect(url.searchParams.get("publish_id")).toBe("v_pub_url~v1.1");
  });

  it("classement des codes de retour", () => {
    const classify = (code, message = "", status = 200) =>
      classifyBusinessError({ ok: status < 400, status }, { code, message });
    expect(classify(0)).toBeNull();
    expect(classify(40105, "Invalid access token")).toMatchObject({
      category: "auth_expired",
      authInvalid: true,
    });
    expect(classify(40102)).toMatchObject({ authInvalid: true });
    expect(classify(40100, "Requests made too frequently")).toMatchObject({
      category: "platform_rate_limit",
      transient: true,
    });
    expect(classify(40002, "music_sound_id is invalid")).toMatchObject({
      category: "sound_rejected",
    });
    expect(classify(40002, "caption too long")).toMatchObject({
      category: "platform_rejected",
    });
    expect(classify(50000, "System error")).toMatchObject({ transient: true });
    expect(
      classify(40001, "spam_risk_too_many_posts: too many posts"),
    ).toMatchObject({ category: "quota_exhausted" });
    expect(classify(40907, "The file is too large")).toMatchObject({
      category: "user_content",
    });
    expect(
      classifyBusinessError({ ok: false, status: 503 }, null),
    ).toMatchObject({ transient: true });
  });

  it("tendances : FR sur 7 jours, identifiant de l'extrait, durée en secondes, rang", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/discovery/cml/trending_list/",
        ok({
          list: [
            {
              commercial_music_id: "cm_1",
              commercial_music_name: "Tube",
              artist: "Artiste",
              duration: 123,
              thumbnail_url: "https://cdn/t.jpg",
              preview_url: "https://cdn/p.mp3",
              rank_position: "1",
              trending_song_clip: {
                song_clip_id: "clip_trend",
                preview_url: "https://cdn/trend.mp3",
              },
              full_duration_song_clip: { song_clip_id: "clip_full" },
            },
            {
              commercial_music_id: "cm_2",
              commercial_music_name: "Autre",
              duration: 0,
              rank_position: "2",
              full_duration_song_clip: { song_clip_id: "clip_full_2" },
            },
          ],
        }),
      ),
    ]);
    const sounds = await tiktokBusinessApi.listSounds({
      account,
      accessToken: "t",
    });
    expect(sounds).toEqual([
      {
        id: "clip_trend",
        title: "Tube",
        artist: "Artiste",
        coverUrl: "https://cdn/t.jpg",
        previewUrl: "https://cdn/trend.mp3",
        durationMs: 123000,
        rank: 1,
        kind: null,
      },
      {
        id: "clip_full_2",
        title: "Autre",
        artist: null,
        coverUrl: null,
        previewUrl: null,
        durationMs: null,
        rank: 2,
        kind: null,
      },
    ]);
    const url = new URL(callsTo(fetchMock, "GET", "/trending_list/")[0][0]);
    expect(url.searchParams.get("business_id")).toBe("open_biz");
    expect(url.searchParams.get("country_code")).toBe("FR");
    expect(url.searchParams.get("date_range")).toBe("7DAY");
  });
});

describe("TikTok (Content Posting) : brouillons", () => {
  const ttAccount = {
    platform: "tiktok",
    externalAccountId: "open_1",
    username: "boulangerie",
  };
  const ttOk = (data) => jsonResponse({ data, error: { code: "ok" } });

  it("vidéo : /inbox/video/init/ sans texte ni creator_info", async () => {
    const fetchMock = stubFetch([
      on("POST", "/post/publish/inbox/video/init/", ttOk({ publish_id: "p1" })),
    ]);
    const result = await tiktokApi.publish({
      account: ttAccount,
      accessToken: "act",
      content: "Texte non transmis",
      media: [video],
      tiktokSettings: { mode: "draft" },
    });
    expect(result).toMatchObject({
      status: "publishing",
      externalPostId: "p1",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/inbox/video/init/")[0])).toEqual(
      {
        source_info: { source: "PULL_FROM_URL", video_url: VIDEO_URL },
      },
    );
    expect(callsTo(fetchMock, "POST", "creator_info")).toHaveLength(0);
  });

  it("photos : MEDIA_UPLOAD avec la description", async () => {
    const fetchMock = stubFetch([
      on("POST", "/post/publish/content/init/", ttOk({ publish_id: "p2" })),
    ]);
    await tiktokApi.publish({
      account: ttAccount,
      accessToken: "act",
      content: "Album",
      media: [image(1)],
      tiktokSettings: { mode: "draft" },
      workspaceId: "ws",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/content/init/")[0])).toEqual({
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { description: "Album" },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: [`${image(1).url}?tiktok`],
      },
    });
  });

  it("SEND_TO_USER_INBOX : brouillon livré ; 5 brouillons en attente : quota avec détail", async () => {
    stubFetch([
      on(
        "POST",
        "/post/publish/status/fetch/",
        ttOk({ status: "SEND_TO_USER_INBOX" }),
      ),
    ]);
    expect(
      await tiktokApi.checkPublication({
        account: ttAccount,
        accessToken: "act",
        externalPostId: "p1",
        media: [video],
      }),
    ).toEqual({
      status: "published",
      deliveredAs: "draft",
      externalPostId: "p1",
      platformPostUrl: null,
    });

    stubFetch([
      on(
        "POST",
        "/post/publish/inbox/video/init/",
        jsonResponse(
          {
            error: {
              code: "spam_risk_too_many_pending_share",
              message: "too many pending",
            },
          },
          403,
        ),
      ),
    ]);
    const error = await tiktokApi
      .publish({
        account: ttAccount,
        accessToken: "act",
        content: "",
        media: [video],
        tiktokSettings: { mode: "draft" },
      })
      .catch((e) => e);
    expect(error).toMatchObject({ category: "quota_exhausted" });
    expect(
      targetErrorMessage({
        status: "failed",
        platform: "tiktok",
        errorCategory: error.category,
        errorMessage: error.detail,
      }),
    ).toBe(
      "TikTok limite le nombre de publications. TikTok limite à 5 brouillons en attente par 24 heures.",
    );
  });
});
