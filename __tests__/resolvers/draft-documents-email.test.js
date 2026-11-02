/**
 * Document en brouillon envoyé par e-mail : le client ne reçoit jamais un
 * numéro provisoire.
 *  - Bon de commande, bon de livraison : refusé avec un message, rien n'est
 *    journalisé.
 *  - Devis : l'application mobile installée propose « Envoyer » sur un devis
 *    brouillon. Le devis est d'abord validé (comme « Finaliser »), puis
 *    envoyé avec son numéro définitif.
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

import { startReplicaSet } from "../helpers/numberingSimulation.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: { notify: vi.fn(), create: vi.fn() },
}));
// Envoi réel délégué au service, sauf pour le devis où seul l'ordre des
// opérations est vérifié
vi.mock("../../src/services/documentEmailService.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendDocumentEmail: vi.fn(actual.sendDocumentEmail) };
});

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import DocumentEmailLog from "../../src/models/DocumentEmailLog.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import documentEmailResolvers from "../../src/resolvers/documentEmail.js";
import {
  sendDocumentEmail,
  DOCUMENT_TYPES,
} from "../../src/services/documentEmailService.js";

const workspaceId = buildOrganizationId();
const ws = String(workspaceId);
const owner = buildUserId();
const ctx = () => buildContext({ userId: owner, organizationId: ws });

const client = {
  name: "Client Brouillon",
  email: "brouillon@test.fr",
  type: "COMPANY",
  siret: "12345678901234",
  address: {
    street: "1 rue du Test",
    city: "Paris",
    postalCode: "75001",
    country: "France",
  },
};
const item = { description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20, unit: "" };

async function insertDraft(Model) {
  const _id = new mongoose.Types.ObjectId();
  await Model.collection.insertOne({
    _id,
    workspaceId,
    createdBy: owner,
    number: `DRAFT-${Date.now()}`,
    status: "DRAFT",
    client,
    issueDate: new Date(),
    items: [item],
    createdAt: new Date(),
  });
  return _id;
}

const mail = (documentId) => ({
  documentId: String(documentId),
  emailSubject: "Document",
  emailBody: "Bonjour",
  recipientEmail: "client@exemple.test",
});

// La validation du devis s'exécute dans une transaction : replica set
let replSet;
beforeAll(async () => {
  replSet = await startReplicaSet("draft_email");
}, 180000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await mongoose.connection.db.collection("organization").updateOne(
    { _id: workspaceId },
    { $set: { capitalSocial: "10000", rcs: "Paris B 123 456 789", vatNumber: "FR12345678901" } },
  );
  invalidateOrgCache();
  sendDocumentEmail.mockClear();
});

describe("Bon de commande et bon de livraison en brouillon", () => {
  for (const [label, Model, type] of [
    ["bon de commande", PurchaseOrder, DOCUMENT_TYPES.PURCHASE_ORDER],
    ["bon de livraison", DeliveryNote, DOCUMENT_TYPES.DELIVERY_NOTE],
  ]) {
    it(`${label} : envoi refusé avec un message, rien n'est journalisé`, async () => {
      const id = await insertDraft(Model);
      await expect(
        sendDocumentEmail({ ...mail(id), documentType: type, workspaceId: ws }),
      ).rejects.toThrow(new RegExp(`${label} est un brouillon`));
      expect(await DocumentEmailLog.countDocuments({ documentId: id })).toBe(0);
    });
  }
});

describe("Devis en brouillon envoyé (application mobile)", () => {
  it("le devis est validé avant l'envoi : l'e-mail part avec son numéro définitif", async () => {
    const draft = await quoteResolvers.Mutation.createQuote(
      null,
      {
        workspaceId: ws,
        input: {
          issueDate: new Date().toISOString(),
          status: "DRAFT",
          client,
          items: [item],
        },
      },
      ctx(),
    );
    expect(draft.status).toBe("DRAFT");

    let numberAtSend = null;
    sendDocumentEmail.mockImplementationOnce(async ({ documentId }) => {
      const quote = await Quote.findById(documentId).lean();
      numberAtSend = { status: quote.status, number: quote.number };
      return { success: true };
    });

    const result = await documentEmailResolvers.Mutation.sendQuoteEmail(
      null,
      { workspaceId: ws, input: mail(draft.id || draft._id) },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(numberAtSend.status).toBe("PENDING");
    expect(numberAtSend.number).toMatch(/^\d{4}$/);
  });

  it("devis déjà émis : envoyé tel quel, rien n'est revalidé", async () => {
    const _id = new mongoose.Types.ObjectId();
    await Quote.collection.insertOne({
      _id,
      workspaceId,
      createdBy: owner,
      number: "0007",
      prefix: "D-202611",
      status: "PENDING",
      client,
      issueDate: new Date(),
      items: [item],
      createdAt: new Date(),
    });
    sendDocumentEmail.mockImplementationOnce(async () => ({ success: true }));

    await documentEmailResolvers.Mutation.sendQuoteEmail(
      null,
      { workspaceId: ws, input: mail(_id) },
      ctx(),
    );

    const quote = await Quote.findById(_id).lean();
    expect(quote.number).toBe("0007");
    expect(quote.status).toBe("PENDING");
  });
});
