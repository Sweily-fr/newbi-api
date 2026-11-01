/**
 * Automatisations de listes de contacts :
 *   - créée inactive : aucune liste modifiée ;
 *   - « Déplacer vers » : chaque retrait d'une liste est tracé dans le
 *     journal du contact ;
 *   - « Devis accepté » : exécutée à l'acceptation d'un devis, appliquée aux
 *     devis acceptés (COMPLETED) existants, montant minimum lu sur le devis ;
 *   - « Facture en retard » : exécutée par le passage quotidien le jour où
 *     l'échéance est dépassée ;
 *   - le créateur n'expose que son nom et son e-mail.
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
import Client from "../../src/models/Client.js";
import ClientList from "../../src/models/ClientList.js";
import ClientAutomation from "../../src/models/ClientAutomation.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import clientAutomationResolvers, {
  automationService,
} from "../../src/resolvers/clientAutomation.js";

const { ObjectId } = mongoose.Types;
const userId = buildUserId();
const organizationId = buildOrganizationId();
const workspaceId = organizationId.toString();
const ctx = () => buildContext({ userId, organizationId });

let alice;
let bruno;
let vip;
let prospects;
let actifs;

const list = (name, clients = []) =>
  ClientList.create({
    name,
    workspaceId: organizationId,
    createdBy: userId,
    clients,
  });

const members = async (l) =>
  (await ClientList.findById(l._id)).clients.map(String).sort();

const create = (input) =>
  clientAutomationResolvers.Mutation.createClientAutomation(
    null,
    { workspaceId, input: { name: "Automatisation", ...input } },
    ctx(),
  );

async function seedDocument(Model, clientDoc, extra) {
  await Model.collection.insertOne({
    _id: new ObjectId(),
    workspaceId: organizationId,
    client: { id: clientDoc._id.toString(), name: clientDoc.name },
    ...extra,
  });
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
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  alice = await Client.create(
    buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
  );
  bruno = await Client.create(
    buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
  );
  vip = await list("VIP", [alice._id]);
  prospects = await list("Prospects", [alice._id, bruno._id]);
  actifs = await list("Clients actifs");
});

describe("Automatisation créée inactive", () => {
  for (const actionType of ["ADD_TO_LIST", "MOVE_TO_LIST"]) {
    it(`${actionType} : aucune liste modifiée`, async () => {
      const before = await Promise.all([vip, prospects, actifs].map(members));
      await create({
        triggerType: "CLIENT_CREATED",
        actionType,
        targetListId: actifs._id.toString(),
        isActive: false,
      });
      const after = await Promise.all([vip, prospects, actifs].map(members));
      expect(after).toEqual(before);
      expect((await Client.findById(alice._id)).activity).toHaveLength(0);
    });
  }

  it("active : appliquée aux contacts existants", async () => {
    await create({
      triggerType: "CLIENT_CREATED",
      actionType: "ADD_TO_LIST",
      targetListId: actifs._id.toString(),
      isActive: true,
    });
    expect(await members(actifs)).toEqual(
      [alice._id.toString(), bruno._id.toString()].sort(),
    );
  });
});

describe("« Déplacer vers »", () => {
  it("chaque retrait d'une liste est tracé dans le journal du contact", async () => {
    await create({
      triggerType: "CLIENT_CREATED",
      actionType: "MOVE_TO_LIST",
      targetListId: actifs._id.toString(),
      isActive: true,
    });
    expect(await members(vip)).toEqual([]);
    expect(await members(prospects)).toEqual([]);

    const activity = (await Client.findById(alice._id)).activity;
    const removed = activity
      .filter((a) => a.type === "removed_from_list")
      .map((a) => a.metadata.listName)
      .sort();
    expect(removed).toEqual(["Prospects", "VIP"]);
    expect(activity.at(-1).type).toBe("automation_executed");
  });
});

describe("« Devis accepté »", () => {
  it("le devis accepté d'un contact l'ajoute à la liste", async () => {
    await create({
      triggerType: "QUOTE_ACCEPTED",
      actionType: "ADD_TO_LIST",
      targetListId: actifs._id.toString(),
      isActive: true,
    });
    expect(await members(actifs)).toEqual([]);

    const result = await automationService.onQuoteAccepted(
      { _id: new ObjectId(), client: { id: bruno._id }, finalTotalTTC: 900 },
      organizationId,
    );
    expect(result.executed).toBe(1);
    expect(await members(actifs)).toEqual([bruno._id.toString()]);
  });

  it("à la création, seuls les contacts d'un devis accepté au-dessus du minimum", async () => {
    await seedDocument(Quote, alice, {
      status: "COMPLETED",
      finalTotalTTC: 900,
    });
    await seedDocument(Quote, bruno, {
      status: "COMPLETED",
      finalTotalTTC: 100,
    });
    // Une facture payée importante ne compte pas pour un devis
    await seedDocument(Invoice, bruno, {
      status: "COMPLETED",
      finalTotalTTC: 5000,
    });
    await create({
      triggerType: "QUOTE_ACCEPTED",
      triggerConfig: { minAmount: 500 },
      actionType: "ADD_TO_LIST",
      targetListId: actifs._id.toString(),
      isActive: true,
    });
    expect(await members(actifs)).toEqual([alice._id.toString()]);
  });
});

describe("« Facture en retard »", () => {
  it("exécutée le jour où l'échéance est dépassée, pas les jours suivants", async () => {
    await ClientAutomation.create({
      name: "Retards",
      triggerType: "INVOICE_OVERDUE",
      actionType: "ADD_TO_LIST",
      targetListId: actifs._id,
      isActive: true,
      workspaceId: organizationId,
      createdBy: userId,
    });
    const now = new Date(2026, 9, 31, 8, 0, 0);
    await seedDocument(Invoice, alice, {
      status: "PENDING",
      finalTotalTTC: 300,
      dueDate: new Date(2026, 9, 30, 12, 0, 0),
    });
    await seedDocument(Invoice, bruno, {
      status: "PENDING",
      finalTotalTTC: 300,
      dueDate: new Date(2026, 9, 27, 12, 0, 0),
    });

    const result = await automationService.checkOverdueInvoices(now);

    expect(result.executed).toBe(1);
    expect(await members(actifs)).toEqual([alice._id.toString()]);
  });
});

describe("Créateur d'une automatisation", () => {
  it("seuls son nom et son e-mail sont lus", async () => {
    await mongoose.connection.db.collection("user").updateOne(
      { _id: userId },
      {
        $set: {
          email: "createur@test.fr",
          name: "Créateur",
          profile: { phone: "+33600000000" },
          referralCode: "PARRAIN",
        },
      },
      { upsert: true },
    );
    await create({
      triggerType: "CLIENT_CREATED",
      actionType: "ADD_TO_LIST",
      targetListId: actifs._id.toString(),
      isActive: false,
    });
    const [automation] =
      await clientAutomationResolvers.Query.clientAutomations(
        null,
        { workspaceId },
        ctx(),
      );
    expect(automation.createdBy.email).toBe("createur@test.fr");
    expect(automation.createdBy.referralCode).toBeUndefined();
    expect(automation.createdBy.profile).toBeUndefined();
  });
});
