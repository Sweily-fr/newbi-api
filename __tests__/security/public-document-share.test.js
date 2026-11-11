/**
 * Accès clients des documents partagés : une URL publique sans compte, sur le
 * modèle du partage d'un tableau kanban. L'accès ne doit montrer que les
 * dossiers choisis (ni dossier privé, ni corbeille, ni rien d'interne), à un
 * visiteur qui a prouvé son adresse e-mail, et toute révocation doit agir
 * sur-le-champ.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { Readable } from "stream";

vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://app.test";
  process.env.BETTER_AUTH_SECRET = "secret-de-test";
});

// Codes et e-mails envoyés aux visiteurs
const mails = vi.hoisted(() => ({
  codes: new Map(),
  approved: [],
  rejected: [],
}));
vi.mock("../../src/utils/documentShareEmails.js", () => ({
  sendDocumentShareCodeEmail: async (to, { code }) => {
    mails.codes.set(to, code);
    return true;
  },
  sendDocumentShareApprovedEmail: async (to, data) => {
    mails.approved.push({ to, ...data });
    return true;
  },
  sendDocumentShareRejectedEmail: async (to, data) => {
    mails.rejected.push({ to, ...data });
    return true;
  },
}));

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
import helmet from "helmet";
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
const CLIENT = "client@dupont.fr";

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
// Adresse IP propre à chaque test : les plafonds anti-abus (par IP) ne se
// cumulent pas d'un test à l'autre
let clientIp = "10.0.0.1";
let ipCounter = 0;

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
    folderIds: [ids.shared],
    createdBy: owner,
    ...extra,
  });
  if (extra.password) await share.setPassword(extra.password);
  await share.save();
  return share;
}

const urlOf = (share, path = "", query = "") =>
  `${baseUrl}/api/public-documents/${share.token}${path}${query}`;
const post = (share, path, body) =>
  fetch(urlOf(share, path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": clientIp,
    },
    body: JSON.stringify(body),
  });
const q = (session) => `?session=${encodeURIComponent(session)}`;
const fileUrl = (share, documentId, session, kind = "download") =>
  urlOf(share, `/files/${documentId}/${kind}`, q(session));
const getJson = async (share, session) =>
  (await fetch(urlOf(share, "", session ? q(session) : ""))).json();

/** Parcours complet du visiteur : code reçu par e-mail, puis session. */
async function identify(share, email = CLIENT, access) {
  const sent = await post(share, "/identify/code", { email, access });
  expect(sent.status).toBe(200);
  const res = await post(share, "/identify/verify", {
    email,
    code: mails.codes.get(email),
    access,
  });
  expect(res.status).toBe(200);
  return (await res.json()).session;
}

const asOwner = () =>
  buildContext({ userId: owner, organizationId: workspaceId });
