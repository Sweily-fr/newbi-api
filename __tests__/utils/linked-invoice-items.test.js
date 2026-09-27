import { describe, it, expect } from "vitest";
import {
  buildLinkedInvoiceItems,
  REVERSE_CHARGE_MENTION,
  VAT_EXEMPT_MENTION,
} from "../../src/utils/linkedInvoiceItems.js";

const DESCRIPTION = "Facture sur devis D-092026-0002";

/** TTC reconstitué depuis les lignes produites. */
const totalTTC = (items) =>
  items.reduce(
    (sum, item) =>
      sum + item.quantity * item.unitPrice * (1 + item.vatRate / 100),
    0,
  );

describe("buildLinkedInvoiceItems", () => {
  it("reprend le taux du devis au lieu de 20 % (cas du ticket : 5,5 %)", () => {
    const quote = {
      items: [{ quantity: 3, unitPrice: 40, vatRate: 5.5 }],
    };

    const items = buildLinkedInvoiceItems({
      quote,
      amountTTC: 126.6,
      description: DESCRIPTION,
    });

    expect(items).toHaveLength(1);
    expect(items[0].vatRate).toBe(5.5);
    expect(items[0].unitPrice).toBeCloseTo(120, 2);
    expect(items[0].description).toBe(DESCRIPTION);
    expect(totalTTC(items)).toBeCloseTo(126.6, 2);
  });

  it("garde 20 % quand le devis est à 20 %", () => {
    const items = buildLinkedInvoiceItems({
      quote: { items: [{ quantity: 1, unitPrice: 100, vatRate: 20 }] },
      amountTTC: 120,
      description: DESCRIPTION,
    });

    expect(items).toHaveLength(1);
    expect(items[0].vatRate).toBe(20);
    expect(items[0].unitPrice).toBeCloseTo(100, 2);
  });

  it("facture un acompte au taux du devis en conservant le TTC demandé", () => {
    const items = buildLinkedInvoiceItems({
      quote: { items: [{ quantity: 1, unitPrice: 1000, vatRate: 10 }] },
      amountTTC: 330,
      description: "Acompte sur devis D-092026-0002",
    });

    expect(items[0].vatRate).toBe(10);
    expect(totalTTC(items)).toBeCloseTo(330, 2);
  });

  it("émet une ligne par taux, au prorata, sur un devis multi-taux", () => {
    // 1000 HT à 20 % (1200 TTC) + 1000 HT à 5,5 % (1055 TTC) = 2255 TTC
    const quote = {
      items: [
        { quantity: 1, unitPrice: 1000, vatRate: 20 },
        { quantity: 1, unitPrice: 1000, vatRate: 5.5 },
      ],
    };

    const items = buildLinkedInvoiceItems({
      quote,
      amountTTC: 2255,
      description: DESCRIPTION,
    });

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.vatRate)).toEqual([20, 5.5]);
    expect(items[0].unitPrice).toBeCloseTo(1000, 2);
    expect(items[1].unitPrice).toBeCloseTo(1000, 2);
    expect(items[1].description).toContain("TVA 5,5 %");
    expect(totalTTC(items)).toBeCloseTo(2255, 2);
  });

  it("conserve le TTC exact malgré les arrondis sur un multi-taux", () => {
    const quote = {
      items: [
        { quantity: 1, unitPrice: 333.33, vatRate: 20 },
        { quantity: 1, unitPrice: 166.67, vatRate: 5.5 },
      ],
    };

    const items = buildLinkedInvoiceItems({
      quote,
      amountTTC: 123.45,
      description: DESCRIPTION,
    });

    expect(totalTTC(items)).toBeCloseTo(123.45, 2);
  });

  it("tient compte de la remise de ligne dans la ventilation", () => {
    // 100 HT à 20 % remisés de 50 % => 50 HT (60 TTC) ; 100 HT à 5,5 % => 105,5 TTC
    const quote = {
      items: [
        {
          quantity: 1,
          unitPrice: 100,
          vatRate: 20,
          discount: 50,
          discountType: "PERCENTAGE",
        },
        { quantity: 1, unitPrice: 100, vatRate: 5.5 },
      ],
    };

    const items = buildLinkedInvoiceItems({
      quote,
      amountTTC: 165.5,
      description: DESCRIPTION,
    });

    const at20 = items.find((i) => i.vatRate === 20);
    const at55 = items.find((i) => i.vatRate === 5.5);
    expect(at20.unitPrice).toBeCloseTo(50, 2);
    expect(at55.unitPrice).toBeCloseTo(100, 2);
  });

  it("intègre les frais de livraison facturés à leur propre taux", () => {
    const quote = {
      items: [{ quantity: 1, unitPrice: 100, vatRate: 5.5 }],
      shipping: {
        billShipping: true,
        shippingAmountHT: 10,
        shippingVatRate: 20,
      },
    };

    const items = buildLinkedInvoiceItems({
      quote,
      amountTTC: 117.5,
      description: DESCRIPTION,
    });

    expect(items.map((i) => i.vatRate).sort((a, b) => a - b)).toEqual([
      5.5, 20,
    ]);
    expect(totalTTC(items)).toBeCloseTo(117.5, 2);
  });

  it("sort une ligne à 0 % avec la mention d'autoliquidation", () => {
    const items = buildLinkedInvoiceItems({
      quote: {
        isReverseCharge: true,
        items: [{ quantity: 1, unitPrice: 1000, vatRate: 20 }],
      },
      amountTTC: 1000,
      description: DESCRIPTION,
    });

    expect(items).toHaveLength(1);
    expect(items[0].vatRate).toBe(0);
    expect(items[0].unitPrice).toBe(1000);
    expect(items[0].vatExemptionText).toBe(REVERSE_CHARGE_MENTION);
  });

  it("sort une ligne à 0 % avec la mention de franchise en base", () => {
    const items = buildLinkedInvoiceItems({
      quote: {
        isVatExempt: true,
        items: [{ quantity: 1, unitPrice: 500, vatRate: 0 }],
      },
      amountTTC: 500,
      description: DESCRIPTION,
    });

    expect(items[0].vatRate).toBe(0);
    expect(items[0].vatExemptionText).toBe(VAT_EXEMPT_MENTION);
  });

  it("reprend la mention d'exonération portée par la ligne du devis", () => {
    const items = buildLinkedInvoiceItems({
      quote: {
        items: [
          {
            quantity: 1,
            unitPrice: 200,
            vatRate: 0,
            vatExemptionText: "Exonération art. 261-4-4° du CGI",
          },
        ],
      },
      amountTTC: 200,
      description: DESCRIPTION,
    });

    expect(items[0].vatRate).toBe(0);
    expect(items[0].vatExemptionText).toBe("Exonération art. 261-4-4° du CGI");
  });

  it("laisse vatExemptionText vide sur une ligne taxée (contrainte du modèle)", () => {
    const items = buildLinkedInvoiceItems({
      quote: { items: [{ quantity: 1, unitPrice: 100, vatRate: 5.5 }] },
      amountTTC: 105.5,
      description: DESCRIPTION,
    });

    expect(items[0].vatExemptionText).toBe("");
  });

  it("retombe sur 20 % si le devis ne permet rien de déduire", () => {
    const items = buildLinkedInvoiceItems({
      quote: { items: [] },
      amountTTC: 120,
      description: DESCRIPTION,
    });

    expect(items).toHaveLength(1);
    expect(items[0].vatRate).toBe(20);
    expect(items[0].unitPrice).toBeCloseTo(100, 2);
  });

  it("garde le taux du devis même si son montant est nul", () => {
    const items = buildLinkedInvoiceItems({
      quote: { items: [{ quantity: 0, unitPrice: 0, vatRate: 5.5 }] },
      amountTTC: 100,
      description: DESCRIPTION,
    });

    expect(items[0].vatRate).toBe(5.5);
  });
});
