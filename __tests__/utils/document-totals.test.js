import { describe, it, expect } from "vitest";

import {
  computeDocumentTotals,
  inputOrStored,
} from "../../src/utils/documentTotals.js";
import { calculateInvoiceTotals } from "../../src/resolvers/invoice.js";
import { calculateQuoteTotals } from "../../src/resolvers/quote.js";

const shipping = {
  billShipping: true,
  shippingAmountHT: 50,
  shippingVatRate: 20,
};

describe("computeDocumentTotals — ordre de l'aperçu PDF", () => {
  it("n'applique pas la remise globale en % aux frais de port", () => {
    const totals = computeDocumentTotals({
      items: [{ quantity: 1, unitPrice: 1000, vatRate: 20 }],
      discount: 10,
      discountType: "PERCENTAGE",
      shipping,
    });

    // Remise : 10 % de 1000 (articles seuls), pas de 1050
    expect(totals.discountAmount).toBe(100);
    // HT : 900 d'articles + 50 de port
    expect(totals.finalTotalHT).toBe(950);
    // TVA : 180 sur les articles remisés + 10 sur le port
    expect(totals.finalTotalVAT).toBeCloseTo(190, 10);
    expect(totals.finalTotalTTC).toBeCloseTo(1140, 10);
    // Avant remise : articles + port
    expect(totals.totalHT).toBe(1050);
    expect(totals.totalVAT).toBe(210);
    expect(totals.totalTTC).toBe(1260);
  });

  it("plafonne une remise fixe au HT des articles, le port reste dû", () => {
    const totals = computeDocumentTotals({
      items: [{ quantity: 1, unitPrice: 100, vatRate: 20 }],
      discount: 500,
      discountType: "FIXED",
      shipping,
    });

    expect(totals.discountAmount).toBe(100);
    expect(totals.finalTotalHT).toBe(50);
    expect(totals.finalTotalVAT).toBe(10);
    expect(totals.finalTotalTTC).toBe(60);
  });

  it("applique remise de ligne et avancement avant la remise globale", () => {
    const totals = computeDocumentTotals({
      items: [
        {
          quantity: 2,
          unitPrice: 500,
          vatRate: 20,
          discount: 10,
          discountType: "PERCENTAGE",
          progressPercentage: 50,
        },
      ],
      discount: 50,
      discountType: "FIXED",
    });

    // 1000 × 50 % = 500, − 10 % = 450, − 50 = 400
    expect(totals.totalHT).toBe(450);
    expect(totals.finalTotalHT).toBe(400);
    expect(totals.finalTotalVAT).toBeCloseTo(80, 10);
  });

  it("met toute la TVA à 0 en auto-liquidation, port compris", () => {
    const totals = computeDocumentTotals({
      items: [{ quantity: 1, unitPrice: 500, vatRate: 20 }],
      discount: 10,
      discountType: "PERCENTAGE",
      shipping,
      isReverseCharge: true,
    });

    expect(totals.totalVAT).toBe(0);
    expect(totals.finalTotalVAT).toBe(0);
    expect(totals.finalTotalHT).toBe(500);
    expect(totals.finalTotalTTC).toBe(500);
  });

  it("ignore une remise nulle, absente ou négative", () => {
    const items = [{ quantity: 1, unitPrice: 100, vatRate: 20 }];
    for (const discount of [0, null, undefined, -10]) {
      const totals = computeDocumentTotals({ items, discount });
      expect(totals.discountAmount).toBe(0);
      expect(totals.finalTotalTTC).toBe(120);
    }
  });

  it("prend le taux par défaut du schéma (20 %) si le port n'en porte pas", () => {
    const totals = computeDocumentTotals({
      items: [],
      shipping: { billShipping: true, shippingAmountHT: 10 },
    });
    expect(totals.finalTotalVAT).toBe(2);
    expect(totals.finalTotalTTC).toBe(12);
  });

  it("est la règle des factures et des devis", () => {
    const items = [{ quantity: 1, unitPrice: 1000, vatRate: 20 }];
    const expected = computeDocumentTotals({
      items,
      discount: 10,
      discountType: "PERCENTAGE",
      shipping,
    });
    expect(calculateInvoiceTotals(items, 10, "PERCENTAGE", shipping)).toEqual(
      expected,
    );
    expect(calculateQuoteTotals(items, 10, "PERCENTAGE", shipping)).toEqual(
      expected,
    );
  });
});

describe("inputOrStored", () => {
  const stored = { discount: 15, discountType: "PERCENTAGE", shipping };

  it("garde une remise remise à 0 au lieu de reprendre l'ancienne", () => {
    expect(inputOrStored({ discount: 0 }, stored, "discount")).toBe(0);
  });

  it("garde un null explicite (enregistré tel quel)", () => {
    expect(inputOrStored({ shipping: null }, stored, "shipping")).toBeNull();
  });

  it("reprend la valeur enregistrée quand l'input ne porte pas le champ", () => {
    expect(inputOrStored({}, stored, "discount")).toBe(15);
    expect(inputOrStored(undefined, stored, "discountType")).toBe("PERCENTAGE");
    expect(inputOrStored({}, undefined, "discount")).toBeUndefined();
  });
});
