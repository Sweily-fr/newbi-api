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
import { seedOrgMembership, buildContext } from "../../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";

// Publications temps réel capturées (canal TASK_UPDATED_…)
const published = [];
vi.mock("../../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async (channel, payload) => {
      published.push({ channel, payload });
    },
    asyncIterator: () => ({}),
  }),
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
vi.mock("../../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import { Board, Column, Task } from "../../../src/models/kanban.js";
import Notification from "../../../src/models/Notification.js";
import SocialAccount from "../../../src/models/SocialAccount.js";
import SocialPost from "../../../src/models/SocialPost.js";
import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import SocialProfile from "../../../src/models/SocialProfile.js";
import SocialConnectState from "../../../src/models/SocialConnectState.js";
import kanbanResolvers from "../../../src/resolvers/kanban.js";
import socialResolvers from "../../../src/resolvers/socialPublishing.js";
import provider, {
  SocialProviderError,
} from "../../../src/services/social/providers/zernioProvider.js";
import {
  completeConnect,
  createConnectUrl,
  sanitizeReturnTo,
} from "../../../src/services/social/socialPublishingService.js";

const { Mutation: KanbanMutation } = kanbanResolvers;
const { Mutation, Query } = socialResolvers;

const alice = buildUserId();
const mallory = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
let ctx;
let board;
let firstColumn;
let secondColumn;
let instagram;
let twitter;
let tiktok;
let foreignAccount;
let squareImage;

const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const taskEvents = (type) =>
  published.filter(
    (p) => p.channel.startsWith("TASK_UPDATED_") && p.payload.type === type,
  );

const remotePost = ({ status = "scheduled", platforms } = {}) => ({
  externalPostId: "zp_1",
  status,
  scheduledFor: null,
  targets: platforms || [
    {
      platform: "instagram",
      externalAccountId: "za_ig",
      status: "pending",
      platformPostUrl: null,
      errorMessage: null,
      errorCategory: null,
      publishedAt: null,
    },
  ],
});

const schedule = (input, context = ctx) =>
  Mutation.scheduleSocialPost(null, { input }, context);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  published.length = 0;
  sendSocialPostFailedEmail.mockClear();
  process.env.ZERNIO_API_KEY = "sk_test_zernio";
  process.env.FRONTEND_URL = "https://www.newbi.test";
  process.env.NEXT_PUBLIC_API_URL = "https://api.newbi.test";

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

  board = await Board.create({
    title: "Communication",
    workspaceId: organizationId,
    userId: alice,
  });
  // Ordre volontairement inversé : la « première » colonne est celle d'ordre 0
  secondColumn = await Column.create({
    title: "En cours",
    color: "#000",
    boardId: board._id,
    order: 1,
    workspaceId: organizationId,
    userId: alice,
  });
  firstColumn = await Column.create({
    title: "Idées",
    color: "#000",
    boardId: board._id,
    order: 0,
    workspaceId: organizationId,
    userId: alice,
  });

  await SocialProfile.create({
    workspaceId: organizationId,
    externalProfileId: "prof_1",
  });
  [instagram, twitter, tiktok] = await SocialAccount.create([
    {
      workspaceId: organizationId,
      platform: "instagram",
      externalAccountId: "za_ig",
      username: "acme",
    },
    {
      workspaceId: organizationId,
      platform: "twitter",
      externalAccountId: "za_x",
      username: "acme_x",
    },
    {
      workspaceId: organizationId,
      platform: "tiktok",
      externalAccountId: "za_tt",
      username: "acme_tt",
    },
  ]);
  foreignAccount = await SocialAccount.create({
    workspaceId: otherOrganizationId,
    platform: "instagram",
    externalAccountId: "za_foreign",
    username: "concurrent",
  });
  squareImage = await SocialPostMedia.create({
    workspaceId: organizationId,
    url: "https://media.zernio.test/square.jpg",
    width: 1080,
    height: 1080,
  });

  vi.spyOn(provider, "createPost").mockResolvedValue({
    httpStatus: 201,
    incomplete: false,
    post: remotePost(),
  });
  vi.spyOn(provider, "updatePost").mockResolvedValue({
    httpStatus: 200,
    incomplete: false,
    post: remotePost(),
  });
  vi.spyOn(provider, "deletePost").mockResolvedValue({ alreadyGone: false });
  vi.spyOn(provider, "retryPost");
  vi.spyOn(provider, "getConnectUrl").mockResolvedValue(
    "https://zernio.test/connect/welcome?ticket=abc",
  );
  vi.spyOn(provider, "listAccounts").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZERNIO_API_KEY;
});

