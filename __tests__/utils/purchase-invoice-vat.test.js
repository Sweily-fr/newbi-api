import { describe, it, expect } from "vitest";
import {
  normalizeVatBreakdown,
  summarizeVatBreakdown,
  scaleVatBreakdown,
  mergeVatBreakdowns,
  vatBreakdownFromOcr,
  applyVatBreakdown,
  scalarVatEditBreaksBreakdown,
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
