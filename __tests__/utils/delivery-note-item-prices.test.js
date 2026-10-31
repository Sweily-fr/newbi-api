import { describe, it, expect } from "vitest";
import { keepHiddenItemPrices } from "../../src/utils/deliveryNoteItemPrices.js";

const prix = (unitPrice, extra = {}) => ({
  unitPrice,
  vatRate: 20,
  discount: 0,
  discountType: "PERCENTAGE",
  ...extra,
});

describe("keepHiddenItemPrices", () => {
  it("garde le prix d'une ligne renvoyée sans prix (même désignation)", () => {
    const stored = [
      { description: "Article du devis livré", quantity: 5, ...prix(40) },
    ];
    const input = [
      { description: "Article du devis livré", quantity: 3, productId: "" },
    ];
    expect(keepHiddenItemPrices(input, stored)).toEqual([
      {
        description: "Article du devis livré",
        quantity: 3,
        productId: "",
        ...prix(40),
      },
    ]);
  });

  it("retrouve la ligne par son produit, puis par sa désignation, même déplacée", () => {
    const stored = [
      { description: "Vis", productId: "p1", ...prix(1) },
      { description: "Colle", ...prix(9) },
    ];
    const input = [
      { description: "Colle", quantity: 1 },
      { description: "Vis 4x40 (renommée)", productId: "p1", quantity: 2 },
    ];
    const lignes = keepHiddenItemPrices(input, stored);
    expect(lignes[0].unitPrice).toBe(9);
    expect(lignes[1].unitPrice).toBe(1);
  });

  it("garde le prix d'une désignation retouchée sur place", () => {
    const stored = [{ description: "Palete", ...prix(120) }];
    const input = [{ description: "Palette", quantity: 1 }];
    expect(keepHiddenItemPrices(input, stored)[0].unitPrice).toBe(120);
  });

  it("ne donne pas le prix d'une ligne supprimée à une ligne nouvelle", () => {
    const stored = [
      { description: "A", ...prix(10) },
      { description: "B", ...prix(20) },
    ];
    // B supprimée, A gardée : la ligne nouvelle « C » d'un autre produit reste sans prix
    const input = [
      { description: "A", quantity: 1 },
      { description: "C", productId: "p9", quantity: 1 },
    ];
    const lignes = keepHiddenItemPrices(input, stored);
    expect(lignes[0].unitPrice).toBe(10);
    expect(lignes[1].unitPrice).toBeUndefined();
  });

  it("un même prix ne sert qu'une fois", () => {
    const stored = [{ description: "Pain", ...prix(2) }];
    const input = [
      { description: "Pain", quantity: 1 },
      { description: "Pain", quantity: 4 },
    ];
    const lignes = keepHiddenItemPrices(input, stored);
    expect(lignes[0].unitPrice).toBe(2);
    expect(lignes[1].unitPrice).toBeUndefined();
  });

  it("ne touche à rien quand le bon n'a aucun prix caché (saisi à la main)", () => {
    const input = [{ description: "Palette", quantity: 1 }];
    expect(keepHiddenItemPrices(input, [{ description: "Palette" }])).toBe(
      input,
    );
    expect(keepHiddenItemPrices(input, [])).toBe(input);
    expect(keepHiddenItemPrices(undefined, [])).toBeUndefined();
  });

  it("lit les sous-documents Mongoose (toObject)", () => {
    const stored = [
      {
        toObject: () => ({ description: "Pain", ...prix(2, { vatRate: 5.5 }) }),
      },
    ];
    const lignes = keepHiddenItemPrices(
      [{ description: "Pain", quantity: 1 }],
      stored,
    );
    expect(lignes[0]).toMatchObject({ unitPrice: 2, vatRate: 5.5 });
  });
});
