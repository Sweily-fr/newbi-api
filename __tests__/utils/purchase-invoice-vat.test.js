import { describe, it, expect } from "vitest";
import {
  normalizeVatBreakdown,
  summarizeVatBreakdown,
  scaleVatBreakdown,
  mergeVatBreakdowns,
  vatBreakdownFromOcr,
  applyVatBreakdown,
  scalarVatEditBreaksBreakdown,
  deriveVatRate,
  completeVatAmounts,
} from "../../src/utils/purchaseInvoiceVat.js";

// Ticket de restaurant : plats à 10 %, boissons alcoolisées à 20 %
const RESTAURANT = [
  { rate: 10, baseHT: 60, amountTVA: 6 },
  { rate: 20, baseHT: 25, amountTVA: 5 },
];

describe("normalizeVatBreakdown", () => {
  it("lit les formats de chaque source (Claude, Mistral, EN16931, saisie)", () => {
    expect(
      normalizeVatBreakdown([
        { rate: 20, base: 25, amount: 5 },
        { type: "TVA", rate: 10, base_amount: 60, tax_amount: 6 },
        {
          vat_category_rate: "5.50",
          vat_category_taxable_amount: "10.00",
          vat_category_tax_amount: { value: "0.55" },
        },
        { rate: 2.1, baseHT: 100, amountTVA: 2.1 },
      ]),
    ).toEqual([
      { rate: 20, baseHT: 25, amountTVA: 5 },
      { rate: 10, baseHT: 60, amountTVA: 6 },
      { rate: 5.5, baseHT: 10, amountTVA: 0.55 },
      { rate: 2.1, baseHT: 100, amountTVA: 2.1 },
    ]);
  });

  it("additionne les lignes de même taux et trie du plus fort au plus faible", () => {
    expect(
      normalizeVatBreakdown([
        { rate: 5.5, baseHT: 10, amountTVA: 0.55 },
        { rate: 20, baseHT: 10, amountTVA: 2 },
        { rate: 20, baseHT: 15, amountTVA: 3 },
      ]),
    ).toEqual([
      { rate: 20, baseHT: 25, amountTVA: 5 },
      { rate: 5.5, baseHT: 10, amountTVA: 0.55 },
    ]);
  });

  it("déduit la base ou la TVA manquante du taux", () => {
    expect(
      normalizeVatBreakdown([
        { rate: 20, base: 50 },
        { rate: 10, amount: 3 },
      ]),
    ).toEqual([
      { rate: 20, baseHT: 50, amountTVA: 10 },
      { rate: 10, baseHT: 30, amountTVA: 3 },
    ]);
  });

  it("garde une ligne à 0 % (autoliquidation, exonération)", () => {
    expect(normalizeVatBreakdown([{ rate: 0, baseHT: 40 }])).toEqual([
      { rate: 0, baseHT: 40, amountTVA: 0 },
    ]);
  });

  it("écarte les taxes qui ne sont pas de la TVA et les lignes inexploitables", () => {
    expect(
      normalizeVatBreakdown([
        { type: "DEEE", rate: 0, base_amount: 0.02, tax_amount: 0.02 },
        { rate: null, base: 10, amount: 2 },
        { rate: 150, base: 10, amount: 2 },
        { rate: 0, amount: 3 },
        { rate: 20, base: 0, amount: 0 },
        null,
      ]),
    ).toEqual([]);
    expect(normalizeVatBreakdown(undefined)).toEqual([]);
  });
});

describe("summarizeVatBreakdown", () => {
  it("additionne HT et TVA, taux principal = plus grosse base", () => {
    expect(summarizeVatBreakdown(RESTAURANT)).toEqual({
      amountHT: 85,
      amountTVA: 11,
      vatRate: 10,
    });
  });

  it("rien à résumer : null", () => {
    expect(summarizeVatBreakdown([])).toBeNull();
  });
});

describe("scaleVatBreakdown / mergeVatBreakdowns", () => {
  it("ramène chaque ligne au prorata (conversion de devise)", () => {
    expect(scaleVatBreakdown(RESTAURANT, 0.5)).toEqual([
      { rate: 20, baseHT: 12.5, amountTVA: 2.5 },
      { rate: 10, baseHT: 30, amountTVA: 3 },
    ]);
    expect(scaleVatBreakdown(RESTAURANT, 0)).toEqual([]);
  });

  it("fusionne les documents additionnés par taux", () => {
    expect(
      mergeVatBreakdowns([
        RESTAURANT,
        [{ rate: 20, baseHT: 10, amountTVA: 2 }],
      ]),
    ).toEqual([
      { rate: 20, baseHT: 35, amountTVA: 7 },
      { rate: 10, baseHT: 60, amountTVA: 6 },
    ]);
  });
});

