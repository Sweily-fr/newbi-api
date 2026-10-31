/**
 * Supprimer un contact : retiré des listes où il était rangé (leur nombre
 * de contacts reste juste) ; refusé s'il a un bon de livraison ou un avoir,
 * comme pour une facture, un devis ou un bon de commande.
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
import ClientList from "../../src/models/ClientList.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import CreditNote from "../../src/models/CreditNote.js";
import mongoose from "mongoose";
import clientResolvers from "../../src/resolvers/client.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let client;

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
    buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
  );
});

const remove = () =>
  clientResolvers.Mutation.deleteClient(
    null,
    { id: client._id.toString() },
    ctx(),
  );

const list = (name, clients) =>
  ClientList.create({
    name,
    workspaceId: organizationId,
    createdBy: userId,
    clients,
  });

describe("deleteClient", () => {
  it("retire le contact des listes où il était rangé", async () => {
    const other = await Client.create(
      buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
    );
    const vip = await list("VIP", [client._id, other._id]);
    const prospects = await list("Prospects", [client._id]);

    await remove();

    expect(await Client.findById(client._id)).toBeNull();
    expect((await ClientList.findById(vip._id)).clients.map(String)).toEqual([
      other._id.toString(),
    ]);
    expect((await ClientList.findById(prospects._id)).clients).toHaveLength(0);
  });

  for (const [nom, Model, usedIn] of [
    ["un bon de livraison", DeliveryNote, "bons de livraison"],
    ["un avoir", CreditNote, "avoirs"],
  ]) {
    it(`refusé quand le contact a ${nom}, contact et listes intacts`, async () => {
      const vip = await list("VIP", [client._id]);
      await Model.collection.insertOne({
        _id: new mongoose.Types.ObjectId(),
        workspaceId: organizationId,
        status: "PENDING",
        client: { id: client._id.toString(), name: client.name },
      });

      await expect(remove()).rejects.toThrow(usedIn);

      expect(await Client.findById(client._id)).not.toBeNull();
      expect((await ClientList.findById(vip._id)).clients).toHaveLength(1);
      const [result] = await Promise.all([
        clientResolvers.Client.hasDocuments(client, {}, {}),
      ]);
      expect(result).toBe(true);
    });
  }
});
