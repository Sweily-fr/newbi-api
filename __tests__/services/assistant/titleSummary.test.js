import { describe, it, expect } from "vitest";
import { parseTitleOutput } from "../../../src/services/assistant/titleSummary.js";

describe("titleSummary — parseTitleOutput()", () => {
  it("trim simple", () => {
    expect(parseTitleOutput("  Chiffre d'affaires de mai  ")).toBe(
      "Chiffre d'affaires de mai",
    );
  });

  it("retire le préfixe 'Titre :' du LLM (cas fréquent malgré l'interdiction)", () => {
    expect(parseTitleOutput("Titre : Top clients de mai")).toBe(
      "Top clients de mai",
    );
    expect(parseTitleOutput("titre: Impayés du mois")).toBe("Impayés du mois");
    expect(parseTitleOutput("Title: Revenue summary")).toBe("Revenue summary");
  });

  it("strip guillemets enrobants", () => {
    expect(parseTitleOutput('"Chiffre d\'affaires"')).toBe(
      "Chiffre d'affaires",
    );
    expect(parseTitleOutput("« Top clients »")).toBe("Top clients");
    expect(parseTitleOutput("'Impayés'")).toBe("Impayés");
  });

  it("strip ponctuation finale (. ! ? …)", () => {
    expect(parseTitleOutput("CA ce mois.")).toBe("CA ce mois");
    expect(parseTitleOutput("Impayés !")).toBe("Impayés");
    expect(parseTitleOutput("Top clients ?")).toBe("Top clients");
    expect(parseTitleOutput("Trésorerie…")).toBe("Trésorerie");
  });

  it("anti-fuite Client_N : remplace par 'un client'", () => {
    // Garde-fou : si le LLM oublie l'interdiction et balance "Client_1"
    // dans le titre, on rattrape côté parsing pour éviter une fuite vers
    // l'utilisateur final.
    expect(parseTitleOutput("Factures de Client_1")).toBe(
      "Factures de un client",
    );
    expect(parseTitleOutput("Client_3 et ses impayés")).toBe(
      "un client et ses impayés",
    );
  });

  it("retourne null sur entrée vide / null / undefined", () => {
    expect(parseTitleOutput("")).toBe(null);
    expect(parseTitleOutput("   ")).toBe(null);
    expect(parseTitleOutput(null)).toBe(null);
    expect(parseTitleOutput(undefined)).toBe(null);
    expect(parseTitleOutput(42)).toBe(null);
  });

  it("retourne null si après nettoyage il ne reste rien", () => {
    expect(parseTitleOutput('""')).toBe(null);
    expect(parseTitleOutput("Titre :")).toBe(null);
  });

  it("cap à 32 chars max + ellipsis quand on coupe", () => {
    const long =
      "Synthèse complète du chiffre d'affaires sur la période couverte par l'analyse";
    const out = parseTitleOutput(long);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.endsWith("…")).toBe(true);
  });

  it("titres déjà courts (≤ 32 chars) ne sont PAS tronqués", () => {
    expect(parseTitleOutput("CA de juin")).toBe("CA de juin");
    expect(parseTitleOutput("Top clients 2025")).toBe("Top clients 2025");
    expect(parseTitleOutput("Trésorerie sur 6 mois")).toBe(
      "Trésorerie sur 6 mois",
    );
  });

  it("combine tout : guillemets + préfixe + ponctuation + Client_N", () => {
    expect(parseTitleOutput('Titre : "Impayés de Client_2 ce mois."')).toBe(
      "Impayés de un client ce mois",
    );
  });

  it("n'altère pas un titre déjà propre", () => {
    expect(parseTitleOutput("Chiffre d'affaires de mai")).toBe(
      "Chiffre d'affaires de mai",
    );
    expect(parseTitleOutput("Trésorerie sur 6 mois")).toBe(
      "Trésorerie sur 6 mois",
    );
  });
});
