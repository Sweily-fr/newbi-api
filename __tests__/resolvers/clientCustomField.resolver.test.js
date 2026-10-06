import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import ClientCustomField from "../../src/models/ClientCustomField.js";
import { clientCustomFieldResolvers } from "../../src/resolvers/clientCustomField.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });
const create = clientCustomFieldResolvers.Mutation.createClientCustomField;

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
});

describe("createClientCustomField - affichage sur les documents", () => {
  it("coche « Sur les documents » par défaut pour un nouveau champ", async () => {
    const field = await create(
      null,
      { workspaceId: organizationId, input: { name: "Code client", fieldType: "TEXT" } },
      ctx(),
    );
    expect(field.showOnDocuments).toBe(true);
  });

  it("respecte un choix explicite de ne pas l'afficher", async () => {
    const field = await create(
      null,
      {
        workspaceId: organizationId,
        input: { name: "Note interne", fieldType: "TEXT", showOnDocuments: false },
      },
      ctx(),
    );
    expect(field.showOnDocuments).toBe(false);
  });

  it("ne change pas les champs existants sans réglage", async () => {
    const legacy = await ClientCustomField.collection.insertOne({
      name: "Ancien champ",
      fieldType: "TEXT",
      workspaceId: organizationId,
      createdBy: userId,
      isActive: true,
    });
    const doc = await ClientCustomField.findById(legacy.insertedId);
    expect(doc.showOnDocuments).toBe(false);
  });
});
