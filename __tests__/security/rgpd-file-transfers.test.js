/**
 * RGPD : transferts de fichiers et documents partagés.
 *
 * L'export et la suppression filtraient les transferts sur un champ
 * createdBy absent du modèle (l'auteur est userId) : l'export n'en
 * contenait aucun, la suppression n'en retirait aucun. Les étiquettes des
 * documents partagés restaient aussi après la suppression de l'espace.
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
  process.env.SMTP_ENCRYPTION_KEY =
    process.env.SMTP_ENCRYPTION_KEY || "a".repeat(64);
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
});

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    signatureBucketName: "signatures-test",
    client: {
      send: vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false }),
    },
  },
}));
const r2 = vi.hoisted(() => ({
  deleteFiles: vi.fn(async (keys) => ({ deleted: keys.length, errors: 0 })),
}));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: r2,
}));

import mongoose from "mongoose";
import { clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { startReplicaSet } from "../helpers/numberingSimulation.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import User from "../../src/models/User.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import Notification from "../../src/models/Notification.js";
import { deleteUserAccount, exportUserData } from "../../src/services/rgpd.js";

const leaver = buildUserId();
const colleague = buildUserId();
const org = buildOrganizationId();
const db = () => mongoose.connection.db;

const transfert = (userId, key, workspaceId = org) =>
  FileTransfer.create({
    userId,
    workspaceId,
    shareLink: `lien-${new mongoose.Types.ObjectId()}`,
    accessKey: "k".repeat(32),
    files: [
      {
        originalName: "plan.pdf",
        fileName: "plan.pdf",
        filePath: `https://transferts.example/${key}`,
        r2Key: key,
        mimeType: "application/pdf",
        size: 10,
        storageType: "r2",
      },
    ],
    totalSize: 10,
    expiryDate: new Date(Date.now() + 86_400_000),
    status: "active",
  });

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("rgpd_transfers");
  await Promise.all([User, FileTransfer, Notification].map((M) => M.init()));
  await db().createCollection("downloadevents").catch(() => {});
  await db().createCollection("sharedtags").catch(() => {});
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  r2.deleteFiles.mockClear();
  for (const [_id, email] of [
    [leaver, "leaver@test.fr"],
    [colleague, "colleague@test.fr"],
  ]) {
    await User.collection.insertOne({ _id, email, createdAt: new Date() });
  }
});

describe("Export RGPD", () => {
  it("contient les transferts de l'utilisateur, pas ceux d'un collègue", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await seedOrgMembership({ userId: colleague, organizationId: org });
    const a = await transfert(leaver, "prod/a.pdf");
    const b = await transfert(leaver, "prod/b.pdf");
    const c = await transfert(colleague, "prod/c.pdf");

    const exported = await exportUserData(String(leaver), String(org));
    const json = JSON.stringify(exported);

    expect(json).toContain(String(a._id));
    expect(json).toContain(String(b._id));
    expect(json).not.toContain(String(c._id));
  });
});

describe("Suppression RGPD", () => {
  it("retire ses transferts, leurs fichiers R2 et leurs téléchargements ; ceux d'un collègue restent", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await seedOrgMembership({ userId: colleague, organizationId: org });
    const a = await transfert(leaver, "prod/a.pdf");
    await transfert(leaver, "prod/b.pdf");
    const c = await transfert(colleague, "prod/c.pdf");
    await db()
      .collection("downloadevents")
      .insertMany([
        { transferId: a._id, ipAddress: "1.2.3.4", createdAt: new Date() },
        { transferId: c._id, ipAddress: "5.6.7.8", createdAt: new Date() },
      ]);

    const summary = await deleteUserAccount(String(leaver), String(org));

    expect(summary.fileTransfersDeleted).toBe(2);
    expect(await FileTransfer.countDocuments({ userId: leaver })).toBe(0);
    expect(await FileTransfer.countDocuments({ _id: c._id })).toBe(1);
    const cles = r2.deleteFiles.mock.calls.flatMap(([keys]) => keys);
    expect(cles).toEqual(expect.arrayContaining(["prod/a.pdf", "prod/b.pdf"]));
    expect(cles).not.toContain("prod/c.pdf");
    expect(
      await db().collection("downloadevents").countDocuments({ transferId: a._id }),
    ).toBe(0);
    expect(
      await db().collection("downloadevents").countDocuments({ transferId: c._id }),
    ).toBe(1);
  });

  it("dernier membre : documents, dossiers et étiquettes partagés de l'espace supprimés", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await db().collection("shareddocuments").insertOne({ workspaceId: org, name: "a.pdf" });
    await db().collection("sharedfolders").insertOne({ workspaceId: org, name: "RH" });
    await db().collection("sharedtags").insertOne({ workspaceId: org, name: "urgent" });

    const summary = await deleteUserAccount(String(leaver), String(org));

    expect(summary.organizationDeleted).toBe(true);
    for (const name of ["shareddocuments", "sharedfolders", "sharedtags"]) {
      expect(
        await db().collection(name).countDocuments({ workspaceId: org }),
        `${name} doit être supprimé`,
      ).toBe(0);
    }
  });
});
