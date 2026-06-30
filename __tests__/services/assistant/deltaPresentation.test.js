import { describe, it, expect } from "vitest";
import {
  formatDeltaPresentation,
  _internals,
} from "../../../src/services/assistant/deltaPresentation.js";

const REF = "avril";

describe("formatDeltaPresentation — cas INCOMPARABLE", () => {
  it("previousHT null → tout null, unreliable=false", () => {
    expect(
      formatDeltaPresentation({
        currentHT: 5000,
        previousHT: null,
        comparisonLabel: REF,
      }),
    ).toEqual({
      deltaPct: null,
      direction: null,
      deltaText: null,
      deltaUnreliable: false,
    });
  });

  it("previousHT 0 → tout null", () => {
    expect(
      formatDeltaPresentation({
        currentHT: 5000,
        previousHT: 0,
        comparisonLabel: REF,
      }),
    ).toEqual({
      deltaPct: null,
      direction: null,
      deltaText: null,
      deltaUnreliable: false,
    });
  });

  it("previousHT NaN → tout null (défensif)", () => {
    expect(
      formatDeltaPresentation({
        currentHT: 5000,
        previousHT: NaN,
        comparisonLabel: REF,
      }).deltaText,
    ).toBeNull();
  });
});

describe("formatDeltaPresentation — cas STABLE", () => {
  it("variation négligeable (+0,5 %) → 'stable vs <ref>', reliable", () => {
    const out = formatDeltaPresentation({
      currentHT: 100_500,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("stable");
    expect(out.deltaText).toBe("stable vs avril");
    expect(out.deltaUnreliable).toBe(false);
  });

  it("variation -3 % → encore stable", () => {
    const out = formatDeltaPresentation({
      currentHT: 97_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("stable");
    expect(out.deltaText).toBe("stable vs avril");
  });

  it("variation +4,9 % → encore stable (boundary < 5)", () => {
    const out = formatDeltaPresentation({
      currentHT: 104_900,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("stable");
  });

  it("variation +5 % EXACT → pas stable (hausse normale)", () => {
    const out = formatDeltaPresentation({
      currentHT: 105_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("hausse");
    expect(out.deltaText).toBe("+5,0 % vs avril");
  });
});

describe("formatDeltaPresentation — cas NORMAL (hausse/baisse lisibles)", () => {
  it("+10 % vs avril, reliable", () => {
    const out = formatDeltaPresentation({
      currentHT: 110_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("hausse");
    expect(out.deltaText).toBe("+10 % vs avril");
    expect(out.deltaUnreliable).toBe(false);
  });

  it("+8,3 % → 1 décimale en virgule FR", () => {
    const out = formatDeltaPresentation({
      currentHT: 108_300,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("+8,3 % vs avril");
  });

  it("-12 % → format baisse avec signe -", () => {
    const out = formatDeltaPresentation({
      currentHT: 88_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("baisse");
    expect(out.deltaText).toBe("-12 % vs avril");
    expect(out.deltaUnreliable).toBe(false);
  });

  it("hausse +200 % EXACT (boundary) → encore lisible", () => {
    const out = formatDeltaPresentation({
      currentHT: 300_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("+200 % vs avril");
    expect(out.deltaUnreliable).toBe(false);
  });

  it("baisse -70 % avec ratio acceptable (3,33 < 4) → reliable", () => {
    // current/prev = 0.3 → prev/current = 3.33 < 4 → reliable
    const out = formatDeltaPresentation({
      currentHT: 30_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("-70 % vs avril");
    expect(out.deltaUnreliable).toBe(false);
  });
});

describe("formatDeltaPresentation — cas UNRELIABLE (ratio ou base quasi-nulle)", () => {
  it("CAS DU TICKET : previous=1230, current=39140 → 'forte hausse (×32...)'", () => {
    // Le cas exact qui a déclenché ce fix. previous=1230 € (base correcte
    // en valeur absolue >100€), mais ratio 31.8 → ratioUnreliable.
    const out = formatDeltaPresentation({
      currentHT: 39_140,
      previousHT: 1_230,
      comparisonLabel: "mai 2026",
    });
    expect(out.direction).toBe("hausse");
    expect(out.deltaText).toBe(
      "forte hausse vs mai 2026 (×32, mois de référence très bas)",
    );
    expect(out.deltaUnreliable).toBe(true);
  });

  it("base quasi-nulle (50 €) + grosse hausse → ×N + caveat", () => {
    const out = formatDeltaPresentation({
      currentHT: 5_000,
      previousHT: 50,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe(
      "forte hausse vs avril (×100, mois de référence très bas)",
    );
    expect(out.deltaUnreliable).toBe(true);
  });

  it("base quasi-nulle (50 €) + petite hausse (mult < 2) → pas de ×, caveat seul", () => {
    const out = formatDeltaPresentation({
      currentHT: 80,
      previousHT: 50,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("hausse vs avril (mois de référence très bas)");
    expect(out.deltaUnreliable).toBe(true);
  });

  it("hausse +600 % mais base correcte (50k) → 'très forte hausse (+600 %)'", () => {
    // 50k → 350k : current/prev = 7, ratio unreliable
    // Mais base 50k est très au-dessus du plancher 100€, et delta 600%
    // dépasse 200% → cas "très forte hausse" + multiplicateur car aussi
    // ratio unreliable. Le code prend la branche ratio.
    const out = formatDeltaPresentation({
      currentHT: 350_000,
      previousHT: 50_000,
      comparisonLabel: REF,
    });
    // ratioUnreliable (7 >= 4) ET baseQuasiZero (false, 50k > 100) →
    // branche multiplicateur.
    expect(out.deltaText).toBe(
      "forte hausse vs avril (×7, mois de référence très bas)",
    );
    expect(out.deltaUnreliable).toBe(true);
  });

  it("hausse 280 % avec ratio 3,8 (sous seuil ratio) → 'très forte hausse (+280 %)'", () => {
    // current/prev = 3.8 < 4 → ratio reliable, mais absDelta=280>200 → unreliable %.
    // Branche "très forte hausse + %".
    const out = formatDeltaPresentation({
      currentHT: 38_000,
      previousHT: 10_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("très forte hausse vs avril (+280 %)");
    expect(out.deltaUnreliable).toBe(true);
  });

  it("ratio = 4 EXACT (boundary) → unreliable", () => {
    const out = formatDeltaPresentation({
      currentHT: 40_000,
      previousHT: 10_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe(
      "forte hausse vs avril (×4, mois de référence très bas)",
    );
    expect(out.deltaUnreliable).toBe(true);
  });

  it("baisse -80 % (ratio prev/curr = 5) → 'forte baisse', pas de %", () => {
    const out = formatDeltaPresentation({
      currentHT: 20_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("baisse");
    expect(out.deltaText).toBe("forte baisse vs avril");
    expect(out.deltaUnreliable).toBe(true);
  });

  it("baisse depuis base quasi-nulle → caveat 'mois de référence très bas'", () => {
    const out = formatDeltaPresentation({
      currentHT: 10,
      previousHT: 50,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe(
      "forte baisse vs avril (mois de référence très bas)",
    );
    expect(out.deltaUnreliable).toBe(true);
  });
});

describe("formatDeltaPresentation — palier CHUTE QUASI TOTALE (-95 %)", () => {
  it("Δ = -95 % EXACT → 'chute quasi totale'", () => {
    const out = formatDeltaPresentation({
      currentHT: 5_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("chute quasi totale vs avril");
    expect(out.deltaUnreliable).toBe(true);
  });

  it("Δ = -98 % → 'chute quasi totale' (pas 'forte baisse')", () => {
    const out = formatDeltaPresentation({
      currentHT: 2_000,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("chute quasi totale vs avril");
  });

  it("Δ = -100 % (current=0) → 'chute quasi totale'", () => {
    const out = formatDeltaPresentation({
      currentHT: 0,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("chute quasi totale vs avril");
    expect(out.direction).toBe("baisse");
  });

  it("Δ = -94,9 % → encore 'forte baisse', PAS chute quasi totale", () => {
    const out = formatDeltaPresentation({
      currentHT: 5_100,
      previousHT: 100_000,
      comparisonLabel: REF,
    });
    expect(out.deltaText).toBe("forte baisse vs avril");
  });
});

describe("formatDeltaPresentation — base NÉGATIVE (trésorerie)", () => {
  it("previousHT = -2000, currentHT = 5000 → 'comparaison non significative'", () => {
    const out = formatDeltaPresentation({
      currentHT: 5_000,
      previousHT: -2_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("hausse");
    expect(out.deltaText).toBe(
      "comparaison non significative vs avril (base négative)",
    );
    expect(out.deltaUnreliable).toBe(true);
    expect(out.deltaPct).toBeNull(); // pas de % bidon
  });

  it("previousHT négatif + current encore plus négatif → direction baisse", () => {
    const out = formatDeltaPresentation({
      currentHT: -5_000,
      previousHT: -2_000,
      comparisonLabel: REF,
    });
    expect(out.direction).toBe("baisse");
    expect(out.deltaText).toBe(
      "comparaison non significative vs avril (base négative)",
    );
  });
});

describe("formatDeltaPresentation — comparisonLabel custom (jamais d'enum interne)", () => {
  it("affiche le label tel quel ('T1 2026', '2025', 'avril')", () => {
    expect(
      formatDeltaPresentation({
        currentHT: 110_000,
        previousHT: 100_000,
        comparisonLabel: "T1 2026",
      }).deltaText,
    ).toBe("+10 % vs T1 2026");

    expect(
      formatDeltaPresentation({
        currentHT: 110_000,
        previousHT: 100_000,
        comparisonLabel: "2025",
      }).deltaText,
    ).toBe("+10 % vs 2025");
  });

  it("AUCUN deltaText ne doit contenir de nom d'enum technique", () => {
    const cases = [
      { currentHT: 110_000, previousHT: 100_000, comparisonLabel: "avril" },
      { currentHT: 5_000, previousHT: 50, comparisonLabel: "T1 2026" },
      { currentHT: 0, previousHT: 100_000, comparisonLabel: "2025" },
      { currentHT: 5_000, previousHT: -2_000, comparisonLabel: "avril" },
    ];
    const forbidden = [
      "this_month",
      "last_month",
      "this_quarter",
      "last_quarter",
      "this_year",
      "last_year",
      "period",
      "previousHT",
      "currentHT",
    ];
    for (const c of cases) {
      const text = formatDeltaPresentation(c).deltaText || "";
      for (const term of forbidden) {
        expect(text).not.toContain(term);
      }
    }
  });
});

describe("formatDeltaPresentation — internals", () => {
  it("expose les seuils pour audit", () => {
    expect(_internals.HUGE_THRESHOLD_PCT).toBe(200);
    expect(_internals.RATIO_UNRELIABLE).toBe(4);
    expect(_internals.QUASI_ZERO_BASE).toBe(100);
    expect(_internals.QUASI_TOTAL_DROP_PCT).toBe(-95);
  });

  it("formatPct utilise virgule FR + 1 décimale sous 10", () => {
    expect(_internals.formatPct(8.25)).toBe("8,3");
    expect(_internals.formatPct(70)).toBe("70");
    expect(_internals.formatPct(250.4)).toBe("250");
  });
});
