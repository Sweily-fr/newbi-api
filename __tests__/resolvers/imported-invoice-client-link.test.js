import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import importedInvoiceResolvers, {
  matchExistingClient,
  resolveImportedClient,
} from "../../src/resolvers/importedInvoice.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

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

const ctx = () => buildContext({ userId, organizationId });

const seedClient = (overrides) =>
  Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      ...overrides,
    }),
  );

describe("matchExistingClient — rapprochement automatique", () => {
  it("matche par nom en ignorant casse, accents, espaces et ponctuation", async () => {
    const awayout = await seedClient({
      name: "Awayout",
      siret: "94036483900012",
    });
    await seedClient({ name: "L'HERITAGE", siret: "93258019400013" });

    const matched = await matchExistingClient(organizationId, {
      name: "A way out ",
      siret: null,
    });
    expect(String(matched._id)).toBe(String(awayout._id));
  });

  it("matche « L'héritage » avec le client « L'HERITAGE »", async () => {
    const heritage = await seedClient({
      name: "L'HERITAGE",
      siret: "93258019400013",
    });
    await seedClient({ name: "Awayout", siret: "94036483900012" });

    const matched = await matchExistingClient(organizationId, {
      name: "L'héritage",
      siret: null,
    });
    expect(String(matched._id)).toBe(String(heritage._id));
  });

  it("le nom prime sur un SIRET incohérent", async () => {
    const awayout = await seedClient({
      name: "Awayout",
      siret: "94036483900012",
    });
    const autre = await seedClient({
      name: "LOBJOIS",
      siret: "98157654900019",
    });

    // OCR : bon nom mais SIRET d'un autre client présent sur le document
    const matched = await matchExistingClient(organizationId, {
      name: "A WAY OUT",
      siret: autre.siret,
    });
    expect(String(matched._id)).toBe(String(awayout._id));
  });

  it("matche par SIREN (9 chiffres vs SIRET 14, espaces ignorés) quand le nom diverge", async () => {
    const lab3 = await seedClient({
      name: "Lab3 Developpement",
      siret: "49461252600025",
    });
    await seedClient({ name: "Awayout", siret: "94036483900012" });

    const matched = await matchExistingClient(organizationId, {
      name: "LAB TROIS",
      siret: " 494 612 526 ",
    });
    expect(String(matched._id)).toBe(String(lab3._id));
  });

  it("ne lie pas quand rien ne correspond ou que le match est ambigu", async () => {
    await seedClient({ name: "Awayout", siret: "94036483900012" });

    expect(
      await matchExistingClient(organizationId, {
        name: "SME France",
        siret: "79832350700011",
      }),
    ).toBeNull();
    expect(
      await matchExistingClient(organizationId, { name: null, siret: null }),
    ).toBeNull();
  });
});

describe("resolveImportedClient — création d'une facture importée", () => {
  it("bascule vendor vers client puis pose client.id si un client Newbi correspond", async () => {
    const heritage = await seedClient({
      name: "L'HERITAGE",
      siret: "93258019400013",
    });

    const invoiceData = {
      vendor: { name: "L'héritage", siret: "932580194", address: "1 rue A" },
      client: { name: null },
    };
    await resolveImportedClient(invoiceData, organizationId);

    expect(invoiceData.client.name).toBe("L'héritage");
    expect(invoiceData.client.id).toBe(String(heritage._id));
  });

  it("laisse client.id vide quand aucun client ne correspond", async () => {
    const invoiceData = {
      vendor: { name: "SME France", siret: "79832350700011" },
      client: { name: null },
    };
    await resolveImportedClient(invoiceData, organizationId);

    expect(invoiceData.client.name).toBe("SME France");
    expect(invoiceData.client.id).toBeUndefined();
  });
});

describe("Mutation.updateImportedInvoice — association manuelle", () => {
  const resolver = importedInvoiceResolvers.Mutation.updateImportedInvoice;

  const seedImported = () =>
    ImportedInvoice.create({
      workspaceId: organizationId,
      importedBy: userId,
      status: "PENDING_REVIEW",
      client: { name: "A way ouf", siret: null },
      totalTTC: 100,
      file: {
        url: "https://files.test/doc.pdf",
        cloudflareKey: `${organizationId}/doc.pdf`,
        originalFileName: "doc.pdf",
        mimeType: "application/pdf",
        fileSize: 1000,
      },
    });

  it("associe un client existant et aligne le nom affiché", async () => {
    const awayout = await seedClient({
      name: "Awayout",
      siret: "94036483900012",
    });
    const imported = await seedImported();

    const updated = await resolver(
      null,
      { id: String(imported._id), input: { clientId: String(awayout._id) } },
      ctx(),
    );

    expect(updated.client.id).toBe(String(awayout._id));
    expect(updated.client.name).toBe("Awayout");
  });

  it("dissocie avec clientId null explicite", async () => {
    const awayout = await seedClient({
      name: "Awayout",
      siret: "94036483900012",
    });
    const imported = await seedImported();
    await resolver(
      null,
      { id: String(imported._id), input: { clientId: String(awayout._id) } },
      ctx(),
    );

    const updated = await resolver(
      null,
      { id: String(imported._id), input: { clientId: null } },
      ctx(),
    );
    expect(updated.client.id).toBeNull();
  });

  it("refuse un client d'un autre workspace", async () => {
    const otherOrg = buildOrganizationId();
    const foreign = await Client.create(
      buildClientDoc({ workspaceId: otherOrg, createdBy: buildUserId() }),
    );
    const imported = await seedImported();

    await expect(
      resolver(
        null,
        { id: String(imported._id), input: { clientId: String(foreign._id) } },
        ctx(),
      ),
    ).rejects.toThrow("Client non trouvé");
  });
});