const ws = String(workspaceId);

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.set("trust proxy", true);
  // Mêmes en-têtes de sécurité que src/server.js
  app.use(
    helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
  );
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
  ipCounter += 1;
  clientIp = `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache(String(workspaceId));
  invalidateOrganizationRoles();
  mails.codes.clear();
  mails.approved.length = 0;
  mails.rejected.length = 0;
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
    folder(ids.sibling, "Factures Dupont", null),
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
    doc(docs.inSibling, "facture.pdf", ids.sibling),
    doc(docs.inbox, "a-classer.pdf", null),
  ]);
});

describe("Accès anticipé (BETA_FEATURES)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lien d'un espace hors des espaces bêta : introuvable, sans envoi de code", async () => {
    vi.stubEnv("BETA_FEATURES", "documentShares");
    vi.stubEnv("BETA_WORKSPACE_IDS", String(otherWorkspaceId));
    const share = await createShare();
    const res = await fetch(urlOf(share));
    expect(res.status).toBe(404);
    const sent = await post(share, "/identify/code", { email: CLIENT });
    expect(sent.status).toBe(404);
    expect(mails.codes.has(CLIENT)).toBe(false);
  });

  it("lien d'un espace bêta : servi normalement", async () => {
    vi.stubEnv("BETA_FEATURES", "documentShares");
    vi.stubEnv("BETA_WORKSPACE_IDS", ws);
    const share = await createShare();
    const res = await fetch(urlOf(share));
    expect(res.status).toBe(200);
  });
});

describe("Identification du visiteur", () => {
  it("sans session : ni contenu, ni fichier, ni ZIP", async () => {
    const share = await createShare();
    const body = await getJson(share);
    expect(body.status).toBe("identify");
    expect(body.workspace.name).toBe("Cabinet Martin");
    expect(body.documents).toBeUndefined();
    for (const url of [
      urlOf(share, `/files/${docs.inShared}/download`),
      urlOf(share, `/files/${docs.inShared}/preview`),
      urlOf(share, "/download-all"),
      fileUrl(share, docs.inShared, "v1.faux.0.signature"),
    ]) {
      expect((await fetch(url)).status).toBe(401);
    }
  });

  it("le code reçu par e-mail ouvre une session, une seule fois", async () => {
    const share = await createShare();
    await post(share, "/identify/code", { email: "  Client@Dupont.FR " });
    const code = mails.codes.get(CLIENT);
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await post(share, "/identify/verify", {
      email: CLIENT,
      code: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(401);

    const ok = await post(share, "/identify/verify", { email: CLIENT, code });
    const { session, needsProfile } = await ok.json();
    expect(needsProfile).toBe(true);
    const reused = await post(share, "/identify/verify", {
      email: CLIENT,
      code,
    });
    expect(reused.status).toBe(401);

    const body = await getJson(share, session);
    expect(body.status).toBe("ready");
    expect(body.visitor.email).toBe(CLIENT);
  });

  it("le code est plafonné à 5 essais", async () => {
    const share = await createShare();
    await post(share, "/identify/code", { email: CLIENT });
    const code = mails.codes.get(CLIENT);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      await post(share, "/identify/verify", { email: CLIENT, code: wrong });
    }
    const late = await post(share, "/identify/verify", { email: CLIENT, code });
    expect(late.status).toBe(401);
  });

  it("une session ne sert ni à un autre accès, ni sous une autre adresse", async () => {
    const share = await createShare();
    const other = await createShare();
    const session = await identify(share);
    expect((await getJson(other, session)).status).toBe("identify");
    expect((await fetch(fileUrl(other, docs.inShared, session))).status).toBe(
      401,
    );
    const [v, , expires, signature] = session.split(".");
    const forged = [
      v,
      Buffer.from("autre@pirate.fr").toString("base64url"),
      expires,
      signature,
    ].join(".");
    expect((await getJson(share, forged)).status).toBe("identify");
  });

  it("enregistre le nom à la première visite et compte les visites", async () => {
    const share = await createShare();
    const session = await identify(share);
    await post(share, "/profile", {
      session,
      firstName: "Jeanne",
      lastName: "Dupont",
    });
    await getJson(share, session);
    await getJson(share, session);
    const res = await fetch(fileUrl(share, docs.inShared, session));
    await res.text();
    await vi.waitFor(async () => {
      const saved = await DocumentShare.findById(share._id).lean();
      expect(saved.visitors[0].downloadCount).toBe(1);
    });
    const saved = await DocumentShare.findById(share._id).lean();
    expect(saved.visitors).toHaveLength(1);
    expect(saved.visitors[0]).toMatchObject({
      email: CLIENT,
      firstName: "Jeanne",
      lastName: "Dupont",
      visitCount: 2,
    });
    expect(saved.stats.totalViews).toBe(2);
    expect(saved.stats.totalDownloads).toBe(1);

    const again = await identify(share);
    const verify = await getJson(share, again);
    expect(verify.visitor.firstName).toBe("Jeanne");
  });
});

describe("Contenu d'un accès", () => {
  it("montre les dossiers choisis et leurs sous-dossiers, rien d'autre", async () => {
    const share = await createShare({ folderIds: [ids.shared, ids.sibling] });
    const body = await getJson(share, await identify(share));
    expect(body.rootFolderIds.sort()).toEqual(
      [String(ids.shared), String(ids.sibling)].sort(),
    );
    expect(body.folders.map((f) => f.name).sort()).toEqual([
      "Client Dupont",
      "Contrats",
      "Factures Dupont",
    ]);
    expect(body.documents.map((d) => d.name).sort()).toEqual([
      "contrat.pdf",
      "devis.pdf",
      "facture.pdf",
    ]);
  });

  it("donne la couleur des dossiers, seulement si c'est une couleur", async () => {
    await SharedFolder.updateOne({ _id: ids.shared }, { color: "#22c55e" });
    await SharedFolder.updateOne(
      { _id: ids.sibling },
      { color: "red;background:url(x)" },
    );
    const share = await createShare({ folderIds: [ids.shared, ids.sibling] });
    const body = await getJson(share, await identify(share));
    const colorOf = (id) => body.folders.find((f) => f.id === String(id)).color;
    expect(colorOf(ids.shared)).toBe("#22c55e");
    expect(colorOf(ids.sibling)).toBe(null);
  });

  it("un sous-dossier choisi avec son parent n'est pas montré deux fois", async () => {
    const share = await createShare({ folderIds: [ids.shared, ids.child] });
    const body = await getJson(share, await identify(share));
    expect(body.rootFolderIds).toEqual([String(ids.shared)]);
  });

  it("lit le premier format (un seul dossier)", async () => {
    const share = await createShare({ folderIds: [], folderId: ids.sibling });
    const body = await getJson(share, await identify(share));
    expect(body.documents.map((d) => d.name)).toEqual(["facture.pdf"]);
  });

  it("n'expose rien d'interne", async () => {
    const share = await createShare();
    const res = await fetch(urlOf(share, "", q(await identify(share))));
    const text = await res.text();
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    for (const secret of [
      "cle-secrete",
      "r2.test",
      "Auteur Interne",
      "commentaire interne",
      "salaires",
      "RH confidentiel",
      String(owner),
      share.token,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("sert les fichiers de la portée, sans cache et sous leur vrai nom", async () => {
    await SharedDocument.updateOne(
      { _id: docs.inChild },
      { originalName: "Contrat signé.pdf" },
    );
    const share = await createShare();
    const session = await identify(share);
    for (const kind of ["download", "preview"]) {
      const res = await fetch(fileUrl(share, docs.inChild, session, kind));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toBe("contenu:cle-secrete/contrat.pdf");
    }
    const res = await fetch(fileUrl(share, docs.inChild, session));
    expect(res.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''Contrat%20sign%C3%A9.pdf",
    );
  });

  it("l'aperçu s'affiche depuis le site, une autre origine que l'API", async () => {
    await SharedDocument.updateOne(
      { _id: docs.inChild },
      { originalName: "logo.png", mimeType: "image/png" },
    );
    const share = await createShare();
    const session = await identify(share);
    const res = await fetch(fileUrl(share, docs.inChild, session, "preview"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Sans « cross-origin », le navigateur refuse l'image dans la page du
    // visiteur (helmet pose « same-origin » sur toute l'API)
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    // Un fichier hors de la portée ne gagne pas cet en-tête
    const refused = await fetch(
      fileUrl(share, docs.inPrivate, session, "preview"),
    );
    expect(refused.status).toBe(404);
    expect(refused.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
  });

  it("refuse tout fichier hors de la portée", async () => {
    const share = await createShare();
    const session = await identify(share);
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
        const res = await fetch(fileUrl(share, documentId, session, kind));
        expect(res.status).toBe(404);
      }
    }
  });

  it("le ZIP réunit les dossiers choisis, sans branche privée ni corbeille", async () => {
    const share = await createShare({
      name: "Dupont",
      folderIds: [ids.shared, ids.sibling],
    });
    const res = await fetch(
      urlOf(share, "/download-all", q(await identify(share))),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Dupont.zip");
    const zip = Buffer.from(await res.arrayBuffer()).toString("latin1");
    for (const present of ["devis.pdf", "contrat.pdf", "facture.pdf"]) {
      expect(zip).toContain(present);
    }
    for (const absent of [
      "salaires.pdf",
      "paie.pdf",
      "ancien.pdf",
      "jete.pdf",
      "RH confidentiel",
    ]) {
      expect(zip).not.toContain(absent);
    }
  });

  it("un dossier fermé sort de l'accès, les autres restent", async () => {
    const share = await createShare({ folderIds: [ids.shared, ids.sibling] });
    const session = await identify(share);
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { visibility: "private" },
    );
    const body = await getJson(share, session);
    expect(body.documents.map((d) => d.name)).toEqual(["facture.pdf"]);
    expect((await fetch(fileUrl(share, docs.inShared, session))).status).toBe(
      404,
    );
  });

  it("répond 404 à un jeton inconnu ou mal formé", async () => {
    expect(
      (await fetch(`${baseUrl}/api/public-documents/${"a".repeat(64)}`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${baseUrl}/api/public-documents/${encodeURIComponent('{"$ne":null}')}`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("Fermeture d'un accès", () => {
  const expectClosed = async (share, session) => {
    expect((await fetch(urlOf(share, "", q(session)))).status).toBe(410);
    expect((await fetch(fileUrl(share, docs.inShared, session))).status).toBe(
      410,
    );
    expect(
      (await fetch(urlOf(share, "/download-all", q(session)))).status,
    ).toBe(410);
    expect(
      (await post(share, "/identify/code", { email: CLIENT })).status,
    ).toBe(410);
  };

  it("désactivé, expiré, ou tous ses dossiers fermés", async () => {
    const share = await createShare();
    const session = await identify(share);
    await DocumentShare.updateOne({ _id: share._id }, { isActive: false });
    await expectClosed(share, session);

    await DocumentShare.updateOne(
      { _id: share._id },
      { isActive: true, expiresAt: new Date(Date.now() - 1000) },
    );
    await expectClosed(share, session);

    await DocumentShare.updateOne({ _id: share._id }, { expiresAt: null });
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { trashedAt: new Date() },
    );
    await expectClosed(share, session);
  });

  it("dossier public rangé sous un parent privé", async () => {
    const share = await createShare();
    const session = await identify(share);
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { parentId: ids.privateChild },
    );
    await SharedFolder.updateOne({ _id: ids.privateChild }, { parentId: null });
    await expectClosed(share, session);
  });
});

