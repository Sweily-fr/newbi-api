/**
 * Vie des devis, bons de commande et bons de livraison émis, à l'API comme
 * à l'écran.
 *
 *   - statut à la création : brouillon ou document émis avec « Créer » ;
 *     accepté, livré, annulé… exigent « status » ; « importé » est réservé
 *     à l'import ;
 *   - préfixe fait d'espaces (insécables compris) : préfixe par défaut, le
 *     devis n'est pas pris pour un devis importé (supprimable) ;
 *   - suppression : brouillons seulement (et devis importés) ;
 *   - devis refusé et bon de commande annulé : plus modifiables ;
 *   - réception d'un bon de livraison : jamais réécrite une fois livré, date
 *     ni dans le futur ni avant l'émission.
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

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";
import deliveryNoteResolvers from "../../src/resolvers/deliveryNote.js";

const workspaceId = buildOrganizationId();
const ws = String(workspaceId);
const owner = buildUserId();
const saisie = buildUserId();
const ROLE = "role_saisie_sans_statut";
const ctx = (userId = owner) => buildContext({ userId, organizationId: ws });

const client = {
  name: "Client Cycle",
  email: "cycle@test.fr",
  type: "COMPANY",
  siret: "12345678901234",
  address: { street: "1 rue du Cycle", city: "Paris", postalCode: "75001", country: "France" },
};
const item = (description) => ({ description, quantity: 1, unitPrice: 100, vatRate: 20, unit: "" });
let courriel = 0;
// Un client nouveau par document (adresse e-mail propre : l'API crée le contact)
const input = (description, extra = {}) => ({
  issueDate: new Date().toISOString(),
  client: { ...client, email: `cycle-${++courriel}@test.fr` },
  items: [item(description)],
  ...extra,
});

let numero = 0;
async function insert(Model, overrides) {
  const _id = new mongoose.Types.ObjectId();
  await Model.collection.insertOne({
    _id,
    workspaceId,
    createdBy: owner,
    number: String(++numero).padStart(4, "0"),
    client,
    issueDate: new Date(),
    items: [item("Document existant")],
    linkedInvoices: [],
    headerNotes: "",
    createdAt: new Date(),
    ...overrides,
  });
  return _id;
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({ userId: saisie, organizationId: workspaceId, role: ROLE });
  const db = mongoose.connection.db;
  await db.collection("organization").updateOne(
    { _id: workspaceId },
    { $set: { capitalSocial: "10000", rcs: "Paris B 123 456 789", vatNumber: "FR12345678901" } },
  );
  await db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Saisie",
    permission: "{}",
    actions: {
      quotes: ["view", "create", "edit"],
      purchaseOrders: ["view", "create", "edit"],
      deliveryNotes: ["view", "create", "edit"],
    },
    createdAt: new Date(),
  });
  invalidateOrganizationRoles();
  invalidateOrgCache();
});

describe("statut à la création", () => {
  const createQuote = (userId, data) => quoteResolvers.Mutation.createQuote(null, { workspaceId: ws, input: data }, ctx(userId));
  const createPo = (userId, data) =>
    purchaseOrderResolvers.Mutation.createPurchaseOrder(null, { workspaceId: ws, input: data }, ctx(userId));

  it("devis créé accepté sans le droit d'accepter : refusé, rien de créé", async () => {
    await expect(createQuote(saisie, input("Devis accepté d'office", { status: "COMPLETED" }))).rejects.toThrow(/permission/i);
    expect(await Quote.countDocuments({ "items.description": "Devis accepté d'office" })).toBe(0);
  });

  it("brouillon et devis en attente : permis avec « Créer »", async () => {
    expect((await createQuote(saisie, input("Brouillon du rôle Saisie", { status: "DRAFT" }))).status).toBe("DRAFT");
    expect((await createQuote(saisie, input("Devis en attente du rôle Saisie", { status: "PENDING" }))).status).toBe("PENDING");
  });

  it("devis créé accepté par le propriétaire : permis (il peut accepter)", async () => {
    expect((await createQuote(owner, input("Devis accepté par le propriétaire", { status: "COMPLETED" }))).status).toBe("COMPLETED");
  });

  it("statut « importé » : réservé à l'import, refusé même au propriétaire", async () => {
    await expect(createQuote(owner, input("Devis importé à la main", { status: "IMPORTED" }))).rejects.toThrow(/autorisé/);
    expect(await Quote.countDocuments({ "items.description": "Devis importé à la main" })).toBe(0);
  });

  it("bon de commande créé livré sans « Changer le statut » : refusé", async () => {
    await expect(createPo(saisie, input("Commande livrée d'office", { status: "DELIVERED" }))).rejects.toThrow(/permission/i);
    expect(await PurchaseOrder.countDocuments({ "items.description": "Commande livrée d'office" })).toBe(0);
    expect((await createPo(saisie, input("Commande confirmée du rôle Saisie", { status: "CONFIRMED" }))).status).toBe("CONFIRMED");
  });
});

describe("préfixe fait d'espaces", () => {
  it("devis au préfixe d'espaces insécables : préfixe par défaut, non supprimable une fois accepté", async () => {
    const quote = await quoteResolvers.Mutation.createQuote(
      null,
      { workspaceId: ws, input: input("Devis au préfixe d'espaces", { prefix: "   ", status: "PENDING" }) },
      ctx(),
    );
    expect(quote.prefix).toMatch(/^D-/);
    await quoteResolvers.Mutation.changeQuoteStatus(null, { id: String(quote._id), status: "COMPLETED" }, ctx());
    await expect(quoteResolvers.Mutation.deleteQuote(null, { id: String(quote._id) }, ctx())).rejects.toThrow(/brouillons/);
    expect(await Quote.findById(quote._id)).not.toBeNull();
  });
});

describe("suppression : brouillons seulement", () => {
  it("bon de commande confirmé : refusé ; brouillon : supprimé", async () => {
    const confirmed = await insert(PurchaseOrder, { prefix: "BC-202610", status: "CONFIRMED" });
    const draft = await insert(PurchaseOrder, { prefix: "BC-202610", status: "DRAFT", number: "DRAFT-0001" });
    const remove = (id) => purchaseOrderResolvers.Mutation.deletePurchaseOrder(null, { id: String(id), workspaceId: ws }, ctx());
    await expect(remove(confirmed)).rejects.toThrow(/brouillons/);
    expect(await PurchaseOrder.findById(confirmed)).not.toBeNull();
    expect(await remove(draft)).toBe(true);
  });

  it("bon de livraison expédié : refusé ; brouillon : supprimé", async () => {
    const shipped = await insert(DeliveryNote, { prefix: "BL-202610", status: "SHIPPED" });
    const draft = await insert(DeliveryNote, { prefix: "BL-202610", status: "DRAFT", number: "DRAFT-0001" });
    const remove = (id) => deliveryNoteResolvers.Mutation.deleteDeliveryNote(null, { id: String(id), workspaceId: ws }, ctx());
    await expect(remove(shipped)).rejects.toThrow(/brouillons/);
    expect(await DeliveryNote.findById(shipped)).not.toBeNull();
    expect(await remove(draft)).toBe(true);
  });
});

describe("documents refusés ou annulés", () => {
  it("devis refusé : plus modifiable", async () => {
    const id = await insert(Quote, { prefix: "D-202610", status: "CANCELED" });
    await expect(
      quoteResolvers.Mutation.updateQuote(null, { id: String(id), input: { headerNotes: "Après le refus" } }, ctx()),
    ).rejects.toThrow(/refusé ne peut pas être modifié/);
    expect((await Quote.findById(id)).headerNotes).toBe("");
  });

  it("bon de commande annulé : plus modifiable", async () => {
    const id = await insert(PurchaseOrder, { prefix: "BC-202610", status: "CANCELED" });
    await expect(
      purchaseOrderResolvers.Mutation.updatePurchaseOrder(
        null,
        { id: String(id), workspaceId: ws, input: { headerNotes: "Après l'annulation" } },
        ctx(),
      ),
    ).rejects.toThrow(/annulé ne peut pas être modifié/);
    expect((await PurchaseOrder.findById(id)).headerNotes).toBe("");
  });
});

describe("réception d'un bon de livraison", () => {
  const SIGNATURE = "data:image/png;base64,iVBORw0KGgo=";
  const record = (id, data) =>
    deliveryNoteResolvers.Mutation.recordDeliveryNoteReception(null, { id: String(id), workspaceId: ws, input: data }, ctx());
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  it("bon déjà livré : nouvelle réception refusée, preuve d'origine conservée", async () => {
    const receivedAt = new Date(Date.now() - 86_400_000);
    const id = await insert(DeliveryNote, {
      prefix: "BL-202610",
      status: "DELIVERED",
      receivedBy: "Claire",
      signatureDataUrl: SIGNATURE,
      receivedAt,
    });
    await expect(record(id, { receivedBy: "Autre", signatureDataUrl: "data:image/png;base64,AAAA", receivedAt: "2020-01-01" })).rejects.toThrow(
      /déjà livré/,
    );
    const dn = await DeliveryNote.findById(id);
    expect(dn.receivedBy).toBe("Claire");
    expect(dn.signatureDataUrl).toBe(SIGNATURE);
    expect(dn.receivedAt.getTime()).toBe(receivedAt.getTime());
  });

  it("date dans le futur ou avant l'émission : refusée", async () => {
    const id = await insert(DeliveryNote, { prefix: "BL-202610", status: "SHIPPED", issueDate: new Date(Date.now() - 2 * 86_400_000) });
    await expect(record(id, { receivedBy: "Jeanne", receivedAt: day(30) })).rejects.toThrow(/futur/);
    await expect(record(id, { receivedBy: "Jeanne", receivedAt: "2020-01-01" })).rejects.toThrow(/précéder l'émission/);
    expect((await DeliveryNote.findById(id)).status).toBe("SHIPPED");
  });

  it("date du jour, émis le jour même : acceptée", async () => {
    const id = await insert(DeliveryNote, { prefix: "BL-202610", status: "SHIPPED", issueDate: new Date() });
    const dn = await record(id, { receivedBy: "Jeanne", receivedAt: day(0) });
    expect(dn.status).toBe("DELIVERED");
  });
});
