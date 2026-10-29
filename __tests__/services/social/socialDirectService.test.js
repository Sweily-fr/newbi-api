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
import { Readable } from "stream";
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

import { Board, Column } from "../../../src/models/kanban.js";
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialConnectState from "../../../src/models/SocialConnectState.js";
import SocialPost from "../../../src/models/SocialPost.js";
import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import kanbanResolvers from "../../../src/resolvers/kanban.js";
import socialResolvers from "../../../src/resolvers/socialPublishing.js";
import { decrypt, isEncrypted } from "../../../src/utils/encryption.js";
import provider from "../../../src/services/social/providers/zernioProvider.js";
import xApi from "../../../src/services/social/direct/xApi.js";
import tiktokApi from "../../../src/services/social/direct/tiktokApi.js";
import linkedinApi from "../../../src/services/social/direct/linkedinApi.js";
import storage from "../../../src/services/social/socialMediaStorage.js";
import {
  DirectApiError,
  timing,
} from "../../../src/services/social/direct/directHttp.js";
import { completeDirectConnect } from "../../../src/services/social/socialDirectConnect.js";
import socialMediaRouter from "../../../src/routes/social-media.js";

const { Mutation: KanbanMutation } = kanbanResolvers;
const { Mutation, Query } = socialResolvers;

const alice = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
let ctx;
let board;
let column;
let instagram;
let xAccount;
let tiktok;
let squareImage;

const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const schedule = (input) => Mutation.scheduleSocialPost(null, { input }, ctx);
const zernioPost = (externalPostId = "zp_1") => ({
  httpStatus: 201,
  incomplete: false,
  post: {
    externalPostId,
    status: "scheduled",
    targets: [
      { platform: "instagram", externalAccountId: "za_ig", status: "pending" },
    ],
  },
});
const xPublished = {
  status: "published",
  externalPostId: "1850",
  platformPostUrl: "https://x.com/acme/status/1850",
};

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
    ZERNIO_API_KEY: "sk_test_zernio",
    DATA_ENCRYPTION_KEY: "test-encryption-key-social-direct",
    SOCIAL_MEDIA_BUCKET: "social-test",
    R2_API_URL: "https://r2.test",
    R2_ACCESS_KEY_ID: "r2_id",
    R2_SECRET_ACCESS_KEY: "r2_secret",
    X_CLIENT_ID: "x_client",
    X_CLIENT_SECRET: "x_secret",
    TIKTOK_CLIENT_KEY: "tt_key",
    TIKTOK_CLIENT_SECRET: "tt_secret",
    SOCIAL_PROVIDER_TWITTER: "direct",
    SOCIAL_PROVIDER_TIKTOK: "direct",
    FRONTEND_URL: "https://www.newbi.test",
    NEXT_PUBLIC_API_URL: "https://api.newbi.test",
  });
  delete process.env.SOCIAL_DIRECT_WORKSPACE_IDS;
  delete process.env.SOCIAL_DIRECT_WORKSPACE_IDS_TWITTER;

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
  [instagram, xAccount, tiktok] = await SocialAccount.create([
    {
      workspaceId: organizationId,
      platform: "instagram",
      externalAccountId: "za_ig",
      username: "acme",
    },
    {
      workspaceId: organizationId,
      provider: "direct",
      platform: "twitter",
      externalAccountId: "42",
      username: "acme",
      accessToken: "x_access",
      refreshToken: "x_refresh",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
    {
      workspaceId: organizationId,
      provider: "direct",
      platform: "tiktok",
      externalAccountId: "open_1",
      username: "boulangerie",
      displayName: "La Boulangerie",
      accessToken: "act.1",
      refreshToken: "rft.1",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  ]);
  squareImage = await SocialPostMedia.create({
    workspaceId: organizationId,
    url: "https://api.newbi.test/social-media/11111111-1111-4111-8111-111111111111.jpg",
    width: 1080,
    height: 1080,
  });
  vi.spyOn(provider, "createPost").mockResolvedValue(zernioPost());
  vi.spyOn(provider, "updatePost").mockResolvedValue(zernioPost());
  vi.spyOn(provider, "deletePost").mockResolvedValue({ alreadyGone: false });
  vi.spyOn(provider, "listAccounts").mockResolvedValue([]);
  vi.spyOn(xApi, "publish").mockResolvedValue(xPublished);
  vi.spyOn(xApi, "revoke").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [
    "SOCIAL_PROVIDER_TWITTER",
    "SOCIAL_PROVIDER_TIKTOK",
    "SOCIAL_PROVIDER_LINKEDIN",
    "SOCIAL_DIRECT_WORKSPACE_IDS",
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "LINKEDIN_PAGES_CLIENT_ID",
    "LINKEDIN_PAGES_CLIENT_SECRET",
  ]) {
    delete process.env[key];
  }
});

