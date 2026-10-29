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
const publishNotification = vi.fn(async () => {});
vi.mock("../../../src/resolvers/notification.js", () => ({
  publishNotification: (...args) => publishNotification(...args),
}));
const sendPushToUser = vi.fn(async () => {});
vi.mock("../../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: (...args) => sendPushToUser(...args),
}));

import { Board, Task } from "../../../src/models/kanban.js";
import Notification from "../../../src/models/Notification.js";
import SocialPost from "../../../src/models/SocialPost.js";
import provider, {
  SocialProviderError,
} from "../../../src/services/social/providers/zernioProvider.js";
import {
  syncDueSocialPosts,
  syncOnePost,
} from "../../../src/services/social/socialPostSync.js";
import { runSocialPostSync } from "../../../src/cron/socialPostSyncCron.js";

const alice = buildUserId();
const organizationId = buildOrganizationId();
const NOW = new Date("2026-11-02T08:03:00.000Z");
let board;
let task;

const remote = (status, targets) => ({
  externalPostId: "zp_1",
  status,
  scheduledFor: null,
  targets,
});
const igTarget = (fields = {}) => ({
  platform: "instagram",
  externalAccountId: "za_ig",
  status: "published",
  platformPostUrl: "https://www.instagram.com/p/abc/",
  errorMessage: null,
  errorCategory: null,
  publishedAt: null,
  ...fields,
});

const createPost = (fields = {}) =>
  SocialPost.create({
    workspaceId: organizationId,
    boardId: board._id,
    taskId: task._id,
    createdBy: alice,
    externalPostId: "zp_1",
    idempotencyKey: "key-1",
    content: "Bonjour",
    targets: [
      {
        platform: "instagram",
        externalAccountId: "za_ig",
        username: "acme",
        status: "pending",
      },
    ],
    scheduledFor: new Date("2026-11-02T08:00:00.000Z"),
    status: "scheduled",
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
  sendSocialPostFailedEmail.mockClear();
  publishNotification.mockClear();
  sendPushToUser.mockClear();
  process.env.ZERNIO_API_KEY = "sk_test_zernio";
  process.env.FRONTEND_URL = "https://www.newbi.test";
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
    title: "Post Instagram : Bonjour",
    status: "col",
    boardId: board._id,
    columnId: "col",
    workspaceId: organizationId,
    userId: alice,
  });
  vi.spyOn(provider, "getPost");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZERNIO_API_KEY;
});

