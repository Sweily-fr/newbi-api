import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock(
  "../../src/services/prospects/societeinfoClient.js",
  async (importOriginal) => {
    const original = await importOriginal();
    return {
      ...original,
      isSocieteinfoConfigured: vi.fn(() => true),
      searchCompanies: vi.fn(),
      getCompany: vi.fn(),
      getKeyInfo: vi.fn(),
      autocompletePlaces: vi.fn(),
    };
  },
);

vi.mock("../../src/services/prospects/prospectOpposition.js", () => ({
  checkCommercialOpposition: vi.fn(),
}));

import {
  searchCompanies,
  getCompany,
  getKeyInfo,
  ProspectProviderError,
} from "../../src/services/prospects/societeinfoClient.js";
import { checkCommercialOpposition } from "../../src/services/prospects/prospectOpposition.js";
import {
  pickBestEmail,
  formatFrenchPhone,
  parseCreationDate,
  mapCompanyToClient,
} from "../../src/services/prospects/prospectMapping.js";
import { resolveNafCodes } from "../../src/services/prospects/prospectTrades.js";
import {
  getProspectQuota,
  getPaidPlan,
} from "../../src/services/prospects/prospectQuota.js";
import {
  searchProspects,
  unlockProspects,
  generateProspects,
  getProspectAvailability,
  resetProviderCreditsCache,
} from "../../src/services/prospects/prospectService.js";
import Client from "../../src/models/Client.js";
import ClientList from "../../src/models/ClientList.js";
import ProspectCreditUsage from "../../src/models/ProspectCreditUsage.js";
import clientResolvers from "../../src/resolvers/client.js";

const userId = buildUserId();
const workspaceId = buildOrganizationId().toString();
const user = { id: userId.toString(), name: "Dylan" };

async function setSubscription(plan, status = "active", extra = {}) {
  await mongoose.connection.db.collection("subscription").updateOne(
    { referenceId: workspaceId },
    {
      $set: {
        referenceId: workspaceId,
        plan,
        status,
        periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        ...extra,
      },
    },
    { upsert: true },
  );
}

function fiche(siren, { email, emails, phones = ["0549513030"], name } = {}) {
  return {
    organization: {
      registration_number: siren,
      name: name || `MENUISERIE ${siren}`,
      creation_date: "2024-03-15",
      vat_number: null,
      activity: { ape_name: "Travaux de menuiserie bois et PVC" },
      address: {
        street: "12 RUE DES ARTISANS",
        postal_code: "86440",
        city: "MIGNE-AUXANCES",
      },
    },
    contacts: {
      phones,
      ...(email ? { email } : {}),
      ...(emails ? { emails } : {}),
    },
    web_infos: { website_url: "https://exemple.fr" },
  };
}

const allowAll = (sirens) => new Map(sirens.map((s) => [s, "ALLOWED"]));

beforeAll(async () => {
  await startMongo();
  await Client.init();
  await ProspectCreditUsage.init();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  process.env.PROSPECTS_ENABLED = "true";
  delete process.env.PROSPECT_MONTHLY_CREDIT_CAP;
  checkCommercialOpposition.mockImplementation(async (s) => allowAll(s));
  getCompany.mockImplementation(async (siren) => fiche(siren));
  getKeyInfo.mockResolvedValue({ totalAvailableCredits: 1000 });
  resetProviderCreditsCache();
  await setSubscription("pme");
});

afterEach(() => {
  delete process.env.PROSPECTS_ENABLED;
});

describe("choix des coordonnées", () => {
  it("préfère contact@ à facturation@ et écarte no-reply et les adresses invalides", () => {
    expect(
      pickBestEmail({
        emails: [
          { value: "facturation.satem@orange.fr" },
          { value: "noreply@satem.fr" },
          { value: "accueil@satem-menuiserie.fr" },
        ],
      }),
    ).toBe("accueil@satem-menuiserie.fr");
    expect(
      pickBestEmail({
        emails: [{ value: "contact@x.fr", email_test_result: "Invalid" }],
      }),
    ).toBeNull();
    expect(pickBestEmail({ email: "compta@x.fr" })).toBe("compta@x.fr");
    expect(pickBestEmail({})).toBeNull();
  });

  it("met le téléphone au format français", () => {
    expect(formatFrenchPhone("0549513030")).toBe("05 49 51 30 30");
    expect(formatFrenchPhone("+33 5 49 93 50 66")).toBe("05 49 93 50 66");
    expect(formatFrenchPhone("abc")).toBeNull();
  });

  it("lit les contacts à la racine ou sous organization", () => {
    const racine = mapCompanyToClient(
      fiche("123456789", { email: "contact@a.fr" }),
    );
    expect(racine).toMatchObject({
      siren: "123456789",
      email: "contact@a.fr",
      phone: "05 49 51 30 30",
      address: {
        postalCode: "86440",
        city: "MIGNE-AUXANCES",
        country: "France",
      },
    });
    const imbrique = fiche("123456789");
    imbrique.organization.contacts = imbrique.contacts;
    delete imbrique.contacts;
    expect(mapCompanyToClient(imbrique).phone).toBe("05 49 51 30 30");
  });
});