describe("vatBreakdownFromOcr", () => {
  const financial = (taxDetails) => ({
    extracted_fields: { tax_details: taxDetails },
  });

  it("garde le détail lu quand il compte plusieurs taux et colle au total", () => {
    expect(
      vatBreakdownFromOcr(
        financial([
          { rate: 10, base: 60, amount: 6 },
          { rate: 20, base: 25, amount: 5 },
        ]),
        { expectedTVA: 11.02 },
      ),
    ).toEqual([
      { rate: 20, baseHT: 25, amountTVA: 5 },
      { rate: 10, baseHT: 60, amountTVA: 6 },
    ]);
  });

  it("un seul taux : pas de détail (les champs historiques suffisent)", () => {
    expect(
      vatBreakdownFromOcr(financial([{ rate: 20, base: 100, amount: 20 }])),
    ).toEqual([]);
  });

  it("détail incohérent avec le total de TVA lu : écarté", () => {
    expect(
      vatBreakdownFromOcr(
        financial([
          { rate: 10, base: 60, amount: 6 },
          { rate: 20, base: 25, amount: 5 },
        ]),
        { expectedTVA: 20 },
      ),
    ).toEqual([]);
  });
});

describe("applyVatBreakdown", () => {
  it("plusieurs taux : détail gardé, champs historiques = résumé", () => {
    const invoice = { amountHT: 0, amountTVA: 0, vatRate: 20 };
    applyVatBreakdown(invoice, RESTAURANT);
    expect(invoice).toEqual({
      vatBreakdown: [
        { rate: 20, baseHT: 25, amountTVA: 5 },
        { rate: 10, baseHT: 60, amountTVA: 6 },
      ],
      amountHT: 85,
      amountTVA: 11,
      vatRate: 10,
    });
  });

  it("un seul taux : redevient les champs historiques, détail vidé", () => {
    const invoice = { vatBreakdown: RESTAURANT, vatRate: 10 };
    applyVatBreakdown(invoice, [{ rate: 5.5, baseHT: 100, amountTVA: 5.5 }]);
    expect(invoice).toEqual({
      vatBreakdown: [],
      amountHT: 100,
      amountTVA: 5.5,
      vatRate: 5.5,
    });
  });

  it("liste vide : détail effacé, montants inchangés", () => {
    const invoice = {
      vatBreakdown: RESTAURANT,
      amountHT: 85,
      amountTVA: 11,
      vatRate: 10,
    };
    applyVatBreakdown(invoice, []);
    expect(invoice).toEqual({
      vatBreakdown: [],
      amountHT: 85,
      amountTVA: 11,
      vatRate: 10,
    });
  });
});

describe("scalarVatEditBreaksBreakdown", () => {
  const invoice = {
    vatBreakdown: RESTAURANT,
    amountHT: 85,
    amountTVA: 11,
    vatRate: 10,
  };

  it("app mobile qui renvoie les montants inchangés : détail conservé", () => {
    expect(
      scalarVatEditBreaksBreakdown(invoice, {
        amountHT: 85,
        amountTVA: 11,
        vatRate: 10,
        amountTTC: 96,
      }),
    ).toBe(false);
    expect(scalarVatEditBreaksBreakdown(invoice, { notes: "x" })).toBe(false);
  });

  it("TVA modifiée à un seul taux : le détail ne correspond plus", () => {
    expect(scalarVatEditBreaksBreakdown(invoice, { vatRate: 20 })).toBe(true);
    expect(scalarVatEditBreaksBreakdown(invoice, { amountTVA: 12 })).toBe(true);
  });

  it("facture sans détail : rien à effacer", () => {
    expect(scalarVatEditBreaksBreakdown({ vatRate: 20 }, { vatRate: 10 })).toBe(
      false,
    );
  });
});

