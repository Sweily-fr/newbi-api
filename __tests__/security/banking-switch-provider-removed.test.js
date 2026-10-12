/**
 * Banque : plus de mutation pour changer le prestataire bancaire.
 *
 * switchBankingProvider remplaçait bankingService.currentProvider, réglage
 * global du processus partagé par tous les espaces, avec un simple droit
 * « Intégrations » sur son propre espace (bascule sur le prestataire de test,
 * par exemple). Elle n'était appelée ni par le site ni par l'application : elle
 * est retirée du schéma et des resolvers.
 */
import { describe, it, expect } from "vitest";
import { print } from "graphql";
import typeDefs from "../../src/schemas/index.js";
import bankingResolvers from "../../src/resolvers/banking.js";

describe("switchBankingProvider", () => {
  it("n'a plus de resolver", () => {
    expect(bankingResolvers.Mutation.switchBankingProvider).toBeUndefined();
  });

  it("n'est plus dans le schéma GraphQL", () => {
    expect(print(typeDefs)).not.toMatch(/switchBankingProvider/);
  });

  it("les autres mutations bancaires restent exposées", () => {
    expect(typeof bankingResolvers.Mutation.syncTransactionHistory).toBe(
      "function",
    );
    expect(print(typeDefs)).toMatch(/syncTransactionHistory/);
  });
});
