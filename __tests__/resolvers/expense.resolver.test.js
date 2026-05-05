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
import { buildOrganizationId, buildUserId } from "../factories/index.js";

// External side effects we don't want to test here
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: vi.fn().mockResolvedValue(undefined) },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Expense from "../../src/models/Expense.js";
import expenseResolvers from "../../src/resolvers/expense.js";

const ownerUserId = buildUserId();
const organizationId = buildOrganizationId();
const memberUserId = buildUserId();

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({
    userId: ownerUserId,
    organizationId,
    role: "owner",
  });
});

const ownerCtx = () =>
  buildContext({
    userId: ownerUserId,
    organizationId,
    extra: { userRole: "owner" },
  });

async function memberCtx() {
  await seedOrgMembership({
    userId: memberUserId,
    organizationId,
    role: "member",
  });
  return buildContext({
    userId: memberUserId,
    organizationId,
    extra: { userRole: "member" },
  });
}

const insertExpense = (overrides = {}) =>
  Expense.collection.insertOne({
    workspaceId: organizationId,
    createdBy: ownerUserId,
    title: "Facture OVH",
    amount: 119.88,
    amountHT: 99.9,
    vatAmount: 19.98,
    vatRate: 20,
    date: new Date(),
    category: "OTHER",
    status: "PENDING",
    type: "EXPENSE",
    files: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

describe("Expense Resolver - Query.expense", () => {
  const resolver = expenseResolvers.Query.expense;

  it("returns the expense for owner role", async () => {
    const { insertedId } = await insertExpense();
    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ownerCtx(),
    );
    expect(result.title).toBe("Facture OVH");
  });

  it("blocks member from accessing another member's expense", async () => {
    const { insertedId } = await insertExpense({ createdBy: ownerUserId });

    const ctx = await memberCtx();
    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx,
      ),
    ).rejects.toThrow(/non trouvée|autorisé/i);
  });

  it("allows member to access their own expense", async () => {
    const ctx = await memberCtx();
    const { insertedId } = await insertExpense({ createdBy: memberUserId });

    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ctx,
    );
    expect(result.title).toBe("Facture OVH");
  });

  it("throws NOT_FOUND when expense does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(
      resolver(
        null,
        { id: fakeId, workspaceId: organizationId.toString() },
        ownerCtx(),
      ),
    ).rejects.toThrow(/non trouvée/i);
  });
});

describe("Expense Resolver - Query.expenses", () => {
  const resolver = expenseResolvers.Query.expenses;

  it("returns paginated expenses for owner", async () => {
    for (let i = 0; i < 12; i++) {
      await insertExpense({ title: `Expense ${i}` });
    }

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 5 },
      ownerCtx(),
    );

    expect(result.totalCount).toBe(12);
    expect(result.hasNextPage).toBe(true);
    expect(result.expenses).toHaveLength(5);
  });

  it("scopes member to their own expenses", async () => {
    await insertExpense({ createdBy: ownerUserId, title: "Owner expense" });
    await insertExpense({ createdBy: memberUserId, title: "Member expense" });

    const ctx = await memberCtx();
    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx,
    );

    expect(result.totalCount).toBe(1);
    expect(result.expenses[0].title).toBe("Member expense");
  });

  it("filters by status", async () => {
    await insertExpense({ status: "PENDING", title: "P" });
    await insertExpense({ status: "PAID", title: "Pa" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        status: "PAID",
        page: 1,
        limit: 10,
      },
      ownerCtx(),
    );
    expect(result.totalCount).toBe(1);
  });

  it("supports search across title/description/vendor/invoiceNumber", async () => {
    await insertExpense({ title: "Facture OVH", vendor: "OVH" });
    await insertExpense({ title: "Repas client", vendor: "Restaurant" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        search: "OVH",
        page: 1,
        limit: 10,
      },
      ownerCtx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("filters by date range", async () => {
    await insertExpense({ date: new Date("2026-01-15") });
    await insertExpense({ date: new Date("2026-06-15") });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        startDate: "2026-05-01",
        endDate: "2026-12-31",
        page: 1,
        limit: 10,
      },
      ownerCtx(),
    );
    expect(result.totalCount).toBe(1);
  });
});

describe("Expense Resolver - Mutation.deleteExpense", () => {
  const resolver = expenseResolvers.Mutation.deleteExpense;

  it("deletes an expense as owner", async () => {
    const { insertedId } = await insertExpense();

    const result = await resolver(
      null,
      { id: insertedId.toString(), workspaceId: organizationId.toString() },
      ownerCtx(),
    );

    expect(result.success).toBe(true);
    expect(await Expense.collection.findOne({ _id: insertedId })).toBeNull();
  });

  it("blocks member from deleting another member's expense", async () => {
    const { insertedId } = await insertExpense({ createdBy: ownerUserId });

    const ctx = await memberCtx();
    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: organizationId.toString() },
        ctx,
      ),
    ).rejects.toThrow(/permission|autorisé|delete/i);
  });

  it("blocks viewer role from deleting", async () => {
    const viewerUserId = buildUserId();
    const viewerOrg = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrg,
      role: "viewer",
    });
    const { insertedId } = await Expense.collection.insertOne({
      workspaceId: viewerOrg,
      createdBy: viewerUserId,
      title: "X",
      amount: 1,
      date: new Date(),
      category: "OTHER",
      status: "PENDING",
      type: "EXPENSE",
      files: [],
    });

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrg,
      extra: { userRole: "viewer" },
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), workspaceId: viewerOrg.toString() },
        viewerCtx,
      ),
    ).rejects.toThrow(/permission|delete/i);
  });
});
