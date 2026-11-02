/**
 * Transferts : espace d'un transfert existant.
 *
 *  - myFileTransfers rattachait en base, au premier espace dont la liste
 *    était ouverte, tous les transferts de l'utilisateur sans espace. Ils
 *    sont désormais listés dans chaque espace, sans être modifiés.
 *  - Lecture, renommage et suppression contrôlaient le rôle dans l'espace
 *    de l'en-tête choisi par le client : un membre en lecture seule dans
 *    l'espace du transfert le supprimait en envoyant l'en-tête d'un espace
 *    où il a tous les droits. Le rôle contrôlé est celui de l'espace du
 *    transfert.
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

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/utils/transferStorage.js", () => ({
  deleteTransferStorage: vi.fn(async () => {}),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";

const { Query, Mutation } = fileTransferResolvers;

let user;
let wsReadOnly;
let wsOwner;

const insertTransfer = async (workspaceId, extra = {}) => {
  const _id = new mongoose.Types.ObjectId();
  await FileTransfer.collection.insertOne({
    _id,
    userId: user,
    shareLink: `link-${_id}`,
    accessKey: `key-${_id}`,
    downloadLink: `dl-${_id}`,
    files: [],
    totalSize: 0,
    expiryDate: new Date(Date.now() + 86400000),
    status: "active",
    createdAt: new Date(),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...extra,
  });
  return _id;
};

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  user = buildUserId();
  wsReadOnly = buildOrganizationId();
  wsOwner = buildOrganizationId();
  await seedOrgMembership({
    userId: user,
    organizationId: wsReadOnly,
    role: "viewer",
  });
  await seedOrgMembership({
    userId: user,
    organizationId: wsOwner,
    role: "owner",
  });
});

describe("myFileTransfers : anciens transferts sans espace", () => {
  it("listés dans l'espace ouvert, jamais modifiés en base", async () => {
    const legacyNull = await insertTransfer(null);
    const legacyMissing = await insertTransfer(undefined);
    const inOwner = await insertTransfer(String(wsOwner));
    const inOther = await insertTransfer(String(wsReadOnly));

    const ctx = buildContext({ userId: user, organizationId: wsOwner });
    const result = await Query.myFileTransfers(
      null,
      { workspaceId: String(wsOwner), page: 1, limit: 10 },
      ctx,
    );
    const ids = result.items.map((t) => String(t._id));
    expect(ids.sort()).toEqual(
      [legacyNull, legacyMissing, inOwner].map(String).sort(),
    );
    expect(ids).not.toContain(String(inOther));

    const relus = await FileTransfer.collection
      .find({ _id: { $in: [legacyNull, legacyMissing] } })
      .toArray();
    expect(relus.find((t) => t._id.equals(legacyNull)).workspaceId).toBeNull();
    expect(
      "workspaceId" in relus.find((t) => t._id.equals(legacyMissing)),
    ).toBe(false);
  });
});

describe("Rôle contrôlé dans l'espace du transfert", () => {
  const headerOf = (ws) => buildContext({ userId: user, organizationId: ws });

  it("lecture seule dans l'espace du transfert : suppression refusée malgré l'en-tête d'un autre espace", async () => {
    const id = await insertTransfer(String(wsReadOnly));
    await expect(
      Mutation.deleteFileTransfer(null, { id: String(id) }, headerOf(wsOwner)),
    ).rejects.toThrow("permission");
    expect((await FileTransfer.findById(id).lean()).status).toBe("active");
  });

  it("renommage refusé de même", async () => {
    const id = await insertTransfer(String(wsReadOnly));
    await expect(
      Mutation.renameFileTransfer(
        null,
        { id: String(id), title: "Nouveau" },
        headerOf(wsOwner),
      ),
    ).rejects.toThrow();
    expect((await FileTransfer.findById(id).lean()).title ?? null).toBeNull();
  });

  it("propriétaire de l'espace du transfert : suppression acceptée", async () => {
    const id = await insertTransfer(String(wsOwner));
    expect(
      await Mutation.deleteFileTransfer(
        null,
        { id: String(id) },
        headerOf(wsReadOnly),
      ),
    ).toBe(true);
    expect((await FileTransfer.findById(id).lean()).status).toBe("deleted");
  });
});
