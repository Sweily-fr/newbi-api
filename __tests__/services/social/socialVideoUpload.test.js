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
import { Readable } from "stream";

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
// Préparation lancée en arrière-plan : seulement constatée ici
const enqueueVideoProcessing = vi.fn(() => true);
vi.mock(
  "../../../src/services/social/socialVideoProcessing.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    enqueueVideoProcessing: (...args) => enqueueVideoProcessing(...args),
  }),
);

import { Board, Column } from "../../../src/models/kanban.js";
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialPost from "../../../src/models/SocialPost.js";
import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import socialResolvers from "../../../src/resolvers/socialPublishing.js";
import storage from "../../../src/services/social/socialMediaStorage.js";
import provider from "../../../src/services/social/providers/zernioProvider.js";
import { VIDEO_CHUNK_SIZE } from "../../../src/services/social/socialVideoUpload.js";

const { Mutation, Query } = socialResolvers;

const alice = buildUserId();
const mallory = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
const MB = 1024 * 1024;
let ctx;
let malloryCtx;
let board;
let instagram;
let tiktok;
let twitter;
let zernioInstagram;

const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const chunkOf = (size) => ({
  createReadStream: () => Readable.from([Buffer.alloc(size, 1)]),
});

const start = (fields = {}, context = ctx) =>
  Mutation.startSocialVideoUpload(
    null,
    {
      fileName: "IMG_0001.MOV",
      size: 20 * MB,
      contentType: "video/quicktime",
      ...fields,
    },
    context,
  );
const sendChunk = (mediaId, index, size, context = ctx) =>
  Mutation.uploadSocialVideoChunk(
    null,
    { mediaId, index, chunk: chunkOf(size) },
    context,
  );
const complete = (mediaId, context = ctx) =>
  Mutation.completeSocialVideoUpload(null, { mediaId }, context);
const schedule = (input) =>
  Mutation.scheduleSocialPost(
    null,
    {
      input: {
        boardId: String(board._id),
        scheduledFor: inOneDay().toISOString(),
        content: "Notre nouvelle vidéo",
        ...input,
      },
    },
    ctx,
  );

