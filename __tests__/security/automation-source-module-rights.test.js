/**
 * Automatisations de documents : la page source (factures, devis, achats,
 * transactions…) doit être visible pour le rôle.
 *
 * Une automatisation copie les PDF de sa page source dans un dossier
 * partagé. Les contrôles ne portaient que sur « Documents partagés » : un
 * rôle sans les factures créait « Facture payée → dossier X », la lançait,
 * et lisait ensuite toutes les factures de l'espace dans ce dossier.
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
import DocumentAutomation from "../../src/models/DocumentAutomation.js";
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";

const { Query, Mutation } = documentAutomationResolvers;
const { ObjectId } = mongoose.Types;

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const archivist = buildUserId(); // documents partagés et devis, sans factures
const folderId = new ObjectId();

const ws = () => String(workspaceId);
const ctxOf = (userId) => buildContext({ userId, organizationId: ws() });
const call = (resolver, name, args, userId = archivist) =>
  resolver[name](null, { workspaceId: ws(), ...args }, ctxOf(userId), {
    fieldName: name,
  });

const input = (triggerType) => ({
  name: "Classement",
  triggerType,
  actionConfig: { targetFolderId: String(folderId) },
});

async function seedInvoiceAutomation() {
  const _id = new ObjectId();
  await DocumentAutomation.collection.insertOne({
    _id,
    workspaceId,
    name: "Factures payées",
    triggerType: "INVOICE_PAID",
    isActive: true,
    createdBy: owner,
    actionConfig: { targetFolderId: folderId },
  });
  return String(_id);
}

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
  await SharedFolder.collection.insertOne({
    _id: folderId,
    workspaceId,
    name: "Classement",
    trashedAt: null,
    createdBy: owner,
  });
});

describe("automatisations et page source", () => {
  it("refuse de créer une automatisation sur une page que le rôle ne voit pas", async () => {
    await expect(
      call(Mutation, "createDocumentAutomation", {
        input: input("INVOICE_PAID"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await DocumentAutomation.countDocuments()).toBe(0);

    // Devis visibles : permis
    const created = await call(Mutation, "createDocumentAutomation", {
      input: input("QUOTE_ACCEPTED"),
    });
    expect(created.triggerType).toBe("QUOTE_ACCEPTED");
  });

  it("refuse de basculer une automatisation vers une page invisible", async () => {
    const created = await call(Mutation, "createDocumentAutomation", {
      input: input("QUOTE_ACCEPTED"),
    });
    await expect(
      call(Mutation, "updateDocumentAutomation", {
        id: String(created._id),
        input: { triggerType: "PURCHASE_INVOICE_PAID" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuse de lancer, activer, modifier ou lister celle du super admin", async () => {
    const id = await seedInvoiceAutomation();
    for (const [resolver, name, args] of [
      [Mutation, "runDocumentAutomation", { id }],
      [Mutation, "toggleDocumentAutomation", { id }],
      [
        Mutation,
        "updateDocumentAutomation",
        { id, input: { name: "Renommée" } },
      ],
      [Query, "documentsForAutomation", { automationId: id }],
      [
        Mutation,
        "processAutomationDocument",
        {
          automationId: id,
          documentId: String(new ObjectId()),
          documentType: "invoice",
          pdfBase64: "",
        },
      ],
    ]) {
      await expect(call(resolver, name, args)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    // Le super admin, lui, la voit et la lance
    await expect(
      call(Query, "documentsForAutomation", { automationId: id }, owner),
    ).resolves.toBeDefined();
  });
});
