import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import instagramApi from "../../../../src/services/social/direct/instagramApi.js";
import instagramFacebookApi from "../../../../src/services/social/direct/instagramFacebookApi.js";
import metaApi from "../../../../src/services/social/direct/metaApi.js";
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

const igAccount = {
  _id: "acc_ig",
  platform: "instagram",
  externalAccountId: "17841400000000001",
};
const page = { _id: "acc_fb", platform: "facebook", externalAccountId: "1001" };
const image = (n) => ({
  url: `https://api.newbi.test/social-media/${n}.jpg`,
  width: 1080,
  height: 1920,
});
const VIDEO_URL =
  "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4";
const video = {
  kind: "video",
  url: VIDEO_URL,
  durationMs: 15000,
  size: 5 * 1000 * 1000,
};
const story = { format: "story" };
// Créations de conteneurs (sans media_publish)
const containerCalls = (fetchMock) =>
  callsTo(fetchMock, "POST", "/17841400000000001/media").filter(([url]) =>
    new URL(url).pathname.endsWith("/media"),
  );

beforeEach(() => {
  vi.unstubAllGlobals();
  timing.sleep = async () => {};
  process.env.META_APP_ID = "meta_app";
  process.env.META_APP_SECRET = "meta_secret";
  process.env.INSTAGRAM_APP_ID = "ig_app";
  process.env.INSTAGRAM_APP_SECRET = "ig_secret";
  delete process.env.META_GRAPH_VERSION;
  delete process.env.META_INSTAGRAM_FB_APP_ID;
  delete process.env.META_INSTAGRAM_FB_APP_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Instagram : stories", () => {
  /** Une story par photo : conteneur STORIES, attente, publication. */
  const storyRoutes = () => [
    on(
      "POST",
      "/media_publish",
      sequence(
        jsonResponse({ id: "story_1" }),
        jsonResponse({ id: "story_2" }),
        jsonResponse({ id: "story_3" }),
      ),
    ),
    on(
      "POST",
      "/17841400000000001/media",
      sequence(
        jsonResponse({ id: "c1" }),
        jsonResponse({ id: "c2" }),
        jsonResponse({ id: "c3" }),
      ),
    ),
    on("GET", "fields=status_code", jsonResponse({ status_code: "FINISHED" })),
    on(
      "GET",
      "/story_1?",
      jsonResponse({ permalink: "https://www.instagram.com/stories/acme/1/" }),
    ),
  ];

  it("photos : une story par photo dans l'ordre, sans légende, progression après chacune", async () => {
    const fetchMock = stubFetch(storyRoutes());
    const saveProgress = vi.fn(async () => {});
    const result = await instagramApi.publish({
      account: igAccount,
      accessToken: "ig_token",
      content: "Texte ignoré en story",
      media: [image(1), image(2), image(3)],
      instagramSettings: story,
      progress: { storyIds: [] },
      saveProgress,
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "story_1",
      platformPostUrl: "https://www.instagram.com/stories/acme/1/",
      storyIds: ["story_1", "story_2", "story_3"],
    });
    const creates = containerCalls(fetchMock);
    expect(creates.map(jsonOf)).toEqual([
      { media_type: "STORIES", image_url: image(1).url },
      { media_type: "STORIES", image_url: image(2).url },
      { media_type: "STORIES", image_url: image(3).url },
    ]);
    expect(saveProgress.mock.calls.map(([arg]) => arg.storyIds)).toEqual([
      ["story_1"],
      ["story_1", "story_2"],
      ["story_1", "story_2", "story_3"],
    ]);
  });

  it("reprise : les stories déjà publiées ne sont jamais renvoyées", async () => {
    const fetchMock = stubFetch(storyRoutes());
    const saveProgress = vi.fn(async () => {});
    const result = await instagramApi.publish({
      account: igAccount,
      accessToken: "ig_token",
      content: "",
      media: [image(1), image(2), image(3)],
      instagramSettings: story,
      progress: { storyIds: ["old_1", "old_2"] },
      saveProgress,
    });
    // Seule la 3e photo part
    const creates = containerCalls(fetchMock);
    expect(creates.map(jsonOf)).toEqual([
      { media_type: "STORIES", image_url: image(3).url },
    ]);
    expect(result.storyIds).toEqual(["old_1", "old_2", "story_1"]);
    expect(result.externalPostId).toBe("old_1");
    expect(saveProgress).toHaveBeenCalledTimes(1);
  });

  it("échec au milieu : la progression des stories publiées est déjà enregistrée", async () => {
    stubFetch([
      on(
        "POST",
        "/media_publish",
        sequence(
          jsonResponse({ id: "story_1" }),
          jsonResponse(
            { error: { message: "Erreur", code: 2, error_subcode: null } },
            500,
          ),
        ),
      ),
      on(
        "POST",
        "/17841400000000001/media",
        sequence(jsonResponse({ id: "c1" }), jsonResponse({ id: "c2" })),
      ),
      on(
        "GET",
        "fields=status_code",
        jsonResponse({ status_code: "FINISHED" }),
      ),
    ]);
    const saved = [];
    await expect(
      instagramApi.publish({
        account: igAccount,
        accessToken: "ig_token",
        content: "",
        media: [image(1), image(2)],
        instagramSettings: story,
        progress: { storyIds: [] },
        saveProgress: async ({ storyIds }) => saved.push(storyIds),
      }),
    ).rejects.toMatchObject({ transient: true });
    expect(saved).toEqual([["story_1"]]);
  });

  it("vidéo : conteneur STORIES en deux temps, sans couverture ni légende, publié au FINISHED", async () => {
    const fetchMock = stubFetch([
      on("POST", "/17841400000000001/media", jsonResponse({ id: "c_v" })),
    ]);
    const started = await instagramApi.publish({
      account: igAccount,
      accessToken: "ig_token",
      content: "Ignoré",
      media: [video],
      instagramSettings: story,
      progress: { storyIds: [] },
    });
    expect(started).toMatchObject({
      status: "publishing",
      processingRef: "c_v",
    });
    expect(jsonOf(callsTo(fetchMock, "POST", "/media")[0])).toEqual({
      media_type: "STORIES",
      video_url: VIDEO_URL,
    });

    stubFetch([
      on("GET", "/c_v?", jsonResponse({ status_code: "FINISHED" })),
      on("POST", "/media_publish", jsonResponse({ id: "story_v" })),
      on("GET", "/story_v?", jsonResponse({})),
    ]);
    const saveProgress = vi.fn(async () => {});
    const done = await instagramApi.checkPublication({
      account: igAccount,
      accessToken: "ig_token",
      processingRef: "c_v",
      instagramSettings: story,
      progress: { storyIds: [] },
      saveProgress,
    });
    expect(done).toEqual({
      status: "published",
      externalPostId: "story_v",
      platformPostUrl: null,
      storyIds: ["story_v"],
    });
    expect(saveProgress).toHaveBeenCalledWith({ storyIds: ["story_v"] });
  });

  it("vidéo déjà publiée (résultat perdu) : rien n'est renvoyé", async () => {
    const fetchMock = stubFetch([
      on("GET", "/story_v?", jsonResponse({ permalink: null })),
    ]);
    const result = await instagramApi.publish({
      account: igAccount,
      accessToken: "ig_token",
      content: "",
      media: [video],
      instagramSettings: story,
      progress: { storyIds: ["story_v"] },
    });
    expect(result).toMatchObject({
      status: "published",
      externalPostId: "story_v",
    });
    expect(callsTo(fetchMock, "POST", "/media")).toHaveLength(0);
  });

  it("via Facebook : mêmes stories sur graph.facebook.com, jeton en paramètre", async () => {
    const fetchMock = stubFetch(storyRoutes());
    await instagramFacebookApi.publish({
      account: igAccount,
      accessToken: "user_token",
      content: "",
      media: [image(1)],
      instagramSettings: story,
      progress: { storyIds: [] },
      saveProgress: async () => {},
    });
    const [create] = callsTo(fetchMock, "POST", "/media");
    const url = new URL(create[0]);
    expect(url.origin + url.pathname).toBe(
      "https://graph.facebook.com/v26.0/17841400000000001/media",
    );
    expect(url.searchParams.get("access_token")).toBe("user_token");
    expect(create[1].headers.Authorization).toBeUndefined();
  });
});

