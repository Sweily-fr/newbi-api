import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildOrganizationId } from "../../factories/index.js";

vi.mock("../../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(async () => true),
  sendMentionEmail: vi.fn(async () => true),
  sendSocialPostFailedEmail: vi.fn(async () => true),
}));
vi.mock("../../../src/resolvers/notification.js", () => ({
  publishNotification: vi.fn(async () => {}),
}));
vi.mock("../../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(async () => {}),
}));

import SocialAccount from "../../../src/models/SocialAccount.js";
import logger from "../../../src/utils/logger.js";
import { decrypt } from "../../../src/utils/encryption.js";
import instagramApi from "../../../src/services/social/direct/instagramApi.js";
import instagramFacebookApi from "../../../src/services/social/direct/instagramFacebookApi.js";
import linkedinApi from "../../../src/services/social/direct/linkedinApi.js";
import metaApi from "../../../src/services/social/direct/metaApi.js";
import tiktokApi from "../../../src/services/social/direct/tiktokApi.js";
import tiktokBusinessApi from "../../../src/services/social/direct/tiktokBusinessApi.js";
import xApi from "../../../src/services/social/direct/xApi.js";
import {
  DirectApiError,
  timing,
} from "../../../src/services/social/direct/directHttp.js";
import {
  PROFILE_MAX_AGE_MS,
  profileFields,
  refreshAccountProfiles,
} from "../../../src/services/social/socialAccountProfiles.js";
import { saveDirectAccounts } from "../../../src/services/social/socialDirectConnect.js";
import { runSocialDirectPublish } from "../../../src/cron/socialDirectPublishCron.js";
import { callsTo, jsonResponse, on, stubFetch } from "./direct/fetchStub.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const organizationId = buildOrganizationId();
// Bien après la création des comptes des tests (createdAt réel)
const NOW = new Date(Date.now() + 60 * DAY);
const at = (ms) => new Date(NOW.getTime() + ms);

const ENV = {
  DATA_ENCRYPTION_KEY: "test-encryption-key-social-direct",
  SOCIAL_MEDIA_BUCKET: "social-test",
  R2_API_URL: "https://r2.test",
  R2_ACCESS_KEY_ID: "r2_id",
  R2_SECRET_ACCESS_KEY: "r2_secret",
  META_APP_ID: "meta_app",
  META_APP_SECRET: "meta_secret",
  INSTAGRAM_APP_ID: "ig_app",
  INSTAGRAM_APP_SECRET: "ig_secret",
  TIKTOK_CLIENT_KEY: "tt_key",
  TIKTOK_CLIENT_SECRET: "tt_secret",
  TIKTOK_BUSINESS_APP_ID: "biz_app",
  TIKTOK_BUSINESS_APP_SECRET: "biz_secret",
  TIKTOK_BUSINESS_AUTH_URL:
    "https://www.tiktok.com/v2/auth/authorize?client_key=biz_key&response_type=code",
  LINKEDIN_CLIENT_ID: "li_client",
  LINKEDIN_CLIENT_SECRET: "li_secret",
  LINKEDIN_PAGES_CLIENT_ID: "li_pages_client",
  LINKEDIN_PAGES_CLIENT_SECRET: "li_pages_secret",
  X_CLIENT_ID: "x_client",
  X_CLIENT_SECRET: "x_secret",
  NEXT_PUBLIC_API_URL: "https://api.newbi.test",
};

const directAccount = (fields = {}) =>
  SocialAccount.create({
    workspaceId: organizationId,
    provider: "direct",
    platform: "twitter",
    externalAccountId: "42",
    username: "ancien",
    displayName: "Ancien nom",
    avatarUrl: "https://cdn/ancienne.jpg",
    accessToken: "x_access",
    refreshToken: "x_refresh",
    tokenExpiresAt: at(30 * DAY),
    ...fields,
  });

