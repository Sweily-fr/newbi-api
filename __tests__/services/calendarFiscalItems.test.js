/**
 * Calendrier : source « Fiscal » de calendarLinkedItems. Les échéances sont
 * calculées à chaque affichage depuis les informations légales de
 * l'organisation (fiscalDeadlines.js) ; ce qui manque est renvoyé dans
 * `fiscalSetup` pour que le calendrier invite à le compléter.
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
import { buildASTSchema, defaultFieldResolver, graphql } from "graphql";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { getCalendarLinkedItems } from "../../src/services/calendar/linkedItemsService.js";
import calendarLinkedItemsResolvers from "../../src/resolvers/calendarLinkedItems.js";
import typeDefs from "../../src/schemas/index.js";

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

// Mercredi 28 octobre 2026, 10 h à Paris
const NOW = new Date("2026-10-28T09:00:00Z");

const allowAll = {
  hasPermission: () => true,
  canDelete: () => true,
};

const SAS = {
  legalForm: "SAS",
  isVatSubject: true,
  vatRegime: "reel-normal",
  vatFrequency: "mensuel",
  vatMode: "debits",
  fiscalYearStartDate: "2026-01-01",
  fiscalYearEndDate: "2026-12-31",
};

const insertOrganization = (fields, _id = orgA) =>
  mongoose.connection.db
    .collection("organization")
    .insertOne({ _id, name: "Atelier Lumière", ...fields });

const run = (overrides = {}) =>
  getCalendarLinkedItems({
    workspaceId: orgA.toString(),
    userId: userId.toString(),
    permissions: allowAll,
    db: mongoose.connection.db,
    from: "2026-11-01",
    to: "2027-01-31",
    now: NOW,
    ...overrides,
  });

const fiscal = (result) =>
  result.items
    .filter((i) => i.kind === "FISCAL")
    .map((i) => [i.day, i.entityId]);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
});

describe("source Fiscal", () => {
  it("SAS au réel normal mensuel : TVA, acompte d'IS et CFE, rien ne manque", async () => {
    await insertOrganization(SAS);

    const result = await run();

    expect(result.kinds).toContain("FISCAL");
    expect(fiscal(result)).toEqual([
      ["2026-11-19", "VAT_RETURN_MONTHLY"],
      ["2026-12-15", "CFE"],
      ["2026-12-15", "CORPORATE_TAX_INSTALLMENT"],
      ["2026-12-21", "VAT_RETURN_MONTHLY"],
      ["2027-01-19", "VAT_RETURN_MONTHLY"],
    ]);
    expect(result.items[0]).toMatchObject({
      id: "FISCAL:VAT_RETURN_MONTHLY:2026-11-19",
      kind: "FISCAL",
      state: "UPCOMING",
      amount: null,
      isIndicative: true,
    });
    expect(result.fiscalSetup).toEqual({ complete: true, missing: [] });
    expect(result.truncated).toBe(false);
  });

  it("information manquante : la taxe n'apparaît pas et fiscalSetup la signale", async () => {
    await insertOrganization({
      legalForm: "SAS",
      isVatSubject: true,
      vatRegime: "reel-normal",
    });

    const result = await run();

    expect(fiscal(result)).toEqual([["2026-12-15", "CFE"]]);
    expect(result.fiscalSetup.complete).toBe(false);
    expect(result.fiscalSetup.missing.map((m) => m.code)).toEqual([
      "VAT_FREQUENCY",
      "FISCAL_YEAR_END",
    ]);
  });

  it("espace sans informations légales : aucune échéance", async () => {
    const result = await run();

    expect(fiscal(result)).toEqual([]);
    expect(result.fiscalSetup.missing.map((m) => m.code)).toEqual([
      "LEGAL_FORM",
    ]);
  });

  it("sans le droit « Voir » du calendrier : ni source Fiscal, ni fiscalSetup", async () => {
    await insertOrganization(SAS);
    const noCalendar = {
      hasPermission: (module) => module !== "calendar",
      canDelete: () => true,
    };

    const result = await run({ permissions: noCalendar });

    expect(result.kinds).not.toContain("FISCAL");
    expect(fiscal(result)).toEqual([]);
    expect(result.fiscalSetup).toBeNull();
  });

  it("les informations légales d'un autre espace ne sont jamais lues", async () => {
    await insertOrganization(SAS, orgB);

    const result = await run();

    expect(fiscal(result)).toEqual([]);
    expect(result.fiscalSetup.missing.map((m) => m.code)).toEqual([
      "LEGAL_FORM",
    ]);
  });
});

describe("schéma GraphQL de la source Fiscal", () => {
  const schema = buildASTSchema(typeDefs, { assumeValidSDL: true });
  const QUERY = `query ($from: String!, $to: String!) {
    calendarLinkedItems(from: $from, to: $to) {
      kinds
      fiscalSetup {
        complete
        missing { code label concerns }
      }
      items {
        id kind entityId day title reference counterparty amount currency
        state documentStatus infoUrl isIndicative isConditional note
      }
    }
  }`;

  const execute = (variableValues) =>
    graphql({
      schema,
      source: QUERY,
      variableValues,
      contextValue: buildContext({
        userId,
        organizationId: orgA,
        extra: { db: mongoose.connection.db },
      }),
      fieldResolver: (parent, args, context, info) => {
        const resolver =
          calendarLinkedItemsResolvers[info.parentType.name]?.[info.fieldName];
        return resolver
          ? resolver(parent, args, context, info)
          : defaultFieldResolver(parent, args, context, info);
      },
    });

  it("sert les échéances et leurs champs sans erreur de type", async () => {
    await insertOrganization(SAS);
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });

    // Mai 2027 : dates indépendantes du jour où le test tourne
    const res = await execute({ from: "2027-05-01", to: "2027-05-31" });

    expect(res.errors).toBeUndefined();
    const { kinds, fiscalSetup, items } = res.data.calendarLinkedItems;
    expect(kinds).toContain("FISCAL");
    expect(fiscalSetup).toEqual({ complete: true, missing: [] });
    const fiscalItems = items.filter((i) => i.kind === "FISCAL");
    expect(fiscalItems.map((i) => [i.day, i.entityId])).toEqual([
      ["2027-05-18", "CORPORATE_TAX_BALANCE"],
      ["2027-05-19", "VAT_RETURN_MONTHLY"],
    ]);
    expect(fiscalItems[0]).toMatchObject({
      title: "Solde de l'impôt sur les sociétés",
      reference: "Exercice clos le 31/12/2026",
      counterparty: "Service des impôts des entreprises",
      amount: null,
      currency: null,
      documentStatus: "DECLARATION_PAYMENT",
      infoUrl: "https://entreprendre.service-public.gouv.fr/vosdroits/F23575",
      isIndicative: false,
      isConditional: false,
    });
    expect(fiscalItems[0].note).toContain("2572");
  });

  it("renvoie les informations manquantes", async () => {
    await insertOrganization({ legalForm: "EI", fiscalRegime: "micro-bnc" });
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });

    const res = await execute({ from: "2027-05-01", to: "2027-05-31" });

    expect(res.errors).toBeUndefined();
    expect(res.data.calendarLinkedItems.fiscalSetup).toEqual({
      complete: false,
      missing: [
        {
          code: "VAT_STATUS",
          label:
            "Indiquez si vous êtes assujetti à la TVA ou en franchise en base.",
          concerns: ["TVA"],
        },
        {
          code: "MICRO_DECLARATION_FREQUENCY",
          label:
            "Indiquez la périodicité de vos déclarations de chiffre d'affaires à l'Urssaf (mensuelle ou trimestrielle).",
          concerns: ["Déclarations Urssaf"],
        },
      ],
    });
  });
});
