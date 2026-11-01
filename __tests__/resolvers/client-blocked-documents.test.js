/**
 * Contact bloqué : la fenêtre de blocage promet qu'il est « exclu de la
 * création de documents et des communications ». L'API l'applique : création
 * d'un document à son nom et envoi par e-mail d'un document existant refusés.
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

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import deliveryNoteResolvers from "../../src/resolvers/deliveryNote.js";
import {
  assertClientNotBlocked,
  BLOCKED_CLIENT_CREATE_MESSAGE,
  BLOCKED_CLIENT_SEND_MESSAGE,
} from "../../src/utils/blockedClient.js";
import {
  sendDocumentEmail,
  DOCUMENT_TYPES,
} from "../../src/services/documentEmailService.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let blocked;
let active;

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
  await mongoose.connection.db.collection("organization").updateOne(
    { _id: organizationId },
    {
      $set: {
        capitalSocial: "10000",
        rcs: "Paris B 123 456 789",
        vatNumber: "FR12345678901",
      },
    },
  );
  blocked = await Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      name: "Client Bloqué SARL",
      email: "bloque@exemple.test",
      isBlocked: true,
      blockedReason: "Impayés",
    }),
  );
  active = await Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      name: "Client Actif SARL",
      email: "actif@exemple.test",
    }),
  );
});

const dnInput = (client) => ({
  items: [{ description: "Palette", quantity: 1, unit: "palette" }],
  client: {
    id: client._id.toString(),
    name: client.name,
    email: client.email,
    type: "COMPANY",
    address: {
      street: "1 rue Test",
      city: "Lyon",
      postalCode: "69001",
      country: "France",
    },
  },
  issueDate: new Date().toISOString(),
});

describe("assertClientNotBlocked", () => {
  it("refuse un contact bloqué de l'espace", async () => {
    await expect(
      assertClientNotBlocked(organizationId, blocked._id),
    ).rejects.toThrow(BLOCKED_CLIENT_CREATE_MESSAGE);
  });

  it("laisse passer un contact actif, un client saisi sans fiche, un autre espace", async () => {
    await expect(
      assertClientNotBlocked(organizationId, active._id),
    ).resolves.toBeUndefined();
    await expect(
      assertClientNotBlocked(organizationId, undefined),
    ).resolves.toBeUndefined();
    await expect(
      assertClientNotBlocked(organizationId, "client-libre"),
    ).resolves.toBeUndefined();
    await expect(
      assertClientNotBlocked(otherOrganizationId, blocked._id),
    ).resolves.toBeUndefined();
  });
});

describe("Création d'un document pour un contact bloqué", () => {
  it("createDeliveryNote refusé, rien en base", async () => {
    await expect(
      deliveryNoteResolvers.Mutation.createDeliveryNote(
        null,
        { input: dnInput(blocked) },
        ctx(),
      ),
    ).rejects.toThrow(BLOCKED_CLIENT_CREATE_MESSAGE);
    expect(await DeliveryNote.countDocuments({})).toBe(0);
  });

  it("createDeliveryNote accepté pour un contact actif", async () => {
    const dn = await deliveryNoteResolvers.Mutation.createDeliveryNote(
      null,
      { input: dnInput(active) },
      ctx(),
    );
    expect(dn.client.id).toBe(active._id.toString());
    expect(await DeliveryNote.countDocuments({})).toBe(1);
  });
});

describe("Envoi par e-mail d'un document existant", () => {
  it("refusé quand le contact a été bloqué après coup", async () => {
    const dn = await deliveryNoteResolvers.Mutation.createDeliveryNote(
      null,
      { input: dnInput(active) },
      ctx(),
    );
    await Client.updateOne({ _id: active._id }, { $set: { isBlocked: true } });

    await expect(
      sendDocumentEmail({
        documentId: dn.id || dn._id.toString(),
        documentType: DOCUMENT_TYPES.DELIVERY_NOTE,
        workspaceId: organizationId.toString(),
        emailSubject: "Votre bon de livraison",
        emailBody: "Bonjour",
        recipientEmail: "actif@exemple.test",
      }),
    ).rejects.toThrow(BLOCKED_CLIENT_SEND_MESSAGE);
  });
});
