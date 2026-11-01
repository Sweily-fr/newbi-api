/**
 * Listes et segments sans « Mes clients : voir » : un rôle personnalisé qui
 * ne voit que les listes ou les segments ne lit pas les fiches des contacts
 * (e-mail, téléphone, notes, activité) par leur biais.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Client from "../../src/models/Client.js";
import ClientList from "../../src/models/ClientList.js";
import ClientSegment from "../../src/models/ClientSegment.js";
import CrmEmailAutomationLog from "../../src/models/CrmEmailAutomationLog.js";
import { clientListResolvers } from "../../src/resolvers/clientList.js";
import { clientSegmentResolvers } from "../../src/resolvers/clientSegment.js";
import crmEmailAutomationResolvers from "../../src/resolvers/crmEmailAutomation.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const ROLE = "role_listes_seules";
const ws = () => String(workspaceId);
const ctx = (userId = member) => buildContext({ userId, organizationId: ws() });

let client;
let list;
let segment;

async function grantActions(actions) {
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne(
      { organizationId: workspaceId, role: ROLE },
      { $set: { actions } },
    );
  invalidateOrganizationRoles();
  invalidateOrgCache();
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
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: ROLE,
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Listes seules",
    permission: "{}",
    actions: {},
    createdAt: new Date(),
  });
  client = await Client.create(
    buildClientDoc({
      workspaceId,
      createdBy: owner,
      email: "secret@contact.test",
      phone: "+33600000000",
      address: {
        street: "1 rue de Lyon",
        city: "Lyon",
        postalCode: "69001",
        country: "France",
      },
    }),
  );
  list = await ClientList.create({
    name: "VIP",
    workspaceId,
    createdBy: owner,
    clients: [client._id],
  });
  segment = await ClientSegment.create({
    name: "Lyonnais",
    workspaceId,
    createdBy: owner,
    rules: [{ field: "address.city", operator: "equals", value: "Lyon" }],
  });
  invalidateOrganizationRoles();
  invalidateOrgCache();
});

const listReads = () => [
  [
    "clientLists",
    () =>
      clientListResolvers.Query.clientLists(null, { workspaceId: ws() }, ctx()),
  ],
  [
    "clientList",
    () =>
      clientListResolvers.Query.clientList(
        null,
        { workspaceId: ws(), id: String(list._id) },
        ctx(),
      ),
  ],
  [
    "clientsInList",
    () =>
      clientListResolvers.Query.clientsInList(
        null,
        { workspaceId: ws(), listId: String(list._id) },
        ctx(),
      ),
  ],
];

describe("Rôle « Listes : voir » sans « Mes clients »", () => {
  for (const [name] of listReads()) {
    it(`${name} : refusé`, async () => {
      await grantActions({ clientLists: ["view"] });
      const read = listReads().find(([n]) => n === name)[1];
      await expect(read()).rejects.toThrow(/permission/);
    });
  }

  it("avec « Mes clients : voir », les listes et leurs contacts sont lus", async () => {
    await grantActions({ clientLists: ["view"], clients: ["view"] });
    const lists = await clientListResolvers.Query.clientLists(
      null,
      { workspaceId: ws() },
      ctx(),
    );
    expect(lists[0].clients[0].email).toBe("secret@contact.test");
  });

  it("les listes d'un contact restent lisibles (sans fiche)", async () => {
    await grantActions({ clientLists: ["view"] });
    const lists = await clientListResolvers.Query.clientListsByClient(
      null,
      { workspaceId: ws(), clientId: String(client._id) },
      ctx(),
    );
    expect(lists.map((l) => l.name)).toEqual(["VIP"]);
  });
});

describe("Rôle « Segments : voir » sans « Mes clients »", () => {
  it("clientsInSegment : refusé", async () => {
    await grantActions({ clientSegments: ["view"] });
    await expect(
      clientSegmentResolvers.Query.clientsInSegment(
        null,
        { workspaceId: ws(), segmentId: String(segment._id) },
        ctx(),
      ),
    ).rejects.toThrow(/permission/);
  });

  it("la liste des segments reste lisible", async () => {
    await grantActions({ clientSegments: ["view"] });
    const segments = await clientSegmentResolvers.Query.clientSegments(
      null,
      { workspaceId: ws() },
      ctx(),
    );
    expect(segments.map((s) => s.name)).toEqual(["Lyonnais"]);
  });
});

describe("Journal des e-mails CRM sans « Mes clients »", () => {
  it("ne renvoie pas la fiche du contact", async () => {
    await grantActions({ clientLists: ["view"], automations: ["view"] });
    await CrmEmailAutomationLog.create({
      automationId: new mongoose.Types.ObjectId(),
      clientId: client._id,
      workspaceId,
      triggerDate: new Date(),
      recipientEmail: "secret@contact.test",
      emailSubject: "Bonjour",
      emailBody: "Bonjour",
      status: "SENT",
    });
    const [log] =
      await crmEmailAutomationResolvers.Query.crmEmailAutomationLogs(
        null,
        { workspaceId: ws() },
        ctx(),
      );
    expect(
      await crmEmailAutomationResolvers.CrmEmailAutomationLog.client(log),
    ).toBeNull();
  });
});
