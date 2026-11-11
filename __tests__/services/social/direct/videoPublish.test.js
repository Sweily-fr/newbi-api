import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import instagramApi from "../../../../src/services/social/direct/instagramApi.js";
import linkedinApi from "../../../../src/services/social/direct/linkedinApi.js";
import metaApi from "../../../../src/services/social/direct/metaApi.js";
import tiktokApi, {
  sliceUtf16,
} from "../../../../src/services/social/direct/tiktokApi.js";
import xApi from "../../../../src/services/social/direct/xApi.js";
import {
  DirectApiError,
  timing,
} from "../../../../src/services/social/direct/directHttp.js";
import storage from "../../../../src/services/social/socialMediaStorage.js";
import { targetErrorMessage } from "../../../../src/services/social/socialPostMessages.js";
import {
  callsTo,
  formOf,
  jsonOf,
  jsonResponse,
  on,
  sequence,
  stubFetch,
} from "./fetchStub.js";

const MB = 1024 * 1024;
const VIDEO_URL =
  "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4";
const video = (fields = {}) => ({
  kind: "video",
  url: VIDEO_URL,
  thumbnailUrl: VIDEO_URL.replace(".mp4", ".jpg"),
  width: 1080,
  height: 1920,
  durationMs: 30 * 1000,
  size: 10 * MB,
  contentType: "video/mp4",
  ...fields,
});
const NOW = new Date("2026-11-02T08:00:00.000Z");
const minutesAfter = (date, minutes) =>
  new Date(date.getTime() + minutes * 60 * 1000);

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  timing.sleep = vi.fn(async () => {});
  Object.assign(process.env, {
    NEXT_PUBLIC_API_URL: "https://api.newbi.test",
    META_APP_ID: "meta_app",
    META_APP_SECRET: "meta_secret",
    INSTAGRAM_APP_ID: "ig_app",
    INSTAGRAM_APP_SECRET: "ig_secret",
    LINKEDIN_CLIENT_ID: "li_client",
    LINKEDIN_CLIENT_SECRET: "li_secret",
    TIKTOK_CLIENT_KEY: "tt_key",
    TIKTOK_CLIENT_SECRET: "tt_secret",
    X_CLIENT_ID: "x_client",
    X_CLIENT_SECRET: "x_secret",
  });
  delete process.env.META_GRAPH_VERSION;
  // Octets relus par plage dans notre stockage (bornes incluses)
  vi.spyOn(storage, "readVideoRange").mockImplementation(
    async (url, start, end) => Buffer.alloc(end - start + 1, 7),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Instagram : Reel en deux temps", () => {
  const account = {
    platform: "instagram",
    externalAccountId: "17841400000000001",
  };

  it("publish crée le conteneur REELS (notre adresse, couverture à 1 s) sans attendre", async () => {
    const fetchMock = stubFetch([
      on("POST", "/17841400000000001/media", jsonResponse({ id: "c_1" })),
    ]);
    const result = await instagramApi.publish({
      account,
      accessToken: "ig_token",
      content: "Coulisses #boulangerie",
      media: [video()],
    });
    expect(result).toMatchObject({
      status: "publishing",
      processingRef: "c_1",
      externalPostId: null,
      nextCheckMs: 60000,
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/media")[0])).toEqual({
      media_type: "REELS",
      video_url: VIDEO_URL,
      share_to_feed: true,
      thumb_offset: 1000,
      caption: "Coulisses #boulangerie",
    });
    expect(callsTo(fetchMock, "GET", "/c_1")).toHaveLength(0);
  });

  it("suivi : en cours, puis prêt → publié avec l'adresse", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/c_1?",
        sequence(
          jsonResponse({ status_code: "IN_PROGRESS" }),
          jsonResponse({ status_code: "FINISHED" }),
        ),
      ),
      on("POST", "/media_publish", jsonResponse({ id: "m_1" })),
      on(
        "GET",
        "/m_1?",
        jsonResponse({ permalink: "https://www.instagram.com/reel/abc/" }),
      ),
    ]);
    const params = { account, accessToken: "ig_token", processingRef: "c_1" };
    expect(await instagramApi.checkPublication(params)).toEqual({
      status: "publishing",
      nextCheckMs: 60000,
    });
    expect(await instagramApi.checkPublication(params)).toEqual({
      status: "published",
      externalPostId: "m_1",
      platformPostUrl: "https://www.instagram.com/reel/abc/",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/media_publish")[0])).toEqual({
      creation_id: "c_1",
    });
  });

  it("conteneur en erreur : vidéo refusée ; expiré : publication à reprendre", async () => {
    stubFetch([
      on(
        "GET",
        "/c_1?",
        sequence(
          jsonResponse({
            status_code: "ERROR",
            status: "Error: Media upload has failed with error code 2207026",
          }),
          jsonResponse({ status_code: "EXPIRED" }),
        ),
      ),
    ]);
    const params = { account, accessToken: "ig_token", processingRef: "c_1" };
    const refused = await instagramApi.checkPublication(params).catch((e) => e);
    expect(refused).toBeInstanceOf(DirectApiError);
    expect(refused).toMatchObject({
      category: "video_rejected",
      transient: false,
    });
    const expired = await instagramApi.checkPublication(params).catch((e) => e);
    expect(expired).toMatchObject({ transient: true, restart: true });
  });
});

