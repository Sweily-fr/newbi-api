/**
 * Routes REST bancaires : comptes, soldes et transactions suivent les mêmes
 * pages que les requêtes GraphQL.
 *
 * GET /banking/accounts et /banking/transactions ne vérifiaient que
 * l'appartenance à l'espace : un rôle sans Transactions ni page de Pilotage
 * listait comptes, soldes et transactions, que GraphQL lui refusait.
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

const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    betterAuthJWTMiddleware: async () => auth.user,
  };
});
// Cache bancaire simulé : la donnée renvoyée si les droits passent
vi.mock("../../src/services/banking/BankingCacheService.js", () => ({
  bankingCacheService: {
    TTL: { accounts: 60, transactions: 60 },
    getAccounts: async () => ({ fromCache: true, data: [{ id: "compte" }] }),
    getTransactions: async () => ({
      fromCache: true,
      data: { transactions: [{ id: "transaction" }] },
    }),
  },
}));
vi.mock("../../src/services/banking/BankingService.js", () => ({
  bankingService: {},
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import bankingRoutes from "../../src/routes/banking.js";

const workspaceId = buildOrganizationId();
const member = buildUserId();
const ROLE = "role_banque_rest";

let server;
let baseUrl;

const get = (path) =>
  fetch(`${baseUrl}/banking${path}`, {
    headers: { "x-workspace-id": String(workspaceId) },
  });

async function grantActions(actions) {
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne(
      { organizationId: workspaceId, role: ROLE },
      { $set: { actions } },
    );
  invalidateOrganizationRoles();
  invalidateOrgCache();
}

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/banking", bankingRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: ROLE,
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Banque REST",
    permission: "{}",
    actions: {},
    createdAt: new Date(),
  });
  invalidateOrganizationRoles();
  invalidateOrgCache();
  auth.user = { _id: member, id: String(member), email: "m@test.fr" };
});

describe("routes REST bancaires", () => {
  it("refusent comptes et transactions sans page qui les affiche", async () => {
    await grantActions({ invoices: ["view"] });
    expect((await get("/accounts")).status).toBe(403);
    expect((await get("/transactions")).status).toBe(403);
  });

  it("comptes lisibles depuis la Prévision ou les Applications, transactions non", async () => {
    await grantActions({ forecast: ["view"] });
    expect((await get("/accounts")).status).toBe(200);
    expect((await get("/transactions")).status).toBe(403);

    await grantActions({ integrations: ["view"] });
    expect((await get("/accounts")).status).toBe(200);
  });

  it("tout est lisible avec Transactions", async () => {
    await grantActions({ banking: ["view"] });
    expect((await get("/accounts")).status).toBe(200);
    expect((await get("/transactions")).status).toBe(200);
  });
});
