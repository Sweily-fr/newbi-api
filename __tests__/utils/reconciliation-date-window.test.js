import { describe, it, expect } from "vitest";

import {
  RECONCILIATION_DATE_BUFFER_DAYS,
  earliestTransactionDateForInvoice,
  latestInvoiceIssueDateForTransaction,
  transactionDateMatchesInvoice,
} from "../../src/utils/reconciliationDateWindow.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("reconciliationDateWindow", () => {
  const invoice = { issueDate: new Date("2026-05-15T00:00:00.000Z") };

  describe("transactionDateMatchesInvoice", () => {
    it("accepte une transaction postérieure à l'émission", () => {
      const tx = { date: new Date("2026-06-02T00:00:00.000Z") };
      expect(transactionDateMatchesInvoice(tx, invoice)).toBe(true);
    });

    it("accepte une transaction le jour de l'émission", () => {
      const tx = { date: new Date("2026-05-15T00:00:00.000Z") };
      expect(transactionDateMatchesInvoice(tx, invoice)).toBe(true);
    });

    it("accepte une transaction dans la marge avant l'émission", () => {
      const tx = {
        date: new Date(
          invoice.issueDate.getTime() -
            RECONCILIATION_DATE_BUFFER_DAYS * DAY_MS,
        ),
      };
      expect(transactionDateMatchesInvoice(tx, invoice)).toBe(true);
    });

    it("refuse une transaction au-delà de la marge avant l'émission", () => {
      const tx = {
        date: new Date(
          invoice.issueDate.getTime() -
            (RECONCILIATION_DATE_BUFFER_DAYS + 1) * DAY_MS,
        ),
      };
      expect(transactionDateMatchesInvoice(tx, invoice)).toBe(false);
    });

    it("refuse un paiement plusieurs mois avant la facture", () => {
      const tx = { date: new Date("2026-01-10T00:00:00.000Z") };
      expect(transactionDateMatchesInvoice(tx, invoice)).toBe(false);
    });

    it("n'exclut pas quand la facture n'a pas de date d'émission", () => {
      const tx = { date: new Date("2026-01-10T00:00:00.000Z") };
      expect(transactionDateMatchesInvoice(tx, {})).toBe(true);
      expect(transactionDateMatchesInvoice(tx, null)).toBe(true);
    });

    it("n'exclut pas quand la transaction n'a pas de date", () => {
      expect(transactionDateMatchesInvoice({}, invoice)).toBe(true);
      expect(transactionDateMatchesInvoice(null, invoice)).toBe(true);
    });

    it("n'exclut pas sur des dates invalides", () => {
      expect(
        transactionDateMatchesInvoice(
          { date: "n'importe quoi" },
          { issueDate: "2026-05-15" },
        ),
      ).toBe(true);
      expect(
        transactionDateMatchesInvoice(
          { date: "2026-01-10" },
          { issueDate: "n'importe quoi" },
        ),
      ).toBe(true);
    });

    it("accepte les dates fournies en chaînes ISO", () => {
      expect(
        transactionDateMatchesInvoice(
          { date: "2026-06-02" },
          { issueDate: "2026-05-15" },
        ),
      ).toBe(true);
      expect(
        transactionDateMatchesInvoice(
          { date: "2026-01-10" },
          { issueDate: "2026-05-15" },
        ),
      ).toBe(false);
    });
  });

  describe("earliestTransactionDateForInvoice", () => {
    it("recule de la marge par rapport à l'émission", () => {
      const min = earliestTransactionDateForInvoice(invoice);
      expect(min.getTime()).toBe(
        invoice.issueDate.getTime() - RECONCILIATION_DATE_BUFFER_DAYS * DAY_MS,
      );
    });

    it("renvoie null sans date d'émission exploitable", () => {
      expect(earliestTransactionDateForInvoice({})).toBeNull();
      expect(earliestTransactionDateForInvoice(null)).toBeNull();
      expect(
        earliestTransactionDateForInvoice({ issueDate: "invalide" }),
      ).toBeNull();
    });
  });

  describe("latestInvoiceIssueDateForTransaction", () => {
    it("avance de la marge par rapport à la transaction", () => {
      const tx = { date: new Date("2026-06-02T00:00:00.000Z") };
      const max = latestInvoiceIssueDateForTransaction(tx);
      expect(max.getTime()).toBe(
        tx.date.getTime() + RECONCILIATION_DATE_BUFFER_DAYS * DAY_MS,
      );
    });

    it("renvoie null sans date exploitable", () => {
      expect(latestInvoiceIssueDateForTransaction({})).toBeNull();
      expect(latestInvoiceIssueDateForTransaction(null)).toBeNull();
      expect(
        latestInvoiceIssueDateForTransaction({ date: "invalide" }),
      ).toBeNull();
    });
  });
});