describe("Facebook : stories de page", () => {
  it("photos : photo déposée sans publication puis photo_stories, une par photo, progression enregistrée", async () => {
    const fetchMock = stubFetch([
      on(
        "POST",
        "/1001/photos",
        sequence(jsonResponse({ id: "ph_1" }), jsonResponse({ id: "ph_2" })),
      ),
      on(
        "POST",
        "/1001/photo_stories",
        sequence(
          jsonResponse({ success: true, post_id: "1001_s1" }),
          jsonResponse({ success: true, post_id: "1001_s2" }),
        ),
      ),
      on(
        "GET",
        "fields=permalink_url",
        jsonResponse({ permalink_url: "/stories/1001/s1" }),
      ),
    ]);
    const saveProgress = vi.fn(async () => {});
    const result = await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "Ignoré",
      media: [image(1), image(2)],
      facebookSettings: story,
      progress: { storyIds: [] },
      saveProgress,
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "1001_s1",
      platformPostUrl: "https://www.facebook.com/stories/1001/s1",
      storyIds: ["1001_s1", "1001_s2"],
    });
    expect(
      callsTo(fetchMock, "POST", "/1001/photos").map((call) => formOf(call)),
    ).toEqual([
      { url: image(1).url, published: "false", access_token: "page_token" },
      { url: image(2).url, published: "false", access_token: "page_token" },
    ]);
    expect(
      callsTo(fetchMock, "POST", "/1001/photo_stories").map(
        (call) => formOf(call).photo_id,
      ),
    ).toEqual(["ph_1", "ph_2"]);
    expect(saveProgress).toHaveBeenCalledTimes(2);
    // Jamais de post dans le fil
    expect(callsTo(fetchMock, "POST", "/1001/feed")).toHaveLength(0);
  });

  it("reprise : seules les photos restantes partent", async () => {
    const fetchMock = stubFetch([
      on("POST", "/1001/photos", jsonResponse({ id: "ph_3" })),
      on(
        "POST",
        "/1001/photo_stories",
        jsonResponse({ success: true, post_id: "1001_s3" }),
      ),
      on("GET", "fields=permalink_url", jsonResponse({})),
    ]);
    const result = await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "",
      media: [image(1), image(2), image(3)],
      facebookSettings: story,
      progress: { storyIds: ["1001_s1", "1001_s2"] },
      saveProgress: async () => {},
    });
    expect(callsTo(fetchMock, "POST", "/1001/photos")).toHaveLength(1);
    expect(formOf(callsTo(fetchMock, "POST", "/1001/photos")[0]).url).toBe(
      image(3).url,
    );
    expect(result.storyIds).toEqual(["1001_s1", "1001_s2", "1001_s3"]);
  });

  it("vidéo : start, envoi de notre adresse à upload_url (OAuth + file_url), finish", async () => {
    const fetchMock = stubFetch([
      on("POST", "rupload.facebook.com", jsonResponse({ success: true })),
      on(
        "POST",
        "/1001/video_stories",
        sequence(
          jsonResponse({
            video_id: "vid_9",
            upload_url: "https://rupload.facebook.com/video-upload/v26.0/vid_9",
          }),
          jsonResponse({ success: true, post_id: "1001_vs" }),
        ),
      ),
      on("GET", "fields=permalink_url", jsonResponse({})),
    ]);
    const saveProgress = vi.fn(async () => {});
    const result = await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "",
      media: [video],
      facebookSettings: story,
      progress: { storyIds: [] },
      saveProgress,
    });
    expect(result).toMatchObject({
      status: "published",
      externalPostId: "1001_vs",
      storyIds: ["1001_vs"],
    });
    const phases = callsTo(fetchMock, "POST", "/1001/video_stories").map(
      (call) => formOf(call),
    );
    expect(phases[0]).toMatchObject({ upload_phase: "start" });
    expect(phases[1]).toMatchObject({
      upload_phase: "finish",
      video_id: "vid_9",
    });
    const upload = callsTo(fetchMock, "POST", "rupload.facebook.com")[0];
    expect(upload[1].headers).toMatchObject({
      Authorization: "OAuth page_token",
      file_url: VIDEO_URL,
    });
    expect(saveProgress).toHaveBeenCalledWith({ storyIds: ["1001_vs"] });
    // Pas de vidéo de page
    expect(callsTo(fetchMock, "POST", "/1001/videos")).toHaveLength(0);
  });

  it("vidéo : envoi refusé par Facebook (success absent) → erreur passagère", async () => {
    stubFetch([
      on("POST", "rupload.facebook.com", jsonResponse({ success: false })),
      on(
        "POST",
        "/1001/video_stories",
        jsonResponse({
          video_id: "vid_9",
          upload_url: "https://rupload.facebook.com/video-upload/v26.0/vid_9",
        }),
      ),
    ]);
    await expect(
      metaApi.publish({
        account: page,
        accessToken: "page_token",
        content: "",
        media: [video],
        facebookSettings: story,
        progress: { storyIds: [] },
      }),
    ).rejects.toMatchObject({ transient: true });
  });

  it("format « post » (défaut) : publication habituelle", async () => {
    const fetchMock = stubFetch([
      on("POST", "/1001/feed", jsonResponse({ id: "1001_9" })),
      on("GET", "fields=permalink_url", jsonResponse({})),
    ]);
    await metaApi.publish({
      account: page,
      accessToken: "page_token",
      content: "Bonjour",
      media: [],
      facebookSettings: { format: "post" },
    });
    expect(callsTo(fetchMock, "POST", "/1001/feed")).toHaveLength(1);
  });
});
