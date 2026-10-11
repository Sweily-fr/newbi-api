import { describe, it, expect } from "vitest";
import {
  assertNotEInvoiceTransmitted,
  isEInvoiceTransmitted,
} from "../../src/utils/eInvoiceLock.js";

describe("isEInvoiceTransmitted", () => {
  it("vrai dès qu'un identifiant SuperPDP est posé", () => {
    expect(isEInvoiceTransmitted({ superPdpInvoiceId: "spdp-1" })).toBe(true);
    expect(
      isEInvoiceTransmitted({
        superPdpInvoiceId: "spdp-1",
        eInvoiceStatus: "ERROR",
      }),
    ).toBe(true);
  });

  it("vrai pour un statut e-invoicing de dépôt ou de cycle de vie", () => {
    for (const status of [
      "PENDING_VALIDATION",
      "VALIDATED",
      "SENT_TO_RECIPIENT",
      "ACCEPTED",
      "REFUSED",
      "PAID",
    ]) {
      expect(isEInvoiceTransmitted({ eInvoiceStatus: status })).toBe(true);
    }
  });

  it("faux sans envoi ou si l'envoi a échoué avant dépôt", () => {
    expect(isEInvoiceTransmitted({})).toBe(false);
    expect(isEInvoiceTransmitted(null)).toBe(false);
    expect(isEInvoiceTransmitted({ eInvoiceStatus: "NOT_SENT" })).toBe(false);
    expect(isEInvoiceTransmitted({ eInvoiceStatus: "ERROR" })).toBe(false);
  });
});

describe("assertNotEInvoiceTransmitted", () => {
  it("lève RESOURCE_LOCKED avec un message propre à la facture ou à l'avoir", () => {
    expect(() =>
      assertNotEInvoiceTransmitted({ superPdpInvoiceId: "spdp-1" }, "invoice"),
    ).toThrow(/Créez un avoir pour la corriger/);
    expect(() =>
      assertNotEInvoiceTransmitted(
        { eInvoiceStatus: "ACCEPTED" },
        "creditNote",
      ),
    ).toThrow(/Cet avoir a été transmis/);
    expect(() => assertNotEInvoiceTransmitted({}, "invoice")).not.toThrow();
  });
});
