/**
 * Journal des automatisations de documents : seulement les documents des
 * pages que le rôle voit, et rien d'un dossier privé qui lui est fermé
 * (numéro, client dans le nom de fichier, nom du dossier) ; nombre de
 * lignes borné.
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
import SharedFolder from "../../src/models/SharedFolder.js";
import DocumentAutomationLog from "../../src/models/DocumentAutomationLog.js";
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";

const { Query } = documentAutomationResolvers;
const { ObjectId } = mongoose.Types;

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const archivist = buildUserId(); // documents partagés et devis, sans factures
const publicFolder = new ObjectId();
const privateFolder = new ObjectId();
const automationId = new ObjectId();

const ws = () => String(workspaceId);
const ctxOf = (userId) => buildContext({ userId, organizationId: ws() });
const call = (name, args, userId) =>
  Query[name](null, { workspaceId: ws(), ...args }, ctxOf(userId), {
    fieldName: name,
  });

let n = 0;
const log = (overrides) => ({
  _id: new ObjectId(),
  automationId,
  workspaceId,
  sourceDocumentId: new ObjectId(),
  sourceDocumentNumber: `N-${++n}`,
  targetFolderId: publicFolder,
  targetFolderName: "Classement",
  status: "SUCCESS",
  fileName: `document-${n}.pdf`,
  createdAt: new Date(Date.now() - n * 1000),
  ...overrides,
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
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: archivist,
    organizationId: workspaceId,
    role: "role_archiviste",
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: "role_archiviste",
    name: "Archiviste",
    permission: "{}",
    actions: {
      sharedDocuments: ["view", "create", "edit", "delete"],
      quotes: ["view"],
    },
    createdAt: new Date(),
  });
  await SharedFolder.collection.insertMany([
    {
      _id: publicFolder,
      workspaceId,
      name: "Classement",
      trashedAt: null,
      createdBy: owner,
    },
    {
      _id: privateFolder,
      workspaceId,
      name: "Direction",
      visibility: "private",
      allowedUserIds: [],
      trashedAt: null,
      createdBy: owner,
    },
  ]);
  await DocumentAutomationLog.collection.insertMany([
    log({ sourceDocumentType: "quote", sourceDocumentNumber: "D-1" }),
    log({
      sourceDocumentType: "invoice",
      sourceDocumentNumber: "F-1",
      fileName: "facture-F-1-Client secret.pdf",
    }),
    log({
      sourceDocumentType: "quote",
      sourceDocumentNumber: "D-PRIVE",
      targetFolderId: privateFolder,
      targetFolderName: "Direction",
    }),
  ]);
});

describe("Journal des automatisations", () => {
  it("rôle sans les factures ni le dossier privé : seulement les devis du dossier ouvert", async () => {
    const logs = await call("documentAutomationLogs", {}, archivist);
    expect(logs.map((l) => l.sourceDocumentNumber)).toEqual(["D-1"]);
  });

  it("propriétaire : tout le journal", async () => {
    const logs = await call("documentAutomationLogs", {}, owner);
    expect(logs.map((l) => l.sourceDocumentNumber).sort()).toEqual([
      "D-1",
      "D-PRIVE",
      "F-1",
    ]);
  });

  it("nombre de lignes borné à 200", async () => {
    await DocumentAutomationLog.collection.insertMany(
      Array.from({ length: 230 }, () => log({ sourceDocumentType: "quote" })),
    );
    const logs = await call("documentAutomationLogs", { limit: 100000 }, owner);
    expect(logs).toHaveLength(200);
  });
});
