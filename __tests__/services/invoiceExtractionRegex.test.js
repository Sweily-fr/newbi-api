import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import invoiceExtractionService from "../../src/services/invoiceExtractionService.js";

// Ticket 14/09/2026 : un numéro Newbi « F-202603-0012 » ressortait tronqué en
// « 202603 » sur le chemin OCR de secours (regex) : préfixe exclu, capture
// limitée à 6 chiffres.
describe("invoiceExtractionService.extractWithPatterns — numéro de facture", () => {
  const number = (text) =>
    invoiceExtractionService.extractWithPatterns(text).invoiceNumber;

  it("conserve le numéro complet au format Newbi F-AAAAMM-NNNN", () => {
    expect(number("Facture N° F-202603-0012 du 12/03/2026")).toBe(
      "F-202603-0012",
    );
    expect(number("FACTURE F-202609-0003")).toBe("F-202609-0003");
    expect(number("Numéro de facture : F-202609-0003")).toBe("F-202609-0003");
  });

  it("garde les formats courts et à segments", () => {
    expect(number("Numéro du fature FA137")).toBe("FA137");
    expect(number("FACTURE FAC-2024-001 Total")).toBe("FAC-2024-001");
    expect(number("Invoice INV-12345")).toBe("INV-12345");
    expect(number("Réf 2024/12345 client")).toBe("2024/12345");
  });

  it("ne capture pas un fragment au milieu d'une référence", () => {
    expect(number("REF12345 sans numéro") ?? null).toBeNull();
  });
});
