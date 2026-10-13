/**
 * Documents partagés : un dossier cible ou parent doit être un dossier de
 * l'espace.
 *
 * L'accès aux dossiers (sharedFolderAccess.canAccess) laisse passer un
 * dossier introuvable dans l'espace (document dont le dossier a disparu).
 * Les mutations s'en servaient pour le dossier cible : le dossier d'un
 * autre espace était accepté comme dossier de dépôt, de déplacement ou
 * parent, et les champs folder / parent le relisaient par son seul id
 * (nom, visibilité, créateur du dossier d'autrui).
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
import { Readable } from "stream";

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: async () => {},
    uploadImage: async () => ({
      key: "cle-document",
      url: "https://r2.test/cle-document",
    }),
  },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";

const { Mutation } = sharedDocumentResolvers;

const alice = buildUserId(); // membre de A
const bob = buildUserId(); // membre de B
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const id = () => new mongoose.Types.ObjectId();

const folderA = id();
const folderB = id();
const docA = id();

const ctx = () => buildContext({ userId: alice, organizationId: orgA });
const call = (name, args) =>
  Mutation[name](null, { workspaceId: String(orgA), ...args }, ctx(), {
    fieldName: name,
  });

const fakeUpload = () =>
  Promise.resolve({
    filename: "note.txt",
    mimetype: "text/plain",
    createReadStream: () => Readable.from([Buffer.from("contenu")]),
  });

const folder = (_id, workspaceId, name, createdBy) => ({
  _id,
  name,
  workspaceId,
  parentId: null,
  createdBy,
  visibility: "public",
  allowedUserIds: [],
  isSystem: false,
  order: 0,
  trashedAt: null,
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId: alice, organizationId: orgA });
  await seedOrgMembership({ userId: bob, organizationId: orgB });
  await SharedFolder.collection.insertMany([
    folder(folderA, orgA, "Factures A", alice),
    folder(folderB, orgB, "Dossier secret de B", bob),
  ]);
  await SharedDocument.collection.insertOne({
    _id: docA,
    name: "devis.pdf",
    originalName: "devis.pdf",
    fileUrl: "https://r2.test/devis.pdf",
    fileKey: "devis.pdf",
    mimeType: "application/pdf",
    fileSize: 10,
    workspaceId: orgA,
    folderId: null,
    status: "pending",
    uploadedBy: alice,
    tags: [],
    trashedAt: null,
  });
});

describe("dossier d'un autre espace refusé comme cible", () => {
  it("uploadSharedDocument", async () => {
    const result = await call("uploadSharedDocument", {
      file: fakeUpload(),
      folderId: String(folderB),
    });
    expect(result.success).toBe(false);
    expect(result.message).toBe("Dossier non trouvé");
    expect(await SharedDocument.countDocuments({ folderId: folderB })).toBe(0);
  });

  it("updateSharedDocument", async () => {
    const result = await call("updateSharedDocument", {
      id: String(docA),
      input: { folderId: String(folderB) },
    });
    expect(result.success).toBe(false);
    const after = await SharedDocument.collection.findOne({ _id: docA });
    expect(after.folderId).toBeNull();
  });

  it("moveSharedDocuments", async () => {
    const result = await call("moveSharedDocuments", {
      ids: [String(docA)],
      targetFolderId: String(folderB),
    });
    expect(result.success).toBe(false);
    expect(result.movedCount).toBe(0);
    const after = await SharedDocument.collection.findOne({ _id: docA });
    expect(after.folderId).toBeNull();
  });

  it("createSharedFolder", async () => {
    const result = await call("createSharedFolder", {
      input: { name: "Sous-dossier", parentId: String(folderB) },
    });
    expect(result.success).toBe(false);
    expect(await SharedFolder.countDocuments({ parentId: folderB })).toBe(0);
  });

  it("updateSharedFolder", async () => {
    const result = await call("updateSharedFolder", {
      id: String(folderA),
      input: { parentId: String(folderB) },
    });
    expect(result.success).toBe(false);
    const after = await SharedFolder.collection.findOne({ _id: folderA });
    expect(after.parentId).toBeNull();
  });
});

describe("cibles légitimes", () => {
  it("la racine et un dossier de l'espace restent acceptés", async () => {
    const moved = await call("moveSharedDocuments", {
      ids: [String(docA)],
      targetFolderId: String(folderA),
    });
    expect(moved.success).toBe(true);
    expect(moved.movedCount).toBe(1);

    const back = await call("moveSharedDocuments", {
      ids: [String(docA)],
      targetFolderId: null,
    });
    expect(back.success).toBe(true);
    expect(back.movedCount).toBe(1);

    const created = await call("createSharedFolder", {
      input: { name: "Sous-dossier", parentId: String(folderA) },
    });
    expect(created.success).toBe(true);

    const uploaded = await call("uploadSharedDocument", {
      file: fakeUpload(),
      folderId: String(folderA),
    });
    expect(uploaded.success).toBe(true);
  });
});

describe("champs folder et parent", () => {
  it("ne relisent pas le dossier d'un autre espace", async () => {
    const doc = {
      _id: id(),
      workspaceId: orgA,
      folderId: folderB,
    };
    expect(await sharedDocumentResolvers.SharedDocument.folder(doc)).toBeNull();

    const child = { _id: id(), workspaceId: orgA, parentId: folderB };
    expect(
      await sharedDocumentResolvers.SharedFolder.parent(child, {}, ctx()),
    ).toBeNull();
  });

  it("relisent le dossier de l'espace", async () => {
    const doc = { _id: id(), workspaceId: orgA, folderId: folderA };
    const docFolder = await sharedDocumentResolvers.SharedDocument.folder(doc);
    expect(docFolder.name).toBe("Factures A");

    const child = { _id: id(), workspaceId: orgA, parentId: folderA };
    const parent = await sharedDocumentResolvers.SharedFolder.parent(
      child,
      {},
      ctx(),
    );
    expect(parent.name).toBe("Factures A");
  });
});
