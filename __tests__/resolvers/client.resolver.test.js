import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientInput,
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

// Side-effect we don't want to test here (automation pipeline)
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
  default: {},
}));

// invalidateOrgCache imports rbac internals — we must clear the LRU between tests
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import clientResolvers from "../../src/resolvers/client.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

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
});

const ctx = () => buildContext({ userId, organizationId });

describe("Client Resolver - Query.client", () => {
  const resolver = clientResolvers.Query.client;

  it("returns a client by id", async () => {
    const doc = await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );

    const result = await resolver(null, { id: doc._id.toString() }, ctx());

    expect(result._id.toString()).toBe(doc._id.toString());
    expect(result.email).toBe(doc.email);
  });

  it("throws NOT_FOUND when client does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      "non trouvé",
    );
  });

  it("does not leak clients across workspaces", async () => {
    const otherOrg = buildOrganizationId();
    const otherClient = await Client.create(
      buildClientDoc({ workspaceId: otherOrg, createdBy: userId }),
    );

    await expect(
      resolver(null, { id: otherClient._id.toString() }, ctx()),
    ).rejects.toThrow("non trouvé");
  });
});

describe("Client Resolver - Query.clients", () => {
  const resolver = clientResolvers.Query.clients;

  it("returns paginated client list", async () => {
    for (let i = 0; i < 25; i++) {
      await Client.create(
        buildClientDoc({
          workspaceId: organizationId,
          createdBy: userId,
          name: `Client ${String(i).padStart(2, "0")}`,
        }),
      );
    }

    const result = await resolver(null, { page: 1, limit: 10 }, ctx());

    expect(result.totalItems).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.currentPage).toBe(1);
    expect(result.items).toHaveLength(10);
  });

  it("applies search filter", async () => {
    await Client.create(
      buildClientDoc({
        workspaceId: organizationId,
        createdBy: userId,
        name: "Acme Corp",
      }),
    );
    await Client.create(
      buildClientDoc({
        workspaceId: organizationId,
        createdBy: userId,
        name: "Beta Inc",
      }),
    );

    const result = await resolver(
      null,
      { page: 1, limit: 10, search: "Acme" },
      ctx(),
    );

    expect(result.totalItems).toBe(1);
    expect(result.items[0].name).toBe("Acme Corp");
  });

  it("scopes results to the active workspace", async () => {
    const otherOrg = buildOrganizationId();
    await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );
    await Client.create(
      buildClientDoc({ workspaceId: otherOrg, createdBy: userId }),
    );

    const result = await resolver(null, { page: 1, limit: 10 }, ctx());

    expect(result.totalItems).toBe(1);
  });
});

describe("Client Resolver - Mutation.createClient", () => {
  const resolver = clientResolvers.Mutation.createClient;

  it("creates a COMPANY client successfully", async () => {
    const input = buildClientInput({ type: "COMPANY" });

    const result = await resolver(null, { input }, ctx());

    expect(result._id).toBeDefined();
    expect(result.email).toBe(input.email);
    const persisted = await Client.findById(result._id);
    expect(persisted).not.toBeNull();
    expect(persisted.workspaceId.toString()).toBe(organizationId.toString());
  });

  it("rejects duplicate email within the same workspace", async () => {
    const input = buildClientInput({ type: "COMPANY" });
    await resolver(null, { input }, ctx());

    await expect(resolver(null, { input }, ctx())).rejects.toThrow(
      /existe déjà|email/i,
    );
  });

  it("allows the same email in a different workspace", async () => {
    const otherOrg = buildOrganizationId();
    const otherUser = buildUserId();
    await seedOrgMembership({
      userId: otherUser,
      organizationId: otherOrg,
      role: "owner",
    });

    const input = buildClientInput({ type: "COMPANY" });
    await resolver(null, { input }, ctx());

    const otherCtx = buildContext({
      userId: otherUser,
      organizationId: otherOrg,
    });
    await expect(resolver(null, { input }, otherCtx)).resolves.toBeDefined();
  });

  it("rejects COMPANY without siret", async () => {
    const input = buildClientInput({ type: "COMPANY", siret: "" });
    await expect(resolver(null, { input }, ctx())).rejects.toThrow();
  });

  it("rejects COMPANY with invalid SIREN/SIRET length (FR)", async () => {
    const input = buildClientInput({
      type: "COMPANY",
      siret: "12345",
      isInternational: false,
    });
    await expect(resolver(null, { input }, ctx())).rejects.toThrow(
      /SIREN.*9.*chiffres|SIRET.*14/i,
    );
  });

  it("generates name from firstName+lastName for INDIVIDUAL", async () => {
    const input = buildClientInput({
      type: "INDIVIDUAL",
      firstName: "Jean",
      lastName: "Dupont",
    });

    const result = await resolver(null, { input }, ctx());

    expect(result.name).toBe("Jean Dupont");
  });
});

describe("Client Resolver - Mutation.deleteClient (RBAC enforced)", () => {
  const resolver = clientResolvers.Mutation.deleteClient;

  it("deletes a client with no associated documents", async () => {
    const doc = await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );

    const result = await resolver(null, { id: doc._id.toString() }, ctx());

    expect(result).toBe(true);
    expect(await Client.findById(doc._id)).toBeNull();
  });

  it("throws when client has invoices", async () => {
    const doc = await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );

    // Insert a minimal invoice referencing the client id, bypassing schema validation
    // since we only need the count to be > 0. Use the raw collection.
    await Invoice.collection.insertOne({
      workspaceId: organizationId,
      client: { id: doc._id.toString() },
      createdAt: new Date(),
    });

    await expect(
      resolver(null, { id: doc._id.toString() }, ctx()),
    ).rejects.toThrow(/factures/i);
  });

  it("throws when client has quotes", async () => {
    const doc = await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );

    await Quote.collection.insertOne({
      workspaceId: organizationId,
      client: { id: doc._id.toString() },
      createdAt: new Date(),
    });

    await expect(
      resolver(null, { id: doc._id.toString() }, ctx()),
    ).rejects.toThrow(/devis/i);
  });

  it("throws when client has purchase orders", async () => {
    const doc = await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );

    await PurchaseOrder.collection.insertOne({
      workspaceId: organizationId,
      client: { id: doc._id.toString() },
      createdAt: new Date(),
    });

    await expect(
      resolver(null, { id: doc._id.toString() }, ctx()),
    ).rejects.toThrow(/bons de commande/i);
  });

  it("throws NOT_FOUND when client does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      "non trouvé",
    );
  });
});

describe("Client Resolver - real RBAC enforcement", () => {
  it("blocks viewer role from creating a client", async () => {
    const viewerUserId = buildUserId();
    const viewerOrgId = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrgId,
      role: "viewer",
    });

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrgId,
    });

    const input = buildClientInput({ type: "COMPANY" });
    await expect(
      clientResolvers.Mutation.createClient(null, { input }, viewerCtx),
    ).rejects.toThrow(/permission|create/i);
  });

  it("blocks viewer role from deleting a client", async () => {
    const viewerUserId = buildUserId();
    const viewerOrgId = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrgId,
      role: "viewer",
    });

    const doc = await Client.create(
      buildClientDoc({ workspaceId: viewerOrgId, createdBy: viewerUserId }),
    );

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrgId,
    });

    await expect(
      clientResolvers.Mutation.deleteClient(
        null,
        { id: doc._id.toString() },
        viewerCtx,
      ),
    ).rejects.toThrow(/permission|delete/i);
  });
});
