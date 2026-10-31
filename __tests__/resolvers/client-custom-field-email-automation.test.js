/**
 * Champ date utilisé par une automatisation d'e-mails : ni supprimé ni
 * changé de type tant qu'elle existe (elle n'enverrait plus rien sans que
 * personne ne le sache). Sans automatisation, les deux restent possibles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import ClientCustomField from "../../src/models/ClientCustomField.js";
import CrmEmailAutomation from "../../src/models/CrmEmailAutomation.js";
import { clientCustomFieldResolvers } from "../../src/resolvers/clientCustomField.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const workspaceId = organizationId.toString();
const ctx = () => buildContext({ userId, organizationId });
const { Mutation } = clientCustomFieldResolvers;

let field;

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
  field = await ClientCustomField.create({
    name: "Date d'anniversaire",
    fieldType: "DATE",
    workspaceId: organizationId,
    createdBy: userId,
  });
});

const withAutomation = () =>
  CrmEmailAutomation.create({
    name: "Joyeux anniversaire",
    workspaceId: organizationId,
    createdBy: userId,
    customFieldId: field._id,
    timing: { type: "ON_DATE", daysOffset: 0, sendHour: 9 },
    email: { subject: "Bonjour", body: "Texte" },
  });

const remove = () =>
  Mutation.deleteClientCustomField(
    null,
    { workspaceId, id: field._id.toString() },
    ctx(),
  );

const changeType = (fieldType) =>
  Mutation.updateClientCustomField(
    null,
    {
      workspaceId,
      id: field._id.toString(),
      input: { name: field.name, fieldType },
    },
    ctx(),
  );

describe("Champ date d'une automatisation d'e-mails", () => {
  it("suppression refusée avec le nom de l'automatisation, champ conservé", async () => {
    await withAutomation();
    await expect(remove()).rejects.toThrow(
      /utilisé par l'automatisation d'e-mails « Joyeux anniversaire »/,
    );
    expect(await ClientCustomField.findById(field._id)).not.toBeNull();
  });

  it("passage en texte refusé, type conservé", async () => {
    await withAutomation();
    await expect(changeType("TEXT")).rejects.toThrow(
      /utilisé par l'automatisation d'e-mails/,
    );
    expect((await ClientCustomField.findById(field._id)).fieldType).toBe(
      "DATE",
    );
  });

  it("sans automatisation : suppression et changement de type possibles", async () => {
    await changeType("TEXT");
    expect((await ClientCustomField.findById(field._id)).fieldType).toBe(
      "TEXT",
    );
    await remove();
    expect(await ClientCustomField.findById(field._id)).toBeNull();
  });
});
