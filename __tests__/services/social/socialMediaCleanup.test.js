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
import sharp from "sharp";

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
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialPost from "../../../src/models/SocialPost.js";
import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import kanbanResolvers from "../../../src/resolvers/kanban.js";
import socialResolvers from "../../../src/resolvers/socialPublishing.js";
import xApi from "../../../src/services/social/direct/xApi.js";
import { timing } from "../../../src/services/social/direct/directHttp.js";
import storage, {
  MEDIA_ID_PATTERN,
  tiktokCopyIdOf,
} from "../../../src/services/social/socialMediaStorage.js";
import {
  FAILURE_RETRY_MS,
  IN_FLIGHT_RETRY_MS,
  isPostPublishing,
  mediaObjectKeys,
  purgeDeletedPostsMedia,
  purgeOrphanMedia,
  purgeWorkspaceSocialData,
  scheduleForgottenPostsPurge,
} from "../../../src/services/social/socialMediaCleanup.js";
import { runSocialDirectPublish } from "../../../src/cron/socialDirectPublishCron.js";

const { Mutation: KanbanMutation } = kanbanResolvers;
const { Mutation } = socialResolvers;

const API = "https://api.newbi.test/social-media";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const alice = buildUserId();
const organizationId = buildOrganizationId();
let ctx;
let board;
let column;
let xAccount;
let deleteObject;
let taskCount = 0;

const uuid = (digit) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const later = (ms) => new Date(Date.now() + ms);

const imageMedia = (digit, fields = {}) =>
  SocialPostMedia.create({
    workspaceId: organizationId,
    provider: "newbi",
    url: `${API}/${uuid(digit)}.jpg`,
    key: `social/${uuid(digit)}.jpg`,
    width: 2048,
    height: 1536,
    ...fields,
  });

const videoMedia = (digit, fields = {}) =>
  SocialPostMedia.create({
    workspaceId: organizationId,
    provider: "newbi",
    kind: "video",
    status: "ready",
    url: `${API}/${uuid(digit)}.mp4`,
    key: `social/${uuid(digit)}.mp4`,
    thumbnailUrl: `${API}/${uuid(digit)}.jpg`,
    thumbnailKey: `social/${uuid(digit)}.jpg`,
    contentType: "video/mp4",
    durationMs: 30000,
    upload: { key: `social/uploads/${uuid(digit)}`, uploadId: "up_1" },
    ...fields,
  });

const postMedia = (media) => ({
  mediaId: media._id,
  kind: media.kind,
  url: media.url,
  width: media.width,
  height: media.height,
  contentType: media.contentType,
  thumbnailUrl: media.thumbnailUrl || null,
});

const newTask = () =>
  Task.create({
    title: `Post ${(taskCount += 1)}`,
    status: "col",
    boardId: board._id,
    columnId: String(column._id),
    workspaceId: organizationId,
    userId: alice,
  });

/** Post déjà publié sur X avec ces médias, sur sa propre carte. */
async function publishedPost(media = [], { target = {}, ...fields } = {}) {
  const task = await newTask();
  const post = await SocialPost.create({
    workspaceId: organizationId,
    boardId: board._id,
    taskId: task._id,
    createdBy: alice,
    provider: "direct",
    idempotencyKey: `key-${taskCount}`,
    content: "Bonjour",
    media: media.map(postMedia),
    targets: [
      {
        socialAccountId: xAccount._id,
        platform: "twitter",
        externalAccountId: "42",
        status: "published",
        provider: "direct",
        externalPostId: "1850",
        platformPostUrl: "https://x.com/acme/status/1850",
        publishedAt: new Date(),
        ...target,
      },
    ],
    scheduledFor: new Date(Date.now() - HOUR),
    status: "published",
    ...fields,
  });
  return { post, task };
}

const deleteTask = (task) =>
  KanbanMutation.deleteTask(null, { id: String(task._id) }, ctx);

