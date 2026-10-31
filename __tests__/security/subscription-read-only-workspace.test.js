/**
 * Mode lecture seule (abonnement inactif) : le contrôle d'abonnement porte
 * sur l'espace validé par le RBAC, celui que lit le resolver.
 *
 * Les enveloppes posées autour de toutes les mutations d'un fichier appellent
 * checkSubscriptionActive avant que l'espace soit connu. Le contrôle est
 * alors refait par withRBAC sur l'espace validé (argument workspaceId ou
 * en-tête), et chaque espace nommé par les en-têtes est aussi contrôlé.
 * Contexte construit comme celui de server.js : aucun workspaceId avant RBAC.
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

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  checkSubscriptionActive,
  clearPendingSubscriptionCheck,
  invalidateOrgCache,
  invalidateSubCache,
  withOrganization,
} from "../../src/middlewares/rbac.js";
import { ERROR_CODES } from "../../src/utils/errors.js";
import { Board } from "../../src/models/kanban.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";
import ocrResolvers from "../../src/resolvers/ocr.js";

const userId = buildUserId();
const expiredOrg = buildOrganizationId(); // abonnement impayé
const activeOrg = buildOrganizationId(); // abonnement actif
const foreignOrg = buildOrganizationId(); // abonné, sans l'utilisateur
const stranger = buildUserId();

// Contexte GraphQL tel que server.js le construit
const serverContext = (headers = {}) => ({
  req: { headers },
  user: {
    _id: new mongoose.Types.ObjectId(String(userId)),
    id: String(userId),
    email: "test@test.com",
  },
  organizationId: headers["x-organization-id"] || null,
});

const readOnly = { code: ERROR_CODES.SUBSCRIPTION_READ_ONLY };

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  await seedOrgMembership({
    userId,
    organizationId: expiredOrg,
    role: "owner",
    subscriptionStatus: "unpaid",
  });
  await seedOrgMembership({
    userId,
    organizationId: activeOrg,
    role: "owner",
  });
  await seedOrgMembership({
    userId: stranger,
    organizationId: foreignOrg,
    role: "owner",
  });
});

const createBoard = (workspaceId, headers) =>
  kanbanResolvers.Mutation.createBoard(
    null,
    { workspaceId: String(workspaceId), input: { title: "Projet" } },
    serverContext(headers),
  );

describe("mutations d'un espace à l'abonnement inactif", () => {
  it("createBoard est refusé sans en-tête d'espace", async () => {
    await expect(createBoard(expiredOrg, {})).rejects.toMatchObject(readOnly);
    expect(await Board.countDocuments({})).toBe(0);
  });

  it("createBoard est refusé avec l'en-tête d'un autre espace abonné", async () => {
    await expect(
      createBoard(expiredOrg, { "x-organization-id": String(activeOrg) }),
    ).rejects.toMatchObject(readOnly);
    expect(await Board.countDocuments({})).toBe(0);
  });

  it("createBoard est refusé avec x-workspace-id d'un espace étranger abonné", async () => {
    await expect(
      createBoard(expiredOrg, { "x-workspace-id": String(foreignOrg) }),
    ).rejects.toMatchObject(readOnly);
    expect(await Board.countDocuments({})).toBe(0);
  });

  it("chaque espace nommé par les en-têtes est contrôlé", async () => {
    await expect(
      createBoard(activeOrg, {
        "x-workspace-id": String(activeOrg),
        "x-organization-id": String(expiredOrg),
      }),
    ).rejects.toMatchObject(readOnly);
  });

  it("processDocumentOcr est refusé sans en-tête d'espace", async () => {
    await expect(
      ocrResolvers.Mutation.processDocumentOcr(
        null,
        { workspaceId: String(expiredOrg), file: Promise.resolve({}) },
        serverContext({}),
      ),
    ).rejects.toMatchObject(readOnly);
  });
});

describe("mutations d'un espace abonné", () => {
  it("createBoard passe sans en-tête d'espace", async () => {
    const board = await createBoard(activeOrg, {});
    expect(board.title).toBe("Projet");
    expect(await Board.countDocuments({ workspaceId: activeOrg })).toBe(1);
  });

  it("createBoard passe avec l'en-tête du même espace", async () => {
    await createBoard(activeOrg, { "x-organization-id": String(activeOrg) });
    expect(await Board.countDocuments({ workspaceId: activeOrg })).toBe(1);
  });
});

describe("contrôle différé jusqu'au RBAC", () => {
  const touch = withOrganization(async (_, __, context) => context.workspaceId);

  it("withRBAC refait le contrôle demandé avant la validation de l'espace", async () => {
    const context = serverContext({});
    await checkSubscriptionActive(context);
    await expect(
      touch(null, { workspaceId: String(expiredOrg) }, context),
    ).rejects.toMatchObject(readOnly);
  });

  it("le contrôle différé n'est fait qu'une fois", async () => {
    const context = serverContext({});
    await checkSubscriptionActive(context);
    await expect(
      touch(null, { workspaceId: String(expiredOrg) }, context),
    ).rejects.toMatchObject(readOnly);
    // Lecture suivante dans la même requête : aucun contrôle d'abonnement
    expect(
      await touch(null, { workspaceId: String(expiredOrg) }, context),
    ).toBe(String(expiredOrg));
  });

  it("clearPendingSubscriptionCheck annule un contrôle différé", async () => {
    const context = serverContext({});
    await checkSubscriptionActive(context);
    clearPendingSubscriptionCheck(context);
    expect(
      await touch(null, { workspaceId: String(expiredOrg) }, context),
    ).toBe(String(expiredOrg));
  });

  it("sans contrôle demandé, le RBAC ne vérifie pas l'abonnement", async () => {
    expect(
      await touch(null, { workspaceId: String(expiredOrg) }, serverContext({})),
    ).toBe(String(expiredOrg));
  });
});
