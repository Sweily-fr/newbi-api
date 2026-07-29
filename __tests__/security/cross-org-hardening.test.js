import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// PennylaneAccount et d'autres modèles chiffrent des champs au repos.
process.env.DATA_ENCRYPTION_KEY ||= "test-encryption-key-crossorg";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";

import { clientCustomFieldResolvers } from "../../src/resolvers/clientCustomField.js";
import { clientListResolvers } from "../../src/resolvers/clientList.js";
import documentAutomationResolvers from "../../src/resolvers/documentAutomation.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import { createDataLoaders } from "../../src/dataloaders/index.js";
import ClientList from "../../src/models/ClientList.js";
import Client from "../../src/models/Client.js";

// user A est membre (owner) de org A ; user B (owner) de org B.
const userA = buildUserId();
const orgA = buildOrganizationId();
const userB = buildUserId();
const orgB = buildOrganizationId();

// Resolvers Query nouvellement wrappés (scopedQuery / withOrganization) qui
// prennent un workspaceId. On vérifie qu'ils refusent l'accès cross-org.
const guardedQueries = [
  ["clientCustomFields", clientCustomFieldResolvers.Query.clientCustomFields],
  ["clientLists", clientListResolvers.Query.clientLists],
  [
    "documentAutomations",
    documentAutomationResolvers.Query.documentAutomations,
  ],
  ["sharedDocuments", sharedDocumentResolvers.Query.sharedDocuments],
];

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({
    userId: userA,
    organizationId: orgA,
    role: "owner",
  });
  await seedOrgMembership({
    userId: userB,
    organizationId: orgB,
    role: "owner",
  });
});

describe("Durcissement cross-org — resolvers nouvellement protégés", () => {
  describe.each(guardedQueries)("%s", (name, resolver) => {
    it("autorise un membre sur sa propre organisation", async () => {
      const ctx = buildContext({ userId: userA, organizationId: orgA });
      // Ne doit pas lever (retourne des données vides, mais pas d'erreur d'accès)
      await expect(
        resolver(null, { workspaceId: orgA.toString() }, ctx),
      ).resolves.toBeDefined();
    });

    it("refuse l'accès direct à une organisation dont l'utilisateur n'est pas membre", async () => {
      // Attaque directe : header x-organization-id = org victime
      const ctx = buildContext({ userId: userA, organizationId: orgB });
      await expect(
        resolver(null, { workspaceId: orgB.toString() }, ctx),
      ).rejects.toThrow();
    });
  });

  it("ne fuit pas les données d'une autre org via args.workspaceId (le header prime dans RBAC)", async () => {
    // Donnée appartenant à l'org B (la victime)
    await ClientList.collection.insertOne({
      workspaceId: orgB,
      name: "Liste secrète org B",
      createdBy: userB,
      clients: [],
      isDefault: false,
      createdAt: new Date(),
    });

    // user A (membre de org A) tente le contournement : header = sa propre org A,
    // mais args.workspaceId = org B. scopedQuery doit forcer le workspace validé
    // (org A) et ne renvoyer AUCUNE liste de l'org B.
    const ctx = buildContext({ userId: userA, organizationId: orgA });
    const lists = await clientListResolvers.Query.clientLists(
      null,
      { workspaceId: orgB.toString() },
      ctx,
    );

    const names = (lists || []).map((l) => l.name);
    expect(names).not.toContain("Liste secrète org B");
  });

  it("le field resolver Quote.client (batché via DataLoader) ne fuit pas un client d'une autre org", async () => {
    // Client appartenant à l'org B
    const { insertedId: clientBId } = await Client.collection.insertOne({
      workspaceId: orgB,
      name: "Client secret B",
      email: "secret@orgb.fr",
      createdBy: userB,
      createdAt: new Date(),
    });

    // Brouillon de devis de l'org A qui référence (malicieusement) le client de l'org B
    const draftQuote = {
      status: "DRAFT",
      workspaceId: orgA,
      client: { id: clientBId.toString(), name: "Snapshot local" },
    };

    // Le field resolver charge via le DataLoader clientById (non scopé) mais doit
    // vérifier le workspace → renvoyer le snapshot embarqué, pas les données de B.
    const context = { loaders: createDataLoaders() };
    const resolved = await quoteResolvers.Quote.client(draftQuote, {}, context);

    expect(resolved.email).not.toBe("secret@orgb.fr");
    expect(resolved.name).toBe("Snapshot local");
  });
});
