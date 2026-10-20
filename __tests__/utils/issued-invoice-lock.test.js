import { describe, it, expect } from "vitest";
import {
  assertInvoiceDeletable,
  assertIssuedInvoiceContentUnchanged,
  creditNoteDeletionRefused,
  ISSUED_INVOICE_LOCKED_FIELDS,
} from "../../src/utils/issuedInvoiceLock.js";

describe("assertIssuedInvoiceContentUnchanged", () => {
  it("laisse un brouillon tout modifier, finalisation comprise", () => {
    for (const status of [undefined, "DRAFT"]) {
      expect(() =>
        assertIssuedInvoiceContentUnchanged(
          { status },
          {
            items: [],
            client: { name: "Autre" },
            discount: 10,
            status: "PENDING",
          },
        ),
      ).not.toThrow();
    }
  });

  it("refuse articles, montants et client d'une facture émise", () => {
    for (const status of ["PENDING", "COMPLETED", "CANCELED", "OVERDUE"]) {
      for (const field of ISSUED_INVOICE_LOCKED_FIELDS) {
        let erreur = null;
        try {
          assertIssuedInvoiceContentUnchanged({ status }, { [field]: 0 });
        } catch (e) {
          erreur = e;
        }
        expect(erreur, `${field} sur une facture ${status}`).not.toBeNull();
        expect(erreur.code).toBe("RESOURCE_LOCKED");
        expect(erreur.message).toMatch(/Corrigez-la par un avoir/);
        expect(erreur.details.fields).toEqual([field]);
      }
    }
  });

  it("laisse modifier les notes et les autres champs d'une facture émise", () => {
    expect(() =>
      assertIssuedInvoiceContentUnchanged(
        { status: "PENDING" },
        {
          headerNotes: "Notes",
          footerNotes: "Bas de page",
          termsAndConditions: "Conditions",
          dueDate: "2026-11-30",
          appearance: { textColor: "#000000" },
          items: undefined,
        },
      ),
    ).not.toThrow();
  });

  it("liste tous les champs refusés", () => {
    try {
      assertIssuedInvoiceContentUnchanged(
        { status: "PENDING" },
        { items: [], client: null, headerNotes: "Notes" },
      );
      throw new Error("aucun refus");
    } catch (e) {
      expect(e.details.fields).toEqual(["items", "client"]);
    }
  });
});

describe("assertInvoiceDeletable", () => {
  it("laisse supprimer un brouillon", () => {
    expect(() => assertInvoiceDeletable({ status: "DRAFT" })).not.toThrow();
  });

  it("refuse une facture émise, payée ou annulée", () => {
    for (const status of ["PENDING", "COMPLETED", "CANCELED", "OVERDUE"]) {
      expect(() => assertInvoiceDeletable({ status })).toThrow(
        /Seul un brouillon peut être supprimé/,
      );
    }
  });
});

describe("creditNoteDeletionRefused", () => {
  it("renvoie un refus explicite (l'avoir garde sa place dans la numérotation)", () => {
    const erreur = creditNoteDeletionRefused({ status: "CREATED" });
    expect(erreur.code).toBe("RESOURCE_LOCKED");
    expect(erreur.message).toMatch(/Un avoir émis ne peut pas être supprimé/);
    expect(erreur.details.status).toBe("CREATED");
  });
});
