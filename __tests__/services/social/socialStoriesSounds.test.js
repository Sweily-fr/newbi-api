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
import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";

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
vi.mock("../../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import { Board, Column, Task } from "../../../src/models/kanban.js";
import Notification from "../../../src/models/Notification.js";
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialConnectState from "../../../src/models/SocialConnectState.js";
import SocialPost from "../../../src/models/SocialPost.js";
import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import socialResolvers from "../../../src/resolvers/socialPublishing.js";
import socialConnectRouter from "../../../src/routes/social-connect.js";
import { decrypt } from "../../../src/utils/encryption.js";
import provider from "../../../src/services/social/providers/zernioProvider.js";
import instagramApi from "../../../src/services/social/direct/instagramApi.js";
import instagramFacebookApi from "../../../src/services/social/direct/instagramFacebookApi.js";
import tiktokApi from "../../../src/services/social/direct/tiktokApi.js";
import tiktokBusinessApi from "../../../src/services/social/direct/tiktokBusinessApi.js";
import {
  DirectApiError,
  timing,
} from "../../../src/services/social/direct/directHttp.js";
import { completeDirectConnect } from "../../../src/services/social/socialDirectConnect.js";
import {
  publishDueDirectTargets,
  resetFailedDirectTargets,
} from "../../../src/services/social/socialDirectPublisher.js";
import { clearSoundsCache } from "../../../src/services/social/socialPublishingService.js";
import { refreshExpiringTokens } from "../../../src/services/social/socialAccountCredentials.js";
import { buildOutcomeMessage } from "../../../src/services/social/socialPostNotifications.js";
import { parseSignedRequest } from "../../../src/services/social/socialMetaCallbacks.js";
import {
  callsTo,
  jsonOf,
  jsonResponse,
  on,
  sequence,
  stubFetch,
} from "./direct/fetchStub.js";

const { Mutation, Query } = socialResolvers;

const alice = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
const NOW = new Date("2026-11-02T08:01:00.000Z");
const SCHEDULED = new Date("2026-11-02T08:00:00.000Z");
const later = (ms, from = NOW) => new Date(from.getTime() + ms);
const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
let ctx;
let board;
let column;
let task;
let accounts;
let photos;
let videoMedia;

const ENV = {
  ZERNIO_API_KEY: "sk_test_zernio",
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
  SOCIAL_PROVIDER_INSTAGRAM: "direct",
  SOCIAL_PROVIDER_FACEBOOK: "direct",
  SOCIAL_PROVIDER_TIKTOK: "direct",
  FRONTEND_URL: "https://www.newbi.test",
  NEXT_PUBLIC_API_URL: "https://api.newbi.test",
};
const ENV_TO_CLEAR = [
  "META_INSTAGRAM_FB_APP_ID",
  "META_INSTAGRAM_FB_APP_SECRET",
  "META_INSTAGRAM_LOGIN_CONFIG_ID",
  "META_LOGIN_CONFIG_ID",
  "SOCIAL_DIRECT_WORKSPACE_IDS",
  "SOCIAL_PROVIDER_LINKEDIN",
  "SOCIAL_PROVIDER_TWITTER",
];

const directAccount = (fields) => ({
  workspaceId: organizationId,
  provider: "direct",
  accessToken: "token",
  tokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  ...fields,
});

const schedule = (input) =>
  Mutation.scheduleSocialPost(
    null,
    {
      input: {
        boardId: String(board._id),
        scheduledFor: inOneDay().toISOString(),
        content: "Bonjour",
        ...input,
      },
    },
    ctx,
  );

const sound = (fields = {}) => ({
  id: "audio_42",
  title: "Été",
  artist: "Artiste",
  coverUrl: "https://cdn/cover.jpg",
  volume: 80,
  videoVolume: 50,
  ...fields,
});

const directSettings = (fields = {}) => ({
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  consentGiven: true,
  ...fields,
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  clearSoundsCache();
  vi.unstubAllGlobals();
  timing.sleep = async () => {};
  Object.assign(process.env, ENV);
  ENV_TO_CLEAR.forEach((key) => delete process.env[key]);

  await mongoose.connection.db
    .collection("user")
    .insertOne({ _id: alice, email: "alice@test.fr", name: "Alice" });
  await seedOrgMembership({ userId: alice, organizationId });
  ctx = buildContext({ userId: alice, organizationId });
  board = await Board.create({
    title: "Communication",
    workspaceId: organizationId,
    userId: alice,
  });
  column = await Column.create({
    title: "Idées",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: organizationId,
    userId: alice,
  });
  task = await Task.create({
    title: "Post",
    status: "col",
    boardId: board._id,
    columnId: String(column._id),
    workspaceId: organizationId,
    userId: alice,
  });
  const created = await SocialAccount.create([
    directAccount({
      platform: "instagram",
      externalAccountId: "17841400000000001",
      username: "boulangerie",
    }),
    directAccount({
      platform: "instagram",
      connector: "facebook",
      externalAccountId: "17841400000000002",
      username: "patisserie",
      credentialGroup: "meta-user:mu_1",
      platformData: {
        pageId: "p2",
        pageName: "Pâtisserie",
        metaUserId: "mu_1",
      },
    }),
    directAccount({
      platform: "facebook",
      externalAccountId: "1001",
      displayName: "Boulangerie",
      platformData: { metaUserId: "mu_1" },
    }),
    directAccount({
      platform: "tiktok",
      externalAccountId: "open_1",
      username: "tt_ancien",
      refreshToken: "rft",
      tokenScopes: ["user.info.basic", "video.publish"],
    }),
    directAccount({
      platform: "tiktok",
      externalAccountId: "open_2",
      username: "tt_neuf",
      refreshToken: "rft",
      tokenScopes: ["user.info.basic", "video.publish", "video.upload"],
    }),
    directAccount({
      platform: "tiktok",
      connector: "business",
      externalAccountId: "open_biz",
      username: "tt_biz",
      refreshToken: "rft",
      tokenScopes: ["video.publish", "video.upload"],
    }),
    {
      workspaceId: organizationId,
      platform: "instagram",
      externalAccountId: "za_ig",
      username: "zernio_ig",
    },
  ]);
  accounts = {
    igLogin: created[0],
    igFacebook: created[1],
    page: created[2],
    tiktokOld: created[3],
    tiktok: created[4],
    tiktokBiz: created[5],
    igZernio: created[6],
  };
  photos = await SocialPostMedia.create(
    [1, 2, 3].map((n) => ({
      workspaceId: organizationId,
      url: `https://api.newbi.test/social-media/${n}.jpg`,
      width: 1080,
      height: 1920,
    })),
  );
  videoMedia = await SocialPostMedia.create({
    workspaceId: organizationId,
    kind: "video",
    status: "ready",
    url: "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4",
    thumbnailUrl:
      "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg",
    width: 1080,
    height: 1920,
    durationMs: 30000,
    size: 10 * 1000 * 1000,
    contentType: "video/mp4",
  });
  vi.spyOn(provider, "createPost").mockResolvedValue({
    httpStatus: 201,
    incomplete: false,
    post: { externalPostId: "zp_1", status: "scheduled", targets: [] },
  });
  vi.spyOn(provider, "listAccounts").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const idOf = (doc) => String(doc._id);

// ── Connecteurs et capacités ───────────────────────────────────────────────

describe("connecteurs et capacités", () => {
  it("connectors : connexion habituelle et connecteurs de plus, seulement en direct", async () => {
    const status = () => Query.socialPublishingStatus(null, {}, ctx);
    const keys = async () => (await status()).connectors.map((c) => c.key);
    expect(await keys()).toEqual([
      "instagram",
      "instagram_facebook",
      "facebook",
      "linkedin",
      "twitter",
      "tiktok",
      "tiktok_business",
    ]);
    const { connectors } = await status();
    expect(connectors[1]).toEqual({
      key: "instagram_facebook",
      platform: "instagram",
      label: "Instagram via Facebook",
      description:
        "Permet d'ajouter un son tendance aux Reels. Le compte doit être relié à une Page Facebook.",
    });
    expect(connectors[6]).toMatchObject({
      label: "TikTok Business",
      description: "Permet d'ajouter un son tendance.",
    });

    // Instagram sur Zernio : la connexion via Facebook n'est pas proposée
    delete process.env.SOCIAL_PROVIDER_INSTAGRAM;
    expect(await keys()).not.toContain("instagram_facebook");
    expect(await keys()).toContain("instagram");

    // TikTok Business sans adresse d'autorisation : absent
    delete process.env.TIKTOK_BUSINESS_AUTH_URL;
    expect(await keys()).not.toContain("tiktok_business");

    // Instagram Login sans identifiants, via Facebook disponible : réseau
    // toujours connectable
    process.env.SOCIAL_PROVIDER_INSTAGRAM = "direct";
    delete process.env.INSTAGRAM_APP_SECRET;
    const result = await status();
    expect(result.connectors.map((c) => c.key)).toContain("instagram_facebook");
    expect(result.connectors.map((c) => c.key)).not.toContain("instagram");
    expect(result.platforms).toContain("instagram");
  });

  it("comptes : connecteur et capacités (stories, sons, brouillons)", async () => {
    const { accounts: list } = await Query.socialPublishingStatus(
      null,
      {},
      ctx,
    );
    const byId = (doc) => list.find((a) => a.id === idOf(doc));
    expect(byId(accounts.igFacebook)).toMatchObject({
      connector: "facebook",
      capabilities: {
        stories: true,
        sounds: true,
        drafts: false,
        draftsNeedReconnect: false,
      },
    });
    expect(byId(accounts.igLogin)).toMatchObject({
      connector: null,
      capabilities: { stories: true, sounds: false },
    });
    expect(byId(accounts.igZernio).capabilities).toEqual({
      stories: false,
      sounds: false,
      drafts: false,
      draftsNeedReconnect: false,
    });
    expect(byId(accounts.tiktokOld).capabilities).toMatchObject({
      drafts: false,
      draftsNeedReconnect: true,
    });
    expect(byId(accounts.tiktokBiz)).toMatchObject({
      connector: "business",
      capabilities: { sounds: true, drafts: true, stories: false },
    });
  });

  it("connexion via Facebook : fenêtre Meta, retour sur /instagram_facebook/callback, connecteur gardé", async () => {
    const url = new URL(
      await Mutation.connectSocialAccount(
        null,
        { platform: "instagram", connector: "instagram_facebook" },
        ctx,
      ),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.facebook.com/v26.0/dialog/oauth",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.newbi.test/social-connect/instagram_facebook/callback",
    );
    const state = await SocialConnectState.findOne({
      token: url.searchParams.get("state"),
    }).lean();
    expect(state).toMatchObject({
      platform: "instagram",
      connector: "instagram_facebook",
      provider: "direct",
    });

    await expect(
      Mutation.connectSocialAccount(
        null,
        { platform: "tiktok", connector: "instagram_facebook" },
        ctx,
      ),
    ).rejects.toThrow("Ce mode de connexion n'est pas pris en charge.");
    delete process.env.SOCIAL_PROVIDER_INSTAGRAM;
    await expect(
      Mutation.connectSocialAccount(
        null,
        { platform: "instagram", connector: "instagram_facebook" },
        ctx,
      ),
    ).rejects.toThrow(
      "La connexion à Instagram via Facebook n'est pas encore disponible.",
    );
  });

  it("retour via Facebook : compte Instagram Login du même espace basculé sur Facebook, jetons remplacés", async () => {
    const url = new URL(
      await Mutation.connectSocialAccount(
        null,
        { platform: "instagram", connector: "instagram_facebook" },
        ctx,
      ),
    );
    const token = url.searchParams.get("state");
    const exchange = vi
      .spyOn(instagramFacebookApi, "exchangeCode")
      .mockResolvedValue({
        accounts: [
          {
            platform: "instagram",
            externalAccountId: "17841400000000001",
            username: "boulangerie",
            displayName: "La Boulangerie",
            credentials: {
              accessToken: "user_long",
              tokenExpiresAt: later(60 * 24 * 60 * 60 * 1000),
              scopes: [],
            },
            credentialGroup: "meta-user:mu_9",
            platformData: { pageId: "p1", pageName: "B", metaUserId: "mu_9" },
          },
        ],
      });
    const redirect = await completeDirectConnect("instagram_facebook", {
      state: token,
      code: "code_1",
    });
    expect(redirect).toContain("social_connected=instagram");
    expect(exchange.mock.calls[0][0].redirectUri).toBe(
      "https://api.newbi.test/social-connect/instagram_facebook/callback",
    );
    const updated = await SocialAccount.findById(accounts.igLogin._id).select(
      "+accessToken",
    );
    expect(updated.connector).toBe("facebook");
    expect(decrypt(updated.accessToken)).toBe("user_long");
    expect(updated.platformData).toMatchObject({ metaUserId: "mu_9" });
    expect(
      await SocialAccount.countDocuments({
        externalAccountId: "17841400000000001",
      }),
    ).toBe(1);
  });

  it("retour via Facebook sans compte Instagram : no_instagram_account ; state d'un autre connecteur refusé", async () => {
    const connect = async (connector) =>
      new URL(
        await Mutation.connectSocialAccount(
          null,
          { platform: "instagram", connector },
          ctx,
        ),
      ).searchParams.get("state");
    vi.spyOn(instagramFacebookApi, "exchangeCode").mockResolvedValue({
      accounts: [],
    });
    expect(
      await completeDirectConnect("instagram_facebook", {
        state: await connect("instagram_facebook"),
        code: "c",
      }),
    ).toContain("social_error=no_instagram_account");
    // State d'Instagram Login présenté sur le retour via Facebook
    expect(
      await completeDirectConnect("instagram_facebook", {
        state: await connect("instagram"),
        code: "c",
      }),
    ).toContain("social_error=invalid_state");
  });

  it("TikTok Business : route avec « / » final, code reçu dans auth_code, compte « business »", async () => {
    const url = new URL(
      await Mutation.connectSocialAccount(
        null,
        { platform: "tiktok", connector: "tiktok_business" },
        ctx,
      ),
    );
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
    const exchange = vi
      .spyOn(tiktokBusinessApi, "exchangeCode")
      .mockResolvedValue({
        accounts: [
          {
            platform: "tiktok",
            externalAccountId: "open_biz_2",
            username: "nouveau_biz",
            credentials: {
              accessToken: "a",
              refreshToken: "r",
              scopes: ["video.publish", "video.upload"],
            },
          },
        ],
      });
    const app = express();
    app.use("/social-connect", socialConnectRouter);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(
        `${base}/social-connect/tiktok_business/callback/?auth_code=code_biz&state=${url.searchParams.get("state")}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "social_connected=tiktok",
      );
      // Clé inconnue : 404
      expect(
        (await fetch(`${base}/social-connect/myspace/callback`)).status,
      ).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(exchange.mock.calls[0][0]).toMatchObject({
      code: "code_biz",
      redirectUri:
        "https://api.newbi.test/social-connect/tiktok_business/callback/",
    });
    const saved = await SocialAccount.findOne({
      externalAccountId: "open_biz_2",
    }).lean();
    expect(saved).toMatchObject({ connector: "business", platform: "tiktok" });
  });
});

// ── Programmer : stories, sons, brouillons ─────────────────────────────────

describe("programmer : stories, sons, brouillons", () => {
  it("story Instagram et Facebook : enregistrée, texte libre ; refusée avec un compte Zernio", async () => {
    const { post } = await schedule({
      accountIds: [idOf(accounts.igLogin), idOf(accounts.page)],
      content: "a".repeat(3000),
      mediaIds: photos.map(idOf),
      instagramSettings: { format: "story" },
      facebookSettings: { format: "story" },
    });
    expect(post.instagramSettings).toEqual({ format: "story", sound: null });
    expect(post.facebookSettings).toEqual({ format: "story" });
    expect(post.targets.map((t) => t.storyCount)).toEqual([0, 0]);

    await expect(
      schedule({
        accountIds: [idOf(accounts.igZernio)],
        mediaIds: [idOf(photos[0])],
        instagramSettings: { format: "story" },
      }),
    ).rejects.toThrow(
      "Les stories ne sont disponibles que pour les comptes connectés directement.",
    );
    await expect(
      schedule({
        accountIds: [idOf(accounts.page)],
        mediaIds: [],
        facebookSettings: { format: "story" },
      }),
    ).rejects.toThrow("Une story Facebook exige une photo ou une vidéo.");
  });

  it("réglage d'un réseau non visé ignoré ; absent = publication", async () => {
    const { post } = await schedule({
      accountIds: [idOf(accounts.page)],
      mediaIds: [idOf(photos[0])],
      instagramSettings: { format: "story", sound: sound() },
    });
    expect(post.instagramSettings).toBeNull();
    expect(post.facebookSettings).toEqual({ format: "post" });
  });

  it("son Instagram : Reel d'un compte via Facebook ; refus clair sinon", async () => {
    const { post } = await schedule({
      accountIds: [idOf(accounts.igFacebook), idOf(accounts.igLogin)],
      mediaIds: [idOf(videoMedia)],
      instagramSettings: { format: "post", sound: sound({ volume: 0 }) },
    });
    expect(post.instagramSettings.sound).toEqual({
      id: "audio_42",
      title: "Été",
      artist: "Artiste",
      coverUrl: "https://cdn/cover.jpg",
      volume: 0,
      videoVolume: 50,
    });
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored.instagramSettings.sound.soundId).toBe("audio_42");

    await expect(
      schedule({
        accountIds: [idOf(accounts.igLogin)],
        mediaIds: [idOf(videoMedia)],
        instagramSettings: { format: "post", sound: sound() },
      }),
    ).rejects.toThrow(
      "Le son tendance Instagram demande un compte connecté via Facebook.",
    );
    await expect(
      schedule({
        accountIds: [idOf(accounts.igFacebook)],
        mediaIds: [idOf(photos[0])],
        instagramSettings: { format: "post", sound: sound() },
      }),
    ).rejects.toThrow(
      "Le son tendance Instagram s'ajoute seulement à une vidéo publiée en Reel (ni photo, ni story).",
    );
    await expect(
      schedule({
        accountIds: [idOf(accounts.igFacebook)],
        mediaIds: [idOf(videoMedia)],
        instagramSettings: { format: "post", sound: sound({ volume: 150 }) },
      }),
    ).rejects.toThrow("Le volume doit être un nombre entier de 0 à 100.");
  });

  it("brouillon TikTok : autorisation video.upload exigée, aucun autre réglage", async () => {
    await expect(
      schedule({
        accountIds: [idOf(accounts.tiktokOld)],
        mediaIds: [idOf(videoMedia)],
        tiktokSettings: { mode: "draft" },
      }),
    ).rejects.toThrow(
      "Reconnectez votre compte TikTok pour envoyer en brouillon.",
    );
    const { post } = await schedule({
      accountIds: [idOf(accounts.tiktok), idOf(accounts.tiktokBiz)],
      mediaIds: [idOf(videoMedia)],
      tiktokSettings: { mode: "draft" },
    });
    expect(post.tiktokSettings).toMatchObject({
      mode: "draft",
      privacyLevel: null,
      allowComment: null,
      sound: null,
    });
    await expect(
      schedule({
        accountIds: [idOf(accounts.tiktokBiz)],
        mediaIds: [idOf(videoMedia)],
        tiktokSettings: { mode: "draft", sound: sound() },
      }),
    ).rejects.toThrow("En brouillon, le son se choisit dans l'appli TikTok.");
  });

  it("TikTok Business : vidéo toujours publique ; son gardé pour les comptes Business", async () => {
    await expect(
      schedule({
        accountIds: [idOf(accounts.tiktokBiz)],
        mediaIds: [idOf(videoMedia)],
        tiktokSettings: directSettings({ privacyLevel: "SELF_ONLY" }),
      }),
    ).rejects.toThrow(
      "Avec un compte TikTok Business, une vidéo est toujours publique : choisissez « Tout le monde ».",
    );
    // Photos : confidentialité libre
    await schedule({
      accountIds: [idOf(accounts.tiktokBiz)],
      mediaIds: [idOf(photos[0])],
      tiktokSettings: directSettings({ privacyLevel: "SELF_ONLY" }),
    });

    const { post } = await schedule({
      accountIds: [idOf(accounts.tiktok), idOf(accounts.tiktokBiz)],
      mediaIds: [idOf(videoMedia)],
      tiktokSettings: directSettings({ sound: sound() }),
    });
    expect(post.tiktokSettings).toMatchObject({
      mode: "direct",
      privacyLevel: "PUBLIC_TO_EVERYONE",
      sound: { id: "audio_42", volume: 80, videoVolume: 50 },
    });
    await expect(
      schedule({
        accountIds: [idOf(accounts.tiktok)],
        mediaIds: [idOf(videoMedia)],
        tiktokSettings: directSettings({ sound: sound() }),
      }),
    ).rejects.toThrow(
      "Le son tendance TikTok demande un compte TikTok Business.",
    );
  });

  it("modifier : réglages gardés relus, son retiré quand le média ne s'y prête plus", async () => {
    const { post } = await schedule({
      accountIds: [idOf(accounts.igFacebook)],
      mediaIds: [idOf(videoMedia)],
      instagramSettings: { format: "post", sound: sound() },
    });
    // Texte seul modifié : son gardé
    const kept = await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { content: "Nouveau texte" } },
      ctx,
    );
    expect(kept.instagramSettings.sound).toMatchObject({ id: "audio_42" });
    // Photo à la place de la vidéo : son retiré sans erreur
    const photo = await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { mediaIds: [idOf(photos[0])] } },
      ctx,
    );
    expect(photo.instagramSettings).toEqual({ format: "post", sound: null });
    // Passage en story
    const story = await Mutation.updateSocialPost(
      null,
      {
        id: post.id,
        input: { instagramSettings: { format: "story" } },
      },
      ctx,
    );
    expect(story.instagramSettings.format).toBe("story");
  });
});

// ── Sons tendance ──────────────────────────────────────────────────────────

describe("socialTrendingSounds", () => {
  const sounds = (accountId, args = {}) =>
    Query.socialTrendingSounds(null, { accountId, ...args }, ctx);

  it("compte sans son tendance : erreur claire", async () => {
    await expect(sounds(idOf(accounts.tiktok))).rejects.toThrow(
      "Le son tendance TikTok demande un compte TikTok Business.",
    );
    await expect(sounds(idOf(accounts.igLogin))).rejects.toThrow(
      "Le son tendance Instagram demande un compte connecté via Facebook.",
    );
    await expect(sounds(idOf(accounts.page))).rejects.toThrow(
      "Ce compte ne permet pas d'ajouter un son tendance.",
    );
  });

  it("TikTok Business : tendances gardées 30 minutes, recherche ignorée", async () => {
    const list = vi
      .spyOn(tiktokBusinessApi, "listSounds")
      .mockResolvedValue([{ id: "clip_1", title: "Tube", rank: 1 }]);
    expect(await sounds(idOf(accounts.tiktokBiz))).toEqual([
      { id: "clip_1", title: "Tube", rank: 1 },
    ]);
    await sounds(idOf(accounts.tiktokBiz), { search: "ignoré" });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toMatchObject({
      accessToken: "token",
      search: "",
      kind: null,
    });
  });

  it("Instagram via Facebook : recherche et type par compte ; type inconnu refusé", async () => {
    const list = vi
      .spyOn(instagramFacebookApi, "listSounds")
      .mockResolvedValue([{ id: "a1", title: "Été" }]);
    await sounds(idOf(accounts.igFacebook));
    await sounds(idOf(accounts.igFacebook), {
      search: " plage ",
      kind: "original_sound",
    });
    await sounds(idOf(accounts.igFacebook), {
      search: "plage",
      kind: "original_sound",
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({
      search: "plage",
      kind: "original_sound",
    });
    await expect(
      sounds(idOf(accounts.igFacebook), { kind: "podcast" }),
    ).rejects.toThrow("Type de son inconnu.");
  });
});

// ── Publication des cibles ─────────────────────────────────────────────────

const createPost = (fields) =>
  SocialPost.create({
    workspaceId: organizationId,
    boardId: board._id,
    taskId: task._id,
    createdBy: alice,
    provider: "direct",
    idempotencyKey: crypto.randomUUID(),
    content: "",
    scheduledFor: SCHEDULED,
    status: "scheduled",
    ...fields,
  });

const target = (account, fields = {}) => ({
  socialAccountId: account._id,
  platform: account.platform,
  externalAccountId: account.externalAccountId,
  username: account.username,
  status: "pending",
  provider: "direct",
  ...fields,
});

const postMediaOf = (items) =>
  items.map((item) => ({
    mediaId: item._id,
    kind: item.kind || "image",
    url: item.url,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs ?? null,
    size: item.size ?? null,
  }));

describe("publication des stories et des brouillons", () => {
  it("stories Instagram : échec après la 1re, nouvel essai à partir de la 2e, aucune story en double", async () => {
    const post = await createPost({
      media: postMediaOf(photos),
      targets: [target(accounts.igLogin)],
      instagramSettings: { format: "story" },
    });
    const fetchMock = stubFetch([
      on(
        "POST",
        "/media_publish",
        sequence(
          jsonResponse({ id: "story_1" }),
          jsonResponse({ error: { message: "Erreur", code: 2 } }, 500),
          jsonResponse({ id: "story_2" }),
          jsonResponse({ id: "story_3" }),
        ),
      ),
      on("POST", "/17841400000000001/media", (url, init) =>
        jsonResponse({ id: `c_${JSON.parse(init.body).image_url.slice(-5)}` }),
      ),
      on(
        "GET",
        "fields=status_code",
        jsonResponse({ status_code: "FINISHED" }),
      ),
      on("GET", "fields=permalink", jsonResponse({})),
    ]);

    const first = await publishDueDirectTargets({ now: NOW });
    expect(first.retried).toBe(1);
    let stored = (await SocialPost.findById(post._id).lean()).targets[0];
    expect(stored).toMatchObject({ status: "pending", storyIds: ["story_1"] });

    const second = await publishDueDirectTargets({
      now: later(2 * 60 * 1000),
    });
    expect(second.published).toBe(1);
    stored = (await SocialPost.findById(post._id).lean()).targets[0];
    expect(stored).toMatchObject({
      status: "published",
      externalPostId: "story_1",
      storyIds: ["story_1", "story_2", "story_3"],
    });
    // Photo 1 envoyée une seule fois
    const sentImages = callsTo(fetchMock, "POST", "/17841400000000001/media")
      .filter(([url]) => new URL(url).pathname.endsWith("/media"))
      .map((call) => jsonOf(call).image_url.slice(-5));
    expect(sentImages).toEqual(["1.jpg", "2.jpg", "2.jpg", "3.jpg"]);
    const [serialized] = (
      await Query.boardSocialPosts(null, { boardId: String(board._id) }, ctx)
    ).filter((p) => p.id === String(post._id));
    expect(serialized.targets[0].storyCount).toBe(3);
  });

  it("« Réessayer » après un échec : stories gardées, reprise après la dernière", async () => {
    const post = await createPost({
      media: postMediaOf(photos.slice(0, 2)),
      targets: [
        target(accounts.page, {
          status: "failed",
          attempts: 4,
          storyIds: ["1001_s1"],
          errorCategory: "platform_rejected",
        }),
      ],
      facebookSettings: { format: "story" },
      status: "failed",
    });
    expect(await resetFailedDirectTargets(post._id)).toBe(1);
    const fetchMock = stubFetch([
      on("POST", "/1001/photos", jsonResponse({ id: "ph_2" })),
      on(
        "POST",
        "/1001/photo_stories",
        jsonResponse({ success: true, post_id: "1001_s2" }),
      ),
      on("GET", "fields=permalink_url", jsonResponse({})),
    ]);
    await publishDueDirectTargets({ now: NOW });
    const stored = (await SocialPost.findById(post._id).lean()).targets[0];
    expect(stored).toMatchObject({
      status: "published",
      storyIds: ["1001_s1", "1001_s2"],
    });
    expect(callsTo(fetchMock, "POST", "/1001/photos")).toHaveLength(1);
  });

  it("bail perdu pendant les stories : envoi arrêté, rien n'est écrit par-dessus", async () => {
    const post = await createPost({
      media: postMediaOf(photos.slice(0, 2)),
      targets: [target(accounts.page)],
      facebookSettings: { format: "story" },
    });
    const stolen = later(60 * 60 * 1000);
    vi.spyOn(
      (await import("../../../src/services/social/direct/metaApi.js")).default,
      "publish",
    ).mockImplementation(async ({ saveProgress }) => {
      // Un autre envoi a repris la cible (bail expiré)
      await SocialPost.updateOne(
        { _id: post._id },
        { $set: { "targets.0.lockedUntil": stolen } },
      );
      await saveProgress({ storyIds: ["s1"] });
      return { status: "published", externalPostId: "s1" };
    });
    const stats = await publishDueDirectTargets({ now: NOW });
    expect(stats.published).toBe(0);
    const stored = (await SocialPost.findById(post._id).lean()).targets[0];
    expect(stored.storyIds).toBeUndefined();
    expect(stored.lockedUntil).toEqual(stolen);
  });

  it("Instagram via Facebook : module du connecteur, son transmis", async () => {
    await createPost({
      media: postMediaOf([videoMedia]),
      targets: [target(accounts.igFacebook)],
      instagramSettings: {
        format: "post",
        sound: {
          soundId: "audio_42",
          title: "Été",
          volume: 80,
          videoVolume: 50,
        },
      },
    });
    const viaFacebook = vi
      .spyOn(instagramFacebookApi, "publish")
      .mockResolvedValue({
        status: "publishing",
        processingRef: "c_1",
        nextCheckMs: 60000,
      });
    const viaLogin = vi.spyOn(instagramApi, "publish");
    await publishDueDirectTargets({ now: NOW });
    expect(viaLogin).not.toHaveBeenCalled();
    expect(viaFacebook.mock.calls[0][0].instagramSettings).toMatchObject({
      format: "post",
      sound: { soundId: "audio_42" },
    });
  });

  it("brouillon TikTok livré : publié, deliveredAs « draft », sans suivi d'adresse, notification adaptée", async () => {
    const post = await createPost({
      media: postMediaOf([videoMedia]),
      targets: [
        target(accounts.tiktok, {
          status: "publishing",
          externalPostId: "p_1",
          submittedAt: SCHEDULED,
        }),
      ],
      tiktokSettings: { mode: "draft" },
      status: "publishing",
    });
    vi.spyOn(tiktokApi, "checkPublication").mockResolvedValue({
      status: "published",
      deliveredAs: "draft",
      externalPostId: "p_1",
      platformPostUrl: null,
    });
    await publishDueDirectTargets({ now: NOW });
    const fresh = await SocialPost.findById(post._id).lean();
    expect(fresh.status).toBe("published");
    expect(fresh.targets[0]).toMatchObject({
      status: "published",
      deliveredAs: "draft",
      urlCheckUntil: null,
      nextAttemptAt: null,
      platformPostUrl: null,
    });
    const notification = await Notification.findOne({
      userId: String(alice),
    }).lean();
    expect(notification).toMatchObject({
      title: "Post envoyé en brouillon",
      message:
        "Votre post a été envoyé dans vos brouillons TikTok : terminez la publication dans l'appli TikTok.",
    });
    const [serialized] = await Query.boardSocialPosts(
      null,
      { boardId: String(board._id) },
      ctx,
    );
    expect(serialized.targets[0]).toMatchObject({
      deliveredAs: "draft",
      storyCount: 0,
    });
  });

  it("notification d'un post publié ailleurs et envoyé en brouillon TikTok", () => {
    expect(
      buildOutcomeMessage({
        status: "published",
        targets: [
          { platform: "instagram", status: "published" },
          { platform: "tiktok", status: "published", deliveredAs: "draft" },
        ],
      }),
    ).toEqual({
      type: "SOCIAL_POST_PUBLISHED",
      title: "Post publié",
      message:
        "Votre post a été publié sur Instagram et envoyé dans vos brouillons TikTok : terminez la publication dans l'appli TikTok.",
    });
    expect(
      buildOutcomeMessage({
        status: "partial",
        targets: [
          { platform: "tiktok", status: "published", deliveredAs: "draft" },
          { platform: "facebook", status: "failed" },
        ],
      }).message,
    ).toBe("Envoyé dans vos brouillons TikTok, échec sur Facebook.");
  });

  it("brouillon TikTok refusé par l'autorisation manquante : compte à reconnecter", async () => {
    const post = await createPost({
      media: postMediaOf([videoMedia]),
      targets: [target(accounts.tiktok)],
      tiktokSettings: { mode: "draft" },
    });
    vi.spyOn(tiktokApi, "publish").mockRejectedValue(
      new DirectApiError("tiktok : scope_not_authorized", {
        network: "tiktok",
        category: "auth_expired",
        authInvalid: true,
      }),
    );
    vi.spyOn(tiktokApi, "refreshCredentials").mockResolvedValue({
      accessToken: "fresh",
    });
    await publishDueDirectTargets({ now: NOW });
    const fresh = await SocialPost.findById(post._id).lean();
    expect(fresh.targets[0]).toMatchObject({
      status: "failed",
      errorCategory: "auth_expired",
    });
  });
});

// ── Jetons des connecteurs ─────────────────────────────────────────────────

describe("jetons des connecteurs", () => {
  it("Instagram via Facebook : jeton partagé rafraîchi une fois pour tout le groupe", async () => {
    const soon = later(5 * 24 * 60 * 60 * 1000);
    await SocialAccount.updateOne(
      { _id: accounts.igFacebook._id },
      { $set: { tokenExpiresAt: soon } },
    );
    const second = await SocialAccount.create(
      directAccount({
        platform: "instagram",
        connector: "facebook",
        externalAccountId: "17841400000000009",
        credentialGroup: "meta-user:mu_1",
        tokenExpiresAt: soon,
        platformData: { metaUserId: "mu_1" },
      }),
    );
    const refresh = vi
      .spyOn(instagramFacebookApi, "refreshCredentials")
      .mockResolvedValue({
        accessToken: "user_new",
        tokenExpiresAt: later(60 * 24 * 60 * 60 * 1000),
      });
    const viaLogin = vi.spyOn(instagramApi, "refreshCredentials");
    expect(await refreshExpiringTokens({ now: NOW })).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(viaLogin).not.toHaveBeenCalled();
    const fresh = await SocialAccount.findById(second._id).select(
      "+accessToken",
    );
    expect(decrypt(fresh.accessToken)).toBe("user_new");
  });

  it("déconnexion d'un compte TikTok Business : révocation par l'API for Business", async () => {
    const business = vi
      .spyOn(tiktokBusinessApi, "revoke")
      .mockResolvedValue(undefined);
    const loginKit = vi.spyOn(tiktokApi, "revoke");
    await Mutation.disconnectSocialAccount(
      null,
      { accountId: idOf(accounts.tiktokBiz) },
      ctx,
    );
    expect(business).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "token" }),
    );
    expect(loginKit).not.toHaveBeenCalled();
  });
});

// ── Rappels de Meta ────────────────────────────────────────────────────────

const sign = (payload, secret) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${signature}.${body}`;
};

describe("rappels de Meta", () => {
  let server;
  let base;

  beforeEach(async () => {
    const app = express();
    app.use("/social-connect", socialConnectRouter);
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}/social-connect`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (path, signedRequest) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: signedRequest }).toString(),
    });
  const withTokens = (doc) =>
    SocialAccount.findById(doc._id).select("+accessToken").lean();

  it("signed_request : signature vérifiée, charge lue", () => {
    const request = sign(
      { algorithm: "HMAC-SHA256", user_id: "mu_1" },
      "meta_secret",
    );
    expect(parseSignedRequest(request, "meta_secret")).toMatchObject({
      user_id: "mu_1",
    });
    expect(parseSignedRequest(request, "autre_secret")).toBeNull();
    expect(parseSignedRequest("abc", "meta_secret")).toBeNull();
    expect(
      parseSignedRequest(
        sign({ algorithm: "HMAC-SHA1", user_id: "1" }, "meta_secret"),
        "meta_secret",
      ),
    ).toBeNull();
  });

  it("désautorisation Facebook : comptes de l'utilisateur (tous espaces) à reconnecter, jetons effacés", async () => {
    const elsewhere = await SocialAccount.create(
      directAccount({
        workspaceId: otherOrganizationId,
        platform: "facebook",
        externalAccountId: "2002",
        platformData: { metaUserId: "mu_1" },
      }),
    );
    const response = await post(
      "/meta/deauthorize",
      sign({ algorithm: "HMAC-SHA256", user_id: "mu_1" }, "meta_secret"),
    );
    expect(response.status).toBe(200);
    for (const doc of [accounts.page, accounts.igFacebook, elsewhere]) {
      const fresh = await withTokens(doc);
      expect(fresh).toMatchObject({
        status: "needs_reconnect",
        accessToken: null,
      });
      expect(fresh.deletedAt).toBeNull();
    }
    // Instagram Login et TikTok : intacts
    expect((await withTokens(accounts.igLogin)).status).toBe("active");
    expect((await withTokens(accounts.tiktok)).accessToken).not.toBeNull();
  });

  it("signature fausse : 400 ; appli non configurée : 404 ; compte inconnu : 200 sans effet", async () => {
    expect(
      (
        await post(
          "/meta/deauthorize",
          sign({ user_id: "mu_1" }, "mauvais_secret"),
        )
      ).status,
    ).toBe(400);
    expect((await withTokens(accounts.page)).status).toBe("active");

    expect(
      (
        await post(
          "/meta/data-deletion",
          sign({ user_id: "inconnu" }, "meta_secret"),
        )
      ).status,
    ).toBe(200);
    expect(
      await SocialAccount.countDocuments({ deletedAt: { $ne: null } }),
    ).toBe(0);

    delete process.env.INSTAGRAM_APP_SECRET;
    expect(
      (await post("/instagram/deauthorize", sign({ user_id: "1" }, "x")))
        .status,
    ).toBe(404);
  });

  it("suppression des données : comptes déconnectés, code de suivi, page de suivi en français", async () => {
    const now = Date.now();
    const response = await post(
      "/meta/data-deletion",
      sign({ algorithm: "HMAC-SHA256", user_id: "mu_1" }, "meta_secret"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.confirmation_code).toMatch(/^[a-f0-9]{24}$/);
    expect(body.url).toBe(
      `https://api.newbi.test/social-connect/meta/data-deletion/${body.confirmation_code}`,
    );
    for (const doc of [accounts.page, accounts.igFacebook]) {
      const fresh = await withTokens(doc);
      expect(fresh.accessToken).toBeNull();
      expect(new Date(fresh.deletedAt).getTime()).toBeGreaterThanOrEqual(
        now - 1000,
      );
    }
    const page = await fetch(
      `${base}/meta/data-deletion/${body.confirmation_code}`,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Demande de suppression reçue le");
    expect(html).toContain(
      "2 compte(s) déconnecté(s) et leurs accès supprimés.",
    );
    expect(
      (await fetch(`${base}/meta/data-deletion/${"0".repeat(24)}`)).status,
    ).toBe(404);
  });

  it("Instagram Login : compte retrouvé par son identifiant, comptes via Facebook intacts", async () => {
    const response = await post(
      "/instagram/deauthorize",
      sign({ user_id: "17841400000000001" }, "ig_secret"),
    );
    expect(response.status).toBe(200);
    expect((await withTokens(accounts.igLogin)).status).toBe("needs_reconnect");
    expect((await withTokens(accounts.igFacebook)).status).toBe("active");
  });

  it("appli dédiée à Instagram via Facebook : son secret, ses comptes seulement", async () => {
    process.env.META_INSTAGRAM_FB_APP_ID = "ig_fb_app";
    process.env.META_INSTAGRAM_FB_APP_SECRET = "ig_fb_secret";
    // Signé avec le secret des Pages : refusé sur la route dédiée
    expect(
      (
        await post(
          "/instagram_facebook/deauthorize",
          sign({ user_id: "mu_1" }, "meta_secret"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/instagram_facebook/deauthorize",
          sign({ user_id: "mu_1" }, "ig_fb_secret"),
        )
      ).status,
    ).toBe(200);
    expect((await withTokens(accounts.igFacebook)).status).toBe(
      "needs_reconnect",
    );
    // Autre appli : la page Facebook n'est pas concernée
    expect((await withTokens(accounts.page)).status).toBe("active");
  });
});
