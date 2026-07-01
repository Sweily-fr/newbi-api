import { describe, it, expect } from "vitest";
import {
  sanitizeString,
  sanitizeDeep,
} from "../../../src/services/assistant/sanitize.js";

describe("sanitize — IBAN", () => {
  // Cas tordu A : IBAN collé sans espaces
  it("masque un IBAN FR sans espaces", () => {
    expect(
      sanitizeString("Mon IBAN est FR7630006000011234567890189 merci"),
    ).toBe("Mon IBAN est [IBAN masqué] merci");
  });

  it("masque un IBAN FR avec espaces", () => {
    expect(sanitizeString("FR76 3000 6000 0112 3456 7890 189")).toBe(
      "[IBAN masqué]",
    );
  });

  it("masque un IBAN en milieu de phrase", () => {
    expect(
      sanitizeString("Voir le compte FR7630006000011234567890189 svp"),
    ).toBe("Voir le compte [IBAN masqué] svp");
  });

  it("masque un IBAN belge (BE)", () => {
    expect(sanitizeString("Compte BE68539007547034")).toBe(
      "Compte [IBAN masqué]",
    );
  });

  it("ne touche pas un texte sans IBAN", () => {
    expect(sanitizeString("Aucun IBAN ici")).toBe("Aucun IBAN ici");
  });
});

describe("sanitize — SIRET", () => {
  // Cas tordu B : SIRET au milieu d'une phrase
  it("masque un SIRET compact (14 chiffres) au milieu d'une phrase", () => {
    expect(sanitizeString("Le SIRET 80246871800015 doit être vérifié.")).toBe(
      "Le SIRET [SIRET masqué] doit être vérifié.",
    );
  });

  it("masque un SIRET formaté avec espaces 3-3-3-5", () => {
    expect(sanitizeString("802 468 718 00015")).toBe("[SIRET masqué]");
  });

  it("ne masque pas un nombre de 13 chiffres", () => {
    expect(sanitizeString("Numéro 1234567890123")).toBe("Numéro 1234567890123");
  });
});

describe("sanitize — Email", () => {
  it("masque un email simple", () => {
    expect(sanitizeString("Contact : jean@sweily.fr")).toBe(
      "Contact : [email masqué]",
    );
  });

  it("masque un email avec sous-domaine + suffixe", () => {
    expect(sanitizeString("ping marketing+ops@news.sweily.co.uk svp")).toBe(
      "ping [email masqué] svp",
    );
  });

  it("ne touche pas un mention @ sans domaine", () => {
    expect(sanitizeString("Mention @sweily sans email")).toBe(
      "Mention @sweily sans email",
    );
  });
});

describe("sanitize — Téléphone FR", () => {
  it("masque un numéro 0X XX XX XX XX", () => {
    expect(sanitizeString("Appelez 06 12 34 56 78 stp")).toBe(
      "Appelez [tél masqué] stp",
    );
  });

  it("masque un numéro 0XXXXXXXXX (sans espaces)", () => {
    expect(sanitizeString("Tél: 0612345678")).toBe("Tél: [tél masqué]");
  });

  it("masque un numéro +33 6 12 34 56 78", () => {
    expect(sanitizeString("+33 6 12 34 56 78 → assistance")).toBe(
      "[tél masqué] → assistance",
    );
  });

  it("ne masque pas une suite de chiffres trop courte", () => {
    expect(sanitizeString("Code 1234")).toBe("Code 1234");
  });
});

describe("sanitize — combinaisons", () => {
  it("masque plusieurs PII dans le même texte", () => {
    const input =
      "Contact jean@acme.fr, IBAN FR7630006000011234567890189, tél 0612345678";
    const expected =
      "Contact [email masqué], IBAN [IBAN masqué], tél [tél masqué]";
    expect(sanitizeString(input)).toBe(expected);
  });
});

describe("sanitize — robustesse", () => {
  it("renvoie tel quel une string vide", () => {
    expect(sanitizeString("")).toBe("");
  });

  it("renvoie tel quel null/undefined/nombre", () => {
    expect(sanitizeString(null)).toBeNull();
    expect(sanitizeString(undefined)).toBeUndefined();
    expect(sanitizeString(42)).toBe(42);
  });
});

describe("sanitizeDeep — walk récursif", () => {
  it("sanitize les strings d'un objet plat", () => {
    const input = { title: "Email jean@x.fr", amount: 100 };
    expect(sanitizeDeep(input)).toEqual({
      title: "Email [email masqué]",
      amount: 100,
    });
  });

  it("sanitize les strings d'un objet imbriqué", () => {
    const input = {
      summary: { count: 3 },
      invoices: [
        { ref: "F-1", desc: "client jean@x.fr SIRET 80246871800015" },
        { ref: "F-2", desc: "rien à masquer" },
      ],
    };
    const out = sanitizeDeep(input);
    expect(out.invoices[0].desc).toBe(
      "client [email masqué] SIRET [SIRET masqué]",
    );
    expect(out.invoices[1].desc).toBe("rien à masquer");
    // immutable : l'input n'est pas mutée
    expect(input.invoices[0].desc).toBe(
      "client jean@x.fr SIRET 80246871800015",
    );
  });

  it("préserve les nombres / booléens / null", () => {
    const input = { a: 1, b: true, c: null, d: "test" };
    expect(sanitizeDeep(input)).toEqual({ a: 1, b: true, c: null, d: "test" });
  });

  it("walke un tableau de strings", () => {
    expect(sanitizeDeep(["x@y.fr", "ok", 0])).toEqual([
      "[email masqué]",
      "ok",
      0,
    ]);
  });
});
