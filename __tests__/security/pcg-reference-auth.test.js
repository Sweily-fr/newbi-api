/**
 * Référentiel du plan comptable (pcgMappingTable, pcgAccounts) : servi aux
 * pages connectées seulement, jamais à une requête sans session.
 */
import { describe, it, expect } from "vitest";
import bankingResolvers from "../../src/resolvers/banking.js";

const { pcgMappingTable, pcgAccounts } = bankingResolvers.Query;

describe("Référentiel du plan comptable : session exigée", () => {
  for (const [nom, resolver] of [
    ["pcgMappingTable", pcgMappingTable],
    ["pcgAccounts", pcgAccounts],
  ]) {
    it(`${nom} sans session : refusé (UNAUTHENTICATED)`, async () => {
      await expect(
        Promise.resolve().then(() => resolver({}, {}, { user: null })),
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });

    it(`${nom} avec une session : le référentiel est servi`, async () => {
      const resultat = await resolver({}, {}, { user: { id: "u1" } });
      expect(Array.isArray(resultat)).toBe(true);
      expect(resultat.length).toBeGreaterThan(0);
    });
  }
});
