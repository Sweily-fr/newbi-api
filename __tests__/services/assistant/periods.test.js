import { describe, it, expect } from "vitest";
import {
  periodLabel,
  previousPeriodLabel,
} from "../../../src/services/assistant/periods.js";

/**
 * Tests des 6 valeurs d'enum à DATE FIXE.
 *
 * Cible : `previousPeriodLabel` — c'est le piège du décalage d'un cran.
 *   - this_*  → recule d'un cran
 *   - last_*  → recule de DEUX crans
 * Sans test deterministe, last_month et last_year passeraient comme
 * "mai 2026" et "2025" alors que la bonne réponse est "avril 2026" et "2024".
 *
 * Date de référence : 30 juin 2026 (mois=5 zéro-indexé, T2 2026).
 */
const TODAY = new Date(2026, 5, 30); // 30 juin 2026

describe("periodLabel — 6 enums à date fixe (30 juin 2026)", () => {
  it("this_month → 'Juin 2026'", () => {
    expect(periodLabel("this_month", TODAY)).toBe("Juin 2026");
  });
  it("last_month → 'Mai 2026' (capitalisé : usage TITRE, pas en phrase)", () => {
    // periodLabel reste capitalisé (utilisé comme titre dans periodLabel
    // de la réponse). previousPeriodLabel est en minuscule (usage en phrase
    // après "vs ...").
    expect(periodLabel("last_month", TODAY)).toBe("Mai 2026");
  });
  it("this_quarter → 'T2 2026'", () => {
    expect(periodLabel("this_quarter", TODAY)).toBe("T2 2026");
  });
  it("last_quarter → 'T1 2026'", () => {
    expect(periodLabel("last_quarter", TODAY)).toBe("T1 2026");
  });
  it("this_year → '2026'", () => {
    expect(periodLabel("this_year", TODAY)).toBe("2026");
  });
  it("last_year → '2025'", () => {
    expect(periodLabel("last_year", TODAY)).toBe("2025");
  });
});

describe("previousPeriodLabel — 6 enums à date fixe (30 juin 2026)", () => {
  // Cas critique : le décalage d'UN cran. À surveiller surtout last_month
  // et last_year qui reculent de DEUX crans.

  it("this_month → 'Mai 2026' (mois précédent)", () => {
    expect(previousPeriodLabel("this_month", TODAY)).toBe("mai 2026");
  });

  it("last_month → 'Avril 2026' (mois encore avant, PAS Mai 2026 !)", () => {
    // Le piège : last_month répond une question sur MAI. La comparaison de
    // mai = AVRIL. Si on rend "mai 2026" ici, le LLM dirait "+12 % vs Mai"
    // alors qu'il parle DE mai → boucle absurde.
    expect(previousPeriodLabel("last_month", TODAY)).toBe("avril 2026");
  });

  it("this_quarter → 'T1 2026' (trimestre précédent)", () => {
    expect(previousPeriodLabel("this_quarter", TODAY)).toBe("T1 2026");
  });

  it("last_quarter → 'T4 2025' (trimestre encore avant)", () => {
    // last_quarter = T1 2026. Sa comparaison = T4 2025. PAS T1 2026.
    expect(previousPeriodLabel("last_quarter", TODAY)).toBe("T4 2025");
  });

  it("this_year → '2025' (année précédente)", () => {
    expect(previousPeriodLabel("this_year", TODAY)).toBe("2025");
  });

  it("last_year → '2024' (année encore avant, PAS 2025 !)", () => {
    // Le piège : last_year répond une question sur 2025. Sa comparaison =
    // 2024. Si on rend "2025", le LLM dirait "+10 % vs 2025" alors qu'il
    // parle DE 2025.
    expect(previousPeriodLabel("last_year", TODAY)).toBe("2024");
  });
});

describe("previousPeriodLabel — passages d'année (cas frontière)", () => {
  it("this_month en janvier → 'Décembre <année-1>'", () => {
    const janvier = new Date(2026, 0, 15);
    expect(previousPeriodLabel("this_month", janvier)).toBe("décembre 2025");
  });

  it("last_month en février → 'Décembre <année-1>'", () => {
    // last_month en février = janvier. Comparaison = décembre année précédente.
    const fevrier = new Date(2026, 1, 15);
    expect(previousPeriodLabel("last_month", fevrier)).toBe("décembre 2025");
  });

  it("this_quarter en T1 → 'T4 <année-1>'", () => {
    const t1 = new Date(2026, 1, 15);
    expect(previousPeriodLabel("this_quarter", t1)).toBe("T4 2025");
  });

  it("last_quarter en T1 → 'T3 <année-1>'", () => {
    // last_quarter en T1 2026 = T4 2025. Comparaison = T3 2025.
    const t1 = new Date(2026, 1, 15);
    expect(previousPeriodLabel("last_quarter", t1)).toBe("T3 2025");
  });
});

describe("previousPeriodLabel — labels SANS jargon technique (anti-fuite)", () => {
  it("AUCUN label ne doit contenir de nom d'enum technique", () => {
    const periods = [
      "this_month",
      "last_month",
      "this_quarter",
      "last_quarter",
      "this_year",
      "last_year",
    ];
    const forbidden = [
      "this_month",
      "last_month",
      "this_quarter",
      "last_quarter",
      "this_year",
      "last_year",
      "period",
    ];
    for (const p of periods) {
      const label = previousPeriodLabel(p, TODAY);
      for (const term of forbidden) {
        expect(label).not.toContain(term);
      }
    }
  });
});
