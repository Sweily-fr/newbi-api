import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { PubSub } from "graphql-subscriptions";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
});

const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { Board, Task } from "../../src/models/kanban.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import {
  BOARD_SHARE_PASSWORD_MAX_PER_IP,
  BOARD_SHARE_PASSWORD_MAX_PER_SHARE,
  createBoardShareAccessToken,
  verifyBoardShareAccessToken,
} from "../../src/utils/boardShareAccessToken.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import publicBoardShareResolvers from "../../src/resolvers/publicBoardShare.js";

const PASSWORD = "Tableau!2026";
const VISITOR = "visiteur@exemple.fr";

const subscribe = (args) =>
  publicBoardShareResolvers.Subscription.publicTaskUpdated.subscribe(
    {},
    args,
    { user: null },
    {},
  );

// Requête HTTP d'un visiteur : seule l'adresse IP compte ici
const httpContext = (ip = "203.0.113.1") => ({ user: null, req: { ip } });

const getPublicBoard = (args, ip) =>
  publicBoardShareResolvers.Query.getPublicBoard({}, args, httpContext(ip));

const mutate = (name, args) =>
  publicBoardShareResolvers.Mutation[name]({}, args, httpContext());

const subscribeError = async (args) => {
  try {
    const iterator = await subscribe(args);
    await iterator?.return?.();
  } catch (error) {
    return error;
  }
  return null;
};

let board;
let share;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  resetMemoryAttempts();
  vi.restoreAllMocks();
  const workspaceId = buildOrganizationId();
  const ownerId = buildUserId();
  board = await Board.create({
    title: "Tableau protégé",
    workspaceId,
    userId: ownerId,
  });
  share = new PublicBoardShare({
    token: PublicBoardShare.generateToken(),
    boardId: board._id,
    workspaceId,
    createdBy: ownerId,
  });
  await share.setPassword(PASSWORD);
  await share.save();
});

describe("Jeton d'accès d'un tableau partagé", () => {
  it("n'est valable que pour son partage et son mot de passe actuel", async () => {
    const accessToken = createBoardShareAccessToken(share);
    expect(verifyBoardShareAccessToken(accessToken, share)).toBe(true);

    const other = new PublicBoardShare({
      token: PublicBoardShare.generateToken(),
      boardId: board._id,
      workspaceId: share.workspaceId,
      createdBy: share.createdBy,
    });
    await other.setPassword(PASSWORD);
    expect(verifyBoardShareAccessToken(accessToken, other)).toBe(false);

    await share.setPassword("NouveauMotDePasse!");
    expect(verifyBoardShareAccessToken(accessToken, share)).toBe(false);
  });

  it("expire", () => {
    const expired = createBoardShareAccessToken(share, -1000);
    expect(verifyBoardShareAccessToken(expired, share)).toBe(false);
    expect(verifyBoardShareAccessToken("123.abc", share)).toBe(false);
    expect(verifyBoardShareAccessToken(null, share)).toBe(false);
  });
});

