import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import Client from "../../src/models/Client.js";
import {
  matchExistingClient,
  clientLooseKey,
  clientMatchKey,
} from "../../src/utils/clientMatching.js";

const userId = buildUserId();
const workspaceId = buildOrganizationId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

let n = 0;
const seedClient = (overrides = {}) => {
  n += 1;
  return Client.create(
    buildClientDoc({
      workspaceId,
      createdBy: userId,
      email: `client${n}@matching.test`,
      ...overrides,
    }),
  );
};

describe("clés de comparaison", () => {
  it("ignore casse, accents, ponctuation et formes juridiques", () => {
    expect(clientMatchKey("L'Héritage & Co.")).toBe("lheritageco");
    expect(clientLooseKey("Lab Developpements SAS")).toBe("labdeveloppements");
    expect(clientLooseKey("SARL Boulangerie Dupont")).toBe("boulangeriedupont");
    expect(clientLooseKey("Qonto SA")).toBe("qonto");
  });
});

describe("matchExistingClient", () => {
  it("associe malgré une forme juridique différente", async () => {
    const lab = await seedClient({ name: "Lab Developpements" });
    const found = await matchExistingClient(workspaceId, {
      name: "LAB DEVELOPPEMENTS SAS",
    });
    expect(found._id.toString()).toBe(lab._id.toString());
  });

  it("associe par email quand le nom diverge", async () => {
    const acme = await seedClient({
      name: "ACME Industries",
      email: "compta@acme.fr",
    });
    const found = await matchExistingClient(workspaceId, {
      name: "A.C.M.E.",
      email: "Compta@ACME.fr",
    });
    expect(found._id.toString()).toBe(acme._id.toString());
  });

  it("associe par inclusion quand un seul client correspond", async () => {
    const qonto = await seedClient({ name: "Qonto" });
    await seedClient({ name: "Hostinger" });
    const found = await matchExistingClient(workspaceId, {
      name: "Qonto SA Paris",
    });
    expect(found._id.toString()).toBe(qonto._id.toString());
  });

  it("refuse une inclusion trop courte ou ambiguë", async () => {
    await seedClient({ name: "Sud Ouest Transports" });
    await seedClient({ name: "Sud Est Logistique" });
    expect(await matchExistingClient(workspaceId, { name: "Sud" })).toBeNull();
    expect(
      await matchExistingClient(workspaceId, { name: "Sud Transports" }),
    ).toBeNull();
  });

  it("le nom exact prime sur une inclusion concurrente", async () => {
    const exact = await seedClient({ name: "Studio Karma" });
    await seedClient({ name: "Studio Karma Productions" });
    const found = await matchExistingClient(workspaceId, {
      name: "studio karma",
    });
    expect(found._id.toString()).toBe(exact._id.toString());
  });

  it("gère les particuliers (prénom + nom)", async () => {
    const jean = await seedClient({
      type: "INDIVIDUAL",
      firstName: "Jean",
      lastName: "Dupont",
      name: "Jean Dupont",
    });
    const found = await matchExistingClient(workspaceId, {
      name: "DUPONT Jean",
    });
    // Ordre inversé : pas de clé stricte identique, ni d'inclusion → null
    expect(found).toBeNull();
    const direct = await matchExistingClient(workspaceId, {
      name: "jean dupont",
    });
    expect(direct._id.toString()).toBe(jean._id.toString());
  });

  it("ne traverse pas les workspaces", async () => {
    await Client.create(
      buildClientDoc({
        workspaceId: buildOrganizationId(),
        createdBy: userId,
        name: "Lab Developpements",
        email: "other@ws.test",
      }),
    );
    expect(
      await matchExistingClient(workspaceId, { name: "Lab Developpements" }),
    ).toBeNull();
  });
});
