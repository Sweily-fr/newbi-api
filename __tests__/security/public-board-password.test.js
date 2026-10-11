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
import { Board } from "../../src/models/kanban.js";
import PublicBoardShare from "../../src/models/PublicBoardShare.js";
import {
  createBoardShareAccessToken,
  verifyBoardShareAccessToken,
} from "../../src/utils/boardShareAccessToken.js";
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

const getPublicBoard = (args) =>
  publicBoardShareResolvers.Query.getPublicBoard({}, args);

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

  it("refuse un mot de passe incorrect ou un jeton d'un autre mot de passe", async () => {
    const staleToken = createBoardShareAccessToken(share);
    await share.setPassword("NouveauMotDePasse!");
    await share.save();

    expect(
      await subscribeError({
        token: share.token,
        boardId: board._id.toString(),
        password: "mauvais",
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

  it("accepte le mot de passe ou le jeton remis par getPublicBoard", async () => {
    expect(
      await subscribeError({
        token: share.token,
        boardId: board._id.toString(),
        password: PASSWORD,
      }),
    ).toBeNull();

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
      password: PASSWORD,
    });
    expect(error?.message).toBe("Lien de partage invalide ou expiré");
  });
});
