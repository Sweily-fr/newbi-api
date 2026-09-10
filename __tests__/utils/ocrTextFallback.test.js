import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  detectCurrency,
  parseLocalizedAmount,
  parseTextDate,
  guessVendorName,
  extractInvoiceFieldsFromText,
} from "../../src/utils/ocrTextFallback.js";

const northwind = fs.readFileSync(
  path.join(process.cwd(), "__tests__/fixtures/ocr/northwind-tesseract.txt"),
  "utf8",
);

const frenchInvoice = `SARL DUPONT PLOMBERIE
12 rue des Lilas 75011 PARIS
SIRET 123 456 789 00012
FACTURE N° FA-2026-0177
Date : 12/08/2026
Échéance : 11/09/2026
Total HT 1 234,56 €
TVA 20 % 246,91 €
TOTAL TTC 1 481,47 €
NET A PAYER 1 481,47 €`;

const blueHarbor = `Blue Harbor Supply Co. INVOICE 2026-INV-0873
742 Harbor Drive, Building C
Seattle, WA 98104 Issue date: September 2, 2026
United States Due date: September 17, 2026
EIN 91-3345120 Terms: Net 15 | 2/10 net 15
ar@blueharborsupply.example Currency: USD
1 SKU-2201 — Commercial espresso machine, 3 unit $3,450.00 $10,350.00
Subtotal $17,901.55
Volume discount (3%) -$537.05
Freight $189.00
Sales tax (Chicago, IL — 10.25%) $1,799.23
Total (USD) $19,352.73
Credit memo CM-0219 applied -$320.15
Balance due (USD) $19,032.58
Reference: 2026-INV-0873 | Also accepted: ACH, wire, corporate card`;

describe("ocrTextFallback.parseLocalizedAmount", () => {
  it("comprend les formats européen et américain", () => {
    expect(parseLocalizedAmount("3,577.78")).toBe(3577.78);
    expect(parseLocalizedAmount("1 234,56")).toBe(1234.56);
    expect(parseLocalizedAmount("4.077,78")).toBe(4077.78);
    expect(parseLocalizedAmount("120,00")).toBe(120);
    expect(parseLocalizedAmount("249.00")).toBe(249);
    expect(parseLocalizedAmount("3 847")).toBe(3847);
    expect(parseLocalizedAmount("$3,577.78")).toBe(3577.78);
    expect(parseLocalizedAmount("-$125.00")).toBe(-125);
    expect(parseLocalizedAmount("")).toBeNull();
    expect(parseLocalizedAmount(null)).toBeNull();
  });
});

describe("ocrTextFallback.parseTextDate", () => {
  it("lit les dates en toutes lettres, numériques (JJ/MM/AAAA) et ISO", () => {
    expect(parseTextDate("March 4, 2026")).toBe("2026-03-04");
    expect(parseTextDate("4 mars 2026")).toBe("2026-03-04");
    expect(parseTextDate("04/03/2026")).toBe("2026-03-04");
    expect(parseTextDate("2026-03-04")).toBe("2026-03-04");
    expect(parseTextDate("Apr 3 2026")).toBe("2026-04-03");
    expect(parseTextDate("n'importe quoi")).toBeNull();
  });
});

describe("ocrTextFallback.detectCurrency", () => {
  it("retient la devise dominante, null si aucun marqueur", () => {
    expect(detectCurrency(northwind)).toBe("USD");
    expect(detectCurrency(frenchInvoice)).toBe("EUR");
    expect(detectCurrency("Total 12 CHF")).toBe("CHF");
    expect(detectCurrency("Total 12 £")).toBe("GBP");
    expect(detectCurrency("rien")).toBeNull();
  });
});

describe("ocrTextFallback.guessVendorName", () => {
  it("prend la première ligne propre, sans le mot INVOICE/FACTURE", () => {
    expect(guessVendorName(northwind)).toBe("Northwind Digital LLC");
    expect(guessVendorName(frenchInvoice)).toBe("SARL DUPONT PLOMBERIE");
    expect(guessVendorName("FACTURE\n\nACME SAS\n")).toBe("ACME SAS");
    expect(guessVendorName("")).toBeNull();
  });
});

describe("ocrTextFallback.extractInvoiceFieldsFromText", () => {
  it("facture anglaise en USD lue par Tesseract : solde dû, taxe, dates, numéro", () => {
    const r = extractInvoiceFieldsFromText(northwind);
    expect(r.found).toBe(true);
    expect(r.transaction_data).toMatchObject({
      vendor_name: "Northwind Digital LLC",
      amount: 3577.78,
      amount_ht: 3847,
      tax_amount: 310.78,
      tax_rate: 8.25,
      transaction_date: "2026-03-04",
      due_date: "2026-04-03",
      document_number: "INV-2026-0042",
      currency: "USD",
    });
    expect(r.extracted_fields.totals).toEqual({
      total_ht: 3847,
      total_tax: 310.78,
      total_ttc: 3577.78,
    });
  });

  it("facture USD avec avoir, remise en % et numéro préfixé par l'année", () => {
    const r = extractInvoiceFieldsFromText(blueHarbor);
    expect(r.transaction_data).toMatchObject({
      vendor_name: "Blue Harbor Supply Co.",
      amount: 19032.58,
      amount_ht: 17901.55,
      tax_amount: 1799.23,
      tax_rate: 10.25, // pas la remise de 3 %
      transaction_date: "2026-09-02",
      due_date: "2026-09-17",
      document_number: "2026-INV-0873",
      currency: "USD",
    });
  });

  it("facture française : net à payer, HT, TVA, SIRET, dates", () => {
    const r = extractInvoiceFieldsFromText(frenchInvoice);
    expect(r.found).toBe(true);
    expect(r.transaction_data).toMatchObject({
      vendor_name: "SARL DUPONT PLOMBERIE",
      amount: 1481.47,
      amount_ht: 1234.56,
      tax_amount: 246.91,
      tax_rate: 20,
      transaction_date: "2026-08-12",
      due_date: "2026-09-11",
      document_number: "FA-2026-0177",
      currency: "EUR",
    });
    expect(r.extracted_fields.vendor_siret?.replace(/\s/g, "")).toBe(
      "12345678900012",
    );
  });

  it("texte vide ou sans rien d'exploitable : found = false", () => {
    expect(extractInvoiceFieldsFromText("").found).toBe(false);
    expect(extractInvoiceFieldsFromText("   \n  ").found).toBe(false);
  });
});
