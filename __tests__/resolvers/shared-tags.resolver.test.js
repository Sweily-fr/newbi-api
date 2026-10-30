/**
 * Registre de tags des documents partagés : les mutations renvoient un
 * SharedTag complet. usageCount est non nullable dans le schéma ; renvoyé
 * absent par updateDocumentTag, il levait « Cannot return null for
 * non-nullable field SharedTag.usageCount » à chaque renommage ou
 * changement de couleur.
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

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: async () => {} },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";

const { Mutation } = sharedDocumentResolvers;

const workspaceId = buildOrganizationId();
const owner = buildUserId();

const call = (name, args) =>
  Mutation[name](
    null,
    { workspaceId: String(workspaceId), ...args },
    buildContext({ userId: owner, organizationId: String(workspaceId) }),
    { fieldName: name },
  );

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
});

describe("Registre de tags : usageCount toujours renseigné", () => {
  it("createDocumentTag", async () => {
    const res = await call("createDocumentTag", { name: "Banque" });
    expect(res.success).toBe(true);
    expect(res.tag.usageCount).toBe(0);
  });

  it("updateDocumentTag : renommage et changement de couleur", async () => {
    const { tag } = await call("createDocumentTag", { name: "Banque" });

    const renamed = await call("updateDocumentTag", {
      id: String(tag.id),
      name: "Banques",
    });
    expect(renamed.success).toBe(true);
    expect(renamed.tag).toMatchObject({ name: "Banques", usageCount: 0 });

    const recolored = await call("updateDocumentTag", {
      id: String(tag.id),
      color: "#ef4444",
    });
    expect(recolored.success).toBe(true);
    expect(recolored.tag).toMatchObject({ color: "#ef4444", usageCount: 0 });
  });
});
