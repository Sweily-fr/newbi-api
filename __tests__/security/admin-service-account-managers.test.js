/**
 * Comptes gestionnaires créés depuis newbi-admin (/api/admin-service).
 *
 * newbi-admin n'a qu'un accès en lecture à la base : ses écritures passent
 * par ces routes, protégées par un jeton de service. Fermées si le jeton
 * n'est pas configuré, refusées sans le bon jeton ou sans admin identifié.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import adminServiceRoutes from "../../src/routes/adminService.js";
import AccountManager from "../../src/models/AccountManager.js";

const TOKEN = "t".repeat(40);
const ADMIN = "admin@newbi.fr";
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

async function seedUser(email) {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.db
    .collection("user")
    .insertOne({ _id, email, name: "Sophie Dupont" });
  return _id;
}

beforeAll(async () => {
  await startMongo();
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
  delete process.env.ADMIN_SERVICE_TOKEN_ALT;
});
afterEach(() => {
  delete process.env.ADMIN_SERVICE_TOKEN;
  delete process.env.ADMIN_SERVICE_TOKEN_ALT;
});

describe("accès", () => {
  it("fermé si le jeton n'est pas configuré", async () => {
    delete process.env.ADMIN_SERVICE_TOKEN;
    const res = await call("/account-managers", { body: {} });
    expect(res.status).toBe(503);
  });

  it("fermé si le jeton configuré est trop court", async () => {
    process.env.ADMIN_SERVICE_TOKEN = "court";
    const res = await call("/account-managers", { token: "court", body: {} });
    expect(res.status).toBe(503);
  });

  it("refuse un mauvais jeton ou son absence", async () => {
    expect(
      (await call("/account-managers", { token: "x".repeat(40) })).status,
    ).toBe(401);
    expect((await call("/account-managers", { token: null })).status).toBe(401);
  });

  it("refuse une requête sans admin identifié", async () => {
    const res = await call("/account-managers", { admin: null, body: {} });
    expect(res.status).toBe(400);
  });

  it("accepte le jeton de rotation", async () => {
    process.env.ADMIN_SERVICE_TOKEN_ALT = "a".repeat(40);
    await seedUser("cabinet@dupont.fr");
    const res = await call("/account-managers", {
      token: "a".repeat(40),
      body: { email: "cabinet@dupont.fr", name: "Compta Dupont" },
    });
    expect(res.status).toBe(201);
  });

  it("accepte un jeton configuré avec un espace ou un retour à la ligne final", async () => {
    process.env.ADMIN_SERVICE_TOKEN_ALT = `${"b".repeat(40)}\n`;
    await seedUser("cabinet@dupont.fr");
    const res = await call("/account-managers", {
      token: "b".repeat(40),
      body: { email: "cabinet@dupont.fr", name: "Compta Dupont" },
    });
    expect(res.status).toBe(201);
  });
});

describe("création", () => {
  it("crée le gestionnaire d'un utilisateur existant et le journalise", async () => {
    const userId = await seedUser("cabinet@dupont.fr");
    const res = await call("/account-managers", {
      body: {
        email: "  Cabinet@Dupont.fr ",
        name: " Compta Dupont ",
        discountPercent: "15.5",
      },
    });
    expect(res.status).toBe(201);
    const { accountManager } = await res.json();
    expect(accountManager).toMatchObject({
      userId: String(userId),
      userEmail: "cabinet@dupont.fr",
      name: "Compta Dupont",
      discountPercent: 15.5,
      status: "active",
    });

    const stored = await AccountManager.findById(accountManager.id).lean();
    expect(stored.createdByAdmin).toBe(ADMIN);
    const log = await mongoose.connection.db
      .collection("backoffice_audit_log")
      .findOne({ action: "account_manager_create" });
    expect(log).toMatchObject({
      adminEmail: ADMIN,
      targetEmail: "cabinet@dupont.fr",
    });
  });

  it("refuse une adresse sans compte Newbi", async () => {
    const res = await call("/account-managers", {
      body: { email: "inconnu@x.fr", name: "Cabinet" },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/Aucun compte Newbi/);
  });

  it("refuse un second gestionnaire pour le même utilisateur", async () => {
    await seedUser("cabinet@dupont.fr");
    const body = { email: "cabinet@dupont.fr", name: "Compta Dupont" };
    expect((await call("/account-managers", { body })).status).toBe(201);
    expect((await call("/account-managers", { body })).status).toBe(409);
  });

  it("refuse une remise hors de 0 à 100 et un nom vide", async () => {
    await seedUser("cabinet@dupont.fr");
    const bad = [
      { email: "cabinet@dupont.fr", name: "Cabinet", discountPercent: 150 },
      { email: "cabinet@dupont.fr", name: "Cabinet", discountPercent: -1 },
      { email: "cabinet@dupont.fr", name: "Cabinet", discountPercent: "abc" },
      { email: "cabinet@dupont.fr", name: "   " },
      { email: { $ne: null }, name: "Cabinet" },
    ];
    for (const body of bad) {
      expect((await call("/account-managers", { body })).status).toBe(400);
    }
    expect(await AccountManager.countDocuments()).toBe(0);
  });
});

describe("modification", () => {
  async function createManager() {
    await seedUser("cabinet@dupont.fr");
    const res = await call("/account-managers", {
      body: {
        email: "cabinet@dupont.fr",
        name: "Compta Dupont",
        discountPercent: 10,
      },
    });
    return (await res.json()).accountManager.id;
  }

  it("modifie la remise, le nom et le statut, avec avant/après au journal", async () => {
    const id = await createManager();
    const res = await call(`/account-managers/${id}`, {
      method: "PATCH",
      body: {
        discountPercent: 20,
        name: "Dupont & Associés",
        status: "suspended",
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accountManager).toMatchObject({
      discountPercent: 20,
      name: "Dupont & Associés",
      status: "suspended",
    });
    const log = await mongoose.connection.db
      .collection("backoffice_audit_log")
      .findOne({ action: "account_manager_update" });
    expect(log.before.discountPercent).toBe(10);
    expect(log.after.discountPercent).toBe(20);
  });

  it("refuse un statut inconnu et un id inexistant", async () => {
    const id = await createManager();
    expect(
      (
        await call(`/account-managers/${id}`, {
          method: "PATCH",
          body: { status: "deleted" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`/account-managers/${new mongoose.Types.ObjectId()}`, {
          method: "PATCH",
          body: { discountPercent: 5 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("/account-managers/pas-un-id", { method: "PATCH", body: {} }))
        .status,
    ).toBe(404);
  });
});
