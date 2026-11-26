/**
 * Crédits de prospection vus et ajustés depuis newbi-admin
 * (/api/admin-service/prospect-credits).
 *
 * newbi-admin n'a qu'un accès en lecture à la base : la liste (solde calculé
 * par l'API, comme pour le client) et les ajustements passent par ces
 * routes, protégées par le jeton de service ; l'admin identifié est gardé
 * sur chaque ajustement.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

// Aucun appel au fournisseur : stock illisible
vi.mock(
  "../../src/services/prospects/societeinfoClient.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    isSocieteinfoConfigured: vi.fn(() => false),
    getKeyInfo: vi.fn(),
  }),
);

import adminServiceRoutes from "../../src/routes/adminService.js";
import ProspectCreditAdjustment from "../../src/models/ProspectCreditAdjustment.js";

const TOKEN = "t".repeat(40);
const ADMIN = "admin@newbi.fr";
const workspaceId = new mongoose.Types.ObjectId().toString();
let server;
let baseUrl;

function call(
  path,
  { method = "POST", body, token = TOKEN, admin = ADMIN } = {},
) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (admin) headers["x-admin-email"] = admin;
  return fetch(`${baseUrl}/api/admin-service${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const ajuster = (body, options = {}) =>
  call(`/prospect-credits/${workspaceId}/adjustments`, { body, ...options });

beforeAll(async () => {
  await startMongo();
  await ProspectCreditAdjustment.init();
  const app = express();
  app.use(express.json());
  app.use("/api/admin-service", adminServiceRoutes);
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
  process.env.ADMIN_SERVICE_TOKEN = TOKEN;
  const db = mongoose.connection.db;
  await db.collection("organization").insertOne({
    _id: new mongoose.Types.ObjectId(workspaceId),
    name: "Menuiserie Dupont",
  });
  await db.collection("subscription").insertOne({
    referenceId: workspaceId,
    plan: "pme",
    status: "active",
    periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });
});
afterEach(() => {
  delete process.env.ADMIN_SERVICE_TOKEN;
});

describe("accès", () => {
  it("refuse sans le bon jeton, en lecture comme en écriture", async () => {
    expect(
      (await call("/prospect-credits", { method: "GET", token: null })).status,
    ).toBe(401);
    expect(
      (
        await ajuster(
          { balance: 40, reason: "Test" },
          { token: "x".repeat(40) },
        )
      ).status,
    ).toBe(401);
    expect(await ProspectCreditAdjustment.countDocuments()).toBe(0);
  });

  it("refuse un ajustement sans admin identifié", async () => {
    const res = await ajuster({ balance: 40, reason: "Test" }, { admin: null });
    expect(res.status).toBe(400);
    expect(await ProspectCreditAdjustment.countDocuments()).toBe(0);
  });
});

describe("liste", () => {
  it("renvoie les organisations abonnées avec leur solde", async () => {
    const res = await call("/prospect-credits", { method: "GET" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.workspaces).toEqual([
      expect.objectContaining({
        workspaceId,
        subscription: expect.objectContaining({ plan: "pme" }),
        balance: expect.objectContaining({
          monthlyCredits: 30,
          monthlyUsed: 0,
          purchasedRemaining: 0,
          purchasedPending: 0,
          available: 30,
        }),
        pendingOrders: [],
      }),
    ]);
    expect(data.provider).toMatchObject({ configured: false, stock: null });
  });
});

describe("ajustement", () => {
  it("enregistre la différence avec l'admin et le motif", async () => {
    const res = await ajuster({
      balance: 45,
      reason: "  Geste commercial  ",
      expectedBalance: 30,
    });
    expect(res.status).toBe(201);
    const { adjustment, balance } = await res.json();
    expect(adjustment).toMatchObject({
      workspaceId,
      credits: 15,
      balanceBefore: 30,
      balanceAfter: 45,
      reason: "Geste commercial",
      adminEmail: ADMIN,
    });
    expect(balance.available).toBe(45);
  });

  it("explique les refus : solde négatif, motif absent, organisation inconnue, solde changé", async () => {
    const negatif = await ajuster({ balance: -5, reason: "Correction" });
    expect(negatif.status).toBe(400);
    expect((await negatif.json()).error).toMatch(/négatif/);

    const sansMotif = await ajuster({ balance: 10 });
    expect(sansMotif.status).toBe(400);
    expect((await sansMotif.json()).error).toMatch(/motif/);

    const inconnue = await call(
      `/prospect-credits/${new mongoose.Types.ObjectId()}/adjustments`,
      { body: { balance: 10, reason: "Correction" } },
    );
    expect(inconnue.status).toBe(404);

    const change = await ajuster({
      balance: 10,
      reason: "Correction",
      expectedBalance: 12,
    });
    expect(change.status).toBe(409);
    expect((await change.json()).error).toMatch(/30 crédits/);

    expect(await ProspectCreditAdjustment.countDocuments()).toBe(0);
  });
});
