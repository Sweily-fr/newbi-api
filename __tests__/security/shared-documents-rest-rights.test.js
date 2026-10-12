/**
 * Documents partagés : droit « Voir » du module exigé partout.
 *
 * Les queries GraphQL du module passent par requireRead("sharedDocuments"),
 * mais les routes REST de téléchargement et d'aperçu
 * (/api/shared-documents/*) ne vérifiaient que l'appartenance à l'espace :
 * un rôle sans accès aux documents partagés (page masquée, queries
 * refusées) téléchargeait quand même les fichiers, dossiers en ZIP compris.
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
});

// Utilisateur de la requête (session simulée)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    betterAuthJWTMiddleware: async () => auth.user,
  };
});

// Stockage R2 simulé : renvoie le contenu de la clé demandée
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
vi.mock("../../src/services/cloudflareService.js", () => ({ default: {} }));
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
import { MODULES } from "../../src/config/rolePermissions.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import sharedDocumentRoutes from "../../src/routes/sharedDocumentDownload.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";

const workspaceId = buildOrganizationId();
const withoutView = buildUserId(); // rôle personnalisé sans les documents partagés
const viewer = buildUserId(); // « Membre » : « Voir » partout
const ROLE = `role_${"b".repeat(24)}`;
const folderId = new mongoose.Types.ObjectId();
const documentId = new mongoose.Types.ObjectId();

let server;
let baseUrl;

const asUser = (userId) => {
  auth.user = { _id: userId, id: String(userId), email: "u@test.fr" };
};

const ws = () => String(workspaceId);

// Les six routes REST du module, toutes en lecture
const ROUTES = {
  "download-folder": () =>
    fetch(
      `${baseUrl}/api/shared-documents/download-folder?folderId=${folderId}&workspaceId=${ws()}`,
    ),
  "folder-info": () =>
    fetch(
      `${baseUrl}/api/shared-documents/folder-info?folderId=${folderId}&workspaceId=${ws()}`,
    ),
  "download-selection": () =>
    fetch(`${baseUrl}/api/shared-documents/download-selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentIds: [String(documentId)],
        workspaceId: ws(),
      }),
    }),
  "selection-info": () =>
    fetch(`${baseUrl}/api/shared-documents/selection-info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentIds: [String(documentId)],
        workspaceId: ws(),
      }),
    }),
  "download-file": () =>
    fetch(
      `${baseUrl}/api/shared-documents/download-file/${documentId}?workspaceId=${ws()}`,
    ),
  "preview-file": () =>
    fetch(
      `${baseUrl}/api/shared-documents/preview-file/${documentId}?workspaceId=${ws()}`,
    ),
};

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/api/shared-documents", sharedDocumentRoutes);
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
  invalidateOrganizationRoles();
  await seedOrgMembership({
    userId: withoutView,
    organizationId: workspaceId,
    role: ROLE,
  });
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
  // « Voir » sur toutes les pages, sauf les documents partagés
  const actions = Object.fromEntries(MODULES.map((m) => [m.key, ["view"]]));
  actions.sharedDocuments = [];
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Sans documents partagés",
    actions,
    permission: "{}",
  });
  await SharedFolder.collection.insertOne({
    _id: folderId,
    name: "Comptabilité",
    workspaceId,
    createdBy: viewer,
    parentId: null,
    trashedAt: null,
  });
  await SharedDocument.collection.insertOne({
    _id: documentId,
    name: "bilan.pdf",
    originalName: "bilan.pdf",
    fileUrl: "https://r2.test/bilan.pdf",
    fileKey: "espace/bilan.pdf",
    mimeType: "application/pdf",
    fileSize: "contenu:espace/bilan.pdf".length,
    workspaceId,
    folderId,
    uploadedBy: viewer,
    trashedAt: null,
  });
});

describe("Routes REST des documents partagés", () => {
  for (const [name, call] of Object.entries(ROUTES)) {
    it(`${name} : refusée sans « Voir » sur les documents partagés`, async () => {
      asUser(withoutView);
      const res = await call();
      const body = await res.text();
      expect(res.status).toBe(403);
      expect(body).not.toContain("espace/bilan.pdf");
      expect(body).not.toContain("bilan.pdf");
    });
  }

  it("un rôle avec « Voir » télécharge et prévisualise toujours", async () => {
    asUser(viewer);
    for (const name of ["download-file", "preview-file"]) {
      const res = await ROUTES[name]();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("contenu:espace/bilan.pdf");
    }
    const info = await ROUTES["folder-info"]();
    expect(info.status).toBe(200);
    expect((await info.json()).data.totalFiles).toBe(1);
    const selection = await ROUTES["selection-info"]();
    expect(selection.status).toBe(200);
  });

  it("un non-membre reste refusé", async () => {
    asUser(buildUserId());
    const res = await ROUTES["download-file"]();
    expect(res.status).toBe(403);
  });
});

describe("Queries GraphQL des documents partagés (même grille)", () => {
  const ARGS = { id: String(documentId) };
  for (const name of Object.keys(sharedDocumentResolvers.Query)) {
    it(`${name} : refusée sans « Voir »`, async () => {
      const ctx = buildContext({ userId: withoutView, organizationId: ws() });
      await expect(
        sharedDocumentResolvers.Query[name](
          null,
          { ...ARGS, workspaceId: ws() },
          ctx,
          { fieldName: name },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }
});
