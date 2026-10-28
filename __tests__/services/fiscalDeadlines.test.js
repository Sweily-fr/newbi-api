/**
 * Calendrier : échéances fiscales et sociales calculées depuis les
 * informations légales (fonctions pures, dates fixes 2024 à 2028).
 *
 * Les dates « officielles » des tests viennent des calendriers publiés par
 * impots.gouv.fr : CFE 2024 le 16/12/2024, acompte d'IS du 17/03/2025, CA3
 * de mai 2026 « entre les 15 et 26 mai », dernière CA12 le 4 mai 2027.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeFiscalProfile,
  computeFiscalDeadlines,
  corporateTaxBalanceDue,
  easterSunday,
  firstCorporateTaxInstallment,
  frenchPublicHolidays,
  isNonWorkingDay,
  nextWorkingDay,
  normalizeLegalForm,
  nthWorkingDayOfMonth,
  FISCAL_INFO_URLS,
} from "../../src/services/calendar/fiscalDeadlines.js";

// Mercredi 28 octobre 2026
const TODAY = "2026-10-28";

const run = (organization, from, to, today = TODAY) =>
  computeFiscalDeadlines(organization, { from, to, today });

const days = (result, code) =>
  result.items.filter((i) => i.entityId === code).map((i) => i.day);

const find = (result, code, day) =>
  result.items.find((i) => i.entityId === code && i.day === day);

const missingCodes = (result) => result.setup.missing.map((m) => m.code);

const SAS = {
  legalForm: "SAS",
  isVatSubject: true,
  vatRegime: "reel-normal",
  vatFrequency: "mensuel",
  vatMode: "debits",
  fiscalYearStartDate: "2026-01-01",
  fiscalYearEndDate: "2026-12-31",
};

describe("jours fériés et report", () => {
  it("calcule Pâques et les fêtes mobiles", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    const holidays = frenchPublicHolidays(2027);
    // Lundi de Pâques, Ascension, lundi de Pentecôte
    expect(holidays.has("2027-03-29")).toBe(true);
    expect(holidays.has("2027-05-06")).toBe(true);
    expect(holidays.has("2027-05-17")).toBe(true);
    expect(holidays.has("2027-11-11")).toBe(true);
    expect(holidays.size).toBe(11);
  });

  it("reporte au premier jour ni samedi, ni dimanche, ni férié", () => {
    expect(isNonWorkingDay("2026-12-19")).toBe(true); // samedi
    expect(nextWorkingDay("2026-12-19")).toBe("2026-12-21");
    expect(nextWorkingDay("2026-11-11")).toBe("2026-11-12"); // mercredi férié
    // Samedi 15 mai 2027, puis dimanche et lundi de Pentecôte
    expect(nextWorkingDay("2027-05-15")).toBe("2027-05-18");
    expect(nextWorkingDay("2026-12-15")).toBe("2026-12-15");
  });

  it("deuxième jour ouvré de mai", () => {
    expect(nthWorkingDayOfMonth(2027, 5, 2)).toBe("2027-05-04");
    expect(nthWorkingDayOfMonth(2026, 5, 2)).toBe("2026-05-05");
  });
});

describe("TVA au réel normal", () => {
  it("mensuelle : société, date indicative la plus tôt, report du samedi", () => {
    const result = run(SAS, "2026-11-01", "2027-01-31");

    expect(days(result, "VAT_RETURN_MONTHLY")).toEqual([
      "2026-11-19",
      "2026-12-21", // le 19 décembre 2026 est un samedi
      "2027-01-19",
    ]);
    const item = find(result, "VAT_RETURN_MONTHLY", "2026-11-19");
    expect(item).toMatchObject({
      id: "FISCAL:VAT_RETURN_MONTHLY:2026-11-19",
      kind: "FISCAL",
      title: "Déclaration de TVA (CA3)",
      reference: "Octobre 2026",
      counterparty: "Service des impôts des entreprises",
      amount: null,
      currency: null,
      state: "UPCOMING",
      documentStatus: "DECLARATION_PAYMENT",
      infoUrl: FISCAL_INFO_URLS.VAT,
      isIndicative: true,
      isConditional: false,
    });
    expect(item.note).toContain("entre le 19 et le 21 du mois");
  });

  it("entreprise individuelle : le 15, reporté au lundi 16 février 2026", () => {
    const result = run(
      { ...SAS, legalForm: "EI", fiscalRegime: "reel-normal" },
      "2026-02-01",
      "2026-02-28",
    );

    expect(find(result, "VAT_RETURN_MONTHLY", "2026-02-16")).toMatchObject({
      reference: "Janvier 2026",
      state: "DONE",
    });
  });

  it("société anonyme : le 23 mai 2026 tombe un samedi, reporté au 26", () => {
    const result = run({ ...SAS, legalForm: "SA" }, "2026-05-01", "2026-05-31");

    expect(days(result, "VAT_RETURN_MONTHLY")).toEqual(["2026-05-26"]);
  });

  it("association : le 24, date exacte", () => {
    const result = run(
      { ...SAS, legalForm: "Association" },
      "2026-11-01",
      "2026-11-30",
    );

    const [item] = result.items;
    expect(item).toMatchObject({ day: "2026-11-24", isIndicative: false });
    expect(item.note).toContain("Date limite fixée au 24 du mois.");
  });

  it("trimestrielle : en avril, juillet, octobre et janvier", () => {
    const result = run(
      { ...SAS, vatFrequency: "trimestriel" },
      "2026-07-01",
      "2027-01-31",
    );

    expect(
      result.items
        .filter((i) => i.entityId === "VAT_RETURN_QUARTERLY")
        .map((i) => [i.day, i.reference, i.state]),
    ).toEqual([
      ["2026-07-20", "2e trimestre 2026", "DONE"], // dimanche 19 juillet
      ["2026-10-19", "3e trimestre 2026", "DONE"],
      ["2027-01-19", "4e trimestre 2026", "UPCOMING"],
    ]);
  });

  it("sans fréquence : pas de TVA, information signalée", () => {
    const result = run(
      { ...SAS, vatFrequency: "" },
      "2026-11-01",
      "2026-11-30",
    );

    expect(days(result, "VAT_RETURN_MONTHLY")).toEqual([]);
    expect(missingCodes(result)).toEqual(["VAT_FREQUENCY"]);
    expect(result.setup.complete).toBe(false);
  });
});

describe("TVA au réel simplifié (supprimé au 1er janvier 2027)", () => {
  const SARL_RSI = {
    legalForm: "SARL",
    isVatSubject: true,
    vatRegime: "reel-simplifie",
    fiscalYearEndDate: "2026-12-31",
  };

  it("exercice civil : acompte de décembre 2026, dernière CA12 le 4 mai 2027, puis CA3 trimestrielle", () => {
    const result = run(SARL_RSI, "2026-01-01", "2027-12-31");

    expect(days(result, "VAT_INSTALLMENT")).toEqual([
      "2026-07-20", // dimanche 19 juillet 2026
      "2026-12-21", // samedi 19 décembre 2026
    ]);
    expect(find(result, "VAT_INSTALLMENT", "2026-12-21")).toMatchObject({
      reference: "Acompte de décembre 2026",
      documentStatus: "PAYMENT",
      isConditional: true,
      isIndicative: true,
      infoUrl: FISCAL_INFO_URLS.VAT_SIMPLIFIED,
    });

    expect(days(result, "VAT_ANNUAL_RETURN")).toEqual([
      "2026-05-05", // exercice 2025 : supposé, donc conditionnel
      "2027-05-04",
    ]);
    const last = find(result, "VAT_ANNUAL_RETURN", "2027-05-04");
    expect(last).toMatchObject({
      reference: "Exercice clos le 31/12/2026",
      isConditional: false,
      isIndicative: false,
    });
    expect(last.note).toContain("C'est la dernière");
    expect(find(result, "VAT_ANNUAL_RETURN", "2026-05-05").isConditional).toBe(
      true,
    );

    expect(days(result, "VAT_RETURN_QUARTERLY")).toEqual([
      "2027-04-19",
      "2027-07-19",
      "2027-10-19",
    ]);
    expect(find(result, "VAT_RETURN_QUARTERLY", "2027-04-19").note).toContain(
      "devient trimestrielle",
    );
  });

  it("clôture au 30 septembre : acompte de juillet 2027, CA12 trois mois après la clôture", () => {
    const result = run(
      {
        ...SARL_RSI,
        legalForm: "EI",
        fiscalRegime: "reel-simplifie",
        fiscalYearStartDate: "2025-10-01",
        fiscalYearEndDate: "2026-09-30",
      },
      "2026-10-01",
      "2028-01-31",
    );

    expect(days(result, "VAT_INSTALLMENT")).toEqual([
      "2026-12-15",
      "2027-07-15",
    ]);
    expect(find(result, "VAT_INSTALLMENT", "2027-07-15").note).toContain(
      "dépasse 1 000 €",
    );
    expect(days(result, "VAT_ANNUAL_RETURN")).toEqual([
      "2026-12-30",
      "2027-12-30",
    ]);
    // Régime trimestriel d'office après la clôture du 30/09/2027
    expect(
      result.items
        .filter((i) => i.entityId === "VAT_RETURN_QUARTERLY")
        .map((i) => [i.day, i.reference]),
    ).toEqual([["2028-01-17", "4e trimestre 2027"]]);
  });

  it("clôture au 31 mars : pas d'acompte en juillet 2027", () => {
    const result = run(
      { ...SARL_RSI, fiscalYearEndDate: "2027-03-31" },
      "2027-01-01",
      "2027-12-31",
    );

    expect(days(result, "VAT_INSTALLMENT")).toEqual([]);
    expect(days(result, "VAT_ANNUAL_RETURN")).toEqual(["2027-06-30"]);
    expect(days(result, "VAT_RETURN_QUARTERLY")).toEqual([
      "2027-07-19",
      "2027-10-19",
    ]);
  });

  it("sans date de clôture : seulement les acomptes de 2026, CA12 signalée", () => {
    const result = run(
      { ...SARL_RSI, fiscalYearEndDate: "" },
      "2026-01-01",
      "2027-12-31",
    );

    expect(days(result, "VAT_INSTALLMENT")).toEqual([
      "2026-07-20",
      "2026-12-21",
    ]);
    expect(days(result, "VAT_ANNUAL_RETURN")).toEqual([]);
    expect(days(result, "VAT_RETURN_QUARTERLY")).toEqual([]);
    const missing = result.setup.missing.find(
      (m) => m.code === "FISCAL_YEAR_END",
    );
    expect(missing.concerns).toEqual([
      "Déclaration annuelle de TVA (CA12)",
      "Impôt sur les sociétés",
    ]);
  });
});

describe("impôt sur les sociétés", () => {
  const SAS_NO_VAT = { legalForm: "SAS", isVatSubject: false };

  it("exercice civil : quatre acomptes conditionnels et solde reporté après la Pentecôte", () => {
    const result = run(
      { ...SAS_NO_VAT, fiscalYearEndDate: "2026-12-31" },
      "2027-01-01",
      "2027-12-31",
    );

    expect(days(result, "CORPORATE_TAX_INSTALLMENT")).toEqual([
      "2027-03-15",
      "2027-06-15",
      "2027-09-15",
      "2027-12-15",
    ]);
    expect(
      find(result, "CORPORATE_TAX_INSTALLMENT", "2027-03-15"),
    ).toMatchObject({
      reference: "1er acompte, exercice clos le 31/12/2027",
      isConditional: true,
      infoUrl: FISCAL_INFO_URLS.CORPORATE_TAX,
    });
    // 15 mai 2027 : samedi, puis dimanche et lundi de Pentecôte
    expect(days(result, "CORPORATE_TAX_BALANCE")).toEqual(["2027-05-18"]);
    expect(find(result, "CORPORATE_TAX_BALANCE", "2027-05-18")).toMatchObject({
      reference: "Exercice clos le 31/12/2026",
      isConditional: false,
      documentStatus: "DECLARATION_PAYMENT",
    });
  });

  it("acompte du samedi 15 mars 2025 reporté au lundi 17", () => {
    const result = run(
      { ...SAS_NO_VAT, fiscalYearEndDate: "2025-12-31" },
      "2025-03-01",
      "2025-03-31",
    );

    expect(days(result, "CORPORATE_TAX_INSTALLMENT")).toEqual(["2025-03-17"]);
  });

  it("clôture décalée au 30 juin : acomptes de septembre à juin, solde le 15 octobre", () => {
    const result = run(
      {
        ...SAS_NO_VAT,
        fiscalYearStartDate: "2026-07-01",
        fiscalYearEndDate: "2027-06-30",
      },
      "2026-07-01",
      "2027-10-31",
    );

    expect(
      result.items
        .filter((i) => i.entityId === "CORPORATE_TAX_INSTALLMENT")
        .map((i) => [i.day, i.reference]),
    ).toEqual([
      ["2026-09-15", "1er acompte, exercice clos le 30/06/2027"],
      ["2026-12-15", "2e acompte, exercice clos le 30/06/2027"],
      ["2027-03-15", "3e acompte, exercice clos le 30/06/2027"],
      ["2027-06-15", "4e acompte, exercice clos le 30/06/2027"],
      ["2027-09-15", "1er acompte, exercice clos le 30/06/2028"],
    ]);
    // Exercice précédant celui saisi : supposé, donc conditionnel
    const previous = find(result, "CORPORATE_TAX_BALANCE", "2026-10-15");
    expect(previous).toMatchObject({
      reference: "Exercice clos le 30/06/2026",
      isConditional: true,
      state: "DONE",
    });
    expect(previous.note).toContain(
      "À condition qu'un exercice ait été clos le 30/06/2026",
    );
    expect(find(result, "CORPORATE_TAX_BALANCE", "2027-10-15")).toMatchObject({
      isConditional: false,
    });
  });

  it("premier exercice de moins de douze mois : aucun exercice antérieur supposé", () => {
    const result = run(
      {
        ...SAS_NO_VAT,
        fiscalYearStartDate: "2026-03-01",
        fiscalYearEndDate: "2026-12-31",
      },
      "2026-01-01",
      "2027-06-30",
    );

    expect(days(result, "CORPORATE_TAX_BALANCE")).toEqual(["2027-05-18"]);
  });

  it("table des acomptes selon la clôture précédente (CGI, ann. III, art. 360 bis)", () => {
    expect(firstCorporateTaxInstallment("2026-02-19")).toBe("2026-03-15");
    expect(firstCorporateTaxInstallment("2026-02-20")).toBe("2026-06-15");
    expect(firstCorporateTaxInstallment("2026-05-19")).toBe("2026-06-15");
    expect(firstCorporateTaxInstallment("2026-05-20")).toBe("2026-09-15");
    expect(firstCorporateTaxInstallment("2026-08-19")).toBe("2026-09-15");
    expect(firstCorporateTaxInstallment("2026-08-20")).toBe("2026-12-15");
    expect(firstCorporateTaxInstallment("2026-11-19")).toBe("2026-12-15");
    expect(firstCorporateTaxInstallment("2026-11-20")).toBe("2027-03-15");
    expect(firstCorporateTaxInstallment("2026-12-31")).toBe("2027-03-15");
  });

  it("solde : 15 du 4e mois après la clôture, 15 mai pour le 31 décembre", () => {
    expect(corporateTaxBalanceDue("2026-12-31")).toBe("2027-05-15");
    expect(corporateTaxBalanceDue("2027-06-30")).toBe("2027-10-15");
    expect(corporateTaxBalanceDue("2027-03-31")).toBe("2027-07-15");
    expect(corporateTaxBalanceDue("2027-09-30")).toBe("2028-01-15");
  });

  it("EURL, EI, SELARL, SCI : pas d'IS (option non connue)", () => {
    for (const legalForm of ["EURL", "EI", "SELARL", "SCI", "SNC"]) {
      const result = run(
        {
          legalForm,
          fiscalRegime: "reel-normal",
          isVatSubject: false,
          fiscalYearEndDate: "2026-12-31",
        },
        "2027-01-01",
        "2027-12-31",
      );
      expect(days(result, "CORPORATE_TAX_INSTALLMENT")).toEqual([]);
      expect(days(result, "CORPORATE_TAX_BALANCE")).toEqual([]);
    }
  });

  it("sans date de clôture : rien, information signalée", () => {
    const result = run(SAS_NO_VAT, "2027-01-01", "2027-12-31");

    expect(days(result, "CORPORATE_TAX_INSTALLMENT")).toEqual([]);
    expect(result.setup.missing).toEqual([
      {
        code: "FISCAL_YEAR_END",
        label: "Renseignez la date de clôture de votre exercice comptable.",
        concerns: ["Impôt sur les sociétés"],
      },
    ]);
  });

  it("clôture au jour anniversaire du début : à vérifier, rien n'est corrigé en silence", () => {
    const result = run(
      {
        ...SAS_NO_VAT,
        fiscalYearStartDate: "2026-01-01",
        fiscalYearEndDate: "2027-01-01",
      },
      "2027-01-01",
      "2027-12-31",
    );

    expect(days(result, "CORPORATE_TAX_BALANCE")).toEqual([]);
    expect(result.setup.missing[0].label).toBe(
      "Vérifiez la date de clôture de votre exercice comptable (1er janvier 2027) : un exercice de douze mois commencé le 1er janvier 2026 se termine le 31 décembre 2026.",
    );
  });

  it("clôture antérieure au début : à corriger", () => {
    const result = run(
      {
        ...SAS_NO_VAT,
        fiscalYearStartDate: "2026-01-01",
        fiscalYearEndDate: "2025-12-31",
      },
      "2027-01-01",
      "2027-12-31",
    );

    expect(result.setup.missing[0].label).toContain("précède sa date de début");
  });
});

describe("CFE", () => {
  it("solde du 15 décembre, reporté au 16 en 2024", () => {
    const result = run(
      { legalForm: "SARL", isVatSubject: false },
      "2024-01-01",
      "2026-12-31",
    );

    expect(days(result, "CFE")).toEqual([
      "2024-12-16",
      "2025-12-15",
      "2026-12-15",
    ]);
    expect(find(result, "CFE", "2026-12-15")).toMatchObject({
      title: "Cotisation foncière des entreprises (CFE)",
      reference: "CFE 2026",
      isConditional: true,
      documentStatus: "PAYMENT",
      infoUrl: FISCAL_INFO_URLS.CFE,
      state: "UPCOMING",
    });
  });

  it("ni SCI, ni association, ni indivision", () => {
    for (const legalForm of ["SCI", "Association", "Indivision"]) {
      const result = run(
        { legalForm, isVatSubject: false },
        "2026-12-01",
        "2026-12-31",
      );
      expect(days(result, "CFE")).toEqual([]);
    }
  });
});

describe("micro-entrepreneur : déclarations Urssaf", () => {
  const MICRO = {
    legalForm: "EI",
    fiscalRegime: "micro-bnc",
    vatFranchise: true,
  };

  it("trimestrielle : date légale gardée, 31 octobre 2026 non reporté", () => {
    const result = run(
      { ...MICRO, microDeclarationFrequency: "trimestriel" },
      "2026-10-01",
      "2027-04-30",
    );

    expect(
      result.items
        .filter((i) => i.entityId === "URSSAF_REVENUE")
        .map((i) => [i.day, i.reference, i.isIndicative]),
    ).toEqual([
      ["2026-10-31", "3e trimestre 2026", false],
      ["2027-01-31", "4e trimestre 2026", true], // dimanche
      ["2027-04-30", "1er trimestre 2027", false],
    ]);
    const october = find(result, "URSSAF_REVENUE", "2026-10-31");
    expect(october).toMatchObject({
      counterparty: "Urssaf",
      infoUrl: FISCAL_INFO_URLS.URSSAF,
      state: "UPCOMING",
    });
    expect(october.note).toContain("exceptionnellement pas reportée");
    expect(find(result, "URSSAF_REVENUE", "2027-01-31").note).toContain(
      "l'Urssaf la reporte en général",
    );
  });

  it("mensuelle : dernier jour du mois suivant", () => {
    const result = run(
      { ...MICRO, microDeclarationFrequency: "mensuel" },
      "2026-10-01",
      "2027-03-31",
    );

    expect(
      result.items
        .filter((i) => i.entityId === "URSSAF_REVENUE")
        .map((i) => [i.day, i.reference]),
    ).toEqual([
      ["2026-10-31", "Septembre 2026"],
      ["2026-11-30", "Octobre 2026"],
      ["2026-12-31", "Novembre 2026"],
      ["2027-01-31", "Décembre 2026"],
      ["2027-02-28", "Janvier 2027"],
      ["2027-03-31", "Février 2027"],
    ]);
  });

  it("ancien libellé « Auto-entrepreneur » sans régime : micro-entrepreneur", () => {
    const result = run(
      {
        legalForm: "Auto-entrepreneur",
        vatFranchise: true,
        microDeclarationFrequency: "trimestriel",
      },
      "2027-04-01",
      "2027-04-30",
    );

    expect(days(result, "URSSAF_REVENUE")).toEqual(["2027-04-30"]);
    expect(result.setup.complete).toBe(true);
  });

  it("périodicité non renseignée : pas de déclaration, CFE quand même", () => {
    const result = run(MICRO, "2026-10-01", "2026-12-31");

    expect(days(result, "URSSAF_REVENUE")).toEqual([]);
    expect(days(result, "CFE")).toEqual(["2026-12-15"]);
    expect(missingCodes(result)).toEqual(["MICRO_DECLARATION_FREQUENCY"]);
  });

  it("entreprise individuelle sans régime fiscal : régime à renseigner", () => {
    const result = run(
      { legalForm: "EI", vatFranchise: true },
      "2026-10-01",
      "2026-12-31",
    );

    expect(missingCodes(result)).toEqual(["FISCAL_REGIME"]);
  });

  it("entreprise individuelle au réel, EURL au micro-BIC : pas de déclaration Urssaf", () => {
    for (const organization of [
      { legalForm: "EI", fiscalRegime: "reel-simplifie", vatFranchise: true },
      { legalForm: "EURL", fiscalRegime: "micro-bic", vatFranchise: true },
    ]) {
      const result = run(
        { ...organization, microDeclarationFrequency: "mensuel" },
        "2026-10-01",
        "2026-12-31",
      );
      expect(days(result, "URSSAF_REVENUE")).toEqual([]);
      expect(result.setup.complete).toBe(true);
    }
  });
});

describe("informations manquantes", () => {
  it("sans forme juridique : rien n'est affiché", () => {
    for (const organization of [null, {}, { legalForm: "" }]) {
      const result = run(organization, "2026-10-01", "2026-12-31");
      expect(result.items).toEqual([]);
      expect(result.setup).toEqual({
        complete: false,
        missing: [
          {
            code: "LEGAL_FORM",
            label: "Renseignez votre forme juridique.",
            concerns: [
              "TVA",
              "Impôt sur les sociétés",
              "CFE",
              "Déclarations Urssaf",
            ],
          },
        ],
      });
    }
  });

  it("forme juridique inconnue : à choisir dans la liste", () => {
    const result = run(
      { legalForm: "AUTRE", isVatSubject: false },
      "2026-10-01",
      "2026-12-31",
    );

    expect(result.items).toEqual([]);
    expect(result.setup.missing[0].label).toBe(
      "Choisissez votre forme juridique dans la liste proposée.",
    );
  });

  // SNC : ni impôt sur les sociétés, ni date de clôture nécessaire
  it("situation de TVA jamais renseignée : signalée ; « non » ou franchise : rien", () => {
    const unknown = run({ legalForm: "SNC" }, "2026-11-01", "2026-11-30");
    expect(missingCodes(unknown)).toEqual(["VAT_STATUS"]);

    for (const vat of [{ isVatSubject: false }, { vatFranchise: true }]) {
      const result = run(
        { legalForm: "SNC", ...vat },
        "2026-11-01",
        "2026-11-30",
      );
      expect(result.items).toEqual([]);
      expect(result.setup.complete).toBe(true);
    }
  });

  it("assujetti sans régime de TVA : régime à renseigner", () => {
    const result = run(
      { legalForm: "SNC", isVatSubject: true, vatRegime: "" },
      "2026-11-01",
      "2026-11-30",
    );

    expect(missingCodes(result)).toEqual(["VAT_REGIME"]);
  });

  it("profil complet : rien ne manque", () => {
    const { missing } = analyzeFiscalProfile(SAS);

    expect(missing).toEqual([]);
  });
});

describe("état et forme juridique", () => {
  it("date passée : DONE ; du jour ou à venir : UPCOMING", () => {
    const result = run(
      { legalForm: "SARL", isVatSubject: false },
      "2026-12-01",
      "2026-12-31",
      "2026-12-15",
    );
    const later = run(
      { legalForm: "SARL", isVatSubject: false },
      "2026-12-01",
      "2026-12-31",
      "2026-12-16",
    );

    expect(result.items[0].state).toBe("UPCOMING");
    expect(later.items[0].state).toBe("DONE");
  });

  it("anciens libellés et codes INSEE ramenés à la liste", () => {
    expect(normalizeLegalForm("SAS")).toBe("SAS");
    expect(normalizeLegalForm("5710")).toBe("SAS");
    expect(normalizeLegalForm("5499")).toBe("SARL");
    expect(normalizeLegalForm("6540")).toBe("SCI");
    expect(normalizeLegalForm("Entrepreneur individuel")).toBe("EI");
    expect(normalizeLegalForm("Association déclarée")).toBe("Association");
    expect(normalizeLegalForm("AUTRE")).toBeNull();
    expect(normalizeLegalForm(undefined)).toBeNull();
  });

  it("code INSEE d'une SAS : impôt sur les sociétés calculé", () => {
    const result = run(
      {
        legalForm: "5710",
        isVatSubject: false,
        fiscalYearEndDate: "2026-12-31",
      },
      "2027-05-01",
      "2027-05-31",
    );

    expect(days(result, "CORPORATE_TAX_BALANCE")).toEqual(["2027-05-18"]);
  });
});