describe("métiers", () => {
  it("traduit un métier en codes NAF et normalise les codes saisis", () => {
    expect(resolveNafCodes({ tradeIds: ["menuisier"] })).toEqual([
      "4332A",
      "4332B",
      "1623Z",
    ]);
    expect(resolveNafCodes({ nafCodes: ["43.32a"] })).toEqual(["4332A"]);
  });

  it("refuse un code mal formé, un métier inconnu ou une recherche vide", () => {
    expect(() => resolveNafCodes({ nafCodes: ["menuiserie"] })).toThrow();
    expect(() => resolveNafCodes({ tradeIds: ["astronaute"] })).toThrow();
    expect(() => resolveNafCodes({})).toThrow();
  });
});

describe("quota de prospects offerts", () => {
  it("rien pendant l'essai ni sans abonnement", async () => {
    await setSubscription("pme", "trialing");
    expect(await getPaidPlan(workspaceId)).toBeNull();
    expect(await getProspectQuota(workspaceId)).toMatchObject({
      quota: 0,
      remaining: 0,
    });
  });

  it("TPE : 20 par mois, Entreprise : 50 par mois", async () => {
    expect(await getProspectQuota(workspaceId)).toMatchObject({
      plan: "pme",
      bucket: "monthly",
      quota: 20,
      remaining: 20,
    });
    await setSubscription("entreprise");
    expect((await getProspectQuota(workspaceId)).quota).toBe(50);
  });

  it("Freelance : 10 une seule fois, les mois passés comptent aussi", async () => {
    await setSubscription("freelance");
    const old = await ProspectCreditUsage.create({
      workspaceId,
      kind: "unlock",
      credits: 1,
      siren: "111111111",
      bucket: "welcome",
    });
    await ProspectCreditUsage.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date("2025-01-10T10:00:00Z") } },
    );
    expect(await getProspectQuota(workspaceId)).toMatchObject({
      bucket: "welcome",
      quota: 10,
      used: 1,
      remaining: 9,
      resetsAt: null,
    });
  });
});

describe("recherche", () => {
  it("fermée tant que la fonctionnalité n'est pas activée", async () => {
    delete process.env.PROSPECTS_ENABLED;
    await expect(
      searchProspects({ workspaceId, input: { tradeIds: ["menuisier"] } }),
    ).rejects.toThrow(/pas encore disponible/);
    expect(searchCompanies).not.toHaveBeenCalled();
  });

  it("compte 1 crédit et signale les entreprises déjà dans les clients", async () => {
    await Client.create({
      name: "SATEM",
      email: "accueil@satem-menuiserie.fr",
      siret: "80542020500249",
      address: { city: "Poitiers" },
      workspaceId,
      createdBy: userId,
    });
    searchCompanies.mockResolvedValue({
      total: 2,
      page: 1,
      totalPages: 1,
      results: [
        {
          siren: "805420205",
          name: "SATEM",
          postalCode: "86440",
          city: "MIGNE",
        },
        {
          siren: "439844549",
          name: "TERNOIS POSE",
          postalCode: "62770",
          city: "LE PARCQ",
        },
      ],
    });

    const result = await searchProspects({
      workspaceId,
      userId: userId.toString(),
      input: { tradeIds: ["menuisier"], contact: "both" },
    });

    expect(searchCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        nafCodes: ["4332A", "4332B", "1623Z"],
        contact: "both",
      }),
    );
    expect(result.results.map((r) => r.alreadyInClients)).toEqual([
      true,
      false,
    ]);
    expect(await ProspectCreditUsage.countDocuments({ kind: "search" })).toBe(
      1,
    );
  });

  it("refuse au-delà du budget mensuel de Newbi", async () => {
    process.env.PROSPECT_MONTHLY_CREDIT_CAP = "1";
    await ProspectCreditUsage.create({
      workspaceId,
      kind: "search",
      credits: 1,
    });
    await expect(
      searchProspects({ workspaceId, input: { tradeIds: ["menuisier"] } }),
    ).rejects.toThrow(/momentanément indisponible/);
    expect(searchCompanies).not.toHaveBeenCalled();
  });
});

