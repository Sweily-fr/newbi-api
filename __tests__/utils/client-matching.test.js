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
  matchClientInText,
  resolveImportedClient,
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

  it("refuse un nom trop court ou ambigu, accepte un sous-ensemble de mots unique", async () => {
    const sudOuest = await seedClient({ name: "Sud Ouest Transports" });
    await seedClient({ name: "Sud Est Logistique" });
    expect(await matchExistingClient(workspaceId, { name: "Sud" })).toBeNull();
    expect(
      await matchExistingClient(workspaceId, { name: "Sud Est Ouest" }),
    ).toBeNull();
    const found = await matchExistingClient(workspaceId, {
      name: "Sud Transports",
    });
    expect(found._id.toString()).toBe(sudOuest._id.toString());
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
    // Ordre inversé : mêmes mots significatifs → associé
    expect(found._id.toString()).toBe(jean._id.toString());
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

describe("matchExistingClient — jetons significatifs", () => {
  it("associe « Association oasis » à « ASSOCIATION : UNE OASIS »", async () => {
    const oasis = await seedClient({ name: "ASSOCIATION : UNE OASIS" });
    await seedClient({ name: "Association des jardins" });
    const found = await matchExistingClient(workspaceId, {
      name: "Association oasis",
    });
    expect(found._id.toString()).toBe(oasis._id.toString());
  });
});

describe("matchClientInText", () => {
  const text = `FACTURE\nNewbi\n1 rue des paysans\nN° TVA: FR70981576549\n\nASSOCIATION : UNE OASIS\n\n35 RUE DES CHARDONNERETS\n77340 PONTAULT-COMBAULT\nSIRET 903 887 743 00012\noasis@gmail.com\nTotal TTC 968,00 €`;

  it("retrouve le client cité dans le texte brut (nom, SIRET, email)", async () => {
    const oasis = await seedClient({
      name: "ASSOCIATION : UNE OASIS",
      email: "oasis@gmail.com",
      siret: "903887743",
    });
    await seedClient({ name: "Hostinger" });
    const found = await matchClientInText(workspaceId, text);
    expect(found._id.toString()).toBe(oasis._id.toString());
  });

  it("préfère la preuve forte (SIRET/email) à un simple nom, et refuse l'ambiguïté", async () => {
    const bySiret = await seedClient({ name: "Autre nom", siret: "903887743" });
    await seedClient({ name: "Une oasis" });
    const found = await matchClientInText(workspaceId, text);
    expect(found._id.toString()).toBe(bySiret._id.toString());

    await seedClient({ name: "Encore autre", siret: "90388774300012" });
    expect(await matchClientInText(workspaceId, text)).toBeNull();
  });

  it("ne renvoie rien sans texte exploitable", async () => {
    await seedClient({ name: "ASSOCIATION : UNE OASIS" });
    expect(await matchClientInText(workspaceId, "")).toBeNull();
    expect(await matchClientInText(workspaceId, "Facture 2026")).toBeNull();
  });
});

describe("resolveImportedClient — repli texte", () => {
  it("pose client.id et un nom quand seuls le texte brut est disponible", async () => {
    const oasis = await seedClient({ name: "ASSOCIATION : UNE OASIS" });
    const invoiceData = {
      client: { name: null },
      vendor: { name: "" },
      ocrData: { extractedText: "Facture\nASSOCIATION : UNE OASIS\nTotal 968" },
    };
    const matched = await resolveImportedClient(invoiceData, workspaceId);
    expect(matched._id.toString()).toBe(oasis._id.toString());
    expect(invoiceData.client.id).toBe(oasis._id.toString());
    expect(invoiceData.client.name).toBe("ASSOCIATION : UNE OASIS");
  });
});
