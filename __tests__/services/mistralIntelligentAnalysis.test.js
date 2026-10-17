import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import mistralIntelligentAnalysisService from "../../src/services/mistralIntelligentAnalysisService.js";
import { normalizeVatBreakdown } from "../../src/utils/purchaseInvoiceVat.js";

// Réponse JSON de Mistral → analyse validée
const clean = (transactionData = {}, extractedFields = {}) =>
  mistralIntelligentAnalysisService.validateAndCleanAnalysis({
    transaction_data: transactionData,
    extracted_fields: extractedFields,
  });

describe("mistralIntelligentAnalysisService : taux de TVA", () => {
  it("garde le taux lu, 0 % compris", () => {
    expect(clean({ tax_rate: 5.5 }).transaction_data.tax_rate).toBe(5.5);
    expect(clean({ tax_rate: "5,5 %" }).transaction_data.tax_rate).toBe(5.5);
    expect(clean({ tax_rate: 0 }).transaction_data.tax_rate).toBe(0);
  });

  it("taux absent ou illisible : null, plus 0 % par défaut", () => {
    expect(clean({}).transaction_data.tax_rate).toBeNull();
    expect(clean({ tax_rate: null }).transaction_data.tax_rate).toBeNull();
    expect(clean({ tax_rate: "" }).transaction_data.tax_rate).toBeNull();
    expect(clean({ tax_rate: "N/A" }).transaction_data.tax_rate).toBeNull();
  });

  it("ligne de TVA sans taux : écartée du détail, pas une ligne à 0 % avec TVA", () => {
    const { extracted_fields } = clean(
      {},
      {
        tax_details: [
          { type: "TVA", rate: null, base_amount: 60, tax_amount: 6 },
          { type: "TVA", rate: 20, base_amount: 25, tax_amount: 5 },
          { type: "DEEE", rate: 0, tax_amount: 0.02 },
        ],
      },
    );
    expect(extracted_fields.tax_details.map((t) => t.rate)).toEqual([
      null,
      20,
      0,
    ]);
    expect(normalizeVatBreakdown(extracted_fields.tax_details)).toEqual([
      { rate: 20, baseHT: 25, amountTVA: 5 },
    ]);
  });

  it("analyse de secours : taux non imprimé null, rien de lisible null", () => {
    const regex = mistralIntelligentAnalysisService.getFallbackAnalysis({
      extractedText: `SNACK DU COIN
Total HT 8,33 €
Montant TVA 1,67 €
TOTAL TTC 10,00 €`,
    });
    expect(regex.transaction_data).toMatchObject({
      amount: 10,
      tax_amount: 1.67,
      tax_rate: null,
    });
    expect(
      mistralIntelligentAnalysisService.getFallbackAnalysis({
        extractedText: "",
      }).transaction_data.tax_rate,
    ).toBeNull();
  });
});