describe("deriveVatRate", () => {
  it("sans TVA : 0 %, pas 20 % (« TVA 0 € à 20 % »)", () => {
    expect(deriveVatRate({ amountHT: 10, amountTVA: 0, amountTTC: 10 })).toBe(
      0,
    );
    expect(deriveVatRate({ amountTTC: 10 })).toBe(0);
    expect(deriveVatRate({ amountHT: null, amountTVA: null })).toBe(0);
    expect(deriveVatRate()).toBe(0);
  });

  it("TVA ÷ HT, avec le taux légal qui redonne la TVA au centime", () => {
    expect(deriveVatRate({ amountHT: 100, amountTVA: 20 })).toBe(20);
    expect(deriveVatRate({ amountHT: 8.33, amountTVA: 1.67 })).toBe(20);
    expect(deriveVatRate({ amountHT: 100, amountTVA: 5.5 })).toBe(5.5);
    expect(deriveVatRate({ amountHT: 100, amountTVA: 8.5 })).toBe(8.5);
    expect(deriveVatRate({ amountHT: "100,00", amountTVA: "10" })).toBe(10);
  });

  it("HT absent : base = TTC - TVA", () => {
    expect(deriveVatRate({ amountTVA: 1.76, amountTTC: 10.59 })).toBe(20);
    expect(deriveVatRate({ amountHT: 0, amountTVA: 20, amountTTC: 120 })).toBe(
      20,
    );
  });

  it("taux mixte sans taux légal correspondant : quotient arrondi", () => {
    expect(deriveVatRate({ amountHT: 100, amountTVA: 12.34 })).toBe(12.34);
  });

  it("avoir (montants négatifs) : même taux", () => {
    expect(deriveVatRate({ amountHT: -100, amountTVA: -20 })).toBe(20);
  });

  it("TVA connue sans aucune base : 20 % en dernier recours", () => {
    expect(deriveVatRate({ amountTVA: 5 })).toBe(20);
  });
});

