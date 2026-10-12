/**
 * Purge back-office et comptes gestionnaires (cabinets) : le cabinet qui
 * suit un espace n'en fait pas un espace partagé, et les fiches
 * managedclients (rattachées par managerId / invitedUserId) ne restent pas
 * orphelines.
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
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { previewUserPurge, purgeUser } =
  await import("../../src/services/backofficePurgeService.js");

let db;
const clientId = new mongoose.Types.ObjectId();
const cabinetUserId = new mongoose.Types.ObjectId();
const clientOrg = new mongoose.Types.ObjectId();
const otherOrg = new mongoose.Types.ObjectId();
const managerId = new mongoose.Types.ObjectId();
const otherOwnerId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startMongo();
  db = mongoose.connection.db;
});
afterAll(stopMongo);

beforeEach(async () => {
  await clearMongo();
  await db.collection("user").insertMany([
    { _id: clientId, email: "client@test.fr" },
    { _id: cabinetUserId, email: "cabinet@test.fr" },
    { _id: otherOwnerId, email: "garage@test.fr" },
  ]);
  await db.collection("organization").insertMany([
    { _id: clientOrg, name: "Boulangerie" },
    { _id: otherOrg, name: "Garage" },
  ]);
  await db.collection("member").insertMany([
    { userId: clientId, organizationId: clientOrg, role: "owner" },
    { userId: cabinetUserId, organizationId: clientOrg, role: "accountant" },
    { userId: cabinetUserId, organizationId: otherOrg, role: "accountant" },
    { userId: otherOwnerId, organizationId: otherOrg, role: "owner" },
  ]);
  await db.collection("accountmanagers").insertOne({
    _id: managerId,
    userId: cabinetUserId,
    name: "Compta Dupont",
    status: "active",
  });
  await db.collection("managedclients").insertMany([
    { managerId, organizationId: clientOrg, status: "active", payer: "client" },
    { managerId, organizationId: otherOrg, status: "active", payer: "client" },
  ]);
});

describe("purge d'un client suivi par un cabinet", () => {
  it("l'espace est purgé : le cabinet ne le rend pas partagé", async () => {
    const preview = await previewUserPurge("client@test.fr");
    const org = preview.organizations.find(
      (o) => String(o.organizationId) === String(clientOrg),
    );
    expect(org.fullPurge).toBe(true);
    expect(preview.mongo.managedclients).toBe(1);

    await purgeUser("client@test.fr", { email: "admin@newbi.fr" });

    expect(
      await db.collection("organization").findOne({ _id: clientOrg }),
    ).toBe(null);
    // Plus aucune adhésion ni fiche sur l'espace supprimé
    expect(
      await db
        .collection("member")
        .countDocuments({ organizationId: clientOrg }),
    ).toBe(0);
    expect(
      await db
        .collection("managedclients")
        .countDocuments({ organizationId: clientOrg }),
    ).toBe(0);
    // Le reste du portefeuille du cabinet est intact
    expect(
      await db
        .collection("member")
        .countDocuments({ organizationId: otherOrg }),
    ).toBe(2);
    expect(await db.collection("accountmanagers").countDocuments()).toBe(1);
  });
});

describe("purge d'un cabinet", () => {
  it("ses fiches clients et les invitations qu'il a reçues disparaissent", async () => {
    await db.collection("managedclients").insertOne({
      managerId: new mongoose.Types.ObjectId(),
      organizationId: null,
      status: "pending",
      invitedUserId: cabinetUserId,
    });

    await purgeUser("cabinet@test.fr", { email: "admin@newbi.fr" });

    expect(await db.collection("managedclients").countDocuments()).toBe(0);
    expect(await db.collection("accountmanagers").countDocuments()).toBe(0);
    // Les espaces des clients ne sont pas touchés
    expect(await db.collection("organization").countDocuments()).toBe(2);
    expect(
      await db.collection("member").countDocuments({ userId: clientId }),
    ).toBe(1);
  });
});
