/**
 * Nombre de banques connectées de l'offre (Freelance 1, TPE 3, Entreprise
 * 5), appliqué par l'API à la demande d'une URL de connexion Bridge : le site
 * grise le bouton, mais l'application mobile et un appel direct passent par
 * GET /banking-connect/bridge/connect. Le refus précède tout appel à Bridge.
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
const bridge = vi.hoisted(() => ({ initialized: 0, urls: 0 }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, betterAuthJWTMiddleware: async () => auth.user };
});
vi.mock("../../src/services/banking/index.js", () => ({
  bankingService: {
    initialize: async () => {
      bridge.initialized += 1;
    },
    currentProvider: {
      config: { environment: "sandbox" },
      getBridgeUserByExternalId: async () => null,
      generateConnectUrl: async () => {
        bridge.urls += 1;
        return "https://connect.bridge.test/session";
      },
    },
  },
}));
vi.mock("../../src/services/banking/BankingCacheService.js", () => ({
  bankingCacheService: { invalidateAll: async () => {} },
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import bankingConnectRoutes from "../../src/routes/banking-connect.js";

const { ObjectId } = mongoose.Types;
const workspaceId = buildOrganizationId();
const ws = String(workspaceId);
const owner = buildUserId();

let server;
let baseUrl;

const connect = (query = "") =>
  fetch(`${baseUrl}/banking-connect/bridge/connect${query}`, {
    headers: { "x-workspace-id": ws },
  });

const setPlan = (plan) =>
  mongoose.connection.db
    .collection("subscription")
    .updateOne({ referenceId: ws }, { $set: { plan } });

let n = 0;
const account = (extra = {}) => {
  n += 1;
  return {
    _id: new ObjectId(),
    externalId: `limite-${n}`,
    provider: "bridge",
    name: `Compte ${n}`,
    type: "checking",
    status: "active",
    balance: 100,
    currency: "EUR",
    workspaceId: ws,
    ...extra,
  };
};

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/banking-connect", bankingConnectRoutes);
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
  bridge.initialized = 0;
  bridge.urls = 0;
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  auth.user = {
    _id: owner,
    id: String(owner),
    email: "owner@test.fr",
    emailVerified: true,
  };
});

describe("GET /banking-connect/bridge/connect : banques de l'offre", () => {
  it("Freelance avec une banque connectée : refus avant tout appel à Bridge", async () => {
    await setPlan("freelance");
    await AccountBanking.collection.insertOne(account());

    for (const query of ["", "?source=mobile"]) {
      const res = await connect(query);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error:
          "Votre offre n'autorise qu'une banque connectée. Passez à l'offre TPE pour en connecter davantage.",
        code: "BANK_CONNECTION_LIMIT",
      });
    }
    expect(bridge.initialized).toBe(0);
    expect(bridge.urls).toBe(0);
  });

  it("Freelance sans banque, ou dont la banque est déconnectée : URL générée", async () => {
    await setPlan("freelance");
    let res = await connect();
    expect(res.status).toBe(200);
    expect((await res.json()).connectUrl).toBe(
      "https://connect.bridge.test/session",
    );

    await AccountBanking.collection.insertOne(
      account({ status: "disconnected", disconnectedAt: new Date() }),
    );
    res = await connect();
    expect(res.status).toBe(200);
    expect(bridge.urls).toBe(2);
  });

  it("TPE : plusieurs comptes d'une même connexion comptent pour une banque", async () => {
    await setPlan("pme");
    await AccountBanking.collection.insertMany([
      account({ raw: { item_id: 11 } }),
      account({ raw: { item_id: 11 } }),
      account({ raw: { item_id: 12 } }),
    ]);
    const res = await connect();
    expect(res.status).toBe(200);
  });

  it("TPE avec trois banques connectées : refus", async () => {
    await setPlan("pme");
    await AccountBanking.collection.insertMany([
      account({ raw: { item_id: 21 } }),
      account({ raw: { item_id: 22 } }),
      account({ raw: { provider_id: 574, item_id: 23 } }),
    ]);
    const res = await connect();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("BANK_CONNECTION_LIMIT");
    expect(body.error).toBe(
      "Votre offre n'autorise pas plus de 3 banques connectées. Passez à l'offre Entreprise pour en connecter davantage.",
    );
    expect(bridge.initialized).toBe(0);
  });

  it("Entreprise : cinq banques, la sixième est refusée", async () => {
    await setPlan("entreprise");
    await AccountBanking.collection.insertMany(
      [31, 32, 33, 34].map((item_id) => account({ raw: { item_id } })),
    );
    expect((await connect()).status).toBe(200);

    await AccountBanking.collection.insertOne(
      account({ raw: { item_id: 35 } }),
    );
    const res = await connect();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Votre offre n'autorise pas plus de 5 banques connectées.",
    );
  });

  it("les comptes d'un autre espace ne comptent pas", async () => {
    await setPlan("freelance");
    await AccountBanking.collection.insertOne(
      account({ workspaceId: String(buildOrganizationId()) }),
    );
    expect((await connect()).status).toBe(200);
  });
});