describe("Accès protégé par mot de passe", () => {
  it("le mot de passe précède l'identification", async () => {
    const share = await createShare({ password: "secret-123" });
    expect((await getJson(share)).status).toBe("password");
    expect(
      (await post(share, "/identify/code", { email: CLIENT })).status,
    ).toBe(401);
    expect(mails.codes.size).toBe(0);

    expect((await post(share, "/unlock", { password: "mauvais" })).status).toBe(
      401,
    );
    expect(
      (await post(share, "/unlock", { password: { $ne: null } })).status,
    ).toBe(401);
    const { accessToken } = await (
      await post(share, "/unlock", { password: "secret-123" })
    ).json();
    expect(
      (
        await (
          await fetch(
            urlOf(share, "", `?access=${encodeURIComponent(accessToken)}`),
          )
        ).json()
      ).status,
    ).toBe("identify");

    const session = await identify(share, CLIENT, accessToken);
    expect((await getJson(share, session)).status).toBe("ready");
  });

  it("changer le mot de passe coupe les sessions ouvertes", async () => {
    const share = await createShare({ password: "secret-123" });
    const { accessToken } = await (
      await post(share, "/unlock", { password: "secret-123" })
    ).json();
    const session = await identify(share, CLIENT, accessToken);
    await shareResolvers.Mutation.updateDocumentShare(
      null,
      {
        workspaceId: ws,
        id: String(share._id),
        input: { password: "nouveau-789" },
      },
      asOwner(),
    );
    expect((await getJson(share, session)).status).toBe("password");
    expect((await fetch(fileUrl(share, docs.inShared, session))).status).toBe(
      401,
    );
  });

  it("les essais en échec sont plafonnés", async () => {
    const share = await createShare({ password: "secret-123" });
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await post(share, "/unlock", { password: "mauvais" });
    }
    expect(last.status).toBe(429);
    expect(
      (await post(share, "/unlock", { password: "secret-123" })).status,
    ).toBe(429);
  });
});

