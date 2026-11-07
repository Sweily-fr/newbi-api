/**
 * Liens clients des documents partagés : une URL publique sans compte.
 * Le lien ne doit montrer que le dossier partagé : ni dossier privé, ni
 * corbeille, ni autre dossier de l'espace, ni rien d'interne, et toute
 * révocation doit agir sur-le-champ.
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

vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://app.test";
  process.env.BETTER_AUTH_SECRET = "secret-de-test";
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(command) {
      return { Body: Readable.from([`contenu:${command.input.Key}`]) };
    }
  },
  GetObjectCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));
vi.mock("heic-convert", () => ({ default: async () => Buffer.from("") }));
vi.mock("sharp", () => ({ default: () => ({}) }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: async () => {}, sharedDocumentsBucketName: "test" },
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

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { PREDEFINED_ROLES } from "../../src/config/rolePermissions.js";
import DocumentShare from "../../src/models/DocumentShare.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import publicRoutes from "../../src/routes/publicDocumentShare.js";
import shareResolvers from "../../src/resolvers/documentShare.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";

const { ObjectId } = mongoose.Types;

const workspaceId = buildOrganizationId();
const otherWorkspaceId = buildOrganizationId();
const owner = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();

const ids = {
  shared: new ObjectId(),
  child: new ObjectId(),
  privateChild: new ObjectId(),
  underPrivate: new ObjectId(),
  trashedChild: new ObjectId(),
  sibling: new ObjectId(),
  otherWorkspace: new ObjectId(),
};
const docs = {
  inShared: new ObjectId(),
  inChild: new ObjectId(),
  inPrivate: new ObjectId(),
  underPrivate: new ObjectId(),
  inTrashedChild: new ObjectId(),
  trashed: new ObjectId(),
  inSibling: new ObjectId(),
  inbox: new ObjectId(),
};

let server;
let baseUrl;

const folder = (_id, name, parentId, extra = {}) => ({
  _id,
  name,
  workspaceId,
  createdBy: owner,
  parentId,
  visibility: "public",
  trashedAt: null,
  ...extra,
});

const doc = (_id, name, folderId, extra = {}) => ({
  _id,
  name,
  originalName: name,
  fileUrl: `https://r2.test/${name}`,
  fileKey: `cle-secrete/${name}`,
  mimeType: "application/pdf",
  fileSize: `contenu:cle-secrete/${name}`.length,
  workspaceId,
  folderId,
  uploadedBy: owner,
  uploadedByName: "Auteur Interne",
  comments: [{ text: "commentaire interne" }],
  trashedAt: null,
  ...extra,
});

async function createShare(extra = {}) {
  const share = new DocumentShare({
    token: DocumentShare.generateToken(),
    workspaceId,
    folderId: ids.shared,
    createdBy: owner,
    ...extra,
  });
  if (extra.password) await share.setPassword(extra.password);
  await share.save();
  return share;
}

const urlOf = (share, path = "", query = "") =>
  `${baseUrl}/api/public-documents/${share.token}${path}${query}`;
const fileUrl = (share, documentId, kind = "download", query = "") =>
  urlOf(share, `/files/${documentId}/${kind}`, query);
const unlock = (share, password) =>
  fetch(urlOf(share, "/unlock"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

const asOwner = () =>
  buildContext({ userId: owner, organizationId: workspaceId });
const ws = String(workspaceId);

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/api/public-documents", publicRoutes);
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
  invalidateOrgCache();
  invalidateSubCache(String(workspaceId));
  invalidateOrganizationRoles();
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Cabinet Martin",
  });
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
  await seedOrgMembership({
    userId: accountant,
    organizationId: workspaceId,
    role: "accountant",
  });
  await SharedFolder.collection.insertMany([
    folder(ids.shared, "Client Dupont", null),
    folder(ids.child, "Contrats", ids.shared),
    folder(ids.privateChild, "RH confidentiel", ids.shared, {
      visibility: "private",
    }),
    folder(ids.underPrivate, "Sous le privé", ids.privateChild),
    folder(ids.trashedChild, "À la corbeille", ids.shared, {
      trashedAt: new Date(),
    }),
    folder(ids.sibling, "Autre client", null),
    folder(ids.otherWorkspace, "Autre espace", null, {
      workspaceId: otherWorkspaceId,
    }),
  ]);
  await SharedDocument.collection.insertMany([
    doc(docs.inShared, "devis.pdf", ids.shared),
    doc(docs.inChild, "contrat.pdf", ids.child),
    doc(docs.inPrivate, "salaires.pdf", ids.privateChild),
    doc(docs.underPrivate, "paie.pdf", ids.underPrivate),
    doc(docs.inTrashedChild, "ancien.pdf", ids.trashedChild),
    doc(docs.trashed, "jete.pdf", ids.shared, { trashedAt: new Date() }),
    doc(docs.inSibling, "voisin.pdf", ids.sibling),
    doc(docs.inbox, "a-classer.pdf", null),
  ]);
});

describe("Consultation d'un lien client", () => {
  it("montre le dossier et ses sous-dossiers, rien d'autre", async () => {
    const res = await fetch(urlOf(await createShare()));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const body = await res.json();
    expect(body.workspace.name).toBe("Cabinet Martin");
    expect(body.folders.map((f) => f.name).sort()).toEqual([
      "Client Dupont",
      "Contrats",
    ]);
    expect(body.documents.map((d) => d.name).sort()).toEqual([
      "contrat.pdf",
      "devis.pdf",
    ]);
  });

  it("n'expose rien d'interne", async () => {
    const res = await fetch(urlOf(await createShare()));
    const text = await res.text();
    for (const secret of [
      "cle-secrete",
      "r2.test",
      "Auteur Interne",
      "commentaire interne",
      "salaires",
      "RH confidentiel",
      String(owner),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("sert les fichiers de la portée, sans cache", async () => {
    const share = await createShare();
    for (const kind of ["download", "preview"]) {
      const res = await fetch(fileUrl(share, docs.inChild, kind));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toBe("contenu:cle-secrete/contrat.pdf");
    }
  });

  it("donne au fichier et au ZIP leur vrai nom, accents et espaces compris", async () => {
    await SharedDocument.updateOne(
      { _id: docs.inShared },
      { originalName: "Devis signé.pdf" },
    );
    const share = await createShare();
    const file = await fetch(fileUrl(share, docs.inShared));
    expect(file.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Devis sign_.pdf\"; filename*=UTF-8''Devis%20sign%C3%A9.pdf",
    );
    const zip = await fetch(urlOf(share, "/download-all"));
    expect(zip.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''Client%20Dupont.zip",
    );
  });

  it("refuse tout fichier hors de la portée", async () => {
    const share = await createShare();
    for (const documentId of [
      docs.inPrivate,
      docs.underPrivate,
      docs.inTrashedChild,
      docs.trashed,
      docs.inSibling,
      docs.inbox,
      new ObjectId(),
      "pas-un-id",
    ]) {
      for (const kind of ["download", "preview"]) {
        const res = await fetch(fileUrl(share, documentId, kind));
        expect(res.status).toBe(404);
      }
    }
  });

  it("le ZIP ne contient ni branche privée ni corbeille", async () => {
    const res = await fetch(urlOf(await createShare(), "/download-all"));
    expect(res.status).toBe(200);
    const zip = Buffer.from(await res.arrayBuffer()).toString("latin1");
    expect(zip).toContain("devis.pdf");
    expect(zip).toContain("contrat.pdf");
    for (const absent of [
      "salaires.pdf",
      "paie.pdf",
      "ancien.pdf",
      "jete.pdf",
      "voisin.pdf",
      "RH confidentiel",
    ]) {
      expect(zip).not.toContain(absent);
    }
  });

  it("répond 404 à un jeton inconnu ou mal formé", async () => {
    const res = await fetch(
      `${baseUrl}/api/public-documents/${"a".repeat(64)}`,
    );
    expect(res.status).toBe(404);
    const malformed = await fetch(
      `${baseUrl}/api/public-documents/${encodeURIComponent('{"$ne":null}')}`,
    );
    expect(malformed.status).toBe(404);
  });

  it("compte les consultations et les téléchargements", async () => {
    const share = await createShare();
    await fetch(urlOf(share));
    const res = await fetch(fileUrl(share, docs.inShared));
    await res.text();
    // Le téléchargement est compté une fois l'envoi lancé, pas avant la fin de
    // la réponse : le client peut avoir tout reçu avant l'écriture en base
    await vi.waitFor(async () => {
      const saved = await DocumentShare.findById(share._id).lean();
      expect(saved.stats.totalDownloads).toBe(1);
    });
    const saved = await DocumentShare.findById(share._id).lean();
    expect(saved.stats.totalViews).toBe(1);
    expect(saved.stats.lastViewedAt).toBeTruthy();
  });
});

describe("Fermeture d'un lien", () => {
  const expectClosed = async (share) => {
    expect((await fetch(urlOf(share))).status).toBe(410);
    expect((await fetch(fileUrl(share, docs.inShared))).status).toBe(410);
    expect((await fetch(fileUrl(share, docs.inShared, "preview"))).status).toBe(
      410,
    );
    expect((await fetch(urlOf(share, "/download-all"))).status).toBe(410);
    expect((await unlock(share, "peu-importe")).status).toBe(410);
  };

  it("lien désactivé", async () => {
    await expectClosed(await createShare({ isActive: false }));
  });

  it("lien expiré", async () => {
    await expectClosed(
      await createShare({ expiresAt: new Date(Date.now() - 1000) }),
    );
  });

  it("dossier passé en privé", async () => {
    const share = await createShare();
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { visibility: "private" },
    );
    await expectClosed(share);
  });

  it("dossier mis à la corbeille", async () => {
    const share = await createShare();
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { trashedAt: new Date() },
    );
    await expectClosed(share);
  });

  it("dossier public rangé sous un parent privé", async () => {
    const share = await createShare();
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { parentId: ids.privateChild },
    );
    await SharedFolder.updateOne({ _id: ids.privateChild }, { parentId: null });
    await expectClosed(share);
  });

  it("document déplacé hors du dossier partagé : plus accessible", async () => {
    const share = await createShare();
    await SharedDocument.updateOne(
      { _id: docs.inShared },
      { folderId: ids.sibling },
    );
    expect((await fetch(fileUrl(share, docs.inShared))).status).toBe(404);
  });
});

describe("Lien protégé par mot de passe", () => {
  it("sans preuve : ni contenu ni fichier ni ZIP", async () => {
    const share = await createShare({ password: "secret-123" });
    const res = await fetch(urlOf(share));
    const body = await res.json();
    expect(body.requiresPassword).toBe(true);
    expect(body.documents).toBeUndefined();
    expect(body.folders).toBeUndefined();

    for (const url of [
      fileUrl(share, docs.inShared),
      fileUrl(share, docs.inShared, "preview"),
      urlOf(share, "/download-all"),
    ]) {
      const denied = await fetch(url);
      expect(denied.status).toBe(401);
    }
    expect((await DocumentShare.findById(share._id)).stats.totalViews).toBe(0);
  });

  it("le bon mot de passe remet un jeton qui ouvre l'accès", async () => {
    const share = await createShare({ password: "secret-123" });
    expect((await unlock(share, "mauvais")).status).toBe(401);
    expect((await unlock(share, { $ne: null })).status).toBe(401);

    const res = await unlock(share, "secret-123");
    expect(res.status).toBe(200);
    const { accessToken } = await res.json();
    const query = `?access=${encodeURIComponent(accessToken)}`;

    const list = await (await fetch(urlOf(share, "", query))).json();
    expect(list.documents).toHaveLength(2);
    const file = await fetch(fileUrl(share, docs.inShared, "download", query));
    expect(file.status).toBe(200);
  });

  it("le jeton ne sert ni à un autre lien, ni après un changement de mot de passe", async () => {
    const share = await createShare({ password: "secret-123" });
    const other = await createShare({ password: "autre-456" });
    const { accessToken } = await (await unlock(share, "secret-123")).json();
    const query = `?access=${encodeURIComponent(accessToken)}`;

    expect(
      (await fetch(fileUrl(other, docs.inShared, "download", query))).status,
    ).toBe(401);

    await shareResolvers.Mutation.updateDocumentShare(
      null,
      {
        workspaceId: ws,
        id: String(share._id),
        input: { password: "nouveau-789" },
      },
      asOwner(),
    );
    expect(
      (await fetch(fileUrl(share, docs.inShared, "download", query))).status,
    ).toBe(401);
  });

  it("les essais en échec sont plafonnés", async () => {
    const share = await createShare({ password: "secret-123" });
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await unlock(share, "mauvais");
    }
    expect(last.status).toBe(429);
    // Même le bon mot de passe attend la fin de la fenêtre
    expect((await unlock(share, "secret-123")).status).toBe(429);
  });
});

describe("Gestion des liens", () => {
  const {
    createDocumentShare,
    updateDocumentShare,
    revokeDocumentShare,
    deleteDocumentShare,
  } = shareResolvers.Mutation;
  const { documentShares } = shareResolvers.Query;
  const create = (input, context = asOwner()) =>
    createDocumentShare(null, { workspaceId: ws, input }, context);

  it("crée un lien sans jamais stocker le mot de passe en clair", async () => {
    const share = await create({
      folderId: String(ids.shared),
      name: " Dupont ",
      password: "secret-123",
    });
    expect(share.name).toBe("Dupont");
    expect(share.hasPassword).toBe(true);
    expect(share.isFolderAvailable).toBe(true);
    expect(share.shareUrl).toMatch(
      /^https:\/\/app\.test\/public\/documents\/[0-9a-f]{64}$/,
    );
    expect(share.passwordHash).toBeUndefined();
    const saved = await DocumentShare.findById(share.id).lean();
    expect(saved.passwordHash).not.toContain("secret-123");
  });

  it("refuse un dossier privé, à la corbeille, sous un privé ou d'un autre espace", async () => {
    for (const folderId of [
      ids.privateChild,
      ids.trashedChild,
      ids.underPrivate,
    ]) {
      await expect(create({ folderId: String(folderId) })).rejects.toThrow(
        "ne peut pas être partagé",
      );
    }
    await expect(
      create({ folderId: String(ids.otherWorkspace) }),
    ).rejects.toThrow("non trouvé");
    await expect(create({ folderId: "pas-un-id" })).rejects.toThrow(
      "non trouvé",
    );
    expect(await DocumentShare.countDocuments()).toBe(0);
  });

  it("refuse une expiration passée et un mot de passe trop court", async () => {
    await expect(
      create({
        folderId: String(ids.shared),
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow("futur");
    await expect(
      create({ folderId: String(ids.shared), password: "abc" }),
    ).rejects.toThrow("mot de passe");
  });

  it("exige l'action « share » : ni Membre ni Comptable par défaut", async () => {
    for (const userId of [viewer, accountant]) {
      const context = buildContext({ userId, organizationId: workspaceId });
      await expect(
        create({ folderId: String(ids.shared) }, context),
      ).rejects.toThrow();
      await expect(
        documentShares(null, { workspaceId: ws }, context),
      ).rejects.toThrow();
    }
    expect(await DocumentShare.countDocuments()).toBe(0);
  });

  it("répartit l'action entre les rôles prédéfinis", () => {
    const has = (role) =>
      PREDEFINED_ROLES[role].actions.sharedDocuments.includes("share");
    expect(["owner", "admin", "member"].every(has)).toBe(true);
    expect(has("viewer")).toBe(false);
    expect(has("accountant")).toBe(false);
  });

  it("un lien d'un autre espace reste introuvable", async () => {
    const foreign = await DocumentShare.create({
      token: DocumentShare.generateToken(),
      workspaceId: otherWorkspaceId,
      folderId: ids.otherWorkspace,
      createdBy: owner,
    });
    const args = { workspaceId: ws, id: String(foreign._id) };
    await expect(
      updateDocumentShare(
        null,
        { ...args, input: { isActive: true } },
        asOwner(),
      ),
    ).rejects.toThrow("non trouvé");
    await expect(revokeDocumentShare(null, args, asOwner())).rejects.toThrow(
      "non trouvé",
    );
    await expect(deleteDocumentShare(null, args, asOwner())).rejects.toThrow(
      "non trouvé",
    );
    expect(await DocumentShare.countDocuments()).toBe(1);
  });

  it("révoque, réactive et supprime : effet immédiat sur l'URL publique", async () => {
    const created = await create({ folderId: String(ids.shared) });
    const url = created.shareUrl.replace(
      "https://app.test/public/documents/",
      `${baseUrl}/api/public-documents/`,
    );
    const args = { workspaceId: ws, id: created.id };

    await revokeDocumentShare(null, args, asOwner());
    expect((await fetch(url)).status).toBe(410);

    await updateDocumentShare(
      null,
      { ...args, input: { isActive: true } },
      asOwner(),
    );
    expect((await fetch(url)).status).toBe(200);

    await deleteDocumentShare(null, args, asOwner());
    expect((await fetch(url)).status).toBe(404);
  });

  it("abonnement échu : on ne crée ni ne modifie plus, mais on coupe l'accès", async () => {
    const created = await create({ folderId: String(ids.shared) });
    const other = await create({ folderId: String(ids.sibling) });
    await mongoose.connection.db.collection("subscription").deleteMany({});
    invalidateOrgCache();
    invalidateSubCache(ws);
    const args = { workspaceId: ws, id: created.id };

    await expect(create({ folderId: String(ids.shared) })).rejects.toThrow();
    await expect(
      updateDocumentShare(
        null,
        { ...args, input: { isActive: true } },
        asOwner(),
      ),
    ).rejects.toThrow();

    const revoked = await revokeDocumentShare(null, args, asOwner());
    expect(revoked.isActive).toBe(false);
    await deleteDocumentShare(
      null,
      { workspaceId: ws, id: other.id },
      asOwner(),
    );
    expect(await DocumentShare.countDocuments()).toBe(1);
  });

  it("retire le mot de passe et l'expiration avec null", async () => {
    const created = await create({
      folderId: String(ids.shared),
      password: "secret-123",
      expiresAt: new Date(Date.now() + 86400000),
    });
    const updated = await updateDocumentShare(
      null,
      {
        workspaceId: ws,
        id: created.id,
        input: { password: null, expiresAt: null },
      },
      asOwner(),
    );
    expect(updated.hasPassword).toBe(false);
    expect(updated.expiresAt).toBeNull();
  });

  it("signale un dossier devenu privé dans la liste", async () => {
    await create({ folderId: String(ids.shared) });
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { visibility: "private" },
    );
    const [share] = await documentShares(
      null,
      { workspaceId: ws, folderId: String(ids.shared) },
      asOwner(),
    );
    expect(share.isFolderAvailable).toBe(false);
  });

  it("supprimer le dossier définitivement supprime ses liens", async () => {
    await create({ folderId: String(ids.shared) });
    const kept = await create({ folderId: String(ids.sibling) });
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { trashedAt: new Date() },
    );
    await sharedDocumentResolvers.Mutation.permanentlyDeleteFolders(
      null,
      { workspaceId: ws, ids: [String(ids.shared)] },
      asOwner(),
    );
    const remaining = await DocumentShare.find().lean();
    expect(remaining.map((s) => String(s._id))).toEqual([kept.id]);
  });
});
