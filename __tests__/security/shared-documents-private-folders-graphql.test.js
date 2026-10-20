/**
 * Documents partagés (GraphQL) : un dossier privé inaccessible et ses
 * documents se comportent comme introuvables dans toutes les queries et
 * mutations du module, et n'entrent pas dans les statistiques.
 *
 * Seules les listes (sharedDocuments avec filtre, sharedFolders) tenaient
 * compte de la visibilité : sharedDocument(id), sharedFolder(id), la liste
 * sans filtre, les statistiques, la corbeille et toutes les mutations par
 * identifiant lisaient ou modifiaient les éléments des dossiers privés.
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

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: async () => {} },
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
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";

const { Query, Mutation } = sharedDocumentResolvers;

const workspaceId = buildOrganizationId();
const owner = buildUserId(); // crée les dossiers privés
const outsider = buildUserId(); // « Administrateur », hors des listes
const allowed = buildUserId(); // « Membre », dans les listes

const id = () => new mongoose.Types.ObjectId();
const publicFolder = id();
const privateFolder = id();
const publicChild = id(); // sous-dossier public du dossier privé
const trashedPrivateFolder = id();
const publicDoc = id();
const privateDoc = id();
const trashedPublicDoc = id();
const trashedPrivateDoc = id();

const ws = () => String(workspaceId);
const ctxOf = (userId) => buildContext({ userId, organizationId: ws() });
const info = (fieldName) => ({ fieldName });

const call = (resolver, name, args, userId = outsider) =>
  resolver[name](
    null,
    { workspaceId: ws(), ...args },
    ctxOf(userId),
    info(name),
  );

const docState = (docId) => SharedDocument.collection.findOne({ _id: docId });
const folderState = (folderId) =>
  SharedFolder.collection.findOne({ _id: folderId });

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
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: outsider,
    organizationId: workspaceId,
    role: "admin",
  });
  await seedOrgMembership({
    userId: allowed,
    organizationId: workspaceId,
    role: "viewer",
  });
  const trashedAt = new Date();
  const folder = (_id, name, parentId, visibility, extra = {}) => ({
    _id,
    name,
    workspaceId,
    parentId,
    createdBy: owner,
    visibility,
    allowedUserIds: visibility === "private" ? [allowed] : [],
    isSystem: false,
    order: 0,
    trashedAt: null,
    ...extra,
  });
  await SharedFolder.collection.insertMany([
    folder(publicFolder, "Comptabilité", null, "public"),
    folder(privateFolder, "Confidentiel", publicFolder, "private"),
    folder(publicChild, "Annexe", privateFolder, "public"),
    folder(trashedPrivateFolder, "Ancien confidentiel", null, "private", {
      trashedAt,
      originalParentId: null,
    }),
  ]);
  const doc = (_id, name, folderId, extra = {}) => ({
    _id,
    name,
    originalName: name,
    fileUrl: `https://r2.test/${name}`,
    fileKey: `espace/${name}`,
    mimeType: "application/pdf",
    fileSize: 100,
    workspaceId,
    folderId,
    uploadedBy: owner,
    status: "classified",
    tags: [],
    comments: [],
    trashedAt: null,
    ...extra,
  });
  await SharedDocument.collection.insertMany([
    doc(publicDoc, "facture.pdf", publicFolder),
    doc(privateDoc, "salaires.pdf", privateFolder, { tags: ["paie"] }),
    doc(trashedPublicDoc, "ancien-devis.pdf", publicFolder, {
      trashedAt,
      originalFolderId: publicFolder,
    }),
    doc(trashedPrivateDoc, "ancien-salaires.pdf", trashedPrivateFolder, {
      trashedAt,
      originalFolderId: trashedPrivateFolder,
    }),
  ]);
});

describe("Queries : dossier privé inaccessible comme introuvable", () => {
  it("sharedDocument(id) et sharedFolder(id)", async () => {
    expect(
      (await call(Query, "sharedDocument", { id: String(privateDoc) })).success,
    ).toBe(false);
    expect(
      (await call(Query, "sharedFolder", { id: String(privateFolder) }))
        .success,
    ).toBe(false);
    // Contrôle : visibles pour un membre de la liste
    expect(
      (await call(Query, "sharedDocument", { id: String(privateDoc) }, allowed))
        .success,
    ).toBe(true);
  });

  it("sharedDocuments sans filtre : sans les documents privés", async () => {
    const { documents } = await call(Query, "sharedDocuments", {});
    expect(documents.map((d) => d.name)).toEqual(["facture.pdf"]);
  });

  it("sharedDocumentsStats : ne compte que ce qui est visible", async () => {
    const stats = await call(Query, "sharedDocumentsStats", {});
    expect(stats).toMatchObject({
      totalDocuments: 1,
      classifiedDocuments: 1,
      totalSize: 100,
      // Comptabilité et son sous-dossier public (visibilité propre)
      totalFolders: 2,
      trashedDocuments: 1,
      trashedFolders: 0,
      trashedSize: 100,
    });
    const own = await call(Query, "sharedDocumentsStats", {}, allowed);
    expect(own).toMatchObject({ totalDocuments: 2, trashedDocuments: 2 });
  });

  it("trashItems : sans les éléments des dossiers privés", async () => {
    const trash = await call(Query, "trashItems", {});
    expect(trash.documents.map((d) => d.name)).toEqual(["ancien-devis.pdf"]);
    expect(trash.folders).toEqual([]);
    expect(trash.totalSize).toBe(100);
  });

  it("documentTags : les tags des documents privés ne sont pas comptés", async () => {
    const { tags } = await call(Query, "documentTags", {});
    const paie = tags.find((t) => t.name === "paie");
    expect(paie?.usageCount ?? 0).toBe(0);
  });

  it("parent d'un sous-dossier public d'un dossier privé : masqué", async () => {
    const child = await SharedFolder.findById(publicChild).lean();
    const parentOf = (userId) =>
      sharedDocumentResolvers.SharedFolder.parent(child, {}, ctxOf(userId));
    expect(await parentOf(outsider)).toBeNull();
    expect((await parentOf(allowed))?.name).toBe("Confidentiel");
  });
});

describe("Mutations : dossier privé inaccessible comme introuvable", () => {
  it("documents privés : ni modifiés, ni déplacés, ni commentés, ni tagués, ni supprimés", async () => {
    const pid = String(privateDoc);
    expect(
      (
        await call(Mutation, "updateSharedDocument", {
          id: pid,
          input: { name: "pirate.pdf" },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "moveSharedDocuments", {
          ids: [pid],
          targetFolderId: String(publicFolder),
        })
      ).movedCount,
    ).toBe(0);
    expect(
      (
        await call(Mutation, "addDocumentComment", {
          input: { documentId: pid, text: "vu" },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "bulkUpdateTags", {
          ids: [pid],
          addTags: ["pirate"],
        })
      ).updatedCount,
    ).toBe(0);
    expect(
      (await call(Mutation, "deleteSharedDocument", { id: pid })).success,
    ).toBe(false);
    expect(
      (await call(Mutation, "deleteSharedDocuments", { ids: [pid] })).success,
    ).toBe(false);

    const after = await docState(privateDoc);
    expect(after).toMatchObject({
      name: "salaires.pdf",
      folderId: privateFolder,
      tags: ["paie"],
      comments: [],
      trashedAt: null,
    });
  });

  it("dossier privé comme cible : refusé (déposer, déplacer, créer dedans)", async () => {
    const target = String(privateFolder);
    expect(
      (
        await call(Mutation, "uploadSharedDocument", {
          file: null,
          folderId: target,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "updateSharedDocument", {
          id: String(publicDoc),
          input: { folderId: target },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "moveSharedDocuments", {
          ids: [String(publicDoc)],
          targetFolderId: target,
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "createSharedFolder", {
          input: { name: "Sous-dossier", parentId: target },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "updateSharedFolder", {
          id: String(publicFolder),
          input: { parentId: target },
        })
      ).success,
    ).toBe(false);
    expect((await docState(publicDoc)).folderId).toEqual(publicFolder);
    expect(await SharedFolder.countDocuments({ parentId: privateFolder })).toBe(
      1,
    );
  });

  it("dossier privé : ni renommé, ni rendu public, ni supprimé", async () => {
    const fid = String(privateFolder);
    expect(
      (
        await call(Mutation, "updateSharedFolder", {
          id: fid,
          input: { name: "Plus confidentiel" },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await call(Mutation, "updateFolderVisibility", {
          id: fid,
          visibility: "public",
        })
      ).success,
    ).toBe(false);
    expect(
      (await call(Mutation, "deleteSharedFolder", { id: fid })).success,
    ).toBe(false);
    expect(await folderState(privateFolder)).toMatchObject({
      name: "Confidentiel",
      visibility: "private",
      trashedAt: null,
    });
  });

  it("updateSharedFolder ne contourne plus la règle de visibilité", async () => {
    // L'administrateur voit le dossier public mais ne l'a pas créé
    const res = await call(Mutation, "updateSharedFolder", {
      id: String(publicFolder),
      input: { visibility: "private", allowedUserIds: [String(outsider)] },
    });
    expect(res.success).toBe(false);
    expect((await folderState(publicFolder)).visibility).toBe("public");
  });

  it("corbeille : éléments privés ni restaurés, ni supprimés définitivement", async () => {
    const restored = await call(Mutation, "restoreFromTrash", {
      documentIds: [String(trashedPrivateDoc)],
      folderIds: [String(trashedPrivateFolder)],
    });
    expect(restored).toMatchObject({
      restoredDocuments: 0,
      restoredFolders: 0,
    });

    await call(Mutation, "permanentlyDeleteDocuments", {
      ids: [String(trashedPrivateDoc)],
    });
    await call(Mutation, "permanentlyDeleteFolders", {
      ids: [String(trashedPrivateFolder)],
    });
    await call(Mutation, "emptyTrash", {});

    expect(await docState(trashedPrivateDoc)).not.toBeNull();
    expect(await folderState(trashedPrivateFolder)).not.toBeNull();
    // Ce qui était visible dans la corbeille a bien été vidé
    expect(await docState(trashedPublicDoc)).toBeNull();
  });

  it("automatisation : dossier cible privé inaccessible refusé et masqué", async () => {
    await expect(
      documentAutomationResolvers.Mutation.createDocumentAutomation(
        null,
        {
          workspaceId: ws(),
          input: {
            name: "Classement",
            triggerType: "INVOICE_PAID",
            actionConfig: { targetFolderId: String(privateFolder) },
          },
        },
        ctxOf(outsider),
        info("createDocumentAutomation"),
      ),
    ).rejects.toThrow();

    const config = { targetFolderId: privateFolder, workspaceId };
    const targetOf = (userId) =>
      documentAutomationResolvers.DocumentAutomationActionConfig.targetFolder(
        config,
        {},
        ctxOf(userId),
      );
    expect(await targetOf(outsider)).toBeNull();
    expect((await targetOf(allowed))?.name).toBe("Confidentiel");
  });
});

describe("Suppression définitive des dossiers : seulement ceux de la corbeille", () => {
  it("un dossier actif (hors corbeille) n'est pas supprimé définitivement", async () => {
    await call(
      Mutation,
      "permanentlyDeleteFolders",
      { ids: [String(publicFolder)] },
      owner,
    );
    expect(await folderState(publicFolder)).not.toBeNull();
  });

  it("un dossier de la corbeille l'est", async () => {
    await call(
      Mutation,
      "permanentlyDeleteFolders",
      { ids: [String(trashedPrivateFolder)] },
      owner,
    );
    expect(await folderState(trashedPrivateFolder)).toBeNull();
  });
});
