/**
 * Suppression du compte du dernier membre d'un espace (RGPD) : ses comptes
 * de réseaux sociaux sont déconnectés (accès révoqué) puis supprimés avec
 * le profil Zernio, ses posts programmés annulés, puis les images et
 * vidéos de ses posts et leurs fiches supprimées par le cron. Un membre qui
 * part d'un espace partagé n'y touche pas.
 */
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

// Clés exigées au chargement des modèles (SmtpSettings, connexions)
vi.hoisted(() => {
  process.env.SMTP_ENCRYPTION_KEY =
    process.env.SMTP_ENCRYPTION_KEY || "a".repeat(64);
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
});

vi.mock("../../../src/services/cloudflareService.js", () => ({
  default: {
    signatureBucketName: "signatures-test",
    client: {
      send: vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false }),
    },
  },
}));
vi.mock("../../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { clearMongo } from "../../helpers/mongo.js";
import { seedOrgMembership } from "../../helpers/auth.js";
import { startReplicaSet } from "../../helpers/numberingSimulation.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";
import { invalidateOrgCache } from "../../../src/middlewares/rbac.js";
import User from "../../../src/models/User.js";
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialPost from "../../../src/models/SocialPost.js";
import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import SocialProfile from "../../../src/models/SocialProfile.js";
import { deleteUserAccount } from "../../../src/services/rgpd.js";
import xApi from "../../../src/services/social/direct/xApi.js";
import storage from "../../../src/services/social/socialMediaStorage.js";
import { purgeDeletedPostsMedia } from "../../../src/services/social/socialMediaCleanup.js";

const leaver = buildUserId();
const colleague = buildUserId();
const org = buildOrganizationId();
const IMAGE_ID = "11111111-1111-4111-8111-111111111111";

let replSet;

async function seedSocial() {
  const account = await SocialAccount.create({
    workspaceId: org,
    provider: "direct",
    platform: "twitter",
    externalAccountId: "42",
    username: "acme",
    accessToken: "x_access",
    refreshToken: "x_refresh",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const media = await SocialPostMedia.create({
    workspaceId: org,
    provider: "newbi",
    url: `https://api.newbi.test/social-media/${IMAGE_ID}.jpg`,
    key: `social/${IMAGE_ID}.jpg`,
  });
  const post = await SocialPost.create({
    workspaceId: org,
    boardId: new mongoose.Types.ObjectId(),
    taskId: new mongoose.Types.ObjectId(),
    provider: "direct",
    idempotencyKey: "key-1",
    content: "Programmé",
    media: [{ mediaId: media._id, url: media.url }],
    targets: [
      {
        socialAccountId: account._id,
        platform: "twitter",
        externalAccountId: "42",
        status: "pending",
        provider: "direct",
      },
    ],
    scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "scheduled",
  });
  return { account, media, post };
}

beforeAll(async () => {
  replSet = await startReplicaSet("rgpd_social");
  // Collections et index de tous les modèles chargés créés avant les
  // transactions (sinon verrou refusé sous charge) ; un index refusé par un
  // autre modèle ne concerne pas ces tests
  await Promise.allSettled(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  Object.assign(process.env, {
    DATA_ENCRYPTION_KEY: "test-encryption-key-social-direct",
    SOCIAL_MEDIA_BUCKET: "social-test",
    R2_API_URL: "https://r2.test",
    R2_ACCESS_KEY_ID: "r2_id",
    R2_SECRET_ACCESS_KEY: "r2_secret",
    X_CLIENT_ID: "x_client",
    X_CLIENT_SECRET: "x_secret",
    NEXT_PUBLIC_API_URL: "https://api.newbi.test",
  });
  delete process.env.ZERNIO_API_KEY;
  await User.collection.insertOne({ _id: leaver, email: "leaver@test.fr" });
  await User.collection.insertOne({
    _id: colleague,
    email: "colleague@test.fr",
  });
  vi.spyOn(xApi, "revoke").mockResolvedValue(undefined);
  vi.spyOn(storage, "deleteObject").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("suppression du compte (RGPD) et réseaux sociaux", () => {
  it("dernier membre : accès révoqué, comptes, profil, posts et médias supprimés", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    const { account, media, post } = await seedSocial();
    await SocialProfile.create({
      workspaceId: org,
      externalProfileId: "zp_profile",
    });

    const summary = await deleteUserAccount(String(leaver), String(org));
    expect(summary.organizationDeleted).toBe(true);

    expect(xApi.revoke).toHaveBeenCalledTimes(1);
    expect(await SocialAccount.exists({ _id: account._id })).toBeNull();
    expect(await SocialProfile.countDocuments({ workspaceId: org })).toBe(0);
    // Post annulé, gardé le temps de supprimer ses médias
    const storedPost = await SocialPost.findById(post._id).lean();
    expect(storedPost).toMatchObject({
      status: "cancelled",
      purgeAction: "delete",
    });
    expect(storedPost.mediaPurgeAt).toBeInstanceOf(Date);

    await purgeDeletedPostsMedia({ now: new Date(Date.now() + 60 * 1000) });
    expect(storage.deleteObject).toHaveBeenCalledWith(`social/${IMAGE_ID}.jpg`);
    expect(await SocialPostMedia.exists({ _id: media._id })).toBeNull();
    expect(await SocialPost.exists({ _id: post._id })).toBeNull();
  });

  it("espace partagé : rien n'est touché", async () => {
    await seedOrgMembership({ userId: colleague, organizationId: org });
    await seedOrgMembership({
      userId: leaver,
      organizationId: org,
      role: "member",
    });
    const { account, post } = await seedSocial();

    const summary = await deleteUserAccount(String(leaver), String(org));
    expect(summary.organizationDeleted).toBe(false);
    expect(xApi.revoke).not.toHaveBeenCalled();
    expect((await SocialAccount.findById(account._id).lean()).deletedAt).toBe(
      null,
    );
    expect(await SocialPost.findById(post._id).lean()).toMatchObject({
      status: "scheduled",
      taskDeletedAt: null,
      mediaPurgeAt: null,
    });
  });
});
