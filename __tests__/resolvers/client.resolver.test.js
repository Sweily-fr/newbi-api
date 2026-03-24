import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

// Mock Mongoose models
vi.mock("../../src/models/Client.js", () => {
  class MockClient {
    constructor(data) {
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
      this.activity = data.activity || [];
      this.notes = data.notes || [];
      this.save = vi.fn().mockResolvedValue(true);
    }
  }
  MockClient.findOne = vi.fn();
  MockClient.find = vi.fn();
  MockClient.countDocuments = vi.fn();
  MockClient.deleteOne = vi.fn();
  return { default: MockClient };
});

vi.mock("../../src/models/Invoice.js", () => ({
  default: { countDocuments: vi.fn() },
}));

vi.mock("../../src/models/Quote.js", () => ({
  default: { countDocuments: vi.fn() },
}));

vi.mock("../../src/models/PurchaseOrder.js", () => ({
  default: { countDocuments: vi.fn() },
}));

vi.mock("../../src/models/ClientCustomField.js", () => ({
  default: { find: vi.fn() },
}));

vi.mock("../../src/models/User.js", () => ({
  default: { findById: vi.fn() },
}));

// Mock RBAC to pass through
vi.mock("../../src/middlewares/rbac.js", () => ({
  requireRead: () => (resolver) => resolver,
  requireWrite: () => (resolver) => resolver,
  requireDelete: () => (resolver) => resolver,
  resolveWorkspaceId: (input, context) =>
    input && context && input !== context ? context : input || context,
}));

vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  isAuthenticated: (resolver) => resolver,
}));

vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));

import Client from "../../src/models/Client.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import clientResolvers from "../../src/resolvers/client.js";

const mockContext = {
  user: { id: "user-1", name: "Test User", email: "test@test.com" },
  workspaceId: "507f1f77bcf86cd799439011",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Client Resolver - Query.client", () => {
  const resolver = clientResolvers.Query.client;

  it("should return a client by id", async () => {
    const mockClientData = {
      _id: "507f1f77bcf86cd799439012",
      name: "Acme Corp",
      email: "contact@acme.com",
    };
    Client.findOne.mockResolvedValue(mockClientData);

    const result = await resolver(
      null,
      { id: "507f1f77bcf86cd799439012" },
      mockContext,
    );

    expect(result).toEqual(mockClientData);
    expect(Client.findOne).toHaveBeenCalled();
  });

  it("should throw NOT_FOUND when client does not exist", async () => {
    Client.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: "nonexistent" }, mockContext),
    ).rejects.toThrow("non trouvé");
  });

  it("should use context workspaceId when input workspaceId mismatches", async () => {
    const mockClientData = {
      _id: "507f1f77bcf86cd799439012",
      name: "Acme Corp",
      email: "contact@acme.com",
    };
    Client.findOne.mockResolvedValue(mockClientData);

    const result = await resolver(
      null,
      { id: "test", workspaceId: "different-ws" },
      mockContext,
    );

    expect(result).toEqual(mockClientData);
    // Verify the query used the context workspaceId, not the mismatched input
    const queryArg = Client.findOne.mock.calls[0][0];
    expect(queryArg.workspaceId.toString()).toBe(mockContext.workspaceId);
  });
});

describe("Client Resolver - Query.clients", () => {
  const resolver = clientResolvers.Query.clients;

  it("should return paginated client list", async () => {
    Client.countDocuments.mockResolvedValue(25);
    const mockItems = [{ name: "Client A" }, { name: "Client B" }];
    Client.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(mockItems),
        }),
      }),
    });

    const result = await resolver(null, { page: 1, limit: 10 }, mockContext);

    expect(result.items).toEqual(mockItems);
    expect(result.totalItems).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.currentPage).toBe(1);
  });

  it("should apply search filter", async () => {
    Client.countDocuments.mockResolvedValue(1);
    Client.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ name: "Acme" }]),
        }),
      }),
    });

    await resolver(null, { page: 1, limit: 10, search: "Acme" }, mockContext);

    // Verify countDocuments was called with search query containing $or
    const countCall = Client.countDocuments.mock.calls[0][0];
    expect(countCall.$or).toBeDefined();
    expect(countCall.$or.length).toBeGreaterThan(0);
  });
});

