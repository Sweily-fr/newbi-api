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
    // Préfixe à deux blocs, cas réel du 15/09/2026 (tronqué en « 2026-0113 »)
    expect(
      number(
        "Numéro de facture: DY-UY2026-0113\nDate d'émission: 20/08/2026\nRéf. projet: SIT-2026-090",
      ),
    ).toBe("DY-UY2026-0113");
  });

  it("garde les formats courts et à segments", () => {
    expect(number("Numéro du fature FA137")).toBe("FA137");
    expect(number("FACTURE FAC-2024-001 Total")).toBe("FAC-2024-001");
    expect(number("Invoice INV-12345")).toBe("INV-12345");
    expect(number("Facture 2024/12345 client")).toBe("2024/12345");
  });

  it("ignore une référence projet, dossier ou commande", () => {
    expect(
      number(
        "Réf. projet : 2026-0451\nChantier : Rénovation\nFacture N° F-202603-0012",
      ),
    ).toBe("F-202603-0012");
    expect(number("N° de commande : FAC-2024-001\nFacture N° FA137")).toBe(
      "FA137",
    );
    expect(number("Référence dossier : FAC-2024-001 sans numéro") ?? null).toBe(
      null,
    );
  });

  it("ne capture pas un fragment au milieu d'une référence", () => {
    expect(number("REF12345 sans numéro") ?? null).toBeNull();
  });
});