describe("Facebook : vidéo de page", () => {
  it("file_url vers notre route, description, adresse absolue", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "graph-video.facebook.com/v26.0/1001/videos",
        jsonResponse({ id: "v_1" }),
      ),
      on(
        "GET",
        "graph.facebook.com/v26.0/v_1?",
        jsonResponse({ permalink_url: "/acme/videos/v_1/" }),
      ),
    ]);
    const result = await metaApi.publish({
      account: { platform: "facebook", externalAccountId: "1001" },
      accessToken: "page_token",
      content: "Notre atelier",
      media: [video()],
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "v_1",
      platformPostUrl: "https://www.facebook.com/acme/videos/v_1/",
    });
    const form = formOf(callsTo(fetchMock, "POST", "/videos")[0]);
    expect(form).toMatchObject({
      file_url: VIDEO_URL,
      description: "Notre atelier",
      published: "true",
      access_token: "page_token",
    });
  });

  it("vidéo introuvable à l'adresse (389) : passager ; fichier refusé (352) : vidéo refusée", async () => {
    stubFetch([
      on(
        "POST",
        "/videos",
        sequence(
          jsonResponse(
            {
              error: {
                message: "Unable to fetch video file from URL.",
                code: 389,
              },
            },
            400,
          ),
          jsonResponse(
            {
              error: {
                message:
                  "The video file you selected is in a format that we don't support.",
                code: 352,
              },
            },
            400,
          ),
        ),
      ),
    ]);
    const params = {
      account: { platform: "facebook", externalAccountId: "1001" },
      accessToken: "page_token",
      content: "",
      media: [video()],
    };
    expect(await metaApi.publish(params).catch((e) => e)).toMatchObject({
      transient: true,
    });
    expect(await metaApi.publish(params).catch((e) => e)).toMatchObject({
      transient: false,
      category: "video_rejected",
    });
  });
});

