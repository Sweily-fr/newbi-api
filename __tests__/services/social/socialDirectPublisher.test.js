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
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { seedOrgMembership } from "../../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";

vi.mock("../../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const sendSocialPostFailedEmail = vi.fn(async () => true);
vi.mock("../../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(async () => true),
  sendMentionEmail: vi.fn(async () => true),
  sendSocialPostFailedEmail: (...args) => sendSocialPostFailedEmail(...args),
}));
vi.mock("../../../src/resolvers/notification.js", () => ({
  publishNotification: vi.fn(async () => {}),
}));
vi.mock("../../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(async () => {}),
}));

import { Board, Task } from "../../../src/models/kanban.js";
import Notification from "../../../src/models/Notification.js";
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialPost from "../../../src/models/SocialPost.js";
import { decrypt, isEncrypted } from "../../../src/utils/encryption.js";
import {
  DirectApiError,
  timing,
} from "../../../src/services/social/direct/directHttp.js";
import xApi from "../../../src/services/social/direct/xApi.js";
import tiktokApi from "../../../src/services/social/direct/tiktokApi.js";
import instagramApi from "../../../src/services/social/direct/instagramApi.js";
import provider from "../../../src/services/social/providers/zernioProvider.js";
import {
  LOCK_MS,
  MAX_ATTEMPTS,
  aggregatePostStatus,
  publishDueDirectTargets,
} from "../../../src/services/social/socialDirectPublisher.js";
import { refreshExpiringTokens } from "../../../src/services/social/socialAccountCredentials.js";
import { syncDueSocialPosts } from "../../../src/services/social/socialPostSync.js";
import { runSocialDirectPublish } from "../../../src/cron/socialDirectPublishCron.js";

const alice = buildUserId();
const organizationId = buildOrganizationId();
const NOW = new Date("2026-11-02T08:01:00.000Z");
const SCHEDULED = new Date("2026-11-02T08:00:00.000Z");
const later = (ms) => new Date(NOW.getTime() + ms);
let board;
let task;
let xAccount;
let tiktokAccount;

const directTarget = (account, fields = {}) => ({
  socialAccountId: account._id,
  platform: account.platform,
  externalAccountId: account.externalAccountId,
  username: account.username,
  status: "pending",
  provider: "direct",
  ...fields,
});

const createPost = (fields = {}) =>
  SocialPost.create({
    workspaceId: organizationId,
    boardId: board._id,
    taskId: task._id,
    createdBy: alice,
    provider: "direct",
    externalPostId: null,
    idempotencyKey: "key-1",
    content: "Bonjour https://newbi.fr",
    media: [],
    targets: [directTarget(xAccount)],
    scheduledFor: SCHEDULED,
    status: "scheduled",
    ...fields,
  });

const targetOf = async (post, index = 0) =>
  (await SocialPost.findById(post._id).lean()).targets[index];