describe("syncDueSocialPosts", () => {
  it("post publié : statut et adresse recopiés, auteur notifié une seule fois", async () => {
    const post = await createPost();
    provider.getPost.mockResolvedValue(remote("published", [igTarget()]));

    const stats = await syncDueSocialPosts({ now: NOW });
    expect(stats).toEqual({ due: 1, synced: 1, errors: 0 });

    const fresh = await SocialPost.findById(post._id).lean();
    expect(fresh.status).toBe("published");
    expect(fresh.notifiedStatus).toBe("published");
    expect(fresh.syncLockedUntil).toBeNull();
    expect(fresh.targets[0]).toMatchObject({
      status: "published",
      platformPostUrl: "https://www.instagram.com/p/abc/",
    });
    expect(fresh.targets[0].publishedAt.toISOString()).toBe(NOW.toISOString());

    const notifications = await Notification.find().lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "SOCIAL_POST_PUBLISHED",
      title: "Post publié",
      message: "Votre post a été publié sur Instagram.",
    });
    expect(publishNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    // Succès : pas d'e-mail
    expect(sendSocialPostFailedEmail).not.toHaveBeenCalled();

    // Nouveau passage sur le même post (même statut) : aucune notification
    const again = await SocialPost.findById(post._id);
    await syncOnePost(again, { now: NOW });
    expect(await Notification.countDocuments()).toBe(1);
  });

  it("échec : notification d'échec et e-mail avec le message traduit", async () => {
    await createPost();
    provider.getPost.mockResolvedValue(
      remote("failed", [
        igTarget({
          status: "failed",
          platformPostUrl: null,
          errorCategory: "auth_expired",
          errorMessage: "Token expired",
        }),
      ]),
    );
    await syncDueSocialPosts({ now: NOW });

    const notification = await Notification.findOne().lean();
    expect(notification).toMatchObject({
      type: "SOCIAL_POST_FAILED",
      title: "Échec de la publication",
      message: "La publication sur Instagram a échoué.",
    });
    expect(sendSocialPostFailedEmail).toHaveBeenCalledTimes(1);
    const [email, data] = sendSocialPostFailedEmail.mock.calls[0];
    expect(email).toBe("alice@test.fr");
    expect(data.failures).toEqual([
      {
        network: "Instagram",
        error:
          "La connexion à Instagram a expiré. Reconnectez le compte dans Paramètres > Intégrations.",
      },
    ]);
    expect(data.taskUrl).toBe(
      `https://www.newbi.test/dashboard/outils/kanban/${board._id}?task=${task._id}`,
    );
  });

  it("bail : un post réservé n'est pas traité deux fois en parallèle", async () => {
    await createPost();
    let release;
    provider.getPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(remote("published", [igTarget()]));
        }),
    );
    const first = syncDueSocialPosts({ now: NOW });
    // Laisser la première passe réserver le post
    await vi.waitFor(() => expect(provider.getPost).toHaveBeenCalledTimes(1));
    const second = await syncDueSocialPosts({ now: NOW });
    expect(second.due).toBe(0);
    release();
    await first;
    expect(provider.getPost).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments()).toBe(1);
  });

  it("ne prend ni les posts futurs, ni les posts réservés, ni les statuts finaux", async () => {
    await createPost({ scheduledFor: new Date("2026-11-02T09:00:00.000Z") });
    await SocialPost.create({
      workspaceId: organizationId,
      boardId: board._id,
      taskId: new mongoose.Types.ObjectId(),
      externalPostId: "zp_2",
      idempotencyKey: "key-2",
      scheduledFor: new Date("2026-11-02T07:00:00.000Z"),
      status: "scheduled",
      syncLockedUntil: new Date("2026-11-02T08:05:00.000Z"),
    });
    await SocialPost.create({
      workspaceId: organizationId,
      boardId: board._id,
      taskId: new mongoose.Types.ObjectId(),
      externalPostId: "zp_3",
      idempotencyKey: "key-3",
      scheduledFor: new Date("2026-11-02T07:00:00.000Z"),
      status: "failed",
    });
    const stats = await syncDueSocialPosts({ now: NOW });
    expect(stats.due).toBe(0);
    expect(provider.getPost).not.toHaveBeenCalled();
  });

  it("erreur réseau : jamais d'échec du post, essai compté et repoussé", async () => {
    const post = await createPost();
    provider.getPost.mockRejectedValue(
      new SocialProviderError("fetch failed", { kind: "network" }),
    );
    const stats = await syncDueSocialPosts({ now: NOW });
    expect(stats).toEqual({ due: 1, synced: 0, errors: 1 });

    const fresh = await SocialPost.findById(post._id).lean();
    expect(fresh.status).toBe("scheduled");
    expect(fresh.syncFailureCount).toBe(1);
    expect(fresh.syncLockedUntil.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await Notification.countDocuments()).toBe(0);
  });

  it("TikTok publié sans adresse : surveillé une heure, adresse recopiée sans nouvelle notification", async () => {
    const post = await createPost({
      status: "published",
      notifiedStatus: "published",
      targets: [
        {
          platform: "tiktok",
          externalAccountId: "za_tt",
          status: "published",
          platformPostUrl: null,
          publishedAt: new Date("2026-11-02T08:00:00.000Z"),
        },
      ],
    });
    provider.getPost.mockResolvedValue(
      remote("published", [
        igTarget({
          platform: "tiktok",
          externalAccountId: "za_tt",
          platformPostUrl: "https://www.tiktok.com/@acme/photo/1",
        }),
      ]),
    );
    await syncDueSocialPosts({ now: NOW });
    const fresh = await SocialPost.findById(post._id).lean();
    expect(fresh.targets[0].platformPostUrl).toBe(
      "https://www.tiktok.com/@acme/photo/1",
    );
    expect(await Notification.countDocuments()).toBe(0);

    // Plus d'une heure après la publication : plus surveillé
    await SocialPost.updateOne(
      { _id: post._id },
      { $set: { "targets.0.platformPostUrl": null } },
    );
    provider.getPost.mockClear();
    await syncDueSocialPosts({ now: new Date("2026-11-02T09:30:00.000Z") });
    expect(provider.getPost).not.toHaveBeenCalled();
  });

  it("post supprimé chez Zernio (404) : annulé et auteur prévenu", async () => {
    const post = await createPost();
    provider.getPost.mockRejectedValue(
      new SocialProviderError("Not found", { kind: "http", status: 404 }),
    );
    await syncDueSocialPosts({ now: NOW });
    const fresh = await SocialPost.findById(post._id).lean();
    expect(fresh.status).toBe("cancelled");
    expect(
      await Notification.countDocuments({ type: "SOCIAL_POST_FAILED" }),
    ).toBe(1);
  });

  it("sans clé Zernio : le cron ne fait rien", async () => {
    await createPost();
    delete process.env.ZERNIO_API_KEY;
    const stats = await runSocialPostSync();
    expect(stats).toEqual({ due: 0, synced: 0, errors: 0 });
    expect(provider.getPost).not.toHaveBeenCalled();
  });
});