describe("LinkedIn : Videos API", () => {
  const account = {
    platform: "linkedin",
    externalAccountId: "urn:li:organization:5",
  };
  const URN = "urn:li:video:C5505AQH";

  const initialized = jsonResponse({
    value: {
      video: URN,
      uploadToken: "",
      uploadUrlsExpireAt: 1,
      uploadInstructions: [
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/part1",
          firstByte: 0,
          lastByte: 4194303,
        },
        {
          uploadUrl: "https://www.linkedin.com/dms-uploads/part2",
          firstByte: 4194304,
          lastByte: 10 * MB - 1,
        },
      ],
    },
  });

  it("parties lues par plage, ETag de chaque partie, finalizeUpload, puis suivi", async () => {
    const fetchMock = stubFetch([
      on("POST", "action=initializeUpload", initialized),
      on(
        "PUT",
        "dms-uploads/part1",
        jsonResponse(undefined, 200, { ETag: '"etag-1"' }),
      ),
      on(
        "PUT",
        "dms-uploads/part2",
        jsonResponse(undefined, 200, { etag: "/ambry/etag-2.bin" }),
      ),
      on("POST", "action=finalizeUpload", jsonResponse(undefined, 200)),
    ]);
    const result = await linkedinApi.publish({
      account,
      accessToken: "li_token",
      content: "Vidéo",
      media: [video()],
    });
    expect(result).toMatchObject({
      status: "publishing",
      processingRef: URN,
      nextCheckMs: 30000,
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "initializeUpload")[0])).toEqual({
      initializeUploadRequest: {
        owner: "urn:li:organization:5",
        fileSizeBytes: 10 * MB,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    });
    expect(storage.readVideoRange).toHaveBeenCalledWith(VIDEO_URL, 0, 4194303);
    expect(storage.readVideoRange).toHaveBeenCalledWith(
      VIDEO_URL,
      4194304,
      10 * MB - 1,
    );
    expect(
      callsTo(fetchMock, "PUT", "part2")[0][1].headers["Content-Type"],
    ).toBe("application/octet-stream");
    expect(jsonOf(callsTo(fetchMock, "POST", "finalizeUpload")[0])).toEqual({
      finalizeUploadRequest: {
        video: URN,
        uploadToken: "",
        uploadedPartIds: ["etag-1", "/ambry/etag-2.bin"],
      },
    });
  });

  it("vidéo traitée (AVAILABLE) → post avec la vidéo ; échec du traitement → vidéo refusée", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        `/rest/videos/${encodeURIComponent(URN)}`,
        sequence(
          jsonResponse({ id: URN, status: "PROCESSING" }),
          jsonResponse({ id: URN, status: "AVAILABLE" }),
          jsonResponse({
            id: URN,
            status: "PROCESSING_FAILED",
            processingFailureReason: "Unsupported codec",
          }),
        ),
      ),
      on(
        "POST",
        "/rest/posts",
        jsonResponse(undefined, 201, {
          "x-restli-id": "urn:li:share:7000",
        }),
      ),
    ]);
    const params = {
      account,
      accessToken: "li_token",
      processingRef: URN,
      submittedAt: NOW,
      content: "Vidéo #atelier",
      now: minutesAfter(NOW, 1),
    };
    expect(await linkedinApi.checkPublication(params)).toEqual({
      status: "publishing",
      nextCheckMs: 30000,
    });
    expect(await linkedinApi.checkPublication(params)).toEqual({
      status: "published",
      externalPostId: "urn:li:share:7000",
      platformPostUrl:
        "https://www.linkedin.com/feed/update/urn:li:share:7000/",
    });
    const body = jsonOf(callsTo(fetchMock, "POST", "/rest/posts")[0]);
    expect(body.content).toEqual({ media: { id: URN } });
    expect(body.commentary).toBe("Vidéo #atelier");
    const refused = await linkedinApi.checkPublication(params).catch((e) => e);
    expect(refused).toMatchObject({
      category: "video_rejected",
      detail: "Unsupported codec",
    });
  });

  it("statut illisible pour l'appli « Share » : post créé 2 minutes après le dépôt", async () => {
    stubFetch([
      on(
        "GET",
        "/rest/videos/",
        jsonResponse({ message: "Not enough permissions", status: 403 }, 403),
      ),
      on(
        "POST",
        "/rest/posts",
        jsonResponse(undefined, 201, { "x-restli-id": "urn:li:share:1" }),
      ),
    ]);
    const params = {
      account,
      accessToken: "li_token",
      processingRef: URN,
      submittedAt: NOW,
      content: "",
    };
    expect(
      (
        await linkedinApi.checkPublication({
          ...params,
          now: minutesAfter(NOW, 1),
        })
      ).status,
    ).toBe("publishing");
    expect(
      (
        await linkedinApi.checkPublication({
          ...params,
          now: minutesAfter(NOW, 3),
        })
      ).status,
    ).toBe("published");
  });
});