describe("disponibilité par réseau et par espace", () => {
  it("platforms : réseaux connectables, direct limité aux espaces listés", async () => {
    const status = () => Query.socialPublishingStatus(null, {}, ctx);
    // Zernio configuré : tout est connectable (direct ou Zernio)
    expect((await status()).platforms).toEqual([
      "instagram",
      "facebook",
      "linkedin",
      "twitter",
      "tiktok",
    ]);

    delete process.env.ZERNIO_API_KEY;
    expect((await status()).platforms).toEqual(["twitter", "tiktok"]);

    // Espace hors de la liste : resterait sur Zernio, absent ici
    process.env.SOCIAL_DIRECT_WORKSPACE_IDS = String(otherOrganizationId);
    expect((await status()).platforms).toEqual([]);
    process.env.SOCIAL_DIRECT_WORKSPACE_IDS = `${otherOrganizationId}, ${organizationId}`;
    expect((await status()).platforms).toEqual(["twitter", "tiktok"]);

    // Identifiants X retirés : X indisponible, sans erreur
    delete process.env.X_CLIENT_SECRET;
    expect((await status()).platforms).toEqual(["tiktok"]);
  });

  it("comptes : aucun jeton dans la réponse GraphQL", async () => {
    const { accounts } = await Query.socialPublishingStatus(null, {}, ctx);
    const x = accounts.find((account) => account.platform === "twitter");
    expect(Object.keys(x).sort()).toEqual([
      "avatarUrl",
      "connectedAt",
      "displayName",
      "id",
      "platform",
      "status",
      "username",
    ]);
    expect(JSON.stringify(accounts)).not.toContain("x_access");
  });

  it("compte Zernio alors que Zernio n'est plus configuré : publication refusée clairement", async () => {
    delete process.env.ZERNIO_API_KEY;
    await expect(
      schedule({
        boardId: String(board._id),
        accountIds: [String(instagram._id)],
        content: "Bonjour",
        mediaIds: [String(squareImage._id)],
        scheduledFor: inOneDay().toISOString(),
      }),
    ).rejects.toThrow(
      "La publication sur Instagram est momentanément indisponible.",
    );
  });
});

