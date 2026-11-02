/**
 * Bloquer un contact avec une raison trop longue : message clair (500
 * caractères au plus), pas « données incohérentes, contactez le support ».
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

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let client;

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
  client = await Client.create(
    buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
  );
});

const block = (reason) =>
  clientResolvers.Mutation.blockClient(
    null,
    { id: client._id.toString(), reason },
    ctx(),
  );

describe("blockClient : raison du blocage", () => {
  it("500 caractères : bloqué avec la raison", async () => {
    await block("r".repeat(500));
    const stored = await Client.findById(client._id);
    expect(stored.isBlocked).toBe(true);
    expect(stored.blockedReason).toHaveLength(500);
  });

  it("501 caractères : refusé avec un message clair, contact inchangé", async () => {
    await expect(block("r".repeat(501))).rejects.toThrow(
      "La raison du blocage ne peut pas dépasser 500 caractères.",
    );
    const stored = await Client.findById(client._id);
    expect(stored.isBlocked).toBe(false);
    expect(stored.activity).toHaveLength(0);
  });
});