const reload = (account) =>
  SocialAccount.findById(account._id).select("+accessToken").lean();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  timing.sleep = async () => {};
  Object.assign(process.env, ENV);
  delete process.env.META_INSTAGRAM_FB_APP_ID;
  delete process.env.META_INSTAGRAM_FB_APP_SECRET;
  delete process.env.LINKEDIN_PAGES_WORKSPACE_IDS;
  delete process.env.LINKEDIN_API_VERSION;
  delete process.env.META_GRAPH_VERSION;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Lectures chez chaque réseau ────────────────────────────────────────────

describe("fetchProfile des réseaux (mêmes lectures qu'à la connexion)", () => {
  it("LinkedIn, profil (appli « profile ») : /v2/userinfo", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "api.linkedin.com/v2/userinfo",
        jsonResponse({
          sub: "abc",
          name: "Alice Martin",
          picture: "https://media.licdn.com/alice.jpg",
        }),
      ),
    ]);
    const profile = await linkedinApi.fetchProfile({
      account: {
        externalAccountId: "urn:li:person:abc",
        platformData: { kind: "person", app: "profile" },
      },
      accessToken: "li_token",
    });
    expect(profile).toEqual({
      externalAccountId: "urn:li:person:abc",
      displayName: "Alice Martin",
      avatarUrl: "https://media.licdn.com/alice.jpg",
    });
    const [call] = callsTo(fetchMock, "GET", "/v2/userinfo");
    expect(call[1].headers.Authorization).toBe("Bearer li_token");
  });

  it("LinkedIn, profil (appli « pages ») : /v2/me avec la photo", async () => {
    stubFetch([
      on(
        "GET",
        "api.linkedin.com/v2/me",
        jsonResponse({
          id: "abc",
          localizedFirstName: "Alice",
          localizedLastName: "Martin",
          profilePicture: {
            "displayImage~": {
              elements: [
                { identifiers: [{ identifier: "https://media/petite.jpg" }] },
                { identifiers: [{ identifier: "https://media/grande.jpg" }] },
              ],
            },
          },
        }),
      ),
    ]);
    const profile = await linkedinApi.fetchProfile({
      account: {
        externalAccountId: "urn:li:person:abc",
        platformData: { kind: "person", app: "pages" },
      },
      accessToken: "li_token",
    });
    expect(profile).toEqual({
      externalAccountId: "urn:li:person:abc",
      displayName: "Alice Martin",
      avatarUrl: "https://media/grande.jpg",
    });
  });

  it("LinkedIn, page : organizations/{id} (nom et nom d'usage, pas de logo)", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "/rest/organizations/123",
        jsonResponse({ localizedName: "Acme SAS", vanityName: "acme" }),
      ),
    ]);
    const profile = await linkedinApi.fetchProfile({
      account: {
        externalAccountId: "urn:li:organization:123",
        platformData: { kind: "organization", app: "pages" },
      },
      accessToken: "li_token",
    });
    expect(profile).toEqual({ username: "acme", displayName: "Acme SAS" });
    expect(profile.avatarUrl).toBeUndefined();
    expect(callsTo(fetchMock, "GET", "organizations/123")).toHaveLength(1);
  });

  it("LinkedIn, page illisible pour ce rôle (403) : erreur, pas un jeton invalide", async () => {
    stubFetch([
      on(
        "GET",
        "/rest/organizations/123",
        jsonResponse({ message: "Not enough permissions" }, 403),
      ),
    ]);
    const error = await linkedinApi
      .fetchProfile({
        account: {
          externalAccountId: "urn:li:organization:123",
          platformData: { kind: "organization", app: "pages" },
        },
        accessToken: "li_token",
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(DirectApiError);
    expect(error.authInvalid).toBe(false);
  });

  it("Page Facebook : nom et photo lus avec le jeton de la page", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "graph.facebook.com/v26.0/1001?",
        jsonResponse({
          id: "1001",
          name: "Boulangerie Martin",
          picture: { data: { url: "https://fb/photo.jpg" } },
        }),
      ),
    ]);
    const profile = await metaApi.fetchProfile({
      account: { externalAccountId: "1001" },
      accessToken: "page_token",
    });
    expect(profile).toEqual({
      externalAccountId: "1001",
      displayName: "Boulangerie Martin",
      avatarUrl: "https://fb/photo.jpg",
    });
    const url = new URL(callsTo(fetchMock, "GET", "/1001?")[0][0]);
    expect(url.searchParams.get("fields")).toBe("id,name,picture{url}");
    expect(url.searchParams.get("access_token")).toBe("page_token");
  });

  it("Instagram : GET /me (pseudo, nom, photo)", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "graph.instagram.com/v26.0/me",
        jsonResponse({
          user_id: "1784",
          username: "boulangerie",
          name: "Boulangerie",
          profile_picture_url: "https://ig/photo.jpg",
        }),
      ),
    ]);
    const profile = await instagramApi.fetchProfile({ accessToken: "ig" });
    expect(profile).toEqual({
      externalAccountId: "1784",
      username: "boulangerie",
      displayName: "Boulangerie",
      avatarUrl: "https://ig/photo.jpg",
    });
    const [call] = callsTo(fetchMock, "GET", "/me");
    expect(call[1].headers.Authorization).toBe("Bearer ig");
  });

  it("Instagram via Facebook : même liste des Pages qu'à la connexion", async () => {
    stubFetch([
      on(
        "GET",
        "graph.facebook.com/v26.0/me/accounts",
        jsonResponse({
          data: [
            {
              id: "p1",
              instagram_business_account: { id: "17840", username: "autre" },
            },
            {
              id: "p2",
              instagram_business_account: {
                id: "17841",
                username: "patisserie",
                name: "Pâtisserie",
                profile_picture_url: "https://ig/patisserie.jpg",
              },
            },
          ],
        }),
      ),
    ]);
    const profile = await instagramFacebookApi.fetchProfile({
      account: { externalAccountId: "17841" },
      accessToken: "user_token",
    });
    expect(profile).toEqual({
      externalAccountId: "17841",
      username: "patisserie",
      displayName: "Pâtisserie",
      avatarUrl: "https://ig/patisserie.jpg",
    });
  });

  it("Instagram via Facebook : compte absent des Pages, erreur sans jeton invalide", async () => {
    stubFetch([
      on("GET", "/me/accounts", jsonResponse({ data: [{ id: "p1" }] })),
    ]);
    const error = await instagramFacebookApi
      .fetchProfile({
        account: { externalAccountId: "17841" },
        accessToken: "user_token",
      })
      .catch((e) => e);
    expect(error.authInvalid).toBe(false);
  });

  it("TikTok : user/info et pseudo par creator_info", async () => {
    stubFetch([
      on(
        "GET",
        "open.tiktokapis.com/v2/user/info/",
        jsonResponse({
          data: {
            user: {
              open_id: "open_1",
              display_name: "La Boulangerie",
              avatar_url: "https://tt/photo.jpg",
            },
          },
          error: { code: "ok" },
        }),
      ),
      on(
        "POST",
        "post/publish/creator_info/query/",
        jsonResponse({
          data: { creator_username: "boulangerie" },
          error: { code: "ok" },
        }),
      ),
    ]);
    expect(await tiktokApi.fetchProfile({ accessToken: "act" })).toEqual({
      externalAccountId: "open_1",
      username: "boulangerie",
      displayName: "La Boulangerie",
      avatarUrl: "https://tt/photo.jpg",
    });
  });

  it("TikTok : pseudo illisible, laissé tel quel", async () => {
    stubFetch([
      on(
        "GET",
        "/v2/user/info/",
        jsonResponse({
          data: { user: { open_id: "open_1", display_name: "Boulangerie" } },
          error: { code: "ok" },
        }),
      ),
      on(
        "POST",
        "creator_info",
        jsonResponse({ error: { code: "internal_error" } }, 500),
      ),
    ]);
    const profile = await tiktokApi.fetchProfile({ accessToken: "act" });
    expect(profile.username).toBeUndefined();
    expect(profile.displayName).toBe("Boulangerie");
    expect(profile.avatarUrl).toBeNull();
  });

  it("TikTok Business : business/get", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "business-api.tiktok.com/open_api/v1.3/business/get/",
        jsonResponse({
          code: 0,
          message: "OK",
          data: {
            username: "tt_biz",
            display_name: "Boulangerie Pro",
            profile_image: "https://tt/biz.jpg",
          },
        }),
      ),
    ]);
    const profile = await tiktokBusinessApi.fetchProfile({
      account: { externalAccountId: "open_biz" },
      accessToken: "biz_token",
    });
    expect(profile).toEqual({
      username: "tt_biz",
      displayName: "Boulangerie Pro",
      avatarUrl: "https://tt/biz.jpg",
    });
    const url = new URL(callsTo(fetchMock, "GET", "business/get/")[0][0]);
    expect(url.searchParams.get("business_id")).toBe("open_biz");
  });

  it("X : GET /2/users/me", async () => {
    const fetchMock = stubFetch([
      on(
        "GET",
        "api.x.com/2/users/me",
        jsonResponse({
          data: {
            id: "42",
            username: "acme",
            name: "Acme",
            profile_image_url: "https://x/acme.jpg",
          },
        }),
      ),
    ]);
    expect(await xApi.fetchProfile({ accessToken: "x_access" })).toEqual({
      externalAccountId: "42",
      username: "acme",
      displayName: "Acme",
      avatarUrl: "https://x/acme.jpg",
    });
    const url = new URL(callsTo(fetchMock, "GET", "/users/me")[0][0]);
    expect(url.searchParams.get("user.fields")).toBe("profile_image_url");
  });

  it("chaque connecteur a sa relecture", () => {
    for (const network of [
      instagramApi,
      instagramFacebookApi,
      linkedinApi,
      metaApi,
      tiktokApi,
      tiktokBusinessApi,
      xApi,
    ]) {
      expect(typeof network.fetchProfile).toBe("function");
    }
  });
});