describe("connexion par notre appli (OAuth direct)", () => {
  const connect = (platform) =>
    Mutation.connectSocialAccount(
      null,
      { platform, returnTo: "/dashboard/outils/kanban/b1?socialPost=new" },
      ctx,
    );

  it("X : PKCE, retour sur /social-connect/twitter/callback, compte enregistré, jetons chiffrés, jeton à usage unique", async () => {
    const url = new URL(await connect("twitter"));
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.newbi.test/social-connect/twitter/callback",
    );
    const token = url.searchParams.get("state");
    const state = await SocialConnectState.findOne({ token }).lean();
    expect(state).toMatchObject({ provider: "direct", platform: "twitter" });
    expect(isEncrypted(state.codeVerifier)).toBe(true);

    const exchange = vi.spyOn(xApi, "exchangeCode").mockResolvedValue({
      accounts: [
        {
          platform: "twitter",
          externalAccountId: "777",
          username: "nouveau",
          displayName: "Nouveau",
          avatarUrl: null,
          credentials: {
            accessToken: "x_new_access",
            refreshToken: "x_new_refresh",
            tokenExpiresAt: new Date(Date.now() + 7200 * 1000),
            scopes: ["tweet.write"],
          },
        },
      ],
    });
    const redirect = await completeDirectConnect("twitter", {
      state: token,
      code: "code",
    });
    expect(redirect).toBe(
      "https://www.newbi.test/dashboard/outils/kanban/b1?socialPost=new&social_connected=twitter",
    );
    const { codeVerifier, redirectUri } = exchange.mock.calls[0][0];
    expect(redirectUri).toBe(
      "https://api.newbi.test/social-connect/twitter/callback",
    );
    expect(
      crypto.createHash("sha256").update(codeVerifier).digest("base64url"),
    ).toBe(url.searchParams.get("code_challenge"));

    const created = await SocialAccount.findOne({
      externalAccountId: "777",
    }).select("+accessToken +refreshToken");
    expect(created).toMatchObject({
      provider: "direct",
      platform: "twitter",
      status: "active",
      workspaceId: new mongoose.Types.ObjectId(String(organizationId)),
    });
    expect(String(created.connectedBy)).toBe(String(alice));
    expect(isEncrypted(created.accessToken)).toBe(true);
    expect(decrypt(created.refreshToken)).toBe("x_new_refresh");

    // Rejeu du même jeton : refusé
    expect(
      await completeDirectConnect("twitter", { state: token, code: "code" }),
    ).toContain("social_error=invalid_state");
  });

  it("refus dans la fenêtre du réseau, réseau qui ne correspond pas, compte déjà pris ailleurs", async () => {
    const stateOf = async (platform) =>
      new URL(await connect(platform)).searchParams.get("state");

    expect(
      await completeDirectConnect("twitter", {
        state: await stateOf("twitter"),
        error: "access_denied",
      }),
    ).toBe(
      "https://www.newbi.test/dashboard/outils/kanban/b1?socialPost=new&social_error=cancelled&social_platform=twitter",
    );

    expect(
      await completeDirectConnect("tiktok", {
        state: await stateOf("twitter"),
        code: "c",
      }),
    ).toContain("social_error=invalid_state");

    await SocialAccount.create({
      workspaceId: otherOrganizationId,
      provider: "direct",
      platform: "twitter",
      externalAccountId: "888",
    });
    vi.spyOn(xApi, "exchangeCode").mockResolvedValue({
      accounts: [
        {
          platform: "twitter",
          externalAccountId: "888",
          credentials: { accessToken: "a" },
        },
      ],
    });
    expect(
      await completeDirectConnect("twitter", {
        state: await stateOf("twitter"),
        code: "c",
      }),
    ).toContain("social_error=account_in_use");

    xApi.exchangeCode.mockRejectedValue(new Error("code expiré"));
    expect(
      await completeDirectConnect("twitter", {
        state: await stateOf("twitter"),
        code: "c",
      }),
    ).toContain("social_error=connection_failed");
  });

  it("LinkedIn, appli des pages ajoutée : le profil déjà connecté n'est pas dupliqué", async () => {
    Object.assign(process.env, {
      SOCIAL_PROVIDER_LINKEDIN: "direct",
      LINKEDIN_CLIENT_ID: "li_client",
      LINKEDIN_CLIENT_SECRET: "li_secret",
      LINKEDIN_PAGES_CLIENT_ID: "li_pages_client",
      LINKEDIN_PAGES_CLIENT_SECRET: "li_pages_secret",
    });
    // Profil connecté par l'appli « profile » avant la validation des pages
    await SocialAccount.create({
      workspaceId: organizationId,
      provider: "direct",
      platform: "linkedin",
      externalAccountId: "urn:li:person:share-abc",
      displayName: "Alice Martin",
      connectedBy: alice,
      platformData: { kind: "person", app: "profile" },
    });
    const credentials = {
      accessToken: "li_pages_access",
      refreshToken: null,
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 3600 * 1000),
      scopes: ["w_organization_social"],
    };
    const pagesConnection = {
      accounts: [
        {
          platform: "linkedin",
          externalAccountId: "urn:li:person:pages-abc",
          displayName: "Alice Martin",
          credentials,
          credentialGroup: "linkedin:urn:li:person:pages-abc",
          platformData: { kind: "person", app: "pages" },
        },
        {
          platform: "linkedin",
          externalAccountId: "urn:li:organization:42",
          displayName: "Newbi",
          credentials,
          credentialGroup: "linkedin:urn:li:person:pages-abc",
          platformData: { kind: "organization", app: "pages" },
        },
      ],
    };
    vi.spyOn(linkedinApi, "exchangeCode").mockResolvedValue(pagesConnection);

    const token = new URL(await connect("linkedin")).searchParams.get("state");
    const redirect = await completeDirectConnect("linkedin", {
      state: token,
      code: "code",
    });
    expect(redirect).toContain("social_connected=linkedin");
    const linkedin = await SocialAccount.find({ platform: "linkedin" })
      .sort({ createdAt: 1 })
      .lean();
    expect(linkedin.map((a) => a.externalAccountId)).toEqual([
      "urn:li:person:share-abc",
      "urn:li:organization:42",
    ]);

    // Sans profil déjà connecté : le profil de l'appli des pages est ajouté
    await SocialAccount.deleteMany({ platform: "linkedin" });
    const second = new URL(await connect("linkedin")).searchParams.get("state");
    await completeDirectConnect("linkedin", { state: second, code: "code" });
    expect(
      (await SocialAccount.find({ platform: "linkedin" }).lean())
        .map((a) => a.externalAccountId)
        .sort(),
    ).toEqual(["urn:li:organization:42", "urn:li:person:pages-abc"]);
  });

  it("déconnexion : accès révoqué chez X, jetons effacés, posts programmés annulés", async () => {
    const { post } = await schedule({
      boardId: String(board._id),
      accountIds: [String(xAccount._id)],
      content: "Bonjour",
      scheduledFor: inOneDay().toISOString(),
    });
    await Mutation.disconnectSocialAccount(
      null,
      { accountId: String(xAccount._id) },
      ctx,
    );
    expect(xApi.revoke).toHaveBeenCalledWith({
      accessToken: "x_access",
      refreshToken: "x_refresh",
    });
    const raw = await mongoose.connection.db
      .collection("socialaccounts")
      .findOne({ _id: xAccount._id });
    expect(raw.deletedAt).toBeInstanceOf(Date);
    expect(raw.accessToken).toBeNull();
    expect(raw.refreshToken).toBeNull();
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored.status).toBe("cancelled");
    expect(stored.notifiedStatus).toBe("cancelled");
    expect(provider.deletePost).not.toHaveBeenCalled();
  });
});