describe("Visiteur retiré et demande d'accès", () => {
  const M = shareResolvers.Mutation;

  it("retirer l'accès coupe la session, la demande d'accès le rétablit", async () => {
    const share = await createShare();
    const session = await identify(share);
    await post(share, "/profile", { session, firstName: "Jeanne" });
    const args = { workspaceId: ws, id: String(share._id) };

    await M.revokeDocumentShareVisitor(
      null,
      { ...args, email: "CLIENT@dupont.fr", reason: "Fin de mission" },
      asOwner(),
    );
    const banned = await getJson(share, session);
    expect(banned.status).toBe("banned");
    expect(banned.documents).toBeUndefined();
    expect((await fetch(fileUrl(share, docs.inShared, session))).status).toBe(
      403,
    );
    expect(
      (await fetch(urlOf(share, "/download-all", q(session)))).status,
    ).toBe(403);

    // Une nouvelle identification ne contourne pas le retrait
    expect((await getJson(share, await identify(share))).status).toBe("banned");

    await post(share, "/access-request", { session, message: "Merci" });
    await post(share, "/access-request", { session, message: "Doublon" });
    const [listed] = await shareResolvers.Query.documentShares(
      null,
      { workspaceId: ws },
      asOwner(),
    );
    expect(listed.pendingRequestsCount).toBe(1);
    expect(listed.accessRequests[0]).toMatchObject({
      email: CLIENT,
      name: "Jeanne",
      message: "Merci",
    });
    expect(listed.visitors[0].isBanned).toBe(true);
    expect((await getJson(share, session)).accessRequest).toBe("pending");

    await M.approveDocumentShareRequest(
      null,
      { ...args, requestId: listed.accessRequests[0].id },
      asOwner(),
    );
    expect((await getJson(share, session)).status).toBe("ready");
    expect(mails.approved).toHaveLength(1);
    expect(mails.approved[0]).toMatchObject({
      to: CLIENT,
      workspaceName: "Cabinet Martin",
      shareUrl: `https://app.test/public/documents/${share.token}`,
    });
  });

  it("une demande refusée laisse l'accès fermé et prévient le visiteur", async () => {
    const share = await createShare();
    const session = await identify(share);
    const args = { workspaceId: ws, id: String(share._id) };
    await M.revokeDocumentShareVisitor(
      null,
      { ...args, email: CLIENT },
      asOwner(),
    );
    await post(share, "/access-request", { session });
    const saved = await DocumentShare.findById(share._id);
    await M.rejectDocumentShareRequest(
      null,
      { ...args, requestId: String(saved.accessRequests[0]._id) },
      asOwner(),
    );
    const body = await getJson(share, session);
    expect(body.status).toBe("banned");
    expect(body.accessRequest).toBe("rejected");
    expect(mails.rejected.map((m) => m.to)).toEqual([CLIENT]);
    await expect(
      M.approveDocumentShareRequest(
        null,
        { ...args, requestId: String(saved.accessRequests[0]._id) },
        asOwner(),
      ),
    ).rejects.toThrow("non trouvé");
  });

  it("rétablir un visiteur sans demande", async () => {
    const share = await createShare();
    const session = await identify(share);
    const args = { workspaceId: ws, id: String(share._id), email: CLIENT };
    await M.revokeDocumentShareVisitor(null, args, asOwner());
    await M.unbanDocumentShareVisitor(null, args, asOwner());
    expect((await getJson(share, session)).status).toBe("ready");
  });

  it("un visiteur qui a accès ne peut pas déposer de demande", async () => {
    const share = await createShare();
    const session = await identify(share);
    expect((await post(share, "/access-request", { session })).status).toBe(
      400,
    );
  });
});

