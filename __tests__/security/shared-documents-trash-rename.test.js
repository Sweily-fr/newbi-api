/**
 * Documents partagés : suppression définitive, renommage, sous-dossiers
 * d'un dossier privé.
 *
 *  - emptyTrash, permanentlyDeleteDocuments et permanentlyDeleteFolders
 *    suppriment le fichier dans le bucket des documents partagés (ils
 *    visaient le bucket des images, R2 répondait succès sur une clé absente
 *    et le fichier restait) ; jamais un document d'un autre espace.
 *  - Renommer avec un nom vide, ou un dossier avec le nom d'un voisin :
 *    refusé comme à la création, base inchangée.
 *  - Un sous-dossier créé sans visibilité dans un dossier privé hérite de
 *    son parent (le défaut « public » du modèle l'ouvrait à tous).
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

const r2 = vi.hoisted(() => ({
  deleteImage: vi.fn(async () => true),
  sharedDocumentsBucketName: "documents-partages-test",
}));
vi.mock("../../src/services/cloudflareService.js", () => ({ default: r2 }));
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

const { Query, Mutation } = sharedDocumentResolvers;

const oid = () => new mongoose.Types.ObjectId();
let workspaceId;
let otherWorkspace;
let owner;
let member;

const ctxOf = (userId, ws = workspaceId) =>
  buildContext({ userId, organizationId: String(ws) });
const call = (resolver, name, args, userId = owner, ws = workspaceId) =>
  resolver[name](
    null,
    { workspaceId: String(ws), ...args },
    ctxOf(userId, ws),
    { fieldName: name },
  );

const doc = (extra) => ({
  _id: oid(),
  name: "facture.pdf",
  originalName: "facture.pdf",
  fileUrl: "https://docs.example/facture.pdf",
  fileKey: `${workspaceId}/documents/${oid()}.pdf`,
  mimeType: "application/pdf",
  fileSize: 100,
  fileExtension: "pdf",
  workspaceId,
  folderId: null,
  uploadedBy: owner,
  trashedAt: new Date(),
  ...extra,
});

const folder = (extra) => ({
  _id: oid(),
  name: "Dossier",
  workspaceId,
  parentId: null,
  createdBy: owner,
  visibility: "public",
  allowedUserIds: [],
  isSystem: false,
  order: 0,
  trashedAt: null,
  ...extra,
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
  r2.deleteImage.mockClear();
  workspaceId = buildOrganizationId();
  otherWorkspace = buildOrganizationId();
  owner = buildUserId();
  member = buildUserId();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({ userId: owner, organizationId: otherWorkspace });
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: "member",
  });
});

const folderIds = async (userId) => {
  const res = await call(Query, "sharedFolders", {}, userId);
  return (res.folders || []).map((f) => String(f.id ?? f._id));
};

const deletedKeys = () =>
  r2.deleteImage.mock.calls.map(([key, bucket]) => ({ key, bucket }));

describe("Suppression définitive : fichier effacé dans le bon bucket", () => {
  it("emptyTrash : chaque fichier de la corbeille, bucket des documents partagés", async () => {
    const a = doc();
    const b = doc();
    const ailleurs = doc({ workspaceId: otherWorkspace });
    await SharedDocument.collection.insertMany([a, b, ailleurs]);

    const res = await call(Mutation, "emptyTrash", {});
    expect(res.success).toBe(true);

    expect(deletedKeys()).toEqual(
      expect.arrayContaining([
        { key: a.fileKey, bucket: "documents-partages-test" },
        { key: b.fileKey, bucket: "documents-partages-test" },
      ]),
    );
    expect(deletedKeys().map((d) => d.key)).not.toContain(ailleurs.fileKey);
    expect(await SharedDocument.collection.countDocuments({ workspaceId })).toBe(0);
    expect(
      await SharedDocument.collection.countDocuments({ _id: ailleurs._id }),
    ).toBe(1);
  });

  it("permanentlyDeleteDocuments : bucket des documents partagés, jamais un autre espace", async () => {
    const a = doc();
    const ailleurs = doc({ workspaceId: otherWorkspace });
    await SharedDocument.collection.insertMany([a, ailleurs]);

    await call(Mutation, "permanentlyDeleteDocuments", {
      ids: [String(a._id), String(ailleurs._id)],
    });

    expect(deletedKeys()).toEqual([
      { key: a.fileKey, bucket: "documents-partages-test" },
    ]);
    expect(
      await SharedDocument.collection.countDocuments({ _id: ailleurs._id }),
    ).toBe(1);
  });

  it("permanentlyDeleteFolders : documents du dossier effacés du bon bucket", async () => {
    const f = folder({ trashedAt: new Date() });
    await SharedFolder.collection.insertOne(f);
    const a = doc({ folderId: null, originalFolderId: f._id });
    await SharedDocument.collection.insertOne(a);

    await call(Mutation, "permanentlyDeleteFolders", { ids: [String(f._id)] });

    expect(deletedKeys()).toEqual([
      { key: a.fileKey, bucket: "documents-partages-test" },
    ]);
  });
});

describe("Renommer : nom vide ou doublon refusé", () => {
  it.each(["", "   "])("dossier renommé en %j : refusé, nom inchangé", async (name) => {
    const f = folder({ name: "Contrats" });
    await SharedFolder.collection.insertOne(f);

    const res = await call(Mutation, "updateSharedFolder", {
      id: String(f._id),
      input: { name },
    });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/ne peut pas être vide/);
    expect((await SharedFolder.collection.findOne({ _id: f._id })).name).toBe("Contrats");
  });

  it("dossier renommé comme son voisin : refusé", async () => {
    const parent = folder({ name: "Clients" });
    const a = folder({ name: "Dupont", parentId: parent._id });
    const b = folder({ name: "Martin", parentId: parent._id });
    await SharedFolder.collection.insertMany([parent, a, b]);

    const res = await call(Mutation, "updateSharedFolder", {
      id: String(b._id),
      input: { name: "Dupont" },
    });

    expect(res.success).toBe(false);
    expect(res.message).toBe("Un dossier avec ce nom existe déjà");
    expect((await SharedFolder.collection.findOne({ _id: b._id })).name).toBe("Martin");
  });

  it("même nom dans un autre dossier, ou vrai nom accentué : accepté", async () => {
    const p1 = folder({ name: "2025" });
    const p2 = folder({ name: "2026" });
    const a = folder({ name: "Factures", parentId: p1._id });
    const b = folder({ name: "Reçus", parentId: p2._id });
    await SharedFolder.collection.insertMany([p1, p2, a, b]);

    const res = await call(Mutation, "updateSharedFolder", {
      id: String(b._id),
      input: { name: "Factures" },
    });
    expect(res.success).toBe(true);

    const res2 = await call(Mutation, "updateSharedFolder", {
      id: String(a._id),
      input: { name: "Pièces n° 3 : œuvres d'été" },
    });
    expect(res2.success).toBe(true);
    expect((await SharedFolder.collection.findOne({ _id: a._id })).name).toBe(
      "Pièces n° 3 : œuvres d'été",
    );
  });

  it("dossier renommé à l'identique : accepté", async () => {
    const f = folder({ name: "Contrats" });
    await SharedFolder.collection.insertOne(f);
    const res = await call(Mutation, "updateSharedFolder", {
      id: String(f._id),
      input: { name: "Contrats" },
    });
    expect(res.success).toBe(true);
  });

  it.each(["", "  "])("document renommé en %j : refusé, nom inchangé", async (name) => {
    const d = doc({ trashedAt: null, name: "devis.pdf" });
    await SharedDocument.collection.insertOne(d);

    const res = await call(Mutation, "updateSharedDocument", {
      id: String(d._id),
      input: { name },
    });

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/ne peut pas être vide/);
    expect((await SharedDocument.collection.findOne({ _id: d._id })).name).toBe("devis.pdf");
  });
});

describe("Sous-dossier d'un dossier privé : visibilité héritée", () => {
  it("créé sans visibilité dans « RH » privé : invisible pour un membre hors liste", async () => {
    const rh = folder({ name: "RH", visibility: "private", allowedUserIds: [] });
    await SharedFolder.collection.insertOne(rh);

    const created = await call(Mutation, "createSharedFolder", {
      input: { name: "Paie", parentId: String(rh._id) },
    });
    expect(created.success).toBe(true);
    const paieId = created.folder.id;
    const d = doc({ trashedAt: null, folderId: paieId, name: "bulletin.pdf" });
    await SharedDocument.collection.insertOne(d);

    // Le propriétaire le voit
    expect(await folderIds(owner)).toContain(String(paieId));

    // Le membre hors liste ne voit ni le dossier ni le document
    expect(await folderIds(member)).not.toContain(String(paieId));
    const unDoc = await call(Query, "sharedDocument", { id: String(d._id) }, member);
    expect(unDoc?.document ?? null).toBeNull();
    expect(unDoc?.success).toBe(false);
  });

  it("sous-dossier d'un dossier public : reste visible de tous", async () => {
    const pub = folder({ name: "Commun" });
    await SharedFolder.collection.insertOne(pub);

    const created = await call(Mutation, "createSharedFolder", {
      input: { name: "Modèles", parentId: String(pub._id) },
    });

    expect(await folderIds(member)).toContain(String(created.folder.id));
  });

  it("visibilité choisie à la création : gardée", async () => {
    const rh = folder({ name: "RH", visibility: "private" });
    await SharedFolder.collection.insertOne(rh);

    const created = await call(Mutation, "createSharedFolder", {
      input: { name: "Public", parentId: String(rh._id), visibility: "public" },
    });
    const stored = await SharedFolder.collection.findOne({
      _id: new mongoose.Types.ObjectId(String(created.folder.id)),
    });
    expect(stored.visibility).toBe("public");
  });
});