describe("posts avec des cibles directes", () => {
  it("post mixte : seules les cibles Zernio vont chez Zernio, la cible X attend le cron", async () => {
    const { post } = await schedule({
      boardId: String(board._id),
      accountIds: [String(instagram._id), String(xAccount._id)],
      content: "Nouvelle collection",
      mediaIds: [String(squareImage._id)],
      scheduledFor: inOneDay().toISOString(),
    });
    expect(provider.createPost.mock.calls[0][0].targets).toEqual([
      { platform: "instagram", externalAccountId: "za_ig" },
    ]);
    expect(xApi.publish).not.toHaveBeenCalled();
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored).toMatchObject({
      provider: "mixed",
      externalPostId: "zp_1",
      status: "scheduled",
    });
    expect(
      stored.targets.map((t) => [t.platform, t.provider, t.status]),
    ).toEqual([
      ["instagram", "zernio", "pending"],
      ["twitter", "direct", "pending"],
    ]);
    expect(post.targets.map((t) => t.accountId)).toEqual([
      String(instagram._id),
      String(xAccount._id),
    ]);
  });

  it("publier maintenant (X seul) : publié dans la mutation, sans Zernio", async () => {
    const { post } = await schedule({
      boardId: String(board._id),
      accountIds: [String(xAccount._id)],
      content: "Tout de suite",
      publishNow: true,
    });
    expect(provider.createPost).not.toHaveBeenCalled();
    expect(xApi.publish).toHaveBeenCalledTimes(1);
    expect(post.status).toBe("published");
    expect(post.targets[0]).toMatchObject({
      status: "published",
      platformPostUrl: "https://x.com/acme/status/1850",
    });
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored).toMatchObject({ provider: "direct", externalPostId: null });
  });

  it("modifier, reprogrammer, annuler une cible directe : purement local", async () => {
    const { post, task } = await schedule({
      boardId: String(board._id),
      accountIds: [String(xAccount._id)],
      content: "Avant",
      scheduledFor: inOneDay().toISOString(),
    });
    const updated = await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { content: "Après" } },
      ctx,
    );
    expect(updated.content).toBe("Après");

    const nextDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await KanbanMutation.updateTask(
      null,
      { input: { id: task.id, dueDate: nextDate.toISOString() } },
      ctx,
    );
    expect(
      (await SocialPost.findById(post.id).lean()).scheduledFor.toISOString(),
    ).toBe(nextDate.toISOString());

    const cancelled = await Mutation.cancelSocialPost(
      null,
      { id: post.id },
      ctx,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.targets[0].status).toBe("cancelled");
    expect(provider.updatePost).not.toHaveBeenCalled();
    expect(provider.deletePost).not.toHaveBeenCalled();
    expect(provider.createPost).not.toHaveBeenCalled();
  });

  it("post mixte modifié : part Zernio mise à jour, supprimée quand plus aucun compte Zernio", async () => {
    const { post } = await schedule({
      boardId: String(board._id),
      accountIds: [String(instagram._id), String(xAccount._id)],
      content: "Mixte",
      mediaIds: [String(squareImage._id)],
      scheduledFor: inOneDay().toISOString(),
    });
    await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { content: "Mixte 2" } },
      ctx,
    );
    expect(provider.updatePost.mock.calls[0][1].targets).toEqual([
      { platform: "instagram", externalAccountId: "za_ig" },
    ]);

    await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { accountIds: [String(xAccount._id)] } },
      ctx,
    );
    expect(provider.deletePost).toHaveBeenCalledWith("zp_1");
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored).toMatchObject({ provider: "direct", externalPostId: null });

    // Compte Zernio ajouté de nouveau : nouveau post Zernio
    provider.createPost.mockResolvedValue(zernioPost("zp_2"));
    await Mutation.updateSocialPost(
      null,
      {
        id: post.id,
        input: { accountIds: [String(instagram._id), String(xAccount._id)] },
      },
      ctx,
    );
    expect(await SocialPost.findById(post.id).lean()).toMatchObject({
      provider: "mixed",
      externalPostId: "zp_2",
    });
  });

  it("post mixte annulé : post Zernio supprimé, toutes les cibles annulées ; carte supprimée de même", async () => {
    const { post } = await schedule({
      boardId: String(board._id),
      accountIds: [String(instagram._id), String(xAccount._id)],
      content: "Mixte",
      mediaIds: [String(squareImage._id)],
      scheduledFor: inOneDay().toISOString(),
    });
    const cancelled = await Mutation.cancelSocialPost(
      null,
      { id: post.id },
      ctx,
    );
    expect(provider.deletePost).toHaveBeenCalledWith("zp_1");
    expect(cancelled.targets.map((t) => t.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);

    const second = await schedule({
      boardId: String(board._id),
      accountIds: [String(xAccount._id)],
      content: "Carte supprimée",
      scheduledFor: inOneDay().toISOString(),
    });
    await KanbanMutation.deleteTask(null, { id: second.task.id }, ctx);
    const stored = await SocialPost.findById(second.post.id).lean();
    expect(stored.status).toBe("cancelled");
    expect(stored.taskDeletedAt).toBeInstanceOf(Date);
  });

  it("réessayer une cible directe en échec : republiée tout de suite", async () => {
    xApi.publish.mockReset();
    xApi.publish
      .mockRejectedValueOnce(
        new DirectApiError("403", {
          network: "x",
          category: "user_content",
          detail: "Refusé",
        }),
      )
      .mockResolvedValueOnce(xPublished);
    const { post } = await schedule({
      boardId: String(board._id),
      accountIds: [String(xAccount._id)],
      content: "Essai",
      publishNow: true,
    });
    expect(post.status).toBe("failed");
    expect(post.targets[0].errorMessage).toBe("X a refusé le contenu : Refusé");

    const retried = await Mutation.retrySocialPost(null, { id: post.id }, ctx);
    expect(retried.status).toBe("published");
    expect(xApi.publish).toHaveBeenCalledTimes(2);
    // Nouvel envoi demandé vers X : compté dans la limite mensuelle
    expect((await SocialPost.findById(post.id).lean()).xRetriedAt).toHaveLength(
      1,
    );
    const { xPostQuota } = await Query.socialPublishingStatus(null, {}, ctx);
    expect(xPostQuota.used).toBe(2);
  });

  it("TikTok direct : creator_info lu par notre appli, pseudo et confidentialités en français", async () => {
    vi.spyOn(tiktokApi, "getCreatorInfo").mockResolvedValue({
      nickname: "La Boulangerie",
      username: "boulangerie",
      canPostMore: true,
      commentDisabled: false,
      privacyLevels: [
        { value: "PUBLIC_TO_EVERYONE", label: "PUBLIC_TO_EVERYONE" },
        { value: "SELF_ONLY", label: "SELF_ONLY" },
      ],
    });
    const info = await Query.tiktokCreatorInfo(
      null,
      { accountId: String(tiktok._id) },
      ctx,
    );
    expect(info).toMatchObject({
      username: "boulangerie",
      nickname: "La Boulangerie",
      privacyLevels: [
        { value: "PUBLIC_TO_EVERYONE", label: "Tout le monde" },
        { value: "SELF_ONLY", label: "Moi uniquement" },
      ],
    });
    expect(tiktokApi.getCreatorInfo).toHaveBeenCalledWith({
      accessToken: "act.1",
    });
  });

  it("TikTok : contenu de marque interdit en « Moi uniquement », enregistré sinon", async () => {
    const input = (privacyLevel) => ({
      boardId: String(board._id),
      accountIds: [String(tiktok._id)],
      content: "Partenariat",
      mediaIds: [String(squareImage._id)],
      scheduledFor: inOneDay().toISOString(),
      tiktokSettings: {
        privacyLevel,
        allowComment: false,
        brandOrganic: false,
        brandContent: true,
        consentGiven: true,
      },
    });
    await expect(schedule(input("SELF_ONLY"))).rejects.toThrow(
      "Le contenu de marque ne peut pas être visible par vous seul sur TikTok.",
    );
    const { post } = await schedule(input("PUBLIC_TO_EVERYONE"));
    expect(post.tiktokSettings).toMatchObject({
      brandContent: true,
      brandOrganic: false,
    });
  });
});