describe("scheduleSocialPost", () => {
  it("crée la carte dans la première colonne puis le post, et diffuse la carte", async () => {
    const scheduledFor = inOneDay();
    const result = await schedule({
      boardId: String(board._id),
      accountIds: [String(instagram._id)],
      content: "Nouvelle collection\nDisponible demain",
      mediaIds: [String(squareImage._id)],
      scheduledFor: scheduledFor.toISOString(),
    });

    expect(result.task.title).toBe(
      "Post Instagram : Nouvelle collection Disponible demain",
    );
    const task = await Task.findById(result.task.id).lean();
    expect(task.columnId).toBe(String(firstColumn._id));
    expect(task.description).toBe(
      "<p>Nouvelle collection</p><p>Disponible demain</p>",
    );
    expect(task.dueDate.toISOString()).toBe(scheduledFor.toISOString());

    expect(result.post).toMatchObject({
      taskId: result.task.id,
      boardId: String(board._id),
      status: "scheduled",
      timezone: "Europe/Paris",
      scheduledFor: scheduledFor.toISOString(),
    });
    expect(result.post.targets).toEqual([
      expect.objectContaining({
        accountId: String(instagram._id),
        platform: "instagram",
        status: "pending",
      }),
    ]);
    expect(result.post.media[0]).toMatchObject({
      id: String(squareImage._id),
      url: squareImage.url,
    });

    const call = provider.createPost.mock.calls[0][0];
    expect(call.targets).toEqual([
      { platform: "instagram", externalAccountId: "za_ig" },
    ]);
    expect(call.mediaUrls).toEqual([squareImage.url]);
    expect(call.publishNow).toBe(false);
    const stored = await SocialPost.findOne({ taskId: task._id }).lean();
    expect(stored.idempotencyKey).toBe(call.idempotencyKey);
    expect(stored.externalPostId).toBe("zp_1");

    expect(taskEvents("CREATED")).toHaveLength(1);
  });

  it("échec chez Zernio : la carte est supprimée, rien ne reste à moitié", async () => {
    provider.createPost.mockRejectedValue(
      new SocialProviderError("Instagram requires a business account", {
        kind: "http",
        status: 400,
        code: "invalid_field_value",
      }),
    );
    await expect(
      schedule({
        boardId: String(board._id),
        accountIds: [String(instagram._id)],
        content: "Hello",
        mediaIds: [String(squareImage._id)],
        scheduledFor: inOneDay().toISOString(),
      }),
    ).rejects.toThrow(
      "Publication refusée : Instagram requires a business account",
    );
    expect(await Task.countDocuments({ boardId: board._id })).toBe(0);
    expect(await SocialPost.countDocuments()).toBe(0);
    expect(taskEvents("CREATED")).toHaveLength(0);
  });

  it("refuse un compte d'un autre espace (ni carte, ni appel à Zernio)", async () => {
    await expect(
      schedule({
        boardId: String(board._id),
        accountIds: [String(foreignAccount._id)],
        content: "Hello",
        mediaIds: [String(squareImage._id)],
        scheduledFor: inOneDay().toISOString(),
      }),
    ).rejects.toThrow(/comptes sélectionnés est introuvable/);
    expect(provider.createPost).not.toHaveBeenCalled();
    expect(await Task.countDocuments()).toBe(0);
  });

  it("refuse une image d'un autre espace", async () => {
    const foreignImage = await SocialPostMedia.create({
      workspaceId: otherOrganizationId,
      url: "https://media.zernio.test/foreign.jpg",
      width: 1080,
      height: 1080,
    });
    await expect(
      schedule({
        boardId: String(board._id),
        accountIds: [String(instagram._id)],
        content: "Hello",
        mediaIds: [String(foreignImage._id)],
        scheduledFor: inOneDay().toISOString(),
      }),
    ).rejects.toThrow(/images est introuvable/);
    expect(provider.createPost).not.toHaveBeenCalled();
  });

  it("refuse un membre d'un autre espace (RBAC)", async () => {
    const malloryCtx = buildContext({ userId: mallory, organizationId });
    await expect(
      schedule(
        {
          boardId: String(board._id),
          accountIds: [String(instagram._id)],
          content: "Hello",
          scheduledFor: inOneDay().toISOString(),
        },
        malloryCtx,
      ),
    ).rejects.toThrow(/pas membre/);
  });

  it("valide avant de créer quoi que ce soit (image Instagram, date, TikTok)", async () => {
    const base = {
      boardId: String(board._id),
      content: "Hello",
      scheduledFor: inOneDay().toISOString(),
    };
    await expect(
      schedule({ ...base, accountIds: [String(instagram._id)] }),
    ).rejects.toThrow("Instagram exige au moins une image.");
    await expect(
      schedule({
        ...base,
        accountIds: [String(twitter._id)],
        scheduledFor: new Date(Date.now() + 60 * 1000).toISOString(),
      }),
    ).rejects.toThrow(
      "La date de publication doit être au moins 5 minutes dans le futur",
    );
    await expect(
      schedule({
        ...base,
        accountIds: [String(tiktok._id)],
        mediaIds: [String(squareImage._id)],
        tiktokSettings: {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          allowComment: true,
          consentGiven: false,
        },
      }),
    ).rejects.toThrow(/confirmation d'utilisation de la musique/);
    expect(provider.createPost).not.toHaveBeenCalled();
    expect(await Task.countDocuments()).toBe(0);
  });

  it("fonctionnalité désactivée sans clé : message clair", async () => {
    delete process.env.ZERNIO_API_KEY;
    await expect(
      schedule({
        boardId: String(board._id),
        accountIds: [String(twitter._id)],
        content: "Hello",
        scheduledFor: inOneDay().toISOString(),
      }),
    ).rejects.toThrow(
      "La publication sur les réseaux sociaux n'est pas encore disponible",
    );
    const status = await Query.socialPublishingStatus(null, {}, ctx);
    expect(status).toMatchObject({
      enabled: false,
      canManageAccounts: true,
      canSchedule: true,
      accounts: [],
    });
  });

  it("publication immédiate en 207 : statut partiel, auteur notifié une fois", async () => {
    provider.createPost.mockResolvedValue({
      httpStatus: 207,
      incomplete: true,
      post: remotePost({
        status: "partial",
        platforms: [
          {
            platform: "instagram",
            externalAccountId: "za_ig",
            status: "failed",
            errorCategory: "account_issue",
            errorMessage: "Not a business account",
          },
          {
            platform: "twitter",
            externalAccountId: "za_x",
            status: "published",
            platformPostUrl: "https://x.com/acme_x/status/1",
          },
        ],
      }),
    });
    const result = await schedule({
      boardId: String(board._id),
      accountIds: [String(instagram._id), String(twitter._id)],
      content: "Ouverture",
      mediaIds: [String(squareImage._id)],
      publishNow: true,
    });
    expect(result.post.status).toBe("partial");
    expect(result.post.targets[0].errorMessage).toBe(
      "Le compte Instagram n'est pas configuré pour publier (ex. Instagram doit être un compte professionnel).",
    );
    expect(result.post.targets[1].platformPostUrl).toBe(
      "https://x.com/acme_x/status/1",
    );
    expect(provider.createPost.mock.calls[0][0].publishNow).toBe(true);

    const notifications = await Notification.find({ userId: alice }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "SOCIAL_POST_FAILED",
      message: "Publié sur X, échec sur Instagram.",
    });
    expect(notifications[0].data.url).toBe(
      `https://www.newbi.test/dashboard/outils/kanban/${board._id}?task=${result.task.id}`,
    );
    expect(sendSocialPostFailedEmail).toHaveBeenCalledTimes(1);
    expect(sendSocialPostFailedEmail.mock.calls[0][0]).toBe("alice@test.fr");
  });
});

