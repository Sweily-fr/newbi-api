/**
 * Contrôle d'abonnement des routes REST (requireActiveSubscriptionREST) :
 * l'abonnement contrôlé est celui de l'espace que lit le handler.
 *
 * Le middleware lisait x-workspace-id puis le corps, alors que les routes
 * de rapprochement lisent x-workspace-id puis ?workspaceId : avec
 * ?workspaceId=<son espace sans abonnement> et un corps citant un espace
 * abonné (celui d'un autre), le contrôle passait et le handler agissait
 * sur l'espace sans abonnement.
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

// Utilisateur de la requête (session simulée)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    betterAuthJWTMiddleware: async () => auth.user,
  };
});

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
  requireActiveSubscriptionREST,
} from "../../src/middlewares/rbac.js";
import { requireWorkspaceMembership } from "../../src/middlewares/require-workspace-membership.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Transaction from "../../src/models/Transaction.js";
import reconciliationRoutes from "../../src/routes/reconciliation.js";

const user = buildUserId();
const unpaidOrg = buildOrganizationId(); // espace de l'utilisateur, sans abonnement
const paidOrg = buildOrganizationId(); // espace de l'utilisateur, abonné
const otherUser = buildUserId();
const otherPaidOrg = buildOrganizationId(); // espace abonné d'un autre client

let server;
let baseUrl;

const seedTransaction = async (workspaceId) => {
  const _id = new mongoose.Types.ObjectId();
  await Transaction.collection.insertOne({
    _id,
    workspaceId: String(workspaceId),
    amount: -42,
    description: "Paiement",
    reconciliationStatus: "unmatched",
    createdAt: new Date(),
  });
  return _id;
};

const ignore = (query, body) =>
  fetch(`${baseUrl}/reconciliation/ignore?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/reconciliation", reconciliationRoutes);
  // Route type banking-sync : appartenance puis abonnement
  app.post(
    "/espace",
    requireWorkspaceMembership,
    requireActiveSubscriptionREST(),
    (req, res) =>
      res.json({ workspaceId: req.headers["x-workspace-id"] || null }),
  );
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
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  auth.user = { _id: user, id: String(user), email: "u@test.fr" };
  await seedOrgMembership({
    userId: user,
    organizationId: unpaidOrg,
    subscriptionStatus: null,
  });
  await seedOrgMembership({ userId: user, organizationId: paidOrg });
  await seedOrgMembership({ userId: otherUser, organizationId: otherPaidOrg });
});

describe("Rapprochement : abonnement de l'espace lu par le handler", () => {
  it("?workspaceId=<espace sans abonnement> + corps citant un espace abonné : refusé", async () => {
    const transactionId = await seedTransaction(unpaidOrg);

    const res = await ignore(`workspaceId=${unpaidOrg}`, {
      workspaceId: String(otherPaidOrg),
      transactionId: String(transactionId),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("SUBSCRIPTION_READ_ONLY");
    const after = await Transaction.collection.findOne({ _id: transactionId });
    expect(after.reconciliationStatus).toBe("unmatched");
  });

  it("?workspaceId=<espace abonné> : accepté", async () => {
    const transactionId = await seedTransaction(paidOrg);

    const res = await ignore(`workspaceId=${paidOrg}`, {
      transactionId: String(transactionId),
    });

    expect(res.status).toBe(200);
    const after = await Transaction.collection.findOne({ _id: transactionId });
    expect(after.reconciliationStatus).toBe("ignored");
  });
});

describe("Routes avec requireWorkspaceMembership : espace validé", () => {
  it("x-organization-id de son espace sans abonnement + corps citant un espace abonné : refusé", async () => {
    const res = await fetch(`${baseUrl}/espace`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-organization-id": String(unpaidOrg),
      },
      body: JSON.stringify({ workspaceId: String(otherPaidOrg) }),
    });
    expect(res.status).toBe(403);
  });

  it("espace abonné validé : accepté, et c'est celui que lit le handler", async () => {
    const res = await fetch(`${baseUrl}/espace?workspaceId=${unpaidOrg}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-organization-id": String(paidOrg),
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).workspaceId).toBe(String(paidOrg));
  });
});
