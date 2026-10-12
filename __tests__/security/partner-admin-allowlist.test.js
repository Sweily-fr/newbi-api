/**
 * Administration du programme partenaire et du nettoyage des transferts :
 * liste blanche par id, plus le domaine de l'e-mail.
 *
 * getAllWithdrawals, approveWithdrawal, rejectWithdrawal et les routes
 * /api/admin/cleanup/* reconnaissaient l'administrateur à son e-mail
 * @sweily.fr ou @newbi.fr. L'inscription ne vérifie pas l'adresse : un compte
 * x@newbi.fr créé par n'importe qui lisait tous les retraits (IBAN, noms,
 * soldes) et les validait ou les refusait.
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

vi.hoisted(() => {
  process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-partner-admin";
});

const jobs = vi.hoisted(() => ({
  cleanupExpiredFiles: null,
  markExpiredTransfersAndDeleteR2: null,
  deleteExpiredLocalFiles: null,
}));
vi.mock("../../src/jobs/cleanupExpiredFiles.js", () => {
  jobs.cleanupExpiredFiles = vi.fn(async () => ({
    markedCount: 0,
    deletedResult: {
      localFiles: 0,
      r2Files: 0,
      failed: 0,
      total: 0,
      totalSizeMB: "0",
    },
  }));
  jobs.markExpiredTransfersAndDeleteR2 = vi.fn(async () => ({
    markedCount: 0,
  }));
  jobs.deleteExpiredLocalFiles = vi.fn(async () => ({
    deletedFiles: 0,
    failedDeletions: 0,
    freedBytes: 0,
  }));
  return { ...jobs };
});

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserId } from "../factories/index.js";
import Withdrawal from "../../src/models/Withdrawal.js";
import partnerResolvers from "../../src/resolvers/partner.js";
import cleanupAdminRoutes from "../../src/routes/cleanupAdmin.js";

const Q = partnerResolvers.Query;
const M = partnerResolvers.Mutation;

const db = () => mongoose.connection.db;
const as = (userId, email) => ({
  user: { _id: userId, id: String(userId), email },
});

const insertUser = async (email) => {
  const _id = buildUserId();
  await db()
    .collection("user")
    .insertOne({ _id, email, name: email, createdAt: new Date() });
  return _id;
};

let pirateId; // s'est inscrit avec une adresse @newbi.fr sans la vérifier
let adminId; // administrateur listé dans BACKOFFICE_ADMIN_USER_IDS
let withdrawalId;

// Session simulée pour les routes REST (validateJWT pose req.user = id)
let requestUser = null;
let server;
let baseUrl;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use((req, _res, next) => {
    req.user = requestUser;
    next();
  });
  app.use("/api/admin", cleanupAdminRoutes);
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
  vi.clearAllMocks();
  pirateId = await insertUser("pirate@newbi.fr");
  adminId = await insertUser("admin@sweily.fr");
  process.env.BACKOFFICE_ADMIN_USER_IDS = String(adminId);
  const partnerId = await insertUser("partenaire@exemple.fr");
  const withdrawal = await Withdrawal.create({
    partnerId,
    amount: 120,
    method: "bank_transfer",
    bankDetails: {
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPP",
      accountHolder: "Partenaire",
    },
  });
  withdrawalId = withdrawal._id.toString();
});

describe("retraits des partenaires (GraphQL)", () => {
  it("getAllWithdrawals refuse un compte @newbi.fr hors liste blanche", async () => {
    await expect(
      Q.getAllWithdrawals(null, {}, as(pirateId, "pirate@newbi.fr")),
    ).rejects.toThrow(/administrateurs/);
  });

  it("approveWithdrawal refuse un compte @newbi.fr hors liste blanche", async () => {
    await expect(
      M.approveWithdrawal(
        null,
        { withdrawalId },
        as(pirateId, "pirate@newbi.fr"),
      ),
    ).rejects.toThrow(/administrateurs/);
    expect((await Withdrawal.findById(withdrawalId)).status).toBe("pending");
  });

  it("rejectWithdrawal refuse un compte @newbi.fr hors liste blanche", async () => {
    await expect(
      M.rejectWithdrawal(
        null,
        { withdrawalId, reason: "test" },
        as(pirateId, "pirate@newbi.fr"),
      ),
    ).rejects.toThrow(/administrateurs/);
    expect((await Withdrawal.findById(withdrawalId)).status).toBe("pending");
  });

  it("tout est refusé quand la liste blanche n'est pas configurée", async () => {
    delete process.env.BACKOFFICE_ADMIN_USER_IDS;
    await expect(
      Q.getAllWithdrawals(null, {}, as(adminId, "admin@sweily.fr")),
    ).rejects.toThrow(/administrateurs/);
  });

  it("l'administrateur de la liste blanche lit et traite les retraits", async () => {
    const list = await Q.getAllWithdrawals(
      null,
      {},
      as(adminId, "admin@sweily.fr"),
    );
    expect(list).toHaveLength(1);
    expect(list[0].bankDetails.iban).toBe("FR7630006000011234567890189");

    const result = await M.approveWithdrawal(
      null,
      { withdrawalId },
      as(adminId, "admin@sweily.fr"),
    );
    expect(result.withdrawal.status).toBe("completed");
  });
});

describe("routes /api/admin/cleanup", () => {
  const run = () =>
    fetch(`${baseUrl}/api/admin/cleanup/run`, { method: "POST" });

  it("refuse un compte @newbi.fr hors liste blanche", async () => {
    requestUser = String(pirateId);
    const res = await run();
    expect(res.status).toBe(403);
    expect(jobs.cleanupExpiredFiles).not.toHaveBeenCalled();
  });

  it("accepte l'administrateur de la liste blanche", async () => {
    requestUser = String(adminId);
    const res = await run();
    expect(res.status).toBe(200);
    expect(jobs.cleanupExpiredFiles).toHaveBeenCalledTimes(1);
  });
});