const published = (id = "1850000000000000000") => ({
  status: "published",
  externalPostId: id,
  platformPostUrl: `https://x.com/acme/status/${id}`,
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  sendSocialPostFailedEmail.mockClear();
  timing.sleep = async () => {};
  Object.assign(process.env, {
    DATA_ENCRYPTION_KEY: "test-encryption-key-social-direct",
    SOCIAL_MEDIA_BUCKET: "social-test",
    R2_API_URL: "https://r2.test",
    R2_ACCESS_KEY_ID: "r2_id",
    R2_SECRET_ACCESS_KEY: "r2_secret",
    X_CLIENT_ID: "x_client",
    X_CLIENT_SECRET: "x_secret",
    TIKTOK_CLIENT_KEY: "tt_key",
    TIKTOK_CLIENT_SECRET: "tt_secret",
    INSTAGRAM_APP_ID: "ig_app",
    INSTAGRAM_APP_SECRET: "ig_secret",
    FRONTEND_URL: "https://www.newbi.test",
    ZERNIO_API_KEY: "sk_test_zernio",
  });
  await mongoose.connection.db
    .collection("user")
    .insertOne({ _id: alice, email: "alice@test.fr", name: "Alice" });
  await seedOrgMembership({ userId: alice, organizationId });
  board = await Board.create({
    title: "Communication",
    workspaceId: organizationId,
    userId: alice,
  });
  task = await Task.create({
    title: "Post X : Bonjour",
    status: "col",
    boardId: board._id,
    columnId: "col",
    workspaceId: organizationId,
    userId: alice,
  });
  [xAccount, tiktokAccount] = await SocialAccount.create([
    {
      workspaceId: organizationId,
      provider: "direct",
      platform: "twitter",
      externalAccountId: "42",
      username: "acme",
      accessToken: "x_access",
      refreshToken: "x_refresh",
      tokenExpiresAt: later(60 * 60 * 1000),
    },
    {
      workspaceId: organizationId,
      provider: "direct",
      platform: "tiktok",
      externalAccountId: "open_1",
      username: "boulangerie",
      accessToken: "act.1",
      refreshToken: "rft.1",
      tokenExpiresAt: later(12 * 60 * 60 * 1000),
    },
  ]);
  vi.spyOn(xApi, "publish");
  vi.spyOn(xApi, "refreshCredentials");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publication des cibles directes", () => {
  it("jetons chiffrés au repos, jamais renvoyés par une lecture normale", async () => {
    const raw = await mongoose.connection.db
      .collection("socialaccounts")
      .findOne({ _id: xAccount._id });
    expect(isEncrypted(raw.accessToken)).toBe(true);
    expect(decrypt(raw.accessToken)).toBe("x_access");
    expect(isEncrypted(raw.refreshToken)).toBe(true);
    const lean = await SocialAccount.findById(xAccount._id).lean();
    expect(lean.accessToken).toBeUndefined();
    expect(lean.refreshToken).toBeUndefined();
  });

  it("cible X à l'heure : publiée, adresse, auteur notifié une fois", async () => {
    const post = await createPost();
    xApi.publish.mockResolvedValue(published());

    const stats = await publishDueDirectTargets({ now: NOW });
    expect(stats).toMatchObject({ posts: 1, published: 1, failed: 0 });
    expect(xApi.publish).toHaveBeenCalledTimes(1);
    const call = xApi.publish.mock.calls[0][0];
    expect(call.accessToken).toBe("x_access");
    expect(call.content).toBe("Bonjour https://newbi.fr");

    const saved = await SocialPost.findById(post._id).lean();
    expect(saved.status).toBe("published");
    expect(saved.targets[0]).toMatchObject({
      status: "published",
      externalPostId: "1850000000000000000",
      platformPostUrl: "https://x.com/acme/status/1850000000000000000",
      attempts: 1,
      lockedUntil: null,
    });

    await publishDueDirectTargets({ now: later(60 * 1000) });
    expect(xApi.publish).toHaveBeenCalledTimes(1);
    expect(
      await Notification.countDocuments({ type: "SOCIAL_POST_PUBLISHED" }),
    ).toBe(1);
  });

  it("pas encore l'heure, ou carte d'un post annulé : rien ne part", async () => {
    await createPost({ scheduledFor: later(10 * 60 * 1000) });
    await createPost({
      taskId: new mongoose.Types.ObjectId(),
      status: "cancelled",
      targets: [directTarget(xAccount, { status: "cancelled" })],
    });
    const stats = await publishDueDirectTargets({ now: NOW });
    expect(stats.posts).toBe(0);
    expect(xApi.publish).not.toHaveBeenCalled();
  });

  it("jeton expiré : rafraîchi d'abord (nouveau jeton chiffré gardé), puis publié avec lui", async () => {
    await SocialAccount.updateOne(
      { _id: xAccount._id },
      { $set: { tokenExpiresAt: later(-60 * 1000) } },
    );
    const post = await createPost();
    xApi.refreshCredentials.mockResolvedValue({
      accessToken: "x_access_2",
      refreshToken: "x_refresh_2",
      tokenExpiresAt: later(2 * 60 * 60 * 1000),
    });
    xApi.publish.mockResolvedValue(published());

    await publishDueDirectTargets({ now: NOW });
    expect(xApi.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "x_refresh" }),
    );
    expect(xApi.publish.mock.calls[0][0].accessToken).toBe("x_access_2");
    const account = await SocialAccount.findById(xAccount._id).select(
      "+accessToken +refreshToken",
    );
    expect(decrypt(account.accessToken)).toBe("x_access_2");
    expect(decrypt(account.refreshToken)).toBe("x_refresh_2");
    expect(account.tokenRefreshLockedUntil).toBeNull();
    expect((await targetOf(post)).status).toBe("published");
  });

  it("jeton refusé avant sa date : un rafraîchissement, puis un seul nouvel envoi", async () => {
    await createPost();
    xApi.publish
      .mockRejectedValueOnce(
        new DirectApiError("401", {
          network: "x",
          authInvalid: true,
          category: "auth_expired",
        }),
      )
      .mockResolvedValueOnce(published());
    xApi.refreshCredentials.mockResolvedValue({
      accessToken: "x_access_2",
      refreshToken: "x_refresh_2",
      tokenExpiresAt: later(2 * 60 * 60 * 1000),
    });
    const stats = await publishDueDirectTargets({ now: NOW });
    expect(stats.published).toBe(1);
    expect(xApi.publish).toHaveBeenCalledTimes(2);
    expect(xApi.publish.mock.calls[1][0].accessToken).toBe("x_access_2");
  });

  it("jeton révoqué : compte à reconnecter, cible en échec auth_expired, e-mail une seule fois", async () => {
    const post = await createPost();
    xApi.publish.mockRejectedValue(
      new DirectApiError("401", {
        network: "x",
        authInvalid: true,
        category: "auth_expired",
      }),
    );
    xApi.refreshCredentials.mockRejectedValue(
      new DirectApiError("invalid_grant", {
        network: "x",
        authInvalid: true,
        category: "auth_expired",
      }),
    );
    await publishDueDirectTargets({ now: NOW });

    expect((await SocialAccount.findById(xAccount._id)).status).toBe(
      "needs_reconnect",
    );
    const saved = await SocialPost.findById(post._id).lean();
    expect(saved.status).toBe("failed");
    expect(saved.targets[0]).toMatchObject({
      status: "failed",
      errorCategory: "auth_expired",
    });
    expect(sendSocialPostFailedEmail).toHaveBeenCalledTimes(1);
    expect(
      sendSocialPostFailedEmail.mock.calls[0][1].failures[0].error,
    ).toContain("Reconnectez le compte");

    // Un autre post sur le même compte échoue sans appeler X
    xApi.publish.mockClear();
    await createPost({ taskId: new mongoose.Types.ObjectId() });
    await publishDueDirectTargets({ now: later(60 * 1000) });
    expect(xApi.publish).not.toHaveBeenCalled();
    await publishDueDirectTargets({ now: later(2 * 60 * 1000) });
    expect(sendSocialPostFailedEmail).toHaveBeenCalledTimes(2);
  });

  it("limite de débit : nouveaux essais espacés, 3 au plus, puis échec", async () => {
    const post = await createPost();
    xApi.publish.mockRejectedValue(
      new DirectApiError("429", {
        network: "x",
        transient: true,
        category: "platform_rate_limit",
        retryAfterMs: 2 * 60 * 1000,
      }),
    );

    await publishDueDirectTargets({ now: NOW });
    let target = await targetOf(post);
    expect(target).toMatchObject({ status: "pending", attempts: 1 });
    // Délai annoncé par X (2 min) plus long que le premier palier (1 min)
    expect(target.nextAttemptAt.getTime()).toBe(later(2 * 60 * 1000).getTime());
    expect((await SocialPost.findById(post._id)).status).toBe("publishing");

    // Avant le délai : pas de nouvel envoi
    await publishDueDirectTargets({ now: later(60 * 1000) });
    expect(xApi.publish).toHaveBeenCalledTimes(1);

    let now = NOW;
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      now = new Date(target.nextAttemptAt.getTime());
      await publishDueDirectTargets({ now });
      target = await targetOf(post);
    }
    expect(xApi.publish).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(target).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      errorCategory: "platform_rate_limit",
    });
    // Chaque nouvel essai automatique vers X compte dans la limite
    // mensuelle ; le premier envoi est compté par la cible elle-même
    const { xRetriedAt } = await SocialPost.findById(post._id).lean();
    expect(xRetriedAt).toHaveLength(MAX_ATTEMPTS - 1);
    expect((await SocialPost.findById(post._id)).status).toBe("failed");

    await publishDueDirectTargets({
      now: new Date(now.getTime() + 60 * 60 * 1000),
    });
    expect(xApi.publish).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("contenu refusé : échec définitif sans nouvel essai, message du réseau gardé", async () => {
    const post = await createPost();
    xApi.publish.mockRejectedValue(
      new DirectApiError("403", {
        network: "x",
        category: "user_content",
        detail: "You are not allowed to create a Tweet with duplicate content.",
      }),
    );
    await publishDueDirectTargets({ now: NOW });
    expect((await SocialPost.findById(post._id).lean()).xRetriedAt).toEqual([]);
    expect(await targetOf(post)).toMatchObject({
      status: "failed",
      errorCategory: "user_content",
      errorMessage:
        "You are not allowed to create a Tweet with duplicate content.",
      attempts: 1,
    });
    await publishDueDirectTargets({ now: later(60 * 60 * 1000) });
    expect(xApi.publish).toHaveBeenCalledTimes(1);
  });

  it("bail : deux passes simultanées n'envoient la cible qu'une fois", async () => {
    await createPost();
    let release;
    xApi.publish.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(published());
        }),
    );
    const first = publishDueDirectTargets({ now: NOW });
    // Laisse la première passe réserver la cible
    await vi.waitFor(() => expect(xApi.publish).toHaveBeenCalledTimes(1));
    const second = await publishDueDirectTargets({ now: NOW });
    expect(second.published).toBe(0);
    release();
    await first;
    expect(xApi.publish).toHaveBeenCalledTimes(1);
  });

  it("envoi interrompu (bail expiré sans résultat) : échec, jamais renvoyé", async () => {
    const post = await createPost({
      status: "publishing",
      targets: [
        directTarget(xAccount, {
          status: "publishing",
          attempts: 1,
          lockedUntil: new Date(NOW.getTime() - 1000),
        }),
      ],
    });
    await publishDueDirectTargets({ now: NOW });
    expect(xApi.publish).not.toHaveBeenCalled();
    expect(await targetOf(post)).toMatchObject({
      status: "failed",
      errorCategory: null,
    });

    // Bail encore valide : la cible est laissée à celui qui l'a
    const busy = await createPost({
      taskId: new mongoose.Types.ObjectId(),
      status: "publishing",
      targets: [
        directTarget(xAccount, {
          status: "publishing",
          lockedUntil: new Date(NOW.getTime() + LOCK_MS),
        }),
      ],
    });
    await publishDueDirectTargets({ now: NOW });
    expect((await targetOf(busy)).status).toBe("publishing");
  });

  it("TikTok : envoi accepté, suivi du statut jusqu'à la publication avec adresse", async () => {
    const post = await createPost({
      content: "Pain du jour",
      media: [
        {
          url: "https://api.newbi.test/social-media/a.jpg",
          width: 1080,
          height: 1080,
        },
      ],
      targets: [directTarget(tiktokAccount)],
      tiktokSettings: {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
      },
    });
    vi.spyOn(tiktokApi, "publish").mockResolvedValue({
      status: "publishing",
      externalPostId: "p_1",
      platformPostUrl: null,
      username: "boulangerie",
    });
    vi.spyOn(tiktokApi, "checkPublication")
      .mockResolvedValueOnce({ status: "publishing", externalPostId: "p_1" })
      .mockResolvedValueOnce({
        status: "published",
        externalPostId: "73001",
        platformPostUrl: "https://www.tiktok.com/@boulangerie/photo/73001",
      });

    await publishDueDirectTargets({ now: NOW });
    expect(tiktokApi.publish.mock.calls[0][0]).toMatchObject({
      tiktokSettings: expect.objectContaining({
        privacyLevel: "PUBLIC_TO_EVERYONE",
      }),
      workspaceId: organizationId,
    });
    let target = await targetOf(post);
    expect(target).toMatchObject({
      status: "publishing",
      externalPostId: "p_1",
    });
    expect((await SocialPost.findById(post._id)).status).toBe("publishing");

    await publishDueDirectTargets({ now: target.nextAttemptAt });
    target = await targetOf(post);
    expect(target.status).toBe("publishing");

    await publishDueDirectTargets({ now: target.nextAttemptAt });
    expect(tiktokApi.checkPublication.mock.calls[1][0].externalPostId).toBe(
      "p_1",
    );
    const saved = await SocialPost.findById(post._id).lean();
    expect(saved.status).toBe("published");
    expect(saved.targets[0]).toMatchObject({
      status: "published",
      platformPostUrl: "https://www.tiktok.com/@boulangerie/photo/73001",
    });
  });

  it("cron : tour complet, sans chevauchement", async () => {
    await createPost();
    xApi.publish.mockResolvedValue(published());
    const [first, second] = await Promise.all([
      runSocialDirectPublish({ now: NOW }),
      runSocialDirectPublish({ now: NOW }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(xApi.publish).toHaveBeenCalledTimes(1);
  });

  it("jetons Instagram rafraîchis 15 jours avant leur expiration, même sans post", async () => {
    const ig = await SocialAccount.create({
      workspaceId: organizationId,
      provider: "direct",
      platform: "instagram",
      externalAccountId: "1784",
      accessToken: "ig_old",
      tokenExpiresAt: later(10 * 24 * 60 * 60 * 1000),
    });
    vi.spyOn(instagramApi, "refreshCredentials").mockResolvedValue({
      accessToken: "ig_new",
      tokenExpiresAt: later(60 * 24 * 60 * 60 * 1000),
    });
    expect(await refreshExpiringTokens({ now: NOW })).toBe(1);
    const saved = await SocialAccount.findById(ig._id).select("+accessToken");
    expect(decrypt(saved.accessToken)).toBe("ig_new");
  });
});

describe("vidéo : publication en deux temps", () => {
  const reel = {
    kind: "video",
    url: "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4",
    width: 1080,
    height: 1920,
    durationMs: 20000,
    size: 5000000,
    contentType: "video/mp4",
  };
  let igAccount;

  beforeEach(async () => {
    igAccount = await SocialAccount.create({
      workspaceId: organizationId,
      provider: "direct",
      platform: "instagram",
      externalAccountId: "1784",
      username: "acme_ig",
      accessToken: "ig_access",
      tokenExpiresAt: later(30 * 24 * 60 * 60 * 1000),
    });
  });

  const createReelPost = () =>
    createPost({
      content: "Coulisses",
      media: [reel],
      targets: [directTarget(igAccount)],
    });

  it("Reel : conteneur gardé, suivi au rythme du réseau, publié sans suivi d'adresse", async () => {
    const post = await createReelPost();
    vi.spyOn(instagramApi, "publish").mockResolvedValue({
      status: "publishing",
      externalPostId: null,
      processingRef: "c_1",
      platformPostUrl: null,
      nextCheckMs: 60 * 1000,
    });
    vi.spyOn(instagramApi, "checkPublication")
      .mockResolvedValueOnce({ status: "publishing", nextCheckMs: 60 * 1000 })
      .mockResolvedValueOnce({
        status: "published",
        externalPostId: "m_1",
        platformPostUrl: "https://www.instagram.com/reel/abc/",
      });

    await publishDueDirectTargets({ now: NOW });
    expect(instagramApi.publish.mock.calls[0][0].media[0]).toMatchObject({
      kind: "video",
      durationMs: 20000,
    });
    let target = await targetOf(post);
    expect(target).toMatchObject({
      status: "publishing",
      processingRef: "c_1",
      externalPostId: null,
    });
    expect(target.nextAttemptAt.getTime()).toBe(NOW.getTime() + 60 * 1000);

    await publishDueDirectTargets({ now: target.nextAttemptAt });
    target = await targetOf(post);
    expect(target.status).toBe("publishing");

    await publishDueDirectTargets({ now: target.nextAttemptAt });
    expect(instagramApi.checkPublication.mock.calls[1][0]).toMatchObject({
      processingRef: "c_1",
      content: "Coulisses",
    });
    const saved = await SocialPost.findById(post._id).lean();
    expect(saved.status).toBe("published");
    expect(saved.targets[0]).toMatchObject({
      status: "published",
      externalPostId: "m_1",
      platformPostUrl: "https://www.instagram.com/reel/abc/",
      urlCheckUntil: null,
      nextAttemptAt: null,
    });
  });

  it("conteneur expiré : la cible repart comme un nouvel essai", async () => {
    const post = await createReelPost();
    vi.spyOn(instagramApi, "publish").mockResolvedValue({
      status: "publishing",
      processingRef: "c_1",
      nextCheckMs: 60 * 1000,
    });
    vi.spyOn(instagramApi, "checkPublication").mockRejectedValue(
      new DirectApiError("instagram : conteneur expiré", {
        network: "instagram",
        transient: true,
        restart: true,
      }),
    );
    await publishDueDirectTargets({ now: NOW });
    let target = await targetOf(post);
    await publishDueDirectTargets({ now: target.nextAttemptAt });
    target = await targetOf(post);
    expect(target).toMatchObject({
      status: "pending",
      processingRef: null,
      attempts: 1,
    });

    await publishDueDirectTargets({ now: target.nextAttemptAt });
    expect(instagramApi.publish).toHaveBeenCalledTimes(2);
    expect((await targetOf(post)).attempts).toBe(2);
  });

  it("traitement trop long chez le réseau : échec « vidéo non traitée à temps »", async () => {
    const post = await createReelPost();
    vi.spyOn(instagramApi, "publish").mockResolvedValue({
      status: "publishing",
      processingRef: "c_1",
      nextCheckMs: 60 * 1000,
    });
    vi.spyOn(instagramApi, "checkPublication").mockResolvedValue({
      status: "publishing",
      nextCheckMs: 60 * 1000,
    });
    await publishDueDirectTargets({ now: NOW });
    await publishDueDirectTargets({ now: later(31 * 60 * 1000) });
    const saved = await SocialPost.findById(post._id).lean();
    expect(saved.status).toBe("failed");
    expect(saved.targets[0]).toMatchObject({
      status: "failed",
      errorCategory: "video_processing_timeout",
    });
  });
});

describe("posts mixtes Zernio + direct", () => {
  it("statut agrégé depuis toutes les cibles", () => {
    const of = (...statuses) => ({
      status: "scheduled",
      targets: statuses.map((status) => ({ status })),
    });
    expect(aggregatePostStatus(of("pending", "pending"))).toBe("scheduled");
    expect(aggregatePostStatus(of("published", "pending"))).toBe("publishing");
    expect(aggregatePostStatus(of("published", "published"))).toBe("published");
    expect(aggregatePostStatus(of("published", "failed"))).toBe("partial");
    expect(aggregatePostStatus(of("failed", "cancelled"))).toBe("failed");
    expect(aggregatePostStatus(of("cancelled", "cancelled"))).toBe("cancelled");
  });

  it("Zernio publie sa part, la cible directe échoue : partiel, une notification", async () => {
    const post = await createPost({
      provider: "mixed",
      externalPostId: "zp_1",
      targets: [
        {
          platform: "instagram",
          externalAccountId: "za_ig",
          status: "pending",
        },
        directTarget(xAccount),
      ],
    });
    xApi.publish.mockRejectedValue(
      new DirectApiError("403", {
        network: "x",
        category: "user_content",
        detail: "Refusé",
      }),
    );
    vi.spyOn(provider, "getPost").mockResolvedValue({
      externalPostId: "zp_1",
      // Zernio ne connaît que sa cible : son statut global ne vaut pas pour
      // le post mixte
      status: "published",
      targets: [
        {
          platform: "instagram",
          externalAccountId: "za_ig",
          status: "published",
          platformPostUrl: "https://www.instagram.com/p/abc/",
        },
      ],
    });

    await publishDueDirectTargets({ now: NOW });
    let saved = await SocialPost.findById(post._id).lean();
    expect(saved.status).toBe("publishing");
    expect(saved.targets[1].status).toBe("failed");

    await syncDueSocialPosts({ now: later(60 * 1000) });
    saved = await SocialPost.findById(post._id).lean();
    expect(saved.targets[0].status).toBe("published");
    // La cible directe n'est pas touchée par la synchro Zernio
    expect(saved.targets[1]).toMatchObject({
      status: "failed",
      errorCategory: "user_content",
    });
    expect(saved.status).toBe("partial");

    // Part Zernio terminée : plus de synchro ; rattrapage sans doublon
    await syncDueSocialPosts({ now: later(5 * 60 * 1000) });
    await publishDueDirectTargets({ now: later(5 * 60 * 1000) });
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(sendSocialPostFailedEmail).toHaveBeenCalledTimes(1);
    expect(
      await Notification.countDocuments({ title: "Post publié en partie" }),
    ).toBe(1);
  });

  it("post Zernio supprimé chez Zernio : seules ses cibles sont annulées", async () => {
    const post = await createPost({
      provider: "mixed",
      externalPostId: "zp_1",
      targets: [
        {
          platform: "instagram",
          externalAccountId: "za_ig",
          status: "pending",
        },
        directTarget(xAccount, { status: "published", publishedAt: NOW }),
      ],
      status: "publishing",
    });
    const { SocialProviderError } =
      await import("../../../src/services/social/providers/zernioProvider.js");
    vi.spyOn(provider, "getPost").mockRejectedValue(
      new SocialProviderError("introuvable", { status: 404 }),
    );
    await syncDueSocialPosts({ now: NOW });
    const saved = await SocialPost.findById(post._id).lean();
    expect(saved.targets.map((t) => t.status)).toEqual([
      "cancelled",
      "published",
    ]);
    expect(saved.status).toBe("partial");
    expect(saved.externalPostId).toBeNull();
  });
});
