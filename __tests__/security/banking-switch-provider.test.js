/**
 * POST /banking/admin/switch-provider : la requête aboutissait jamais
 * (middleware d'authentification monté comme middleware Express, sans
 * next). Elle répond désormais, et n'est ouverte qu'aux administrateurs du
 * back-office.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, betterAuthJWTMiddleware: async () => auth.user };
});
const banking = vi.hoisted(() => ({ switchProvider: vi.fn(async () => {}) }));
vi.mock("../../src/services/banking/BankingService.js", () => ({
  bankingService: banking,
}));
vi.mock("../../src/services/banking/BankingCacheService.js", () => ({
  bankingCacheService: {},
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import bankingRoutes from "../../src/routes/banking.js";

let server;
let baseUrl;
const adminId = new mongoose.Types.ObjectId();
const autreId = new mongoose.Types.ObjectId();

const post = () =>
  fetch(`${baseUrl}/banking/admin/switch-provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "mock" }),
    signal: AbortSignal.timeout(5000),
  });

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
  banking.switchProvider.mockClear();
  process.env.BACKOFFICE_ADMIN_USER_IDS = String(adminId);
  await mongoose.connection.db.collection("user").insertMany([
    { _id: adminId, email: "admin@sweily.fr" },
    { _id: autreId, email: "client@exemple.fr", role: "admin" },
  ]);
});

describe("POST /banking/admin/switch-provider", () => {
  it("sans session : 401, sans attendre indéfiniment", async () => {
    auth.user = null;
    expect((await post()).status).toBe(401);
    expect(banking.switchProvider).not.toHaveBeenCalled();
  });

  it("compte au rôle « admin » hors back-office : 403", async () => {
    auth.user = { _id: autreId, role: "admin" };
    expect((await post()).status).toBe(403);
    expect(banking.switchProvider).not.toHaveBeenCalled();
  });

  it("administrateur du back-office : changement fait", async () => {
    auth.user = { _id: adminId };
    expect((await post()).status).toBe(200);
    expect(banking.switchProvider).toHaveBeenCalledWith("mock");
  });
});
