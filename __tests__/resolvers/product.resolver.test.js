import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

// ─── Mock models ────────────────────────────────────────────────────

vi.mock("../../src/models/Product.js", () => {
  class MockProduct {
    constructor(data) {
      Object.assign(this, data);
      this._id = data._id || new mongoose.Types.ObjectId();
      this.save = vi.fn().mockResolvedValue(true);
    }
  }
  MockProduct.findOne = vi.fn();
  MockProduct.find = vi.fn();
  MockProduct.countDocuments = vi.fn();
  MockProduct.findById = vi.fn();
  MockProduct.findByIdAndUpdate = vi.fn();
  MockProduct.findByIdAndDelete = vi.fn();
  MockProduct.deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
  return { default: MockProduct };
});

// ─── Mock middlewares (pass-through) ────────────────────────────────

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

// ─── Import ─────────────────────────────────────────────────────────

import Product from "../../src/models/Product.js";
import productResolvers from "../../src/resolvers/product.js";

const workspaceId = "507f1f77bcf86cd799439011";

const mockContext = {
  user: { id: "user-1", name: "Test User", email: "test@test.com" },
  workspaceId,
  userRole: "owner",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Query.product ──────────────────────────────────────────────────

describe("Product Resolver - Query.product", () => {
  const resolver = productResolvers.Query.product;

  it("should return a product by id", async () => {
    const mockProduct = { _id: "prod-1", name: "Audit SEO", unitPrice: 1500 };
    Product.findOne.mockResolvedValue(mockProduct);

    const result = await resolver(
      null,
      { id: "prod-1", workspaceId },
      mockContext,
    );

    expect(result).toEqual(mockProduct);
    expect(Product.findOne).toHaveBeenCalled();
  });

  it("should throw NOT_FOUND when product does not exist", async () => {
    Product.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: "nonexistent", workspaceId }, mockContext),
    ).rejects.toThrow();
  });

  it("should use context workspaceId when input workspaceId mismatches", async () => {
    const mockProduct = { _id: "prod-1", name: "Audit SEO", unitPrice: 1500 };
    Product.findOne.mockResolvedValue(mockProduct);

    const result = await resolver(
      null,
      { id: "prod-1", workspaceId: "different-ws" },
      mockContext,
    );

    expect(result).toEqual(mockProduct);
    // Verify the query used the context workspaceId, not the mismatched input
    const queryArg = Product.findOne.mock.calls[0][0];
    expect(queryArg.workspaceId).toBe(mockContext.workspaceId);
  });
});

// ─── Query.products ─────────────────────────────────────────────────

describe("Product Resolver - Query.products", () => {
  const resolver = productResolvers.Query.products;

  it("should return paginated product list", async () => {
    const mockProducts = [{ name: "Product A" }, { name: "Product B" }];
    // Pattern: Promise.all([Product.find(query).sort().skip().limit(), Product.countDocuments(query)])
    Product.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(mockProducts),
        }),
      }),
    });
    Product.countDocuments.mockResolvedValue(15);

    const result = await resolver(
      null,
      { workspaceId, page: 1, limit: 10 },
      mockContext,
    );

    expect(result.products).toEqual(mockProducts);
    expect(result.totalCount).toBe(15);
  });

  it("should apply search filter", async () => {
    Product.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    Product.countDocuments.mockResolvedValue(1);

    await resolver(
      null,
      { workspaceId, search: "SEO", page: 1, limit: 10 },
      mockContext,
    );

    const queryArg = Product.find.mock.calls[0][0];
    expect(queryArg.$or).toBeDefined();
  });
});

// ─── Mutation.createProduct ─────────────────────────────────────────

describe("Product Resolver - Mutation.createProduct", () => {
  const resolver = productResolvers.Mutation.createProduct;

  it("should create a product successfully", async () => {
    Product.findOne.mockResolvedValue(null); // no duplicate

    const input = {
      name: "Audit technique",
      unitPrice: 2000,
      vatRate: 20,
      unit: "forfait",
      workspaceId,
    };

    const result = await resolver(null, { input }, mockContext);

    expect(result).toBeDefined();
    expect(result.save).toHaveBeenCalled();
    expect(result.name).toBe("Audit technique");
  });

  it("should throw when product name already exists in workspace", async () => {
    Product.findOne.mockResolvedValue({ name: "Existing Product" });

    const input = {
      name: "Existing Product",
      unitPrice: 100,
      workspaceId,
    };

    await expect(resolver(null, { input }, mockContext)).rejects.toThrow();
  });

  it("should use context workspaceId on workspace mismatch in input", async () => {
    Product.findOne.mockResolvedValue(null); // no duplicate

    const input = {
      name: "Test",
      unitPrice: 100,
      workspaceId: "different-workspace",
    };

    const result = await resolver(null, { input }, mockContext);

    expect(result).toBeDefined();
    expect(result.save).toHaveBeenCalled();
    // The resolver should fall back to context workspaceId
    expect(result.workspaceId).toBe(mockContext.workspaceId);
  });
});

// ─── Mutation.updateProduct ─────────────────────────────────────────

describe("Product Resolver - Mutation.updateProduct", () => {
  const resolver = productResolvers.Mutation.updateProduct;

  it("should update a product", async () => {
    // updateProduct uses Product.findOne() then modifies and calls product.save()
    const existingProduct = {
      _id: "prod-1",
      name: "Old Name",
      unitPrice: 1000,
      workspaceId,
      save: vi.fn().mockResolvedValue(true),
    };
    Product.findOne.mockResolvedValueOnce(existingProduct); // access check
    Product.findOne.mockResolvedValueOnce(null); // no duplicate name

    const result = await resolver(
      null,
      { id: "prod-1", input: { name: "Updated", unitPrice: 3000 } },
      mockContext,
    );

    expect(result.name).toBe("Updated");
    expect(result.unitPrice).toBe(3000);
    expect(result.save).toHaveBeenCalled();
  });

  it("should throw NOT_FOUND when product does not exist", async () => {
    Product.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: "nonexistent", input: { name: "X" } }, mockContext),
    ).rejects.toThrow();
  });
});

// ─── Mutation.deleteProduct ─────────────────────────────────────────

describe("Product Resolver - Mutation.deleteProduct", () => {
  const resolver = productResolvers.Mutation.deleteProduct;

  it("should delete a product", async () => {
    // deleteProduct uses Product.findOne() then Product.deleteOne()
    Product.findOne.mockResolvedValue({ _id: "prod-1", workspaceId });
    Product.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await resolver(null, { id: "prod-1" }, mockContext);

    expect(result).toBe(true);
    expect(Product.deleteOne).toHaveBeenCalled();
  });

  it("should throw NOT_FOUND when product does not exist", async () => {
    Product.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: "nonexistent" }, mockContext),
    ).rejects.toThrow();
  });
});