describe("X : envoi en morceaux v2", () => {
  const account = {
    platform: "twitter",
    externalAccountId: "42",
    username: "acme",
  };
  const uploadRoutes = (finalize) => [
    on(
      "POST",
      "/2/media/upload/initialize",
      jsonResponse({ data: { id: "m_9", media_key: "7_m_9" } }),
    ),
    on("POST", "/2/media/upload/m_9/append", jsonResponse(undefined, 204)),
    on("POST", "/2/media/upload/m_9/finalize", finalize),
  ];

  it("initialize, morceaux de 4 Mo, finalize, traitement court attendu sur place, post", async () => {
    const fetchMock = stubFetch([
      ...uploadRoutes(
        jsonResponse({
          data: {
            id: "m_9",
            processing_info: { state: "pending", check_after_secs: 5 },
          },
        }),
      ),
      on(
        "GET",
        "/2/media/upload?",
        sequence(
          jsonResponse({
            data: {
              id: "m_9",
              processing_info: { state: "in_progress", check_after_secs: 5 },
            },
          }),
          jsonResponse({
            data: { id: "m_9", processing_info: { state: "succeeded" } },
          }),
        ),
      ),
      on("POST", "/2/tweets", jsonResponse({ data: { id: "1850" } }, 201)),
    ]);
    const result = await xApi.publish({
      account,
      accessToken: "x_token",
      content: "Regardez",
      media: [video({ size: 10 * MB })],
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "1850",
      platformPostUrl: "https://x.com/acme/status/1850",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "initialize")[0])).toEqual({
      media_type: "video/mp4",
      total_bytes: 10 * MB,
      media_category: "tweet_video",
    });
    const appends = callsTo(fetchMock, "POST", "/append");
    expect(appends).toHaveLength(3);
    expect(appends.map(([, init]) => init.body.get("segment_index"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(appends[2][1].body.get("media").size).toBe(2 * MB);
    const status = callsTo(fetchMock, "GET", "/2/media/upload?")[0][0];
    expect(status).toContain("command=STATUS");
    expect(status).toContain("media_id=m_9");
    expect(jsonOf(callsTo(fetchMock, "POST", "/2/tweets")[0])).toEqual({
      text: "Regardez",
      media: { media_ids: ["m_9"] },
    });
  });

  it("traitement long : publication en deux temps (media_id gardé), puis post", async () => {
    const fetchMock = stubFetch([
      ...uploadRoutes(
        jsonResponse({
          data: {
            id: "m_9",
            processing_info: { state: "pending", check_after_secs: 90 },
          },
        }),
      ),
      on(
        "GET",
        "/2/media/upload?",
        jsonResponse({
          data: { id: "m_9", processing_info: { state: "succeeded" } },
        }),
      ),
      on("POST", "/2/tweets", jsonResponse({ data: { id: "1851" } }, 201)),
    ]);
    const params = {
      account,
      accessToken: "x_token",
      content: "",
      media: [video({ size: 3 * MB })],
    };
    expect(await xApi.publish(params)).toEqual({
      status: "publishing",
      externalPostId: null,
      processingRef: "m_9",
      platformPostUrl: null,
      nextCheckMs: 90000,
    });
    expect(callsTo(fetchMock, "POST", "/2/tweets")).toHaveLength(0);
    expect(
      await xApi.checkPublication({ ...params, processingRef: "m_9" }),
    ).toMatchObject({ status: "published", externalPostId: "1851" });
  });

  it("traitement en échec : vidéo refusée ; vidéo trop longue pour le compte (403) : pas une déconnexion", async () => {
    stubFetch([
      on(
        "GET",
        "/2/media/upload?",
        jsonResponse({
          data: {
            id: "m_9",
            processing_info: {
              state: "failed",
              error: { name: "InvalidMedia", message: "Unsupported video" },
            },
          },
        }),
      ),
      on(
        "POST",
        "/2/tweets",
        jsonResponse(
          {
            title: "Forbidden",
            detail:
              "This user is not allowed to post a video longer than 2 minutes and 20 seconds.",
            type: "about:blank",
            status: 403,
          },
          403,
        ),
      ),
    ]);
    const refused = await xApi
      .checkPublication({ account, accessToken: "x", processingRef: "m_9" })
      .catch((e) => e);
    expect(refused).toMatchObject({
      category: "video_rejected",
      detail: "Unsupported video",
    });
    const forbidden = await xApi
      .publish({ account, accessToken: "x", content: "Salut", media: [] })
      .catch((e) => e);
    expect(forbidden).toMatchObject({
      category: "video_rejected",
      authInvalid: false,
    });
  });
});

describe("TikTok : vidéo en PULL_FROM_URL", () => {
  const ok = { code: "ok", message: "", log_id: "log" };
  const account = {
    platform: "tiktok",
    externalAccountId: "open_1",
    username: "boulangerie",
  };
  const creatorInfo = (fields = {}) =>
    jsonResponse({
      data: {
        creator_username: "boulangerie",
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: true,
        max_video_post_duration_sec: 600,
        ...fields,
      },
      error: ok,
    });
  const settings = {
    privacyLevel: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    brandOrganic: false,
    brandContent: true,
  };

  it("creator_info : duos, collages et durée maximale du créateur", async () => {
    stubFetch([on("POST", "/creator_info/query/", creatorInfo())]);
    expect(
      await tiktokApi.getCreatorInfo({ accessToken: "act" }),
    ).toMatchObject({
      duetDisabled: false,
      stitchDisabled: true,
      maxVideoPostDurationSec: 600,
    });
  });

  it("video/init : titre UTF-16, réglages (collage coupé par le créateur), couverture, notre adresse", async () => {
    const fetchMock = stubFetch([
      on("POST", "/creator_info/query/", creatorInfo()),
      on(
        "POST",
        "/post/publish/video/init/",
        jsonResponse({ data: { publish_id: "v_pub_1" }, error: ok }),
      ),
    ]);
    const result = await tiktokApi.publish({
      account,
      accessToken: "act",
      content: "Pain du jour 🥖",
      media: [video({ durationMs: 1500 })],
      tiktokSettings: settings,
    });
    expect(result).toMatchObject({
      status: "publishing",
      externalPostId: "v_pub_1",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/video/init/")[0])).toEqual({
      post_info: {
        title: "Pain du jour 🥖",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: false,
        disable_duet: false,
        disable_stitch: true,
        video_cover_timestamp_ms: 750,
        brand_content_toggle: true,
        brand_organic_toggle: false,
      },
      source_info: { source: "PULL_FROM_URL", video_url: VIDEO_URL },
    });
    expect(callsTo(fetchMock, "POST", "/content/init/")).toHaveLength(0);
  });

  it("vidéo plus longue que la limite du créateur : refusée avant l'envoi, message français", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/creator_info/query/",
        creatorInfo({ max_video_post_duration_sec: 60 }),
      ),
    ]);
    const error = await tiktokApi
      .publish({
        account,
        accessToken: "act",
        content: "",
        media: [video({ durationMs: 95 * 1000 })],
        tiktokSettings: settings,
      })
      .catch((e) => e);
    expect(error).toMatchObject({
      category: "video_too_long",
      transient: false,
    });
    expect(callsTo(fetchMock, "POST", "/video/init/")).toHaveLength(0);
    expect(
      targetErrorMessage({
        status: "failed",
        platform: "tiktok",
        errorCategory: error.category,
        errorMessage: error.detail,
      }),
    ).toBe(
      "TikTok accepte des vidéos de 1 min au maximum pour ce compte (cette vidéo dure 1 min 35).",
    );
  });

  it("publication confirmée : adresse en /video/ ; durée refusée par TikTok : vidéo refusée", async () => {
    stubFetch([
      on(
        "POST",
        "/post/publish/status/fetch/",
        sequence(
          jsonResponse(
            '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}',
          ),
          jsonResponse({
            data: { status: "FAILED", fail_reason: "duration_check_failed" },
            error: ok,
          }),
        ),
      ),
    ]);
    const params = {
      account,
      accessToken: "act",
      externalPostId: "v_pub_1",
      media: [video()],
    };
    expect(await tiktokApi.checkPublication(params)).toMatchObject({
      status: "published",
      platformPostUrl:
        "https://www.tiktok.com/@boulangerie/video/7300000000000000001",
    });
    const refused = await tiktokApi.checkPublication(params).catch((e) => e);
    expect(refused).toMatchObject({ category: "video_rejected" });
    expect(
      targetErrorMessage({
        status: "failed",
        platform: "tiktok",
        errorCategory: refused.category,
        errorMessage: refused.detail,
      }),
    ).toBe("TikTok a refusé la vidéo : durée non acceptée");
  });

  it("titre coupé à 2 200 unités UTF-16 sans couper un emoji", () => {
    expect(sliceUtf16("a".repeat(2199) + "🥖", 2200)).toBe("a".repeat(2199));
    expect(sliceUtf16("court", 2200)).toBe("court");
  });
});

describe("messages des nouvelles catégories", () => {
  const failed = (fields) => ({ status: "failed", ...fields });
  it("vidéo refusée, traitement trop long, sans tiret cadratin", () => {
    const messages = [
      targetErrorMessage(
        failed({
          platform: "linkedin",
          errorCategory: "video_rejected",
          errorMessage: "Unsupported codec",
        }),
      ),
      targetErrorMessage(
        failed({ platform: "instagram", errorCategory: "video_rejected" }),
      ),
      targetErrorMessage(
        failed({
          platform: "twitter",
          errorCategory: "video_processing_timeout",
        }),
      ),
    ];
    expect(messages).toEqual([
      "LinkedIn a refusé la vidéo : Unsupported codec",
      "Instagram a refusé la vidéo.",
      "X n'a pas terminé le traitement de la vidéo à temps. Réessayez plus tard.",
    ]);
    messages.forEach((message) => expect(message).not.toContain("—"));
  });
});