describe("déblocage", () => {
  it("crée les fiches, même sans email, et les range dans une nouvelle liste", async () => {
    getCompany.mockImplementation(async (siren) =>
      siren === "222222222"
        ? fiche(siren, { email: "contact@deux.fr" })
        : fiche(siren),
    );

    const result = await unlockProspects({
      workspaceId,
      user,
      sirens: ["111111111", "222222222", "333333333"],
      newListName: "Menuisiers Vienne",
    });

    expect(result.unlockedCount).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.quota).toMatchObject({ used: 3, remaining: 17 });

    const sansEmail = await Client.findOne({
      "prospect.siren": "111111111",
    }).lean();
    expect(sansEmail.email).toBeUndefined();
    expect(sansEmail).toMatchObject({
      type: "COMPANY",
      phone: "05 49 51 30 30",
      siret: "111111111",
      prospect: { provider: "societeinfo" },
    });

    const list = await ClientList.findOne({ name: "Menuisiers Vienne" }).lean();
    expect(list.clients).toHaveLength(3);
    expect(
      await ProspectCreditUsage.countDocuments({
        kind: "unlock",
        bucket: "monthly",
      }),
    ).toBe(3);
  });

  it("une fiche sans email reste lisible par GraphQL (chaîne vide)", async () => {
    await unlockProspects({ workspaceId, user, sirens: ["111111111"] });
    const client = await Client.findOne({ "prospect.siren": "111111111" });
    expect(clientResolvers.Client.email(client)).toBe("");
  });

  it("ne fait jamais payer deux fois la même entreprise", async () => {
    await unlockProspects({ workspaceId, user, sirens: ["111111111"] });
    getCompany.mockClear();

    const again = await unlockProspects({
      workspaceId,
      user,
      sirens: ["111111111"],
    });
    expect(getCompany).not.toHaveBeenCalled();
    expect(again.skipped).toEqual([
      { siren: "111111111", reason: "ALREADY_IN_CLIENTS" },
    ]);
    expect(again.quota.used).toBe(1);
  });

  it("n'ajoute jamais une entreprise opposée à la prospection, ni une non vérifiée", async () => {
    checkCommercialOpposition.mockResolvedValue(
      new Map([
        ["111111111", "OPPOSED"],
        ["222222222", "UNKNOWN"],
        ["333333333", "ALLOWED"],
      ]),
    );
    const result = await unlockProspects({
      workspaceId,
      user,
      sirens: ["111111111", "222222222", "333333333"],
    });
    expect(getCompany).toHaveBeenCalledTimes(1);
    expect(result.unlockedCount).toBe(1);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "OPPOSED_TO_PROSPECTING",
      "VERIFICATION_UNAVAILABLE",
    ]);
    expect(result.quota.used).toBe(1);
  });

  it("refuse avant toute dépense quand le quota ne suffit pas", async () => {
    await setSubscription("freelance");
    const sirens = Array.from({ length: 11 }, (_, i) => String(100000000 + i));
    await expect(
      unlockProspects({ workspaceId, user, sirens }),
    ).rejects.toThrow(/Il vous reste 10 prospects/);
    expect(getCompany).not.toHaveBeenCalled();
  });

  it("refuse pendant l'essai", async () => {
    await setSubscription("pme", "trialing");
    await expect(
      unlockProspects({ workspaceId, user, sirens: ["111111111"] }),
    ).rejects.toThrow(/abonnements payés/);
  });

  it("s'arrête proprement si le compte fournisseur n'a plus de crédits", async () => {
    getCompany.mockImplementation(async (siren) => {
      if (siren === "222222222")
        throw new ProspectProviderError("API_MAX_MATCH_EXCEEDED");
      return fiche(siren);
    });
    const result = await unlockProspects({
      workspaceId,
      user,
      sirens: ["111111111", "222222222", "333333333"],
    });
    expect(result.unlockedCount).toBe(1);
    expect(result.providerError).toMatch(/indisponible/);
    // La fiche ratée ne coûte rien au quota
    expect(result.quota.used).toBe(1);
    expect(await ProspectCreditUsage.exists({ siren: "222222222" })).toBeNull();
  });

  it("refuse un nom de liste déjà pris avant toute dépense", async () => {
    await ClientList.create({
      name: "Prospects",
      workspaceId,
      createdBy: userId.toString(),
      clients: [],
    });
    await expect(
      unlockProspects({
        workspaceId,
        user,
        sirens: ["111111111"],
        newListName: "Prospects",
      }),
    ).rejects.toThrow(/déjà ce nom/);
    expect(getCompany).not.toHaveBeenCalled();
  });
});