describe("Client Resolver - Mutation.createClient", () => {
  const resolver = clientResolvers.Mutation.createClient;

  it("should create a client successfully", async () => {
    Client.findOne.mockResolvedValue(null); // no duplicate

    const input = {
      name: "New Client",
      email: "new@client.com",
      type: "COMPANY",
      siret: "123456789",
    };

    const result = await resolver(null, { input }, mockContext);

    expect(result).toBeDefined();
    expect(result.save).toHaveBeenCalled();
  });

  it("should throw when client email already exists", async () => {
    Client.findOne.mockResolvedValue({ email: "existing@client.com" });

    const input = {
      name: "Duplicate",
      email: "existing@client.com",
      type: "COMPANY",
      siret: "123456789",
    };

    await expect(resolver(null, { input }, mockContext)).rejects.toThrow(
      "existe déjà",
    );
  });

  it("should throw when COMPANY type has no siret", async () => {
    Client.findOne.mockResolvedValue(null);

    const input = {
      name: "Missing Siret",
      email: "no-siret@client.com",
      type: "COMPANY",
      siret: "",
    };

    await expect(resolver(null, { input }, mockContext)).rejects.toThrow();
  });

  it("should validate SIREN/SIRET format for French company", async () => {
    Client.findOne.mockResolvedValue(null);

    const input = {
      name: "Bad Format",
      email: "bad@client.com",
      type: "COMPANY",
      siret: "12345", // invalid: neither 9 nor 14 digits
      isInternational: false,
    };

    await expect(resolver(null, { input }, mockContext)).rejects.toThrow(
      "SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres",
    );
  });

  it("should generate name from firstName/lastName for INDIVIDUAL type", async () => {
    Client.findOne.mockResolvedValue(null);

    const input = {
      email: "individual@client.com",
      type: "INDIVIDUAL",
      firstName: "Jean",
      lastName: "Dupont",
    };

    const result = await resolver(null, { input }, mockContext);

    expect(result.name).toBe("Jean Dupont");
  });
});

describe("Client Resolver - Mutation.deleteClient", () => {
  const resolver = clientResolvers.Mutation.deleteClient;

  it("should delete a client with no associated documents", async () => {
    Client.findOne.mockResolvedValue({ _id: "client-1" });
    Invoice.countDocuments.mockResolvedValue(0);
    Quote.countDocuments.mockResolvedValue(0);
    PurchaseOrder.countDocuments.mockResolvedValue(0);
    Client.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await resolver(null, { id: "client-1" }, mockContext);

    expect(result).toBe(true);
    expect(Client.deleteOne).toHaveBeenCalled();
  });

  it("should throw RESOURCE_IN_USE when client has invoices", async () => {
    Client.findOne.mockResolvedValue({ _id: "client-1" });
    Invoice.countDocuments.mockResolvedValue(3);

    await expect(
      resolver(null, { id: "client-1" }, mockContext),
    ).rejects.toThrow("factures");
  });

  it("should throw RESOURCE_IN_USE when client has quotes", async () => {
    Client.findOne.mockResolvedValue({ _id: "client-1" });
    Invoice.countDocuments.mockResolvedValue(0);
    Quote.countDocuments.mockResolvedValue(2);

    await expect(
      resolver(null, { id: "client-1" }, mockContext),
    ).rejects.toThrow("devis");
  });

  it("should throw NOT_FOUND when client does not exist", async () => {
    Client.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: "nonexistent" }, mockContext),
    ).rejects.toThrow("non trouvé");
  });
});