// ── Relecture régulière des comptes ────────────────────────────────────────

describe("refreshAccountProfiles", () => {
  const xProfile = (fields = {}) => ({
    externalAccountId: "42",
    username: "acme_neuf",
    displayName: "Acme Neuf",
    avatarUrl: "https://x/neuve.jpg",
    ...fields,
  });

  it("profil de plus de 28 jours relu ; plus récent, Zernio, déconnecté ou à reconnecter : non", async () => {
    const stale = await directAccount({
      profileRefreshedAt: at(-PROFILE_MAX_AGE_MS - HOUR),
    });
    const fresh = await directAccount({
      externalAccountId: "43",
      profileRefreshedAt: at(-DAY),
    });
    await directAccount({
      externalAccountId: "44",
      status: "needs_reconnect",
      profileRefreshedAt: at(-60 * DAY),
    });
    await directAccount({
      externalAccountId: "45",
      deletedAt: at(-DAY),
      profileRefreshedAt: at(-60 * DAY),
    });
    await SocialAccount.create({
      workspaceId: organizationId,
      platform: "twitter",
      externalAccountId: "zernio_x",
      username: "zernio",
    });
    const fetchProfile = vi
      .spyOn(xApi, "fetchProfile")
      .mockResolvedValue(xProfile());

    expect(await refreshAccountProfiles({ now: NOW })).toEqual({
      refreshed: 1,
      failed: 0,
    });
    expect(fetchProfile).toHaveBeenCalledTimes(1);
    expect(fetchProfile.mock.calls[0][0].accessToken).toBe("x_access");
    expect(await reload(stale)).toMatchObject({
      username: "acme_neuf",
      displayName: "Acme Neuf",
      avatarUrl: "https://x/neuve.jpg",
      status: "active",
      profileRefreshedAt: NOW,
      profileRefreshAttemptedAt: NOW,
    });
    expect((await reload(fresh)).username).toBe("ancien");
  });

  it("jamais relu : date de connexion (lastSyncedAt), sinon de création", async () => {
    const connectedLongAgo = await directAccount({
      lastSyncedAt: at(-40 * DAY),
    });
    // Connecté il y a 10 jours (createdAt réel plus ancien, sans effet)
    await directAccount({ externalAccountId: "43", lastSyncedAt: at(-10 * DAY) });
    // Ni relu ni date de connexion : date de création (60 jours avant NOW)
    const legacy = await directAccount({ externalAccountId: "44" });
    vi.spyOn(xApi, "fetchProfile").mockImplementation(
      async ({ account }) => xProfile({ externalAccountId: account.externalAccountId }),
    );
    expect((await refreshAccountProfiles({ now: NOW })).refreshed).toBe(2);
    expect((await reload(connectedLongAgo)).profileRefreshedAt).toEqual(NOW);
    expect((await reload(legacy)).profileRefreshedAt).toEqual(NOW);
  });

  it("connexion : profil considéré comme tout juste relu", async () => {
    await saveDirectAccounts(
      organizationId,
      [
        {
          platform: "twitter",
          externalAccountId: "42",
          username: "acme",
          displayName: "Acme",
          avatarUrl: null,
          credentials: { accessToken: "x_access", refreshToken: "x_refresh" },
        },
      ],
      { now: NOW },
    );
    const saved = await SocialAccount.findOne({ externalAccountId: "42" });
    expect(saved.profileRefreshedAt).toEqual(NOW);
    const fetchProfile = vi.spyOn(xApi, "fetchProfile");
    await refreshAccountProfiles({ now: at(27 * DAY) });
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("nom absent de la réponse : gardé ; photo absente : effacée", async () => {
    expect(
      profileFields({ username: null, displayName: "", avatarUrl: null }),
    ).toEqual({ avatarUrl: null });
    expect(profileFields({ username: undefined })).toEqual({});
    const account = await directAccount({ lastSyncedAt: at(-40 * DAY) });
    vi.spyOn(xApi, "fetchProfile").mockResolvedValue({
      externalAccountId: "42",
      username: null,
      displayName: null,
      avatarUrl: null,
    });
    await refreshAccountProfiles({ now: NOW });
    expect(await reload(account)).toMatchObject({
      username: "ancien",
      displayName: "Ancien nom",
      avatarUrl: null,
      profileRefreshedAt: NOW,
    });
  });

  it("échec passager : journalisé, statut inchangé, un essai par jour au plus", async () => {
    const account = await directAccount({ lastSyncedAt: at(-40 * DAY) });
    const warn = vi.spyOn(logger, "warn");
    const fetchProfile = vi
      .spyOn(xApi, "fetchProfile")
      .mockRejectedValue(
        new DirectApiError("x : HTTP 503", { network: "x", transient: true }),
      );

    expect(await refreshAccountProfiles({ now: NOW })).toEqual({
      refreshed: 0,
      failed: 1,
    });
    expect(warn.mock.calls.some(([m]) => /Profil twitter/.test(m))).toBe(true);
    expect(await reload(account)).toMatchObject({
      status: "active",
      username: "ancien",
      profileRefreshedAt: null,
      profileRefreshAttemptedAt: NOW,
    });

    // Même jour : pas de nouvel essai
    await refreshAccountProfiles({ now: at(6 * HOUR) });
    expect(fetchProfile).toHaveBeenCalledTimes(1);

    // Le lendemain : nouvel essai, réussi
    fetchProfile.mockResolvedValue(xProfile());
    await refreshAccountProfiles({ now: at(DAY + HOUR) });
    expect(fetchProfile).toHaveBeenCalledTimes(2);
    expect(await reload(account)).toMatchObject({
      username: "acme_neuf",
      profileRefreshedAt: at(DAY + HOUR),
    });
  });

  it("jeton refusé : rafraîchi puis relu ; refusé encore : à reconnecter (comme à la publication)", async () => {
    const saved = await directAccount({ lastSyncedAt: at(-40 * DAY) });
    const refresh = vi
      .spyOn(xApi, "refreshCredentials")
      .mockResolvedValue({
        accessToken: "x_new",
        refreshToken: "x_refresh_2",
        tokenExpiresAt: at(2 * HOUR),
      });
    const authError = () =>
      new DirectApiError("x : 401", { network: "x", authInvalid: true });
    const fetchProfile = vi
      .spyOn(xApi, "fetchProfile")
      .mockRejectedValueOnce(authError())
      .mockResolvedValueOnce(xProfile());

    await refreshAccountProfiles({ now: NOW });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchProfile.mock.calls[1][0].accessToken).toBe("x_new");
    let stored = await reload(saved);
    expect(stored).toMatchObject({ status: "active", username: "acme_neuf" });
    expect(decrypt(stored.accessToken)).toBe("x_new");

    // Profil de nouveau périmé, jeton refusé même rafraîchi
    fetchProfile.mockReset().mockRejectedValue(authError());
    await refreshAccountProfiles({ now: at(30 * DAY) });
    stored = await reload(saved);
    expect(stored.status).toBe("needs_reconnect");
  });

  it("erreur sans jeton invalide (page LinkedIn illisible) : le compte reste actif", async () => {
    const page = await directAccount({
      platform: "linkedin",
      externalAccountId: "urn:li:organization:123",
      username: "acme",
      displayName: "Acme",
      lastSyncedAt: at(-40 * DAY),
      credentialGroup: "linkedin:urn:li:person:abc",
      platformData: { kind: "organization", app: "pages" },
    });
    stubFetch([
      on(
        "GET",
        "/rest/organizations/123",
        jsonResponse({ message: "Not enough permissions" }, 403),
      ),
    ]);
    expect((await refreshAccountProfiles({ now: NOW })).failed).toBe(1);
    expect(await reload(page)).toMatchObject({
      status: "active",
      displayName: "Acme",
    });
  });

  it("jeton partagé (profil et page LinkedIn) : rafraîchi une fois pour le groupe", async () => {
    const group = "linkedin:urn:li:person:abc";
    const shared = {
      platform: "linkedin",
      accessToken: "li_old",
      refreshToken: "li_refresh",
      // Expire dans la minute : à rafraîchir avant usage
      tokenExpiresAt: at(60 * 1000),
      credentialGroup: group,
      lastSyncedAt: at(-40 * DAY),
    };
    const person = await directAccount({
      ...shared,
      externalAccountId: "urn:li:person:abc",
      platformData: { kind: "person", app: "pages" },
    });
    const organization = await directAccount({
      ...shared,
      externalAccountId: "urn:li:organization:123",
      platformData: { kind: "organization", app: "pages" },
    });
    const refresh = vi
      .spyOn(linkedinApi, "refreshCredentials")
      .mockResolvedValue({
        accessToken: "li_new",
        tokenExpiresAt: at(60 * DAY),
      });
    const fetchProfile = vi
      .spyOn(linkedinApi, "fetchProfile")
      .mockImplementation(async ({ account }) =>
        account.platformData.kind === "person"
          ? { externalAccountId: "urn:li:person:abc", displayName: "Alice" }
          : { username: "acme", displayName: "Acme SAS" },
      );

    expect((await refreshAccountProfiles({ now: NOW })).refreshed).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchProfile.mock.calls.map((c) => c[0].accessToken)).toEqual([
      "li_new",
      "li_new",
    ]);
    expect((await reload(person)).displayName).toBe("Alice");
    expect((await reload(organization)).displayName).toBe("Acme SAS");
  });

  it("réponse d'un autre compte : rien n'est écrit", async () => {
    const account = await directAccount({ lastSyncedAt: at(-40 * DAY) });
    vi.spyOn(xApi, "fetchProfile").mockResolvedValue(
      xProfile({ externalAccountId: "999" }),
    );
    expect((await refreshAccountProfiles({ now: NOW })).failed).toBe(1);
    expect((await reload(account)).username).toBe("ancien");
  });

  it("cron : relecture une fois par heure au plus", async () => {
    await directAccount({ lastSyncedAt: at(-40 * DAY) });
    const fetchProfile = vi
      .spyOn(xApi, "fetchProfile")
      .mockImplementation(async ({ account }) =>
        xProfile({ externalAccountId: account.externalAccountId }),
      );
    await runSocialDirectPublish({ now: NOW });
    expect(fetchProfile).toHaveBeenCalledTimes(1);

    await directAccount({
      externalAccountId: "43",
      lastSyncedAt: at(-40 * DAY),
    });
    await runSocialDirectPublish({ now: at(10 * 60 * 1000) });
    expect(fetchProfile).toHaveBeenCalledTimes(1);

    await runSocialDirectPublish({ now: at(HOUR + 60 * 1000) });
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });
});