describe("completeVatAmounts", () => {
  const fill = { fillMissingVat: true };

  it("TTC seul : sans TVA (HT = TTC, 0 %) seulement si demandé", () => {
    expect(completeVatAmounts({ amountTTC: 10 }, fill)).toEqual({
      amountHT: 10,
      amountTVA: 0,
      amountTTC: 10,
      vatRate: 0,
    });
    expect(completeVatAmounts({ amountTTC: 10 })).toEqual({
      amountHT: null,
      amountTVA: null,
      amountTTC: 10,
      vatRate: null,
    });
  });

  it("TTC et TVA : HT = TTC - TVA, taux légal", () => {
    expect(
      completeVatAmounts({ amountTTC: 10.59, amountTVA: 1.76 }),
    ).toMatchObject({ amountHT: 8.83, amountTVA: 1.76, vatRate: 20 });
  });

  it("TTC et HT, TVA non lue : TVA = TTC - HT (pas 0 %)", () => {
    expect(
      completeVatAmounts({ amountTTC: 120, amountHT: 100 }, fill),
    ).toMatchObject({ amountHT: 100, amountTVA: 20, vatRate: 20 });
    // TVA lue à 0 alors que TTC > HT : la lecture du HT donne un taux légal
    expect(
      completeVatAmounts({ amountTTC: 120, amountHT: 100, amountTVA: 0 }, fill),
    ).toMatchObject({ amountHT: 100, amountTVA: 20, vatRate: 20 });
  });

  it("HT et TVA incohérents avec le TTC : la lecture au taux légal est gardée", () => {
    // HT mal lu (90) : la TVA (20) redonne 20 % sur 100
    expect(
      completeVatAmounts({ amountTTC: 120, amountHT: 90, amountTVA: 20 }),
    ).toMatchObject({ amountHT: 100, amountTVA: 20, vatRate: 20 });
  });

  it("TTC et taux seuls : HT = TTC / (1 + taux), sauf fromRate: false", () => {
    expect(
      completeVatAmounts({ amountTTC: 120, vatRate: 20 }, fill),
    ).toMatchObject({ amountHT: 100, amountTVA: 20, vatRate: 20 });
    expect(
      completeVatAmounts({ amountTTC: 120, vatRate: 20 }, { fromRate: false }),
    ).toMatchObject({ amountHT: null, amountTVA: null, vatRate: 20 });
  });

  it("taux fabriqué par l'OCR : remplacé par celui des montants", () => {
    // Claude arrondit 5,5 à 6, Mistral met 0, le secours garde 20,05
    expect(
      completeVatAmounts({
        amountHT: 100,
        amountTVA: 5.5,
        amountTTC: 105.5,
        vatRate: 6,
      }).vatRate,
    ).toBe(5.5);
    expect(
      completeVatAmounts({
        amountHT: 100,
        amountTVA: 20,
        amountTTC: 120,
        vatRate: 0,
      }).vatRate,
    ).toBe(20);
    expect(
      completeVatAmounts({
        amountHT: 8.33,
        amountTVA: 1.67,
        amountTTC: 10,
        vatRate: 20.05,
      }).vatRate,
    ).toBe(20);
  });

  it("« TVA 0 € à 20 % » : le taux suit la TVA", () => {
    expect(
      completeVatAmounts(
        { amountHT: null, amountTVA: 0, amountTTC: 120.5, vatRate: 20 },
        fill,
      ),
    ).toEqual({
      amountHT: 120.5,
      amountTVA: 0,
      amountTTC: 120.5,
      vatRate: 0,
    });
  });

  it("taux cohérent gardé : légal, 0 %, ou mixte sans taux légal", () => {
    expect(
      completeVatAmounts({
        amountHT: 100,
        amountTVA: 10,
        amountTTC: 110,
        vatRate: 10,
      }).vatRate,
    ).toBe(10);
    expect(
      completeVatAmounts({ amountHT: 50, amountTTC: 50, vatRate: 0 }),
    ).toMatchObject({ amountTVA: 0, vatRate: 0 });
    expect(
      completeVatAmounts({
        amountHT: 100,
        amountTVA: 12.34,
        amountTTC: 112.34,
        vatRate: 12.34,
      }).vatRate,
    ).toBe(12.34);
  });

  it("HT et TVA sans TTC : TTC = HT + TVA", () => {
    expect(completeVatAmounts({ amountHT: 100, amountTVA: 20 })).toMatchObject({
      amountTTC: 120,
      vatRate: 20,
    });
  });

  it("lecture plus grande que le TTC : ignorée", () => {
    expect(
      completeVatAmounts({ amountTTC: 10, amountTVA: 15 }, fill),
    ).toMatchObject({ amountHT: 10, amountTVA: 0, vatRate: 0 });
  });
  it("part hors TVA dans le TTC : HT, TVA et taux cohérents gardés", () => {
    // Hôtel avec taxe de séjour (10 %), garage avec débours de carte grise
    expect(
      completeVatAmounts({
        amountHT: 90.91,
        amountTVA: 9.09,
        amountTTC: 101.65,
        vatRate: 10,
      }),
    ).toEqual({
      amountHT: 90.91,
      amountTVA: 9.09,
      amountTTC: 101.65,
      vatRate: 10,
    });
    expect(
      completeVatAmounts({
        amountHT: 90.91,
        amountTVA: 9.09,
        amountTTC: 101.65,
      }).vatRate,
    ).toBe(10);
    expect(
      completeVatAmounts({
        amountHT: 500,
        amountTVA: 100,
        amountTTC: 900,
        vatRate: 20,
      }),
    ).toMatchObject({ amountHT: 500, amountTVA: 100, vatRate: 20 });
    // Facture de solde : acompte déduit du TTC
    expect(
      completeVatAmounts({
        amountHT: 1000,
        amountTVA: 200,
        amountTTC: 600,
        vatRate: 20,
      }),
    ).toMatchObject({ amountHT: 1000, amountTVA: 200, vatRate: 20 });
  });

  it("TVA non lue sur une assurance : pas de TVA inventée", () => {
    // 9 € de taxe d'assurance sur 100 € : 9 % n'est pas un taux légal
    expect(
      completeVatAmounts(
        { amountHT: 100, amountTVA: null, amountTTC: 109 },
        { fillMissingVat: true },
      ),
    ).toMatchObject({ amountHT: 100, amountTVA: 0, vatRate: 0 });
  });

  it("TVA connue et taux légal fourni : HT = TVA / taux, le reste est hors TVA", () => {
    expect(
      completeVatAmounts({ amountTVA: 9.09, amountTTC: 101.65, vatRate: 10 }),
    ).toMatchObject({ amountHT: 90.9, amountTVA: 9.09, vatRate: 10 });
  });

  it("HT connu et taux légal fourni : TVA = HT x taux", () => {
    expect(
      completeVatAmounts({ amountHT: 90.91, amountTTC: 101.65, vatRate: 10 }),
    ).toMatchObject({ amountHT: 90.91, amountTVA: 9.09, vatRate: 10 });
  });

  it("anciennes propositions « TVA 0 € à 20 % »", () => {
    // TVA non lue (0) avec un TTC qui la contient : TVA rétablie
    expect(
      completeVatAmounts(
        { amountHT: 100, amountTVA: 0, amountTTC: 120, vatRate: 20 },
        { fillMissingVat: true },
      ),
    ).toMatchObject({ amountHT: 100, amountTVA: 20, vatRate: 20 });
    // Assurance : pas de TVA, le taux suit (0 %)
    expect(
      completeVatAmounts(
        { amountHT: 100, amountTVA: 0, amountTTC: 109, vatRate: 20 },
        { fillMissingVat: true },
      ),
    ).toMatchObject({ amountHT: 100, amountTVA: 0, vatRate: 0 });
  });
});