describe("images des posts", () => {
  it("téléversement : déposée dans notre bucket, adresse servie par l'API", async () => {
    const png = await sharp({
      create: { width: 600, height: 400, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const store = vi.spyOn(storage, "storeImage").mockResolvedValue({
      url: "https://api.newbi.test/social-media/22222222-2222-4222-8222-222222222222.jpg",
      key: "social/22222222-2222-4222-8222-222222222222.jpg",
    });
    vi.spyOn(provider, "uploadMedia");
    const media = await Mutation.uploadSocialPostMedia(
      null,
      {
        file: Promise.resolve({ createReadStream: () => Readable.from([png]) }),
      },
      ctx,
    );
    expect(media).toMatchObject({
      url: "https://api.newbi.test/social-media/22222222-2222-4222-8222-222222222222.jpg",
      width: 600,
      height: 400,
      contentType: "image/jpeg",
    });
    expect(store.mock.calls[0][0]).toMatchObject({ contentType: "image/jpeg" });
    expect(String(store.mock.calls[0][0].workspaceId)).toBe(
      String(organizationId),
    );
    expect(provider.uploadMedia).not.toHaveBeenCalled();
  });

  it("route publique : le fichier lui-même (jamais de redirection), 404 sinon", async () => {
    const layer = socialMediaRouter.stack.find(
      (l) => l.route?.path === "/:file",
    );
    const handler = layer.route.stack[0].handle;
    const response = () => {
      const res = {
        statusCode: 200,
        headers: {},
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        set(name, value) {
          if (typeof name === "object") Object.assign(this.headers, name);
          else this.headers[name] = value;
          return this;
        },
        end(body) {
          this.body = body ?? null;
          return this;
        },
      };
      return res;
    };
    vi.spyOn(storage, "readImage").mockImplementation(async (id) =>
      id === "33333333-3333-4333-8333-333333333333"
        ? {
            body: {
              transformToByteArray: async () => new Uint8Array([1, 2, 3]),
            },
            contentType: "image/jpeg",
            contentLength: 3,
          }
        : null,
    );

    const found = response();
    await handler(
      { params: { file: "33333333-3333-4333-8333-333333333333.jpg" } },
      found,
    );
    expect(found.statusCode).toBe(200);
    expect(found.headers).toMatchObject({
      "Content-Type": "image/jpeg",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    expect(Buffer.from(found.body)).toEqual(Buffer.from([1, 2, 3]));

    const missing = response();
    await handler(
      { params: { file: "44444444-4444-4444-8444-444444444444.jpg" } },
      missing,
    );
    expect(missing.statusCode).toBe(404);
    const invalid = response();
    await handler({ params: { file: "../secret.jpg" } }, invalid);
    expect(invalid.statusCode).toBe(404);
  });
});