const deletedKeys = () => deleteObject.mock.calls.map(([key]) => key);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  timing.sleep = async () => {};
  Object.assign(process.env, {
    DATA_ENCRYPTION_KEY: "test-encryption-key-social-direct",
    SOCIAL_MEDIA_BUCKET: "social-test",
    R2_API_URL: "https://r2.test",
    R2_ACCESS_KEY_ID: "r2_id",
    R2_SECRET_ACCESS_KEY: "r2_secret",
    X_CLIENT_ID: "x_client",
    X_CLIENT_SECRET: "x_secret",
    SOCIAL_PROVIDER_TWITTER: "direct",
    FRONTEND_URL: "https://www.newbi.test",
    NEXT_PUBLIC_API_URL: "https://api.newbi.test",
  });
  delete process.env.ZERNIO_API_KEY;
  delete process.env.SOCIAL_DIRECT_WORKSPACE_IDS;

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
  xAccount = await SocialAccount.create({
    workspaceId: organizationId,
    provider: "direct",
    platform: "twitter",
    externalAccountId: "42",
    username: "acme",
    accessToken: "x_access",
    refreshToken: "x_refresh",
    tokenExpiresAt: later(HOUR),
  });
  deleteObject = vi.spyOn(storage, "deleteObject").mockResolvedValue();
  vi.spyOn(xApi, "revoke").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SOCIAL_PROVIDER_TWITTER;
});

// ── Fichiers d'un média ────────────────────────────────────────────────────

describe("fichiers d'un média", () => {
  it("image : fichier et copie TikTok ; vidéo : fichier, vignette et original", async () => {
    const image = await imageMedia("1");
    expect(mediaObjectKeys(image.toObject()).sort()).toEqual(
      [
        `social/${uuid("1")}.jpg`,
        `social/${tiktokCopyIdOf(image.url)}.jpg`,
      ].sort(),
    );
    const video = await videoMedia("2");
    expect(mediaObjectKeys(video.toObject()).sort()).toEqual(
      [
        `social/${uuid("2")}.mp4`,
        `social/${uuid("2")}.jpg`,
        `social/uploads/${uuid("2")}`,
      ].sort(),
    );
    // Sans document : adresses servies par notre route
    expect(mediaObjectKeys(null, postMedia(video)).sort()).toEqual(
      [`social/${uuid("2")}.mp4`, `social/${uuid("2")}.jpg`].sort(),
    );
  });

  it("copie TikTok : identifiant tiré de l'original, une seule copie par image", async () => {
    const url = `${API}/${uuid("3")}.jpg`;
    const id = tiktokCopyIdOf(url);
    expect(MEDIA_ID_PATTERN.test(id)).toBe(true);
    expect(tiktokCopyIdOf(url)).toBe(id);
    expect(tiktokCopyIdOf(`${API}/${uuid("4")}.jpg`)).not.toBe(id);

    const buffer = await sharp({
      create: { width: 2048, height: 1536, channels: 3, background: "#fff" },
    })
      .jpeg()
      .toBuffer();
    vi.spyOn(storage, "fetchImage").mockResolvedValue({
      buffer,
      contentType: "image/jpeg",
    });
    const store = vi
      .spyOn(storage, "storeImage")
      .mockImplementation(async ({ id: stored }) => ({
        url: `${API}/${stored}.jpg`,
        key: `social/${stored}.jpg`,
      }));
    const media = { url, width: 2048, height: 1536 };
    expect(await storage.prepareTikTokImage(media, organizationId)).toBe(
      `${API}/${id}.jpg`,
    );
    await storage.prepareTikTokImage(media, organizationId);
    expect(store.mock.calls.map(([args]) => args.id)).toEqual([id, id]);
  });
});

// ── Post supprimé ──────────────────────────────────────────────────────────

