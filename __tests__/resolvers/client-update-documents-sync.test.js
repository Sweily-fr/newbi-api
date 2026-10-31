/**
 * Modifier un contact ne met à jour que les BROUILLONS qui le référencent.
 * Les documents émis (factures en attente, annulées ou payées, devis signés
 * ou importés, bons de commande hors brouillon) gardent le client figé à
 * leur émission, champs « sur les documents » compris.
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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import clientResolvers from "../../src/resolvers/client.js";

const { ObjectId } = mongoose.Types;
const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

const DOCUMENT_FIELDS = [{ label: "Code fournisseur", value: "CF-778" }];

let client;
const snapshot = () => ({
  id: client._id.toString(),
  type: "COMPANY",
  name: "Alpha SARL",
  email: client.email,
  siret: client.siret,
  address: { street: "1 rue A", city: "Paris", postalCode: "75001" },
  documentFields: DOCUMENT_FIELDS,
});

async function seed(Model, status, extra = {}) {
  const _id = new ObjectId();
  await Model.collection.insertOne({
    _id,
    workspaceId: organizationId,
    status,
    number: `N-${status}-${Math.random().toString(36).slice(2, 7)}`,
    client: snapshot(),
    ...extra,
  });
  return _id;
}

const clientOf = async (Model, _id) =>
  (await Model.collection.findOne({ _id })).client;

const update = (input) =>
  clientResolvers.Mutation.updateClient(
    null,
    { id: client._id.toString(), input },
    ctx(),
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  client = await Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      type: "COMPANY",
      name: "Alpha SARL",
      siret: "12345678901234",
    }),
  );
});

describe("updateClient : synchronisation des documents", () => {
  it("les documents émis gardent le client figé et ses champs sur les documents", async () => {
    const issued = [
      [Invoice, await seed(Invoice, "PENDING", { superPdpInvoiceId: "sp-1" })],
      [Invoice, await seed(Invoice, "CANCELED")],
      [Invoice, await seed(Invoice, "COMPLETED")],
      [Quote, await seed(Quote, "COMPLETED")],
      [Quote, await seed(Quote, "IMPORTED")],
      [
        Quote,
        await seed(Quote, "PENDING", { convertedToInvoice: new ObjectId() }),
      ],
      [Quote, await seed(Quote, "PENDING")],
      [PurchaseOrder, await seed(PurchaseOrder, "CONFIRMED")],
      [PurchaseOrder, await seed(PurchaseOrder, "CANCELED")],
    ];

    await update({ name: "Alpha SAS", phone: "0102030405" });

    for (const [Model, id] of issued) {
      const stored = await clientOf(Model, id);
      expect(stored.name).toBe("Alpha SARL");
      expect(stored.documentFields).toEqual(DOCUMENT_FIELDS);
    }
  });

  it("les brouillons reçoivent la fiche à jour sans perdre leurs champs sur les documents", async () => {
    const drafts = [
      [Invoice, await seed(Invoice, "DRAFT")],
      [Quote, await seed(Quote, "DRAFT")],
      [PurchaseOrder, await seed(PurchaseOrder, "DRAFT")],
    ];

    await update({ name: "Alpha SAS" });

    for (const [Model, id] of drafts) {
      const stored = await clientOf(Model, id);
      expect(stored.name).toBe("Alpha SAS");
      expect(stored.id).toBe(client._id.toString());
      expect(stored.documentFields).toEqual(DOCUMENT_FIELDS);
    }
  });

  it("un simple changement de téléphone ne touche aucun document émis", async () => {
    const invoiceId = await seed(Invoice, "PENDING");
    const before = await clientOf(Invoice, invoiceId);

    await update({ phone: "0607080910" });

    expect(await clientOf(Invoice, invoiceId)).toEqual(before);
  });
});