const readyVideo = (fields = {}) =>
  SocialPostMedia.create({
    workspaceId: organizationId,
    provider: "newbi",
    kind: "video",
    status: "ready",
    url: "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4",
    thumbnailUrl:
      "https://api.newbi.test/social-media/1b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg",
    width: 1080,
    height: 1920,
    durationMs: 30 * 1000,
    size: 25 * 1000 * 1000,
    contentType: "video/mp4",
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
  enqueueVideoProcessing.mockClear();
  Object.assign(process.env, {
    NEXT_PUBLIC_API_URL: "https://api.newbi.test",
    DATA_ENCRYPTION_KEY: "test-encryption-key-social-video",
    SOCIAL_MEDIA_BUCKET: "social-test",
    R2_API_URL: "https://r2.test",
    R2_ACCESS_KEY_ID: "r2_id",
    R2_SECRET_ACCESS_KEY: "r2_secret",
    INSTAGRAM_APP_ID: "ig_app",
    INSTAGRAM_APP_SECRET: "ig_secret",
    TIKTOK_CLIENT_KEY: "tt_key",
    TIKTOK_CLIENT_SECRET: "tt_secret",
    X_CLIENT_ID: "x_client",
    X_CLIENT_SECRET: "x_secret",
    ZERNIO_API_KEY: "sk_test_zernio",
  });
  await mongoose.connection.db.collection("user").insertMany([
    { _id: alice, email: "alice@test.fr", name: "Alice" },
    { _id: mallory, email: "mallory@test.fr", name: "Mallory" },
  ]);
  await seedOrgMembership({ userId: alice, organizationId });
  await seedOrgMembership({
    userId: mallory,
    organizationId: otherOrganizationId,
    organizationName: "Autre espace",
  });
  ctx = buildContext({ userId: alice, organizationId });
  malloryCtx = buildContext({
    userId: mallory,
    organizationId: otherOrganizationId,
  });
  board = await Board.create({
    title: "Communication",
    workspaceId: organizationId,
    userId: alice,
  });
  await Column.create({
    title: "Idées",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: organizationId,
    userId: alice,
  });
  const direct = (platform, externalAccountId, username) => ({
    workspaceId: organizationId,
    provider: "direct",
    platform,
    externalAccountId,
    username,
    accessToken: "token",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  [instagram, tiktok, twitter, zernioInstagram] = await SocialAccount.create([
    direct("instagram", "ig_1", "acme"),
    direct("tiktok", "open_1", "acme_tt"),
    direct("twitter", "42", "acme_x"),
    {
      workspaceId: organizationId,
      platform: "instagram",
      externalAccountId: "za_ig",
      username: "acme_zernio",
    },
  ]);

  vi.spyOn(storage, "createVideoUpload").mockResolvedValue({
    key: "social/uploads/abc",
    uploadId: "up_1",
  });
  vi.spyOn(storage, "uploadVideoPart").mockImplementation(
    async ({ partNumber, body }) => `"etag-${partNumber}-${body.length}"`,
  );
  vi.spyOn(storage, "completeVideoUpload").mockResolvedValue();
  vi.spyOn(provider, "createPost");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZERNIO_API_KEY;
});

describe("envoi d'une vidéo en morceaux", () => {
  it("ouverture : type et poids contrôlés, morceaux de 8 Mo", async () => {
    await expect(
      start({ fileName: "film.avi", contentType: "video/x-msvideo" }),
    ).rejects.toThrow(
      "Format de vidéo non pris en charge. Formats acceptés : MP4, MOV, M4V et WebM.",
    );
    await expect(start({ size: 501 * MB })).rejects.toThrow(
      "Vidéo trop lourde (500 Mo maximum).",
    );
    expect(storage.createVideoUpload).not.toHaveBeenCalled();

    const result = await start();
    expect(result).toMatchObject({
      chunkSize: VIDEO_CHUNK_SIZE,
      chunkCount: 3,
      media: {
        kind: "video",
        status: "uploading",
        url: "",
        errorMessage: null,
      },
    });
    const saved = await SocialPostMedia.findById(result.media.id).lean();
    expect(saved.upload).toMatchObject({
      key: "social/uploads/abc",
      uploadId: "up_1",
      fileName: "IMG_0001.MOV",
      chunkCount: 3,
      etags: [null, null, null],
    });
  });

  it("morceaux : taille exacte exigée, renvoi idempotent, puis assemblage et préparation", async () => {
    const { media } = await start();
    await expect(sendChunk(media.id, 0, 1000)).rejects.toThrow(
      "Morceau de vidéo incomplet. Réessayez.",
    );
    await expect(sendChunk(media.id, 3, VIDEO_CHUNK_SIZE)).rejects.toThrow(
      "Morceau de vidéo invalide.",
    );
    expect(await sendChunk(media.id, 0, VIDEO_CHUNK_SIZE)).toBe(true);
    // Dernier morceau plus petit (20 Mo = 8 + 8 + 4)
    expect(await sendChunk(media.id, 2, 4 * MB)).toBe(true);
    await expect(complete(media.id)).rejects.toThrow(
      "L'envoi de la vidéo est incomplet. Réessayez.",
    );
    // Renvoyé : remplace le précédent
    expect(await sendChunk(media.id, 0, VIDEO_CHUNK_SIZE)).toBe(true);
    expect(await sendChunk(media.id, 1, VIDEO_CHUNK_SIZE)).toBe(true);
    expect(storage.uploadVideoPart).toHaveBeenCalledWith(
      expect.objectContaining({ partNumber: 3, uploadId: "up_1" }),
    );

    const completed = await complete(media.id);
    expect(completed).toMatchObject({ status: "processing", url: "" });
    expect(storage.completeVideoUpload).toHaveBeenCalledWith({
      key: "social/uploads/abc",
      uploadId: "up_1",
      etags: [
        `"etag-1-${VIDEO_CHUNK_SIZE}"`,
        `"etag-2-${VIDEO_CHUNK_SIZE}"`,
        `"etag-3-${4 * MB}"`,
      ],
    });
    expect(enqueueVideoProcessing).toHaveBeenCalledWith(
      expect.objectContaining({}),
    );
    expect(String(enqueueVideoProcessing.mock.calls[0][0])).toBe(media.id);

    // Deuxième appel : état renvoyé tel quel, rien de relancé
    expect((await complete(media.id)).status).toBe("processing");
    expect(storage.completeVideoUpload).toHaveBeenCalledTimes(1);
    await expect(sendChunk(media.id, 0, VIDEO_CHUNK_SIZE)).rejects.toThrow(
      "Cette vidéo n'attend plus de morceau.",
    );
  });

  it("une vidéo n'est visible que par son espace", async () => {
    const { media } = await start();
    await expect(
      sendChunk(media.id, 0, VIDEO_CHUNK_SIZE, malloryCtx),
    ).rejects.toThrow("Vidéo introuvable. Ajoutez-la de nouveau.");
    await expect(complete(media.id, malloryCtx)).rejects.toThrow(
      "Vidéo introuvable",
    );
    expect(
      await Query.socialPostMedia(null, { id: media.id }, malloryCtx),
    ).toBeNull();
    expect(
      await Query.socialPostMedia(null, { id: media.id }, ctx),
    ).toMatchObject({ id: media.id, kind: "video", status: "uploading" });
  });

  it("vidéo indisponible sans stockage ni réseau en direct", async () => {
    delete process.env.SOCIAL_MEDIA_BUCKET;
    await expect(start()).rejects.toThrow(
      "La vidéo n'est disponible que pour les comptes connectés directement.",
    );
  });
});

describe("programmer un post avec une vidéo", () => {
  const tiktokSettings = {
    privacyLevel: "SELF_ONLY",
    allowComment: true,
    consentGiven: true,
  };

  it("vidéo encore en préparation ou en échec : refusée", async () => {
    const processing = await readyVideo({ status: "processing", url: "" });
    await expect(
      schedule({
        accountIds: [String(instagram._id)],
        mediaIds: [String(processing._id)],
      }),
    ).rejects.toThrow(
      "La vidéo est encore en préparation. Patientez quelques instants.",
    );
    const failed = await readyVideo({
      status: "failed",
      url: "",
      errorMessage: "Vidéo illisible ou endommagée.",
    });
    await expect(
      schedule({
        accountIds: [String(instagram._id)],
        mediaIds: [String(failed._id)],
      }),
    ).rejects.toThrow("Vidéo illisible ou endommagée.");
    expect(await SocialPost.countDocuments()).toBe(0);
  });

  it("compte Zernio : vidéo refusée, rien n'est créé", async () => {
    const video = await readyVideo();
    await expect(
      schedule({
        accountIds: [String(instagram._id), String(zernioInstagram._id)],
        mediaIds: [String(video._id)],
      }),
    ).rejects.toThrow(
      "La vidéo n'est disponible que pour les comptes connectés directement.",
    );
    expect(provider.createPost).not.toHaveBeenCalled();
    expect(await SocialPost.countDocuments()).toBe(0);
  });

  it("vidéo trop longue pour X, ou mêlée à des photos : refusée", async () => {
    const long = await readyVideo({ durationMs: 185 * 1000 });
    await expect(
      schedule({
        accountIds: [String(twitter._id)],
        mediaIds: [String(long._id)],
      }),
    ).rejects.toThrow(
      "X accepte des vidéos de 2 min 20 au maximum (cette vidéo dure 3 min 05).",
    );
    const image = await SocialPostMedia.create({
      workspaceId: organizationId,
      url: "https://api.newbi.test/social-media/2b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg",
      width: 1080,
      height: 1080,
    });
    const video = await readyVideo();
    await expect(
      schedule({
        accountIds: [String(instagram._id)],
        mediaIds: [String(image._id), String(video._id)],
      }),
    ).rejects.toThrow(
      "Un post contient soit des photos, soit une vidéo, pas les deux.",
    );
  });

  it("TikTok : duos et collages obligatoires, gardés avec le post", async () => {
    const video = await readyVideo();
    await expect(
      schedule({
        accountIds: [String(tiktok._id)],
        mediaIds: [String(video._id)],
        tiktokSettings,
      }),
    ).rejects.toThrow("Indiquez si les duos sont autorisés sur TikTok.");

    const result = await schedule({
      accountIds: [String(instagram._id), String(tiktok._id)],
      mediaIds: [String(video._id)],
      tiktokSettings: {
        ...tiktokSettings,
        allowDuet: false,
        allowStitch: true,
      },
    });
    expect(provider.createPost).not.toHaveBeenCalled();
    expect(result.post.media).toEqual([
      {
        id: String(video._id),
        kind: "video",
        status: "ready",
        errorMessage: null,
        url: video.url,
        thumbnailUrl: video.thumbnailUrl,
        width: 1080,
        height: 1920,
        durationMs: 30000,
        size: 25000000,
        contentType: "video/mp4",
      },
    ]);
    expect(result.post.tiktokSettings).toMatchObject({
      allowDuet: false,
      allowStitch: true,
    });
    const stored = await SocialPost.findById(result.post.id).lean();
    expect(stored.media[0]).toMatchObject({
      kind: "video",
      durationMs: 30000,
      size: 25000000,
    });
    expect(stored.tiktokSettings).toMatchObject({
      allowDuet: false,
      allowStitch: true,
    });

    // Modifier le texte garde les réglages vidéo
    const updated = await Mutation.updateSocialPost(
      null,
      { id: result.post.id, input: { content: "Nouveau texte" } },
      ctx,
    );
    expect(updated.tiktokSettings).toMatchObject({
      allowDuet: false,
      allowStitch: true,
    });
  });
});