describe("post supprimé avec sa carte", () => {
  it("images supprimées du stockage, documents effacés ; le post garde ses cibles", async () => {
    const [first, second] = [await imageMedia("1"), await imageMedia("2")];
    const { post, task } = await publishedPost([first, second]);

    await deleteTask(task);
    expect(await Task.exists({ _id: task._id })).toBeNull();
    let stored = await SocialPost.findById(post._id).lean();
    expect(stored.taskDeletedAt).toBeInstanceOf(Date);
    expect(stored.mediaPurgeAt).toBeInstanceOf(Date);
    // Rien n'est supprimé pendant la mutation
    expect(deleteObject).not.toHaveBeenCalled();

    expect(await purgeDeletedPostsMedia({ now: later(MINUTE) })).toEqual({
      purged: 1,
      deferred: 0,
      failed: 0,
    });
    expect(deletedKeys().sort()).toEqual(
      [
        `social/${uuid("1")}.jpg`,
        `social/${tiktokCopyIdOf(first.url)}.jpg`,
        `social/${uuid("2")}.jpg`,
        `social/${tiktokCopyIdOf(second.url)}.jpg`,
      ].sort(),
    );
    expect(await SocialPostMedia.countDocuments()).toBe(0);
    stored = await SocialPost.findById(post._id).lean();
    expect(stored.media).toEqual([]);
    expect(stored.mediaPurgeAt).toBeNull();
    expect(stored.mediaPurgedAt).toBeInstanceOf(Date);
    expect(stored.targets[0]).toMatchObject({
      status: "published",
      externalPostId: "1850",
      platformPostUrl: "https://x.com/acme/status/1850",
    });

    // Tour suivant : plus rien à faire
    deleteObject.mockClear();
    expect((await purgeDeletedPostsMedia({ now: later(HOUR) })).purged).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("vidéo : fichier, vignette et original supprimés", async () => {
    const video = await videoMedia("5");
    const { task } = await publishedPost([video]);
    await deleteTask(task);
    await purgeDeletedPostsMedia({ now: later(MINUTE) });
    expect(deletedKeys().sort()).toEqual(
      [
        `social/${uuid("5")}.mp4`,
        `social/${uuid("5")}.jpg`,
        `social/uploads/${uuid("5")}`,
      ].sort(),
    );
    expect(await SocialPostMedia.exists({ _id: video._id })).toBeNull();
  });

  it("suppression du tableau : médias de toutes ses cartes supprimés", async () => {
    const { post: first } = await publishedPost([await imageMedia("1")]);
    const { post: second } = await publishedPost([await imageMedia("2")]);
    await KanbanMutation.deleteBoard(null, { id: String(board._id) }, ctx);
    expect(await purgeDeletedPostsMedia({ now: later(MINUTE) })).toMatchObject({
      purged: 2,
    });
    for (const post of [first, second]) {
      expect((await SocialPost.findById(post._id).lean()).media).toEqual([]);
    }
    expect(await SocialPostMedia.countDocuments()).toBe(0);
  });

  it("publication en cours : suppression repoussée, jamais pendant l'envoi", async () => {
    const image = await imageMedia("1");
    const { post, task } = await publishedPost([image], {
      status: "publishing",
      target: {
        status: "publishing",
        platformPostUrl: null,
        lockedUntil: later(10 * MINUTE),
      },
    });
    await deleteTask(task);
    const now = later(MINUTE);
    expect(await purgeDeletedPostsMedia({ now })).toEqual({
      purged: 0,
      deferred: 1,
      failed: 0,
    });
    expect(deleteObject).not.toHaveBeenCalled();
    let stored = await SocialPost.findById(post._id).lean();
    expect(stored.mediaPurgeAt).toEqual(
      new Date(now.getTime() + IN_FLIGHT_RETRY_MS),
    );
    expect(stored.media).toHaveLength(1);

    // Publication terminée : supprimés au tour suivant
    await SocialPost.updateOne(
      { _id: post._id },
      {
        $set: {
          status: "published",
          "targets.0.status": "published",
          "targets.0.lockedUntil": null,
        },
      },
    );
    expect(
      (await purgeDeletedPostsMedia({ now: later(12 * MINUTE) })).purged,
    ).toBe(1);
    stored = await SocialPost.findById(post._id).lean();
    expect(stored.media).toEqual([]);
    expect(await SocialPostMedia.exists({ _id: image._id })).toBeNull();
  });

  it("en cours : bail, envoi en attente, adresse TikTok attendue ; cible bloquée depuis 7 jours : non", () => {
    const now = new Date();
    const post = (target, scheduledFor = now) => ({
      scheduledFor,
      targets: [target],
    });
    expect(
      isPostPublishing(
        post({ status: "published", lockedUntil: later(MINUTE) }),
        now,
      ),
    ).toBe(true);
    expect(
      isPostPublishing(
        post({ status: "published", urlCheckUntil: later(MINUTE) }),
        now,
      ),
    ).toBe(true);
    expect(isPostPublishing(post({ status: "pending" }), now)).toBe(true);
    expect(isPostPublishing(post({ status: "publishing" }), now)).toBe(true);
    expect(
      isPostPublishing(
        post({ status: "publishing" }, new Date(now.getTime() - 8 * DAY)),
        now,
      ),
    ).toBe(false);
    expect(
      isPostPublishing(
        post({ status: "published", lockedUntil: later(-MINUTE) }),
        now,
      ),
    ).toBe(false);
    expect(isPostPublishing(post({ status: "cancelled" }), now)).toBe(false);
  });

  it("média repris dans un autre post : gardé jusqu'à la suppression du dernier", async () => {
    const shared = await imageMedia("1");
    const { post: first, task: firstTask } = await publishedPost([shared]);
    const { task: secondTask } = await publishedPost([shared]);

    await deleteTask(firstTask);
    expect((await purgeDeletedPostsMedia({ now: later(MINUTE) })).purged).toBe(
      1,
    );
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await SocialPostMedia.exists({ _id: shared._id })).not.toBeNull();
    expect((await SocialPost.findById(first._id).lean()).media).toEqual([]);

    await deleteTask(secondTask);
    await purgeDeletedPostsMedia({ now: later(2 * MINUTE) });
    expect(deletedKeys()).toContain(`social/${uuid("1")}.jpg`);
    expect(await SocialPostMedia.exists({ _id: shared._id })).toBeNull();
  });

  it("stockage en échec : la carte est supprimée quand même, nouvel essai une heure plus tard", async () => {
    const image = await imageMedia("1");
    const { post, task } = await publishedPost([image]);
    deleteObject.mockRejectedValue(new Error("R2 indisponible"));

    await deleteTask(task);
    expect(await Task.exists({ _id: task._id })).toBeNull();

    const now = later(MINUTE);
    expect(await purgeDeletedPostsMedia({ now })).toMatchObject({ failed: 1 });
    let stored = await SocialPost.findById(post._id).lean();
    expect(stored.media).toHaveLength(1);
    expect(stored.mediaPurgeAt).toEqual(
      new Date(now.getTime() + FAILURE_RETRY_MS),
    );
    expect(await SocialPostMedia.exists({ _id: image._id })).not.toBeNull();

    // Pas avant l'heure
    deleteObject.mockReset().mockResolvedValue();
    await purgeDeletedPostsMedia({ now: later(30 * MINUTE) });
    expect(deleteObject).not.toHaveBeenCalled();

    expect(
      (await purgeDeletedPostsMedia({ now: later(HOUR + 2 * MINUTE) })).purged,
    ).toBe(1);
    stored = await SocialPost.findById(post._id).lean();
    expect(stored.media).toEqual([]);
    expect(await SocialPostMedia.exists({ _id: image._id })).toBeNull();
  });

  it("post programmé supprimé avec sa carte : annulé, puis médias supprimés", async () => {
    const image = await imageMedia("1");
    vi.spyOn(xApi, "publish");
    const { post, task } = await Mutation.scheduleSocialPost(
      null,
      {
        input: {
          boardId: String(board._id),
          accountIds: [String(xAccount._id)],
          content: "Programmé",
          mediaIds: [String(image._id)],
          scheduledFor: later(DAY).toISOString(),
        },
      },
      ctx,
    );
    await KanbanMutation.deleteTask(null, { id: task.id }, ctx);
    expect((await SocialPost.findById(post.id).lean()).status).toBe(
      "cancelled",
    );
    await purgeDeletedPostsMedia({ now: later(MINUTE) });
    expect(deletedKeys()).toContain(`social/${uuid("1")}.jpg`);
    expect(xApi.publish).not.toHaveBeenCalled();
  });

  it("posts supprimés avant ce nettoyage : rattrapés", async () => {
    const image = await imageMedia("1");
    const { post } = await publishedPost([image], {
      taskDeletedAt: later(-30 * DAY),
    });
    await publishedPost([await imageMedia("2")]);
    expect(await scheduleForgottenPostsPurge({ now: new Date() })).toBe(1);
    expect(await scheduleForgottenPostsPurge({ now: new Date() })).toBe(0);
    await purgeDeletedPostsMedia({ now: later(MINUTE) });
    expect((await SocialPost.findById(post._id).lean()).media).toEqual([]);
    expect(await SocialPostMedia.countDocuments()).toBe(1);
  });

  it("cron : médias des posts supprimés à chaque tour", async () => {
    const { task } = await publishedPost([await imageMedia("1")]);
    await deleteTask(task);
    await runSocialDirectPublish({ now: later(MINUTE) });
    expect(deletedKeys()).toContain(`social/${uuid("1")}.jpg`);
    expect(await SocialPostMedia.countDocuments()).toBe(0);
  });
});

// ── Médias jamais utilisés ─────────────────────────────────────────────────

describe("médias jamais utilisés par un post", () => {
  it("supprimés après 7 jours ; utilisés, en cours d'envoi ou récents : gardés", async () => {
    const abandoned = await imageMedia("1");
    const inPost = await imageMedia("2");
    await publishedPost([inPost]);
    const uploading = await videoMedia("3", { status: "uploading", url: "" });
    const failedVideo = await videoMedia("4", {
      status: "failed",
      url: "",
      key: null,
      thumbnailUrl: null,
      thumbnailKey: null,
    });

    expect(await purgeOrphanMedia({ now: later(6 * DAY) })).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
    });

    const now = later(8 * DAY);
    expect(await purgeOrphanMedia({ now })).toEqual({
      deleted: 2,
      kept: 1,
      failed: 0,
    });
    expect(deletedKeys().sort()).toEqual(
      [
        `social/${uuid("1")}.jpg`,
        `social/${tiktokCopyIdOf(abandoned.url)}.jpg`,
        `social/uploads/${uuid("4")}`,
      ].sort(),
    );
    expect(await SocialPostMedia.exists({ _id: abandoned._id })).toBeNull();
    expect(await SocialPostMedia.exists({ _id: failedVideo._id })).toBeNull();
    expect(await SocialPostMedia.exists({ _id: uploading._id })).not.toBeNull();
    // Vu dans un post : marqué, plus examiné ensuite
    expect(
      (await SocialPostMedia.findById(inPost._id).lean()).attachedAt,
    ).toEqual(now);
    deleteObject.mockClear();
    expect(await purgeOrphanMedia({ now: later(9 * DAY) })).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
    });
  });

  it("stockage en échec : document gardé, nouvel essai au tour suivant", async () => {
    const abandoned = await imageMedia("1");
    deleteObject.mockRejectedValueOnce(new Error("R2 indisponible"));
    expect(await purgeOrphanMedia({ now: later(8 * DAY) })).toMatchObject({
      failed: 1,
    });
    expect(await SocialPostMedia.exists({ _id: abandoned._id })).not.toBeNull();
    expect(
      await purgeOrphanMedia({ now: later(8 * DAY + HOUR) }),
    ).toMatchObject({ deleted: 1 });
    expect(await SocialPostMedia.exists({ _id: abandoned._id })).toBeNull();
  });

  it("image retirée d'un post modifié : supprimée 7 jours après si elle ne sert plus", async () => {
    const [removed, kept] = [await imageMedia("1"), await imageMedia("2")];
    const { post } = await Mutation.scheduleSocialPost(
      null,
      {
        input: {
          boardId: String(board._id),
          accountIds: [String(xAccount._id)],
          content: "Avant",
          mediaIds: [String(removed._id)],
          scheduledFor: later(DAY).toISOString(),
        },
      },
      ctx,
    );
    await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { mediaIds: [String(kept._id)] } },
      ctx,
    );
    const detached = await SocialPostMedia.findById(removed._id).lean();
    expect(detached.attachedAt).toBeNull();
    expect(detached.detachedAt).toBeInstanceOf(Date);

    await purgeOrphanMedia({ now: later(6 * DAY) });
    expect(await SocialPostMedia.exists({ _id: removed._id })).not.toBeNull();

    expect(await purgeOrphanMedia({ now: later(8 * DAY) })).toEqual({
      deleted: 1,
      kept: 1,
      failed: 0,
    });
    expect(await SocialPostMedia.exists({ _id: removed._id })).toBeNull();
    expect(await SocialPostMedia.exists({ _id: kept._id })).not.toBeNull();
    expect(deletedKeys()).not.toContain(`social/${uuid("2")}.jpg`);
  });
});