describe("Gestion des accès", () => {
  const {
    createDocumentShare,
    updateDocumentShare,
    revokeDocumentShare,
    deleteDocumentShare,
  } = shareResolvers.Mutation;
  const { documentShares } = shareResolvers.Query;
  const create = (input, context = asOwner()) =>
    createDocumentShare(null, { workspaceId: ws, input }, context);

  it("crée un accès sur plusieurs dossiers, sans mot de passe en clair", async () => {
    const share = await create({
      folderIds: [String(ids.shared), String(ids.sibling), String(ids.shared)],
      name: " Dupont ",
      password: "secret-123",
    });
    expect(share.name).toBe("Dupont");
    expect(share.folders.map((f) => f.name)).toEqual([
      "Client Dupont",
      "Factures Dupont",
    ]);
    expect(share.hasPassword).toBe(true);
    expect(share.shareUrl).toMatch(
      /^https:\/\/app\.test\/public\/documents\/[0-9a-f]{64}$/,
    );
    const saved = await DocumentShare.findById(share.id).lean();
    expect(saved.passwordHash).not.toContain("secret-123");
  });

  it("refuse aucun dossier, un dossier privé, à la corbeille ou d'un autre espace", async () => {
    await expect(create({ folderIds: [] })).rejects.toThrow("au moins un");
    for (const folderId of [
      ids.privateChild,
      ids.trashedChild,
      ids.underPrivate,
    ]) {
      await expect(
        create({ folderIds: [String(ids.shared), String(folderId)] }),
      ).rejects.toThrow("ne peut pas être partagé");
    }
    await expect(
      create({ folderIds: [String(ids.otherWorkspace)] }),
    ).rejects.toThrow("non trouvé");
    await expect(create({ folderIds: ["pas-un-id"] })).rejects.toThrow(
      "non trouvé",
    );
    expect(await DocumentShare.countDocuments()).toBe(0);
  });

  it("modifie les dossiers d'un accès : le visiteur voit le changement", async () => {
    const created = await create({ folderIds: [String(ids.shared)] });
    const share = await DocumentShare.findById(created.id);
    const session = await identify(share);
    await updateDocumentShare(
      null,
      {
        workspaceId: ws,
        id: created.id,
        input: { folderIds: [String(ids.sibling)] },
      },
      asOwner(),
    );
    const body = await getJson(share, session);
    expect(body.documents.map((d) => d.name)).toEqual(["facture.pdf"]);
  });

  it("refuse une expiration passée et un mot de passe trop court", async () => {
    await expect(
      create({
        folderIds: [String(ids.shared)],
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow("futur");
    await expect(
      create({ folderIds: [String(ids.shared)], password: "abc" }),
    ).rejects.toThrow("mot de passe");
  });

  it("exige l'action « share » : ni Membre ni Comptable par défaut", async () => {
    const share = await createShare();
    for (const userId of [viewer, accountant]) {
      const context = buildContext({ userId, organizationId: workspaceId });
      await expect(
        create({ folderIds: [String(ids.shared)] }, context),
      ).rejects.toThrow();
      await expect(
        documentShares(null, { workspaceId: ws }, context),
      ).rejects.toThrow();
      await expect(
        shareResolvers.Mutation.revokeDocumentShareVisitor(
          null,
          { workspaceId: ws, id: String(share._id), email: CLIENT },
          context,
        ),
      ).rejects.toThrow();
    }
    expect(await DocumentShare.countDocuments()).toBe(1);
  });

  it("répartit l'action entre les rôles prédéfinis", () => {
    const has = (role) =>
      PREDEFINED_ROLES[role].actions.sharedDocuments.includes("share");
    expect(["owner", "admin", "member"].every(has)).toBe(true);
    expect(has("viewer")).toBe(false);
    expect(has("accountant")).toBe(false);
  });

  it("un accès d'un autre espace reste introuvable", async () => {
    const foreign = await DocumentShare.create({
      token: DocumentShare.generateToken(),
      workspaceId: otherWorkspaceId,
      folderIds: [ids.otherWorkspace],
      createdBy: owner,
    });
    const args = { workspaceId: ws, id: String(foreign._id) };
    const M = shareResolvers.Mutation;
    for (const call of [
      () =>
        updateDocumentShare(
          null,
          { ...args, input: { isActive: true } },
          asOwner(),
        ),
      () => revokeDocumentShare(null, args, asOwner()),
      () => deleteDocumentShare(null, args, asOwner()),
      () =>
        M.revokeDocumentShareVisitor(
          null,
          { ...args, email: CLIENT },
          asOwner(),
        ),
      () =>
        M.unbanDocumentShareVisitor(
          null,
          { ...args, email: CLIENT },
          asOwner(),
        ),
    ]) {
      await expect(call()).rejects.toThrow("non trouvé");
    }
    expect(await documentShares(null, { workspaceId: ws }, asOwner())).toEqual(
      [],
    );
  });

  it("révoque, réactive et supprime : effet immédiat sur l'URL publique", async () => {
    const created = await create({ folderIds: [String(ids.shared)] });
    const share = await DocumentShare.findById(created.id);
    const session = await identify(share);
    const args = { workspaceId: ws, id: created.id };

    await revokeDocumentShare(null, args, asOwner());
    expect((await fetch(urlOf(share, "", q(session)))).status).toBe(410);
    await updateDocumentShare(
      null,
      { ...args, input: { isActive: true } },
      asOwner(),
    );
    expect((await fetch(urlOf(share, "", q(session)))).status).toBe(200);
    await deleteDocumentShare(null, args, asOwner());
    expect((await fetch(urlOf(share, "", q(session)))).status).toBe(404);
  });

  it("abonnement échu : on ne crée ni ne modifie plus, mais on coupe l'accès", async () => {
    const created = await create({ folderIds: [String(ids.shared)] });
    const other = await create({ folderIds: [String(ids.sibling)] });
    await mongoose.connection.db.collection("subscription").deleteMany({});
    invalidateOrgCache();
    invalidateSubCache(ws);
    const args = { workspaceId: ws, id: created.id };
    const M = shareResolvers.Mutation;

    await expect(create({ folderIds: [String(ids.shared)] })).rejects.toThrow();
    await expect(
      updateDocumentShare(
        null,
        { ...args, input: { isActive: true } },
        asOwner(),
      ),
    ).rejects.toThrow();

    expect((await revokeDocumentShare(null, args, asOwner())).isActive).toBe(
      false,
    );
    const banned = await M.revokeDocumentShareVisitor(
      null,
      { ...args, email: CLIENT },
      asOwner(),
    );
    expect(banned.bannedEmails.map((b) => b.email)).toEqual([CLIENT]);
    await deleteDocumentShare(
      null,
      { workspaceId: ws, id: other.id },
      asOwner(),
    );
    expect(await DocumentShare.countDocuments()).toBe(1);
  });

  it("signale un dossier devenu privé dans la liste", async () => {
    await create({ folderIds: [String(ids.shared), String(ids.sibling)] });
    await SharedFolder.updateOne(
      { _id: ids.shared },
      { visibility: "private" },
    );
    const [share] = await documentShares(null, { workspaceId: ws }, asOwner());
    expect(share.isFolderAvailable).toBe(true);
    expect(share.folders.map((f) => f.available)).toEqual([false, true]);
  });

  it("supprimer un dossier définitivement le retire des accès", async () => {
    const both = await create({
      folderIds: [String(ids.shared), String(ids.sibling)],
    });
    const only = await create({ folderIds: [String(ids.shared)] });
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
    expect(remaining.map((s) => String(s._id))).toEqual([both.id]);
    expect(remaining[0].folderIds.map(String)).toEqual([String(ids.sibling)]);
    expect(await DocumentShare.findById(only.id)).toBeNull();
  });
});
