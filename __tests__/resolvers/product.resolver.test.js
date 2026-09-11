import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildProductInput,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Product from "../../src/models/Product.js";
import productResolvers from "../../src/resolvers/product.js";

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

const insertProduct = (overrides = {}) =>
  Product.create({
    ...buildProductInput(),
    workspaceId: organizationId,
    createdBy: userId,
    ...overrides,
  });

describe("Product Resolver - Query.product", () => {
  const resolver = productResolvers.Query.product;

  it("returns a product by id", async () => {
    const product = await insertProduct({ name: "Audit SEO" });

    const result = await resolver(
      null,
      { id: product._id.toString(), workspaceId: organizationId.toString() },
      ctx(),
    );

    expect(result.name).toBe("Audit SEO");
  });

  it("throws NOT_FOUND when product does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(
        null,
        { id: fakeId, workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé|Produit/i);
  });

  it("does not leak products across workspaces", async () => {
    const otherOrg = buildOrganizationId();
    const product = await Product.create({
      ...buildProductInput(),
      workspaceId: otherOrg,
      createdBy: userId,
    });

    await expect(
      resolver(
        null,
        { id: product._id.toString(), workspaceId: organizationId.toString() },
        ctx(),
      ),
    ).rejects.toThrow(/non trouvé/i);
  });
});

describe("Product Resolver - Query.products", () => {
  const resolver = productResolvers.Query.products;

  it("returns paginated product list", async () => {
    for (let i = 0; i < 15; i++) {
      await insertProduct({ name: `Product ${String(i).padStart(2, "0")}` });
    }

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx(),
    );

    expect(result.totalCount).toBe(15);
    expect(result.hasNextPage).toBe(true);
    expect(result.products).toHaveLength(10);
  });

  it("applies search filter", async () => {
    await insertProduct({ name: "SEO Audit", reference: "SEO-001" });
    await insertProduct({ name: "Site web vitrine", reference: "WEB-001" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        search: "SEO",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
    expect(result.products[0].name).toBe("SEO Audit");
  });

  it("filters by category", async () => {
    await insertProduct({ name: "Audit", category: "Service" });
    await insertProduct({ name: "Lampe", category: "Product" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        category: "Service",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
    expect(result.products[0].category).toBe("Service");
  });
});

describe("Product Resolver - Mutation.createProduct", () => {
  const resolver = productResolvers.Mutation.createProduct;

  it("creates a product successfully", async () => {
    const input = buildProductInput({
      name: "Audit technique",
      workspaceId: organizationId.toString(),
    });

    const result = await resolver(null, { input }, ctx());

    expect(result.name).toBe("Audit technique");
    const persisted = await Product.findById(result._id);
    expect(persisted).not.toBeNull();
    expect(persisted.workspaceId.toString()).toBe(organizationId.toString());
  });

  it("rejects duplicate product name in same workspace", async () => {
    await insertProduct({ name: "Existing Product" });

    const input = buildProductInput({
      name: "Existing Product",
      workspaceId: organizationId.toString(),
    });
    await expect(resolver(null, { input }, ctx())).rejects.toThrow();
  });

  it("allows the same name in a different workspace", async () => {
    const otherUser = buildUserId();
    const otherOrg = buildOrganizationId();
    await seedOrgMembership({ userId: otherUser, organizationId: otherOrg });

    await insertProduct({ name: "Shared Name" });

    const otherCtx = buildContext({
      userId: otherUser,
      organizationId: otherOrg,
    });
    const input = buildProductInput({
      name: "Shared Name",
      workspaceId: otherOrg.toString(),
    });

    await expect(resolver(null, { input }, otherCtx)).resolves.toBeDefined();
  });
});

describe("Product Resolver - Mutation.updateProduct", () => {
  const resolver = productResolvers.Mutation.updateProduct;

  it("updates a product", async () => {
    const product = await insertProduct({ name: "Old Name", unitPrice: 1000 });

    const result = await resolver(
      null,
      {
        id: product._id.toString(),
        input: { name: "Updated", unitPrice: 3000 },
      },
      ctx(),
    );

    expect(result.name).toBe("Updated");
    expect(result.unitPrice).toBe(3000);
  });

  it("throws NOT_FOUND when product does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(null, { id: fakeId, input: { name: "X" } }, ctx()),
    ).rejects.toThrow(/non trouvé|Produit/i);
  });
});

describe("Product Resolver - Mutation.deleteProduct (RBAC enforced)", () => {
  const resolver = productResolvers.Mutation.deleteProduct;

  it("deletes a product", async () => {
    const product = await insertProduct();

    const result = await resolver(null, { id: product._id.toString() }, ctx());

    expect(result).toBe(true);
    expect(await Product.findById(product._id)).toBeNull();
  });

  it("throws NOT_FOUND when product does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      /non trouvé|Produit/i,
    );
  });

  it("blocks viewer role from deleting", async () => {
    const viewerUserId = buildUserId();
    const viewerOrg = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrg,
      role: "viewer",
    });
    const product = await Product.create({
      ...buildProductInput(),
      workspaceId: viewerOrg,
      createdBy: viewerUserId,
    });

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrg,
    });

    await expect(
      resolver(null, { id: product._id.toString() }, viewerCtx),
    ).rejects.toThrow(/permission|delete/i);
  });
});

