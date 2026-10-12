/**
 * Documents partagés : dossiers privés (`visibility` / `allowedUserIds`).
 *
 * Les queries GraphQL du module masquent les dossiers privés auxquels
 * l'utilisateur n'a pas accès, mais les routes REST de téléchargement et
 * d'aperçu (/api/shared-documents/*) et le transfert créé depuis les
 * documents partagés les ignoraient : un membre qui avait « Voir »
 * téléchargeait un fichier, un dossier privé ou le ZIP d'un dossier parent
 * avec ses sous-dossiers privés.
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
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
  HeadObjectCommand: class {},
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

// Transfert : le ZIP envoyé au stockage des transferts est capturé
const uploaded = vi.hoisted(() => ({ buffer: null }));
vi.mock("../../src/services/cloudflareTransferService.js", () => ({
  default: {
    uploadFile: async (buffer, transferId, fileId, name) => {
      uploaded.buffer = buffer;
      return {
        url: `https://r2.test/${name}`,
        key: `transfers/${name}`,
        size: buffer.length,
      };
    },
  },
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import sharedDocumentRoutes from "../../src/routes/sharedDocumentDownload.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId(); // crée le dossier privé
const editor = buildUserId(); // « Éditeur », hors de la liste du dossier privé
const allowed = buildUserId(); // « Membre », dans la liste du dossier privé

const publicFolder = new mongoose.Types.ObjectId();
const privateFolder = new mongoose.Types.ObjectId();
const publicDoc = new mongoose.Types.ObjectId();
const privateDoc = new mongoose.Types.ObjectId();

const PRIVATE_FOLDER_NAME = "Dossier confidentiel";
const PRIVATE_FILE = "salaires.pdf";
const PUBLIC_FILE = "facture.pdf";

let server;
let baseUrl;

const ws = () => String(workspaceId);
const asUser = (userId) => {
  auth.user = { _id: userId, id: String(userId), email: "u@test.fr" };
};

const get = (path) => fetch(`${baseUrl}/api/shared-documents${path}`);
const post = (path, body) =>
  fetch(`${baseUrl}/api/shared-documents${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: ws(), ...body }),
  });

// Noms des entrées d'un ZIP (en clair dans les en-têtes, contenu compressé)
const zipText = async (res) =>
  Buffer.from(await res.arrayBuffer()).toString("latin1");

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
  uploaded.buffer = null;
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: editor,
    organizationId: workspaceId,
    role: "member",
  });
  await seedOrgMembership({
    userId: allowed,
    organizationId: workspaceId,
    role: "viewer",
  });
  await SharedFolder.collection.insertMany([
    {
      _id: publicFolder,
      name: "Comptabilité",
      workspaceId,
      parentId: null,
      createdBy: owner,
      visibility: "public",
      allowedUserIds: [],
      trashedAt: null,
    },
    {
      _id: privateFolder,
      name: PRIVATE_FOLDER_NAME,
      workspaceId,
      parentId: publicFolder,
      createdBy: owner,
      visibility: "private",
      allowedUserIds: [allowed],
      trashedAt: null,
    },
  ]);
  const doc = (id, name, folderId) => ({
    _id: id,
    name,
    originalName: name,
    fileUrl: `https://r2.test/${name}`,
    fileKey: `espace/${name}`,
    mimeType: "application/pdf",
    fileSize: `contenu:espace/${name}`.length,
    workspaceId,
    folderId,
    uploadedBy: owner,
    trashedAt: null,
  });
  await SharedDocument.collection.insertMany([
    doc(publicDoc, PUBLIC_FILE, publicFolder),
    doc(privateDoc, PRIVATE_FILE, privateFolder),
  ]);
});

describe("Dossier privé : membre hors de la liste", () => {
  beforeEach(() => asUser(editor));

  it("fichier du dossier privé : téléchargement et aperçu refusés (404)", async () => {
    for (const route of ["download-file", "preview-file"]) {
      const res = await get(`/${route}/${privateDoc}?workspaceId=${ws()}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(PRIVATE_FILE);
    }
  });

  it("fichier d'un dossier public : toujours téléchargeable", async () => {
    const res = await get(`/download-file/${publicDoc}?workspaceId=${ws()}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`contenu:espace/${PUBLIC_FILE}`);
  });

  it("dossier privé : ZIP et informations refusés (404)", async () => {
    for (const route of ["download-folder", "folder-info"]) {
      const res = await get(
        `/${route}?folderId=${privateFolder}&workspaceId=${ws()}`,
      );
      expect(res.status).toBe(404);
    }
  });

  it("ZIP du dossier parent : sans le sous-dossier privé ni ses fichiers", async () => {
    const info = await get(
      `/folder-info?folderId=${publicFolder}&workspaceId=${ws()}`,
    );
    expect((await info.json()).data.totalFiles).toBe(1);

    const res = await get(
      `/download-folder?folderId=${publicFolder}&workspaceId=${ws()}`,
    );
    expect(res.status).toBe(200);
    const zip = await zipText(res);
    expect(zip).toContain(PUBLIC_FILE);
    expect(zip).not.toContain(PRIVATE_FILE);
    expect(zip).not.toContain(PRIVATE_FOLDER_NAME);
  });

  it("ZIP de sélection : dossier ou fichier privé refusé, parent sans le privé", async () => {
    expect(
      (
        await post("/download-selection", {
          folderIds: [String(privateFolder)],
        })
      ).status,
    ).toBe(404);
    expect(
      (await post("/download-selection", { documentIds: [String(privateDoc)] }))
        .status,
    ).toBe(404);

    const res = await post("/download-selection", {
      folderIds: [String(publicFolder)],
    });
    expect(res.status).toBe(200);
    const zip = await zipText(res);
    expect(zip).toContain(PUBLIC_FILE);
    expect(zip).not.toContain(PRIVATE_FILE);
    expect(zip).not.toContain(PRIVATE_FOLDER_NAME);
  });

  it("informations de sélection : sans le sous-dossier privé", async () => {
    expect(
      (await post("/selection-info", { documentIds: [String(privateDoc)] }))
        .status,
    ).toBe(404);

    const res = await post("/selection-info", {
      folderIds: [String(publicFolder)],
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.totalFiles).toBe(1);
    expect(JSON.stringify(data)).not.toContain(PRIVATE_FOLDER_NAME);
    expect(JSON.stringify(data)).not.toContain(PRIVATE_FILE);
  });

  it("identifiants de sélection non conformes : refusés (400)", async () => {
    const res = await post("/download-selection", {
      folderIds: [{ $ne: null }],
    });
    expect(res.status).toBe(400);
  });

  it("transfert créé depuis les documents partagés : sans le dossier privé", async () => {
    const create =
      fileTransferResolvers.Mutation.createFileTransferFromSharedDocuments;
    const ctx = () => buildContext({ userId: editor, organizationId: ws() });
    const info = { fieldName: "createFileTransferFromSharedDocuments" };

    await create(
      null,
      { folderIds: [String(publicFolder)], workspaceId: ws() },
      ctx(),
      info,
    );
    const zip = uploaded.buffer.toString("latin1");
    expect(zip).toContain(PUBLIC_FILE);
    expect(zip).not.toContain(PRIVATE_FILE);
    expect(zip).not.toContain(PRIVATE_FOLDER_NAME);

    uploaded.buffer = null;
    await expect(
      create(
        null,
        { documentIds: [String(privateDoc)], workspaceId: ws() },
        ctx(),
        info,
      ),
    ).rejects.toThrow();
    expect(uploaded.buffer).toBeNull();
  });
});

describe("Dossier privé : créateur et membres autorisés", () => {
  for (const [label, userId] of [
    ["membre de la liste", allowed],
    ["créateur", owner],
  ]) {
    it(`${label} : fichier et ZIP du parent complets`, async () => {
      asUser(userId);
      const file = await get(
        `/download-file/${privateDoc}?workspaceId=${ws()}`,
      );
      expect(file.status).toBe(200);
      expect(await file.text()).toBe(`contenu:espace/${PRIVATE_FILE}`);

      const info = await get(
        `/folder-info?folderId=${publicFolder}&workspaceId=${ws()}`,
      );
      expect((await info.json()).data.totalFiles).toBe(2);
    });
  }
});
