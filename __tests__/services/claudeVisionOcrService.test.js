import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import claudeVisionOcrService from "../../src/services/claudeVisionOcrService.js";
import { completeVatAmounts } from "../../src/utils/purchaseInvoiceVat.js";

// Réponse de Claude (JSON du prompt d'extraction) → format système
const taxRate = (data) =>
  claudeVisionOcrService.toInvoiceFormat({ data }).transaction_data.tax_rate;

describe("claudeVisionOcrService.toInvoiceFormat : taux de TVA", () => {
  it("garde le taux imprimé, 0 % compris (autoliquidation, franchise)", () => {
    expect(
      taxRate({
        totals: { total_ht: 100, total_vat: 5.5, total_ttc: 105.5 },
        tax_details: [{ rate: 5.5, base: 100, amount: 5.5 }],
      }),
    ).toBe(5.5);
    expect(
      taxRate({
        totals: { total_ht: 100, total_vat: 0, total_ttc: 100 },
        tax_details: [{ rate: 0, base: 100, amount: 0 }],
      }),
    ).toBe(0);
  });

  it("taux non imprimé : null, plus le quotient TVA / HT arrondi (5,5 devenait 6)", () => {
    expect(
      taxRate({ totals: { total_ht: 100, total_vat: 5.5, total_ttc: 105.5 } }),
    ).toBeNull();
    expect(
      taxRate({
        totals: { total_ht: 8.33, total_vat: 1.67, total_ttc: 10 },
        tax_details: [{ rate: null, base: 8.33, amount: 1.67 }],
      }),
    ).toBeNull();
    expect(taxRate({ totals: { total_ttc: 12 }, tax_details: [] })).toBeNull();
    expect(taxRate({})).toBeNull();
  });

  it("la règle commune déduit ensuite le taux des montants lus", () => {
    const td = claudeVisionOcrService.toInvoiceFormat({
      data: { totals: { total_ht: 100, total_vat: 5.5, total_ttc: 105.5 } },
    }).transaction_data;
    expect(
      completeVatAmounts({
        amountHT: td.amount_ht,
        amountTVA: td.tax_amount,
        amountTTC: td.amount,
        vatRate: td.tax_rate,
      }).vatRate,
    ).toBe(5.5);
  });
});