// ── Espace supprimé ────────────────────────────────────────────────────────

describe("espace supprimé", () => {
  it("comptes déconnectés (accès révoqué, jetons effacés), posts annulés, médias supprimés", async () => {
    const image = await imageMedia("1");
    const { post: published } = await publishedPost([await imageMedia("2")]);
    const { post: scheduled } = await Mutation.scheduleSocialPost(
      null,
      {
        input: {
          boardId: String(board._id),
          accountIds: [String(xAccount._id)],
          content: "Programmé",
          mediaIds: [String(image._id)],
          scheduledFor: later(DAY).toISOString(),
        },
      },
      ctx,
    );

    expect(await purgeWorkspaceSocialData(organizationId)).toEqual({
      accounts: 1,
      posts: 2,
    });
    expect(xApi.revoke).toHaveBeenCalledTimes(1);
    const account = await SocialAccount.findById(xAccount._id)
      .select("+accessToken +refreshToken")
      .lean();
    expect(account.deletedAt).toBeInstanceOf(Date);
    expect(account.accessToken).toBeNull();
    expect(account.refreshToken).toBeNull();
    expect((await SocialPost.findById(scheduled.id).lean()).status).toBe(
      "cancelled",
    );

    await purgeDeletedPostsMedia({ now: later(MINUTE) });
    for (const id of [published._id, scheduled.id]) {
      const stored = await SocialPost.findById(id).lean();
      expect(stored.taskDeletedAt).toBeInstanceOf(Date);
      expect(stored.media).toEqual([]);
    }
    expect(await SocialPostMedia.countDocuments()).toBe(0);
  });
});