describe("getPublicBoard sur un partage protégé", () => {
  it("demande le mot de passe sans le divulguer", async () => {
    const result = await getPublicBoard({
      token: share.token,
      email: VISITOR,
    });
    expect(result.success).toBe(false);
    expect(result.requiresPassword).toBe(true);
    expect(result.board).toBeUndefined();
  });

  it("refuse un mot de passe incorrect", async () => {
    const result = await getPublicBoard({
      token: share.token,
      email: VISITOR,
      password: "mauvais",
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe("Mot de passe incorrect");
    expect(result.requiresPassword).toBe(true);
  });

  it("remet un jeton avec le bon mot de passe, accepté ensuite seul", async () => {
    const first = await getPublicBoard({
      token: share.token,
      email: VISITOR,
      password: PASSWORD,
    });
    expect(first.success).toBe(true);
    expect(first.accessToken).toBeTruthy();

    const reload = await getPublicBoard({
      token: share.token,
      email: VISITOR,
      accessToken: first.accessToken,
    });
    expect(reload.success).toBe(true);
  });

  it("ne remet pas de jeton pour un partage sans mot de passe", async () => {
    await share.setPassword(null);
    await share.save();
    const result = await getPublicBoard({ token: share.token, email: VISITOR });
    expect(result.success).toBe(true);
    expect(result.accessToken).toBeNull();
  });
});

describe("publicTaskUpdated sur un partage protégé", () => {
  it("refuse le seul lien", async () => {
    const error = await subscribeError({
      token: share.token,
      boardId: board._id.toString(),
    });
    expect(error?.extensions?.code || error?.code).toBe("FORBIDDEN");
  });

  it("refuse le mot de passe seul ou un jeton d'un autre mot de passe", async () => {
    const staleToken = createBoardShareAccessToken(share);
    await share.setPassword("NouveauMotDePasse!");
    await share.save();

    // Le mot de passe n'est pas accepté par l'abonnement (essais non limités)
    expect(
      await subscribeError({
        token: share.token,
        boardId: board._id.toString(),
        password: "NouveauMotDePasse!",
      }),
    ).not.toBeNull();
    expect(
      await subscribeError({
        token: share.token,
        boardId: board._id.toString(),
        accessToken: staleToken,
      }),
    ).not.toBeNull();
  });

  it("accepte le jeton remis par getPublicBoard", async () => {
    const { accessToken } = await getPublicBoard({
      token: share.token,
      email: VISITOR,
      password: PASSWORD,
    });
    expect(
      await subscribeError({
        token: share.token,
        boardId: board._id.toString(),
        accessToken,
      }),
    ).toBeNull();
  });

  it("reste ouverte avec le seul lien pour un partage sans mot de passe", async () => {
    await share.setPassword(null);
    await share.save();
    expect(
      await subscribeError({
        token: share.token,
        boardId: board._id.toString(),
      }),
    ).toBeNull();
  });

  it("refuse un partage expiré", async () => {
    share.expiresAt = new Date(Date.now() - 1000);
    await share.save();
    const error = await subscribeError({
      token: share.token,
      boardId: board._id.toString(),
      accessToken: createBoardShareAccessToken(share),
    });
    expect(error?.message).toBe("Lien de partage invalide ou expiré");
  });
});

describe("publicTaskUpdated : bannissement et flux déjà ouvert", () => {
  const channel = () => `TASK_UPDATED_${share.workspaceId}_${share.boardId}`;
  const event = () => ({
    type: "VISITOR_PROFILE_UPDATED",
    boardId: board._id.toString(),
    visitor: { email: "autre@exemple.fr", name: "Autre" },
  });
  const openSubscription = () =>
    subscribe({
      token: share.token,
      boardId: board._id.toString(),
      accessToken: createBoardShareAccessToken(share),
      email: VISITOR,
    });

  it("refuse un visiteur banni", async () => {
    share.bannedEmails.push({ email: VISITOR, reason: "Test" });
    await share.save();
    const error = await subscribeError({
      token: share.token,
      boardId: board._id.toString(),
      accessToken: createBoardShareAccessToken(share),
      email: "Visiteur@Exemple.fr",
    });
    expect(error?.extensions?.code || error?.code).toBe("FORBIDDEN");
  });

  it("transmet les événements tant que l'accès tient", async () => {
    const iterator = await openSubscription();
    const next = iterator.next();
    await pubsub.publish(channel(), event());
    const { done, value } = await next;
    expect(done).toBe(false);
    expect(value.visitor.email).toBe("autre@exemple.fr");
    await iterator.return();
  });

  it("coupe le flux quand le visiteur est banni", async () => {
    const iterator = await openSubscription();
    const next = iterator.next();
    await PublicBoardShare.updateOne(
      { _id: share._id },
      { $push: { bannedEmails: { email: VISITOR, reason: "Test" } } },
    );
    await pubsub.publish(channel(), event());
    expect((await next).done).toBe(true);
  });

  it("coupe le flux quand le mot de passe change", async () => {
    const iterator = await openSubscription();
    const next = iterator.next();
    await share.setPassword("NouveauMotDePasse!");
    await share.save();
    await pubsub.publish(channel(), event());
    expect((await next).done).toBe(true);
  });

  it("coupe le flux quand le partage est désactivé", async () => {
    const iterator = await openSubscription();
    const next = iterator.next();
    await PublicBoardShare.updateOne(
      { _id: share._id },
      { $set: { isActive: false } },
    );
    await pubsub.publish(channel(), event());
    expect((await next).done).toBe(true);
  });
});

describe("getPublicBoard : essais de mot de passe limités", () => {
  const attempt = (password, ip) =>
    getPublicBoard({ token: share.token, email: VISITOR, password }, ip);

  it("bloque une adresse IP après trop d'échecs, même avec le bon mot de passe", async () => {
    const verify = vi
      .spyOn(PublicBoardShare.prototype, "verifyPassword")
      .mockImplementation(async (value) => value === PASSWORD);
    for (let i = 0; i < BOARD_SHARE_PASSWORD_MAX_PER_IP; i += 1) {
      const result = await attempt("mauvais", "198.51.100.7");
      expect(result.message).toBe("Mot de passe incorrect");
    }
    const blocked = await attempt(PASSWORD, "198.51.100.7");
    expect(blocked.success).toBe(false);
    expect(blocked.requiresPassword).toBe(true);
    expect(blocked.message).toMatch(/Trop de tentatives/);
    // Aucun calcul de mot de passe une fois bloqué
    expect(verify).toHaveBeenCalledTimes(BOARD_SHARE_PASSWORD_MAX_PER_IP);

    // Une autre adresse reste libre
    expect((await attempt(PASSWORD, "198.51.100.8")).success).toBe(true);
  });

  it("bloque le partage après trop d'échecs répartis sur plusieurs adresses", async () => {
    vi.spyOn(PublicBoardShare.prototype, "verifyPassword").mockImplementation(
      async (value) => value === PASSWORD,
    );
    for (let i = 0; i < BOARD_SHARE_PASSWORD_MAX_PER_SHARE; i += 1) {
      await attempt("mauvais", `192.0.2.${i}`);
    }
    const blocked = await attempt(PASSWORD, "192.0.2.250");
    expect(blocked.message).toMatch(/Trop de tentatives/);

    // Le jeton déjà remis reste valable
    const token = createBoardShareAccessToken(share);
    const withToken = await getPublicBoard(
      { token: share.token, email: VISITOR, accessToken: token },
      "192.0.2.251",
    );
    expect(withToken.success).toBe(true);
  });
});

describe("Actions des visiteurs sur un partage protégé", () => {
  let task;

  beforeEach(async () => {
    share.permissions.canComment = true;
    await share.save();
    task = await Task.create({
      title: "Tâche",
      status: "todo",
      boardId: board._id,
      columnId: "colonne",
      workspaceId: share.workspaceId,
      userId: share.createdBy,
    });
  });

  const comment = (extra = {}) =>
    mutate("addExternalComment", {
      token: share.token,
      taskId: task._id.toString(),
      content: "Bonjour",
      visitorEmail: VISITOR,
      ...extra,
    });

  it("refusent un visiteur sans preuve", async () => {
    const results = await Promise.all([
      comment(),
      mutate("updateVisitorProfile", {
        token: share.token,
        email: VISITOR,
        input: { firstName: "Jean" },
      }),
      mutate("uploadVisitorImage", {
        token: share.token,
        email: VISITOR,
        file: null,
      }),
      mutate("uploadExternalCommentImage", {
        token: share.token,
        taskId: task._id.toString(),
        visitorEmail: VISITOR,
        file: null,
      }),
    ]);
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.requiresPassword).toBe(true);
    }
    const saved = await Task.findById(task._id).lean();
    expect(saved.comments || []).toHaveLength(0);
  });

  it("acceptent le jeton remis par getPublicBoard", async () => {
    const { accessToken } = await getPublicBoard({
      token: share.token,
      email: VISITOR,
      password: PASSWORD,
    });
    const result = await comment({ accessToken });
    expect(result.success).toBe(true);
    expect(result.task.comments).toHaveLength(1);
  });

  it("refusent un visiteur banni, même avec le jeton", async () => {
    share.bannedEmails.push({ email: VISITOR, reason: "Test" });
    await share.save();
    const result = await comment({
      accessToken: createBoardShareAccessToken(share),
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe("Votre accès à ce tableau a été révoqué");
  });

  it("demande d'accès : preuve exigée, bannissement attendu", async () => {
    share.bannedEmails.push({ email: VISITOR, reason: "Test" });
    await share.save();
    const denied = await mutate("requestAccess", {
      token: share.token,
      email: VISITOR,
    });
    expect(denied.success).toBe(false);
    expect(denied.requiresPassword).toBe(true);

    const accepted = await mutate("requestAccess", {
      token: share.token,
      email: VISITOR,
      password: PASSWORD,
    });
    expect(accepted.success).toBe(true);
  });
});
