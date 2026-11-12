import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import instagramUnifiedApi, {
  unifiedLoginSettings,
} from "../../../../src/services/social/direct/instagramUnifiedApi.js";
import { timing } from "../../../../src/services/social/direct/directHttp.js";
import { callsTo, jsonOf, jsonResponse, on, stubFetch } from "./fetchStub.js";

const NOW = new Date("2026-11-12T08:00:00.000Z");
const IG_ID = "17841400000000001";
const account = {
  _id: "acc_ig",
  platform: "instagram",
  connector: "unified",
  externalAccountId: IG_ID,
};
const REDIRECT_URI =
  "https://api.newbi.test/social-connect/instagram_unified/callback";
const VIDEO_URL =
  "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4";

/** Échange du code, utilisateur système, puis profil de chaque compte. */
const connectionRoutes = ({
  token = { access_token: "suat_1" },
  me = { id: "su_7", client_business_id: "biz_3" },
  assigned = [{ id: IG_ID, username: "boulangerie" }],
} = {}) => [
  on("GET", "/oauth/access_token", jsonResponse(token)),
  on(
    "GET",
    "/me/assigned_instagram_accounts",
    jsonResponse({ data: assigned }),
  ),
  on("GET", "/me?", jsonResponse(me)),
  on(
    "GET",
    `/${IG_ID}?`,
    jsonResponse({
      id: IG_ID,
      username: "boulangerie",
      name: "La Boulangerie",
      profile_picture_url: "https://cdn/ig.jpg",
    }),
  ),
];

beforeEach(() => {
  vi.unstubAllGlobals();
  timing.sleep = async () => {};
  process.env.META_APP_ID = "meta_app";
  process.env.META_APP_SECRET = "meta_secret";
  process.env.META_INSTAGRAM_UNIFIED_CONFIG_ID = "cfg_unified";
  delete process.env.META_GRAPH_VERSION;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Instagram connexion unifiée : appli et fenêtre", () => {
  it("configurée seulement avec l'appli des Pages ET la configuration Unified Login", () => {
    expect(unifiedLoginSettings()).toEqual({
      appId: "meta_app",
      appSecret: "meta_secret",
      configId: "cfg_unified",
    });
    expect(instagramUnifiedApi.isConfigured()).toBe(true);
    delete process.env.META_INSTAGRAM_UNIFIED_CONFIG_ID;
    expect(instagramUnifiedApi.isConfigured()).toBe(false);
    process.env.META_INSTAGRAM_UNIFIED_CONFIG_ID = "  ";
    expect(instagramUnifiedApi.isConfigured()).toBe(false);
    process.env.META_INSTAGRAM_UNIFIED_CONFIG_ID = "cfg_unified";
    delete process.env.META_APP_SECRET;
    expect(instagramUnifiedApi.isConfigured()).toBe(false);
  });

  it("fenêtre Meta : configuration, code demandé, jamais de scope", () => {
    const url = new URL(
      instagramUnifiedApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: REDIRECT_URI,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/v26.0/dialog/oauth",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "meta_app",
      config_id: "cfg_unified",
      redirect_uri: REDIRECT_URI,
      state: "etat",
      response_type: "code",
      override_default_response_type: "true",
    });
  });

  it("sans configuration : erreur de configuration, aucune fenêtre", () => {
    delete process.env.META_INSTAGRAM_UNIFIED_CONFIG_ID;
    expect(() =>
      instagramUnifiedApi.buildAuthorizeUrl({
        state: "etat",
        redirectUri: REDIRECT_URI,
      }),
    ).toThrow(/META_INSTAGRAM_UNIFIED_CONFIG_ID/);
  });
});