describe("carte modifiée dans le kanban", () => {
  const createScheduledPost = async () => {
    const result = await schedule({
      boardId: String(board._id),
      columnId: String(secondColumn._id),
      accountIds: [String(twitter._id)],
      content: "Rendez-vous jeudi",
      scheduledFor: inOneDay().toISOString(),
    });
    published.length = 0;
    return result;
  };

  it("nouvelle date d'échéance : reprogrammée chez Zernio avant l'enregistrement", async () => {
    const { task } = await createScheduledPost();
    expect(task.columnId).toBe(String(secondColumn._id));
    const nextDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

    await KanbanMutation.updateTask(
      null,
      { input: { id: task.id, dueDate: nextDate.toISOString() } },
      ctx,
    );

    expect(provider.updatePost).toHaveBeenCalledWith("zp_1", {
      scheduledFor: nextDate,
      timezone: "Europe/Paris",
    });
    const post = await SocialPost.findOne({ taskId: task.id }).lean();
    expect(post.scheduledFor.toISOString()).toBe(nextDate.toISOString());
    const fresh = await Task.findById(task.id).lean();
    expect(fresh.dueDate.toISOString()).toBe(nextDate.toISOString());
  });

  it("date trop proche, retirée ou refusée par Zernio : la carte n'est pas modifiée", async () => {
    const { task } = await createScheduledPost();
    const before = (await Task.findById(task.id).lean()).dueDate.toISOString();

    await expect(
      KanbanMutation.updateTask(
        null,
        {
          input: {
            id: task.id,
            dueDate: new Date(Date.now() + 60 * 1000).toISOString(),
          },
        },
        ctx,
      ),
    ).rejects.toThrow(
      "La date de publication doit être au moins 5 minutes dans le futur",
    );
    await expect(
      KanbanMutation.updateTask(
        null,
        { input: { id: task.id, dueDate: null } },
        ctx,
      ),
    ).rejects.toThrow("Un post programmé doit garder une date de publication");
    // Chaîne vide : le scalaire DateTime en fait une date invalide
    await expect(
      KanbanMutation.updateTask(
        null,
        { input: { id: task.id, dueDate: new Date("") } },
        ctx,
      ),
    ).rejects.toThrow("Un post programmé doit garder une date de publication");

    provider.updatePost.mockRejectedValue(
      new SocialProviderError("timeout", { kind: "timeout" }),
    );
    await expect(
      KanbanMutation.updateTask(
        null,
        {
          input: {
            id: task.id,
            dueDate: new Date(Date.now() + 3 * 86400000).toISOString(),
          },
        },
        ctx,
      ),
    ).rejects.toThrow(/ne répond pas/);

    const after = (await Task.findById(task.id).lean()).dueDate.toISOString();
    expect(after).toBe(before);
  });

  it("tâche sans post : updateTask inchangé, aucun appel à Zernio", async () => {
    const task = await Task.create({
      title: "Préparer la démo",
      status: String(firstColumn._id),
      boardId: board._id,
      columnId: String(firstColumn._id),
      workspaceId: organizationId,
      userId: alice,
    });
    await KanbanMutation.updateTask(
      null,
      { input: { id: String(task._id), dueDate: null, title: "Démo" } },
      ctx,
    );
    await KanbanMutation.updateTask(
      null,
      {
        input: {
          id: String(task._id),
          dueDate: new Date(Date.now() + 60 * 1000).toISOString(),
        },
      },
      ctx,
    );
    expect(provider.updatePost).not.toHaveBeenCalled();
    await KanbanMutation.deleteTask(null, { id: String(task._id) }, ctx);
    expect(provider.deletePost).not.toHaveBeenCalled();
    expect(await Task.countDocuments({ _id: task._id })).toBe(0);
  });

  it("carte supprimée : post annulé chez Zernio, retiré du tableau", async () => {
    const { task, post } = await createScheduledPost();
    await KanbanMutation.deleteTask(null, { id: task.id }, ctx);

    expect(provider.deletePost).toHaveBeenCalledWith("zp_1");
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored.status).toBe("cancelled");
    expect(stored.taskDeletedAt).toBeInstanceOf(Date);
    expect(
      await Query.boardSocialPosts(null, { boardId: String(board._id) }, ctx),
    ).toEqual([]);
    // Annulation voulue : pas de notification
    expect(await Notification.countDocuments()).toBe(0);
  });

  it("Zernio injoignable : la suppression est bloquée (le post partirait sans carte)", async () => {
    const { task } = await createScheduledPost();
    provider.deletePost.mockRejectedValue(
      new SocialProviderError("fetch failed", { kind: "network" }),
    );
    await expect(
      KanbanMutation.deleteTask(null, { id: task.id }, ctx),
    ).rejects.toThrow(/Impossible d'annuler la publication programmée/);
    expect(await Task.countDocuments({ _id: task.id })).toBe(1);
  });

  it("colonne supprimée : posts de ses cartes annulés", async () => {
    const { post } = await createScheduledPost();
    await KanbanMutation.deleteColumn(
      null,
      { id: String(secondColumn._id) },
      ctx,
    );
    const stored = await SocialPost.findById(post.id).lean();
    expect(stored.status).toBe("cancelled");
    expect(provider.deletePost).toHaveBeenCalledTimes(1);
  });

  it("modifier le post met à jour Zernio, le post et la carte", async () => {
    const { post, task } = await createScheduledPost();
    const updated = await Mutation.updateSocialPost(
      null,
      { id: post.id, input: { content: "Rendez-vous vendredi" } },
      ctx,
    );
    expect(updated.content).toBe("Rendez-vous vendredi");
    expect(provider.updatePost.mock.calls[0][1]).toMatchObject({
      content: "Rendez-vous vendredi",
      targets: [{ platform: "twitter", externalAccountId: "za_x" }],
    });
    const fresh = await Task.findById(task.id).lean();
    expect(fresh.title).toBe("Post X : Rendez-vous vendredi");
    expect(taskEvents("UPDATED")).toHaveLength(1);
  });

  it("annuler la publication : statut cancelled, la carte reste", async () => {
    const { post, task } = await createScheduledPost();
    const cancelled = await Mutation.cancelSocialPost(
      null,
      { id: post.id },
      ctx,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.targets[0].status).toBe("cancelled");
    expect(await Task.countDocuments({ _id: task.id })).toBe(1);
  });

  it("réessayer un post en échec", async () => {
    const { post } = await createScheduledPost();
    await SocialPost.updateOne(
      { _id: post.id },
      {
        $set: {
          status: "failed",
          notifiedStatus: "failed",
          "targets.0.status": "failed",
        },
      },
    );
    provider.retryPost.mockResolvedValue({
      httpStatus: 200,
      post: remotePost({
        status: "published",
        platforms: [
          {
            platform: "twitter",
            externalAccountId: "za_x",
            status: "published",
            platformPostUrl: "https://x.com/acme_x/status/2",
          },
        ],
      }),
    });
    const retried = await Mutation.retrySocialPost(null, { id: post.id }, ctx);
    expect(retried.status).toBe("published");
    expect(retried.targets[0].platformPostUrl).toBe(
      "https://x.com/acme_x/status/2",
    );
    expect(
      await Notification.countDocuments({ type: "SOCIAL_POST_PUBLISHED" }),
    ).toBe(1);
  });
});