describe("Product Resolver - produits liés", () => {
  const create = productResolvers.Mutation.createProduct;
  const update = productResolvers.Mutation.updateProduct;
  const remove = productResolvers.Mutation.deleteProduct;
  const typeResolver = productResolvers.Product.linkedProducts;

  it("stores linked products on create and resolves them with their product", async () => {
    const enduit = await insertProduct({ name: "Enduit" });
    const poncage = await insertProduct({ name: "Ponçage" });

    const peinture = await create(
      null,
      {
        input: {
          ...buildProductInput({ name: "Peinture" }),
          workspaceId: organizationId.toString(),
          linkedProducts: [
            { productId: enduit._id.toString(), quantity: 2 },
            {
              productId: poncage._id.toString(),
              quantity: 1,
              per: 20,
              rounding: "NONE",
            },
            // doublon : ignoré, la première quantité gagne
            { productId: enduit._id.toString(), quantity: 99 },
          ],
        },
      },
      ctx(),
    );

    expect(peinture.linkedProducts).toHaveLength(2);

    const resolved = await typeResolver(peinture);
    expect(resolved.map((l) => l.product.name)).toEqual(["Enduit", "Ponçage"]);
    expect(resolved.map((l) => l.quantity)).toEqual([2, 1]);
    // per et rounding par défaut : 1 et UP
    expect(resolved.map((l) => l.per)).toEqual([1, 20]);
    expect(resolved.map((l) => l.rounding)).toEqual(["UP", "NONE"]);
  });

  it("rejects a non-positive base (per) and an unknown rounding", async () => {
    const peinture = await insertProduct({ name: "Peinture" });
    const enduit = await insertProduct({ name: "Enduit" });

    await expect(
      update(
        null,
        {
          id: peinture._id.toString(),
          input: {
            linkedProducts: [
              { productId: enduit._id.toString(), quantity: 1, per: 0 },
            ],
          },
        },
        ctx(),
      ),
    ).rejects.toThrow(/base/);

    await expect(
      update(
        null,
        {
          id: peinture._id.toString(),
          input: {
            linkedProducts: [
              { productId: enduit._id.toString(), quantity: 1, rounding: "X" },
            ],
          },
        },
        ctx(),
      ),
    ).rejects.toThrow(/Arrondi/);
  });

  it("rejects a self link, a non-positive quantity and a product from another workspace", async () => {
    const peinture = await insertProduct({ name: "Peinture" });
    const enduit = await insertProduct({ name: "Enduit" });
    const foreign = await Product.create({
      ...buildProductInput({ name: "Ailleurs" }),
      workspaceId: buildOrganizationId(),
      createdBy: buildUserId(),
    });

    await expect(
      update(
        null,
        {
          id: peinture._id.toString(),
          input: {
            linkedProducts: [{ productId: peinture._id.toString(), quantity: 1 }],
          },
        },
        ctx(),
      ),
    ).rejects.toThrow(/lui-même/);

    await expect(
      update(
        null,
        {
          id: peinture._id.toString(),
          input: {
            linkedProducts: [{ productId: enduit._id.toString(), quantity: 0 }],
          },
        },
        ctx(),
      ),
    ).rejects.toThrow(/supérieure à 0/);

    await expect(
      update(
        null,
        {
          id: peinture._id.toString(),
          input: {
            linkedProducts: [{ productId: foreign._id.toString(), quantity: 1 }],
          },
        },
        ctx(),
      ),
    ).rejects.toThrow(/n'existent pas/);
  });

  it("replaces links on update and keeps them when linkedProducts is omitted", async () => {
    const enduit = await insertProduct({ name: "Enduit" });
    const lessivage = await insertProduct({ name: "Lessivage" });
    const peinture = await insertProduct({
      name: "Peinture",
      linkedProducts: [{ productId: enduit._id, quantity: 1 }],
    });

    const renamed = await update(
      null,
      { id: peinture._id.toString(), input: { name: "Peinture mate" } },
      ctx(),
    );
    expect(renamed.linkedProducts).toHaveLength(1);

    const relinked = await update(
      null,
      {
        id: peinture._id.toString(),
        input: {
          linkedProducts: [{ productId: lessivage._id.toString(), quantity: 3 }],
        },
      },
      ctx(),
    );
    expect(relinked.linkedProducts).toHaveLength(1);
    expect(String(relinked.linkedProducts[0].productId)).toBe(
      lessivage._id.toString(),
    );

    const cleared = await update(
      null,
      { id: peinture._id.toString(), input: { linkedProducts: [] } },
      ctx(),
    );
    expect(cleared.linkedProducts).toHaveLength(0);
  });

  it("removes the link from other products when a linked product is deleted", async () => {
    const enduit = await insertProduct({ name: "Enduit" });
    const poncage = await insertProduct({ name: "Ponçage" });
    const peinture = await insertProduct({
      name: "Peinture",
      linkedProducts: [
        { productId: enduit._id, quantity: 2 },
        { productId: poncage._id, quantity: 1 },
      ],
    });

    await remove(null, { id: enduit._id.toString() }, ctx());

    const reloaded = await Product.findById(peinture._id);
    expect(reloaded.linkedProducts).toHaveLength(1);
    expect(String(reloaded.linkedProducts[0].productId)).toBe(
      poncage._id.toString(),
    );
  });

  it("ignores dangling links when resolving", async () => {
    const peinture = await insertProduct({
      name: "Peinture",
      linkedProducts: [
        { productId: new mongoose.Types.ObjectId(), quantity: 2 },
      ],
    });

    expect(await typeResolver(peinture)).toEqual([]);
  });
});