describe("Instagram connexion unifiée : retour de connexion", () => {
  it("code → jeton système sans expiration → comptes assignés, avec nom et photo", async () => {
    const fetchMock = stubFetch(connectionRoutes());
    const { accounts } = await instagramUnifiedApi.exchangeCode({
      code: "code_1",
      redirectUri: REDIRECT_URI,
      now: NOW,
    });
    expect(accounts).toEqual([
      {
        platform: "instagram",
        externalAccountId: IG_ID,
        username: "boulangerie",
        displayName: "La Boulangerie",
        avatarUrl: "https://cdn/ig.jpg",
        credentials: {
          accessToken: "suat_1",
          tokenExpiresAt: null,
          scopes: [],
        },
        credentialGroup: "meta-system-user:su_7",
        platformData: { metaUserId: "su_7", businessId: "biz_3" },
      },
    ]);
    const exchange = new URL(
      callsTo(fetchMock, "GET", "/oauth/access_token")[0][0],
    );
    expect(exchange.searchParams.get("client_id")).toBe("meta_app");
    expect(exchange.searchParams.get("client_secret")).toBe("meta_secret");
    expect(exchange.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(exchange.searchParams.get("code")).toBe("code_1");
    // Jeton système : pas d'échange contre un jeton longue durée
    expect(callsTo(fetchMock, "GET", "fb_exchange_token")).toHaveLength(0);
    const assigned = new URL(
      callsTo(fetchMock, "GET", "/me/assigned_instagram_accounts")[0][0],
    );
    expect(assigned.searchParams.get("access_token")).toBe("suat_1");
  });

  it("expiration renvoyée par Meta : gardée sur le compte", async () => {
    stubFetch(
      connectionRoutes({
        token: { access_token: "suat_1", expires_in: 5184000 },
      }),
    );
    const { accounts } = await instagramUnifiedApi.exchangeCode({
      code: "c",
      redirectUri: REDIRECT_URI,
      now: NOW,
    });
    expect(accounts[0].credentials.tokenExpiresAt).toEqual(
      new Date(NOW.getTime() + 5184000 * 1000),
    );
  });

  it("aucun compte assigné : comptes Instagram du portefeuille du client", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/biz_3/instagram_accounts",
        jsonResponse({ data: [{ id: IG_ID, username: "boulangerie" }] }),
      ),
      ...connectionRoutes({ assigned: [] }),
    ]);
    const { accounts } = await instagramUnifiedApi.exchangeCode({
      code: "c",
      redirectUri: REDIRECT_URI,
      now: NOW,
    });
    expect(accounts.map((a) => a.externalAccountId)).toEqual([IG_ID]);
    expect(callsTo(fetchMock, "GET", "/biz_3/instagram_accounts")).toHaveLength(
      1,
    );
  });

  it("portefeuille illisible et rien d'assigné : liste vide, sans erreur", async () => {
    stubFetch([
      on(
        "GET",
        "/biz_3/instagram_accounts",
        jsonResponse(
          { error: { message: "Missing permission", code: 200 } },
          403,
        ),
      ),
      ...connectionRoutes({ assigned: [] }),
    ]);
    const { accounts } = await instagramUnifiedApi.exchangeCode({
      code: "c",
      redirectUri: REDIRECT_URI,
      now: NOW,
    });
    expect(accounts).toEqual([]);
  });

  it("client_business_id refusé : identifiant seul, sans portefeuille", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "client_business_id",
        jsonResponse(
          {
            error: {
              message: "(#100) Tried accessing nonexisting field",
              code: 100,
            },
          },
          400,
        ),
      ),
      ...connectionRoutes({ me: { id: "su_7" } }),
    ]);
    const { accounts } = await instagramUnifiedApi.exchangeCode({
      code: "c",
      redirectUri: REDIRECT_URI,
      now: NOW,
    });
    expect(accounts[0].platformData).toEqual({
      metaUserId: "su_7",
      businessId: null,
    });
    expect(callsTo(fetchMock, "GET", "/me?")).toHaveLength(2);
  });

  it("profil illisible : le pseudo de la liste suffit ; doublons ignorés", async () => {
    stubFetch([
      on(
        "GET",
        `/${IG_ID}?`,
        jsonResponse({ error: { message: "Unsupported", code: 100 } }, 400),
      ),
      ...connectionRoutes({
        assigned: [
          { id: IG_ID, username: "boulangerie" },
          { id: IG_ID, username: "boulangerie" },
          { username: "sans_identifiant" },
        ],
      }),
    ]);
    const { accounts } = await instagramUnifiedApi.exchangeCode({
      code: "c",
      redirectUri: REDIRECT_URI,
      now: NOW,
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      username: "boulangerie",
      displayName: "boulangerie",
      avatarUrl: null,
    });
  });

  it("jeton absent de la réponse : erreur passagère", async () => {
    stubFetch(connectionRoutes({ token: {} }));
    await expect(
      instagramUnifiedApi.exchangeCode({
        code: "c",
        redirectUri: REDIRECT_URI,
        now: NOW,
      }),
    ).rejects.toMatchObject({ transient: true });
  });

  it("code refusé par Meta : erreur, aucun compte", async () => {
    stubFetch([
      on(
        "GET",
        "/oauth/access_token",
        jsonResponse(
          {
            error: {
              message: "This authorization code has been used",
              code: 100,
            },
          },
          400,
        ),
      ),
    ]);
    await expect(
      instagramUnifiedApi.exchangeCode({
        code: "c",
        redirectUri: REDIRECT_URI,
        now: NOW,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("Instagram connexion unifiée : profil, jeton et publication", () => {
  it("profil relu sur le compte lui-même", async () => {
    const fetchMock = stubFetch(connectionRoutes());
    expect(
      await instagramUnifiedApi.fetchProfile({
        account,
        accessToken: "suat_1",
      }),
    ).toEqual({
      externalAccountId: IG_ID,
      username: "boulangerie",
      displayName: "La Boulangerie",
      avatarUrl: "https://cdn/ig.jpg",
    });
    const url = new URL(callsTo(fetchMock, "GET", `/${IG_ID}?`)[0][0]);
    expect(url.searchParams.get("fields")).toBe(
      "id,username,name,profile_picture_url",
    );
  });

  it("jeton système : jamais rafraîchi à l'avance", () => {
    expect(instagramUnifiedApi.refreshesAccessToken).toBe(false);
    expect(instagramUnifiedApi.refreshAheadMs).toBe(0);
    expect(instagramUnifiedApi.refreshCredentials).toBeUndefined();
    expect(instagramUnifiedApi.listSounds).toBeUndefined();
  });

  it("photo : conteneur puis publication sur graph.facebook.com, jeton en paramètre", async () => {
    const fetchMock = stubFetch([
      on("POST", "/media_publish", jsonResponse({ id: "post_1" })),
      on("POST", `/${IG_ID}/media`, jsonResponse({ id: "c_1" })),
      on(
        "GET",
        "fields=status_code",
        jsonResponse({ status_code: "FINISHED" }),
      ),
      on(
        "GET",
        "/post_1?",
        jsonResponse({ permalink: "https://www.instagram.com/p/abc/" }),
      ),
    ]);
    const result = await instagramUnifiedApi.publish({
      account,
      accessToken: "suat_1",
      content: "Bonjour",
      media: [{ url: "https://api.newbi.test/social-media/1.jpg" }],
    });
    expect(result).toEqual({
      status: "published",
      externalPostId: "post_1",
      platformPostUrl: "https://www.instagram.com/p/abc/",
    });
    const [create] = callsTo(fetchMock, "POST", `/${IG_ID}/media`);
    expect(String(create[0])).toMatch(
      /^https:\/\/graph\.facebook\.com\/v26\.0\//,
    );
    expect(new URL(create[0]).searchParams.get("access_token")).toBe("suat_1");
    expect(jsonOf(create)).toEqual({
      image_url: "https://api.newbi.test/social-media/1.jpg",
      caption: "Bonjour",
    });
  });

  it("Reel : jamais de son (API Audio réservée au jeton utilisateur)", async () => {
    const fetchMock = stubFetch([
      on("POST", `/${IG_ID}/media`, jsonResponse({ id: "c_r" })),
    ]);
    const result = await instagramUnifiedApi.publish({
      account,
      accessToken: "suat_1",
      content: "Reel",
      media: [{ kind: "video", url: VIDEO_URL, durationMs: 30000 }],
      instagramSettings: {
        format: "post",
        sound: { soundId: "audio_42", volume: 80, videoVolume: 50 },
      },
    });
    expect(result.status).toBe("publishing");
    const body = jsonOf(callsTo(fetchMock, "POST", "/media")[0]);
    expect(body).toMatchObject({ media_type: "REELS", caption: "Reel" });
    expect(body.audio_configuration).toBeUndefined();
  });
});