const page = (sirens, totalPages = 3) => ({
  total: totalPages * 25,
  page: 1,
  totalPages,
  results: sirens.map((siren) => ({ siren, name: `M ${siren}` })),
});

describe("disponibilité réelle", () => {
  it("prend le plus petit du quota et des crédits du fournisseur", async () => {
    getKeyInfo.mockResolvedValue({ totalAvailableCredits: 8 });
    expect(await getProspectAvailability(workspaceId)).toMatchObject({
      remaining: 20,
      // 8 crédits moins une page de recherche
      available: 7,
    });
  });

  it("ignore le solde fournisseur quand il est illisible", async () => {
    getKeyInfo.mockRejectedValue(new Error("réseau"));
    expect((await getProspectAvailability(workspaceId)).available).toBe(20);
  });
});

describe("génération par nombre", () => {
  it("parcourt les pages jusqu'au nombre demandé, sans opposées ni déjà présentes", async () => {
    await Client.create({
      name: "Déjà client",
      email: "deja@client.fr",
      siret: "100000001",
      address: { city: "Poitiers" },
      workspaceId,
      createdBy: userId,
    });
    searchCompanies
      .mockResolvedValueOnce(page(["100000001", "100000002", "100000003"]))
      .mockResolvedValueOnce(page(["100000004", "100000005", "100000006"]));
    checkCommercialOpposition.mockImplementation(
      async (sirens) =>
        new Map(
          sirens.map((s) => [s, s === "100000003" ? "OPPOSED" : "ALLOWED"]),
        ),
    );

    const result = await generateProspects({
      workspaceId,
      user,
      input: { tradeIds: ["menuisier"] },
      count: 3,
      newListName: "Menuisiers",
    });

    expect(searchCompanies).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      requested: 3,
      unlockedCount: 3,
      opposedCount: 1,
    });
    expect(getCompany.mock.calls.map(([s]) => s)).toEqual([
      "100000002",
      "100000004",
      "100000005",
    ]);
    // Le contrôle d'opposition fait pendant la recherche n'est pas refait
    expect(checkCommercialOpposition).toHaveBeenCalledTimes(2);
    const list = await ClientList.findOne({ name: "Menuisiers" }).lean();
    expect(list.clients).toHaveLength(3);
  });

  it("s'arrête sur la dernière page s'il n'y a pas assez d'entreprises", async () => {
    searchCompanies.mockResolvedValue(page(["100000002"], 1));
    const result = await generateProspects({
      workspaceId,
      user,
      input: { tradeIds: ["menuisier"] },
      count: 5,
    });
    expect(searchCompanies).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requested: 5, unlockedCount: 1 });
  });

  it("refuse plus que la disponibilité réelle, avant toute recherche", async () => {
    getKeyInfo.mockResolvedValue({ totalAvailableCredits: 4 });
    await expect(
      generateProspects({
        workspaceId,
        user,
        input: { tradeIds: ["menuisier"] },
        count: 5,
      }),
    ).rejects.toThrow(/Il vous reste 3 prospects disponibles/);
    expect(searchCompanies).not.toHaveBeenCalled();
  });
});

describe("date de création", () => {
  it("lit la date et écarte la date fictive du fournisseur", () => {
    expect(parseCreationDate("2024-03-15")?.toISOString()).toBe(
      "2024-03-15T00:00:00.000Z",
    );
    expect(parseCreationDate("1970-01-01")).toBeNull();
    expect(parseCreationDate("")).toBeNull();
  });

  it("transmet les bornes au fournisseur et refuse une date invalide", async () => {
    searchCompanies.mockResolvedValue(page([], 1));
    await searchProspects({
      workspaceId,
      input: {
        tradeIds: ["menuisier"],
        createdAfter: "2025-11-10",
        createdBefore: "2026-11-10",
      },
    });
    expect(searchCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        minCreationDate: "20251110",
        maxCreationDate: "20261110",
      }),
    );
    await expect(
      searchProspects({
        workspaceId,
        input: { tradeIds: ["menuisier"], createdAfter: "10/11/2025" },
      }),
    ).rejects.toThrow(/Date de création invalide/);
  });

  it("garde la date de création sur la fiche du prospect", async () => {
    await unlockProspects({ workspaceId, user, sirens: ["111111111"] });
    const client = await Client.findOne({
      "prospect.siren": "111111111",
    }).lean();
    expect(client.prospect.companyCreatedAt.toISOString()).toBe(
      "2024-03-15T00:00:00.000Z",
    );
  });
});
