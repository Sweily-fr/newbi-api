/**
 * Kanban : mettre un tableau en favori ajoute ou retire le seul
 * utilisateur, sans réécrire la liste : deux membres qui le font au même
 * moment gardent chacun leur favori.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
});
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/mailer.js", () => ({
  sendTaskAssignmentEmail: vi.fn(async () => true),
  sendMentionEmail: vi.fn(async () => true),
  sendShareAccessApprovedEmail: vi.fn(),
  sendShareAccessRejectedEmail: vi.fn(),
}));
vi.mock("../../src/resolvers/notification.js", () => ({
  publishNotification: vi.fn(async () => {}),
}));
vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(async () => {}),
}));
vi.mock("../../src/collab/kanbanCollabServer.js", () => ({
  syncExternalDescription: vi.fn(async () => {}),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { Board } from "../../src/models/kanban.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";

const { Mutation } = kanbanResolvers;

const org = buildOrganizationId();
const members = [buildUserId(), buildUserId(), buildUserId()];
const ctx = (userId) => buildContext({ userId, organizationId: org });
const toggle = (boardId, userId) =>
  Mutation.toggleBoardFavorite(
    null,
    { boardId: String(boardId), workspaceId: String(org) },
    ctx(userId),
    { fieldName: "toggleBoardFavorite" },
  );

let board;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  for (const userId of members) {
    await seedOrgMembership({ userId, organizationId: org, role: "owner" });
  }
  board = await Board.create({
    title: "Projet",
    workspaceId: org,
    userId: members[0],
  });
});

describe("Favori d'un tableau", () => {
  it("trois membres en même temps : trois favoris", async () => {
    await Promise.all(members.map((userId) => toggle(board._id, userId)));
    const saved = await Board.findById(board._id).lean();
    expect([...saved.favoritedBy].sort()).toEqual(
      members.map(String).sort(),
    );
  });

  it("retirer son favori garde celui des autres", async () => {
    await toggle(board._id, members[0]);
    await toggle(board._id, members[1]);
    const result = await toggle(board._id, members[0]);
    expect(result.favoritedBy).toEqual([String(members[1])]);
    expect((await Board.findById(board._id).lean()).favoritedBy).toEqual([
      String(members[1]),
    ]);
  });
});
