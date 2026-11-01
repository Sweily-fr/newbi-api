/**
 * Pagination hostile des listes de contacts et du catalogue : page 0 ou
 * négative, taille 0, négative ou démesurée. Jamais d'erreur technique ni de
 * réponse géante.
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

import { boundedPage } from "../../src/utils/pageBounds.js";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import clientResolvers from "../../src/resolvers/client.js";

describe("boundedPage", () => {
  it.each([
    [0, 10, { page: 1, limit: 10, skip: 0 }],
    [-1, 10, { page: 1, limit: 10, skip: 0 }],
    [2, 0, { page: 2, limit: 10, skip: 10 }],
    [1, -5, { page: 1, limit: 10, skip: 0 }],
    [1, 100000, { page: 1, limit: 1000, skip: 0 }],
    ["abc", "x", { page: 1, limit: 10, skip: 0 }],
    [3, 25, { page: 3, limit: 25, skip: 50 }],
  ])("page %j, taille %j", (page, limit, expected) => {
    expect(boundedPage(page, limit)).toEqual(expected);
  });

  it("borne haute propre à chaque liste", () => {
    expect(
      boundedPage(1, 100000, { defaultLimit: 20, maxLimit: 10000 }).limit,
    ).toBe(10000);
    expect(boundedPage(1, 0, { defaultLimit: 20 }).limit).toBe(20);
  });
});

describe("clients : pagination hostile", () => {
  const userId = buildUserId();
  const organizationId = buildOrganizationId();
  const ctx = () => buildContext({ userId, organizationId });

  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });
  beforeEach(async () => {
    await clearMongo();
    invalidateOrgCache();
    await seedOrgMembership({ userId, organizationId, role: "owner" });
    for (let i = 0; i < 3; i++) {
      await Client.create(
        buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
      );
    }
  });

  it.each([
    [0, 10],
    [-1, 10],
    [1, 0],
    [1, -5],
  ])("page %j, taille %j : réponse normale", async (page, limit) => {
    const result = await clientResolvers.Query.clients(
      null,
      { page, limit },
      ctx(),
    );
    expect(result.items).toHaveLength(3);
    expect(result.currentPage).toBe(1);
    expect(result.totalPages).toBe(1);
  });
});