describe("connexion des comptes", () => {
  it("page de retour : un chemin du tableau de bord seulement", () => {
    expect(
      sanitizeReturnTo("/dashboard/outils/kanban/abc?socialPost=new"),
    ).toBe("/dashboard/outils/kanban/abc?socialPost=new");
    expect(
      sanitizeReturnTo("/dashboard?openSettings=true&settingsTab=applications"),
    ).toBe("/dashboard?openSettings=true&settingsTab=applications");
    expect(sanitizeReturnTo("https://evil.test/dashboard/")).toBe(
      "/dashboard/outils/kanban",
    );
    expect(sanitizeReturnTo("//evil.test/dashboard/")).toBe(
      "/dashboard/outils/kanban",
    );
    expect(sanitizeReturnTo("/dashboardx")).toBe("/dashboard/outils/kanban");
  });

  it("adresse de retour courte (limite du state OAuth de X), jeton à usage unique", async () => {
    const url = await createConnectUrl({
      workspaceId: organizationId,
      userId: alice,
      platform: "twitter",
      returnTo: "/dashboard/outils/kanban/b1?socialPost=new",
    });
    expect(url).toBe("https://zernio.test/connect/welcome?ticket=abc");
    const { redirectUrl } = provider.getConnectUrl.mock.calls[0][0];
    expect(redirectUrl.length).toBeLessThan(120);
    const token = new URL(redirectUrl).searchParams.get("state");

    provider.listAccounts.mockResolvedValue([
      {
        externalAccountId: "za_x",
        platform: "twitter",
        username: "acme_x",
        active: true,
        enabled: true,
      },
      {
        externalAccountId: "za_new",
        platform: "twitter",
        username: "acme_new",
        active: true,
        enabled: true,
      },
    ]);
    const redirect = await completeConnect({
      state: token,
      connected: "twitter",
      accountId: "za_new",
    });
    expect(redirect).toBe(
      "https://www.newbi.test/dashboard/outils/kanban/b1?socialPost=new&social_connected=twitter",
    );
    const created = await SocialAccount.findOne({
      externalAccountId: "za_new",
    });
    expect(String(created.connectedBy)).toBe(String(alice));
    // Absents de la liste : marqués supprimés
    expect(
      (await SocialAccount.findById(instagram._id)).deletedAt,
    ).toBeInstanceOf(Date);
    expect(await SocialConnectState.countDocuments()).toBe(0);

    // Rejeu du même jeton : refusé
    const replay = await completeConnect({ state: token });
    expect(replay).toContain("social_error=invalid_state");
  });

  it("refus chez le réseau : code et réseau renvoyés au site", async () => {
    await createConnectUrl({
      workspaceId: organizationId,
      userId: alice,
      platform: "instagram",
    });
    const { redirectUrl } = provider.getConnectUrl.mock.calls[0][0];
    const token = new URL(redirectUrl).searchParams.get("state");
    const redirect = await completeConnect({
      state: token,
      error: "oauth_denied",
      platform: "instagram",
    });
    expect(redirect).toBe(
      "https://www.newbi.test/dashboard/outils/kanban?social_error=oauth_denied&social_platform=instagram",
    );
  });
});
