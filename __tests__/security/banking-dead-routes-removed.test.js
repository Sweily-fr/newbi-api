/**
 * Routes bancaires publiques ou mortes retirées : /banking/status (public),
 * /banking/admin/switch-provider (requête jamais terminée, bascule globale
 * du prestataire), /banking/webhook/* (toujours refusées, le corps était
 * déjà lu ; les webhooks passent par /webhook) et les opérations GraphQL
 * sans resolver (getRecentTransactions, getTransactionStats,
 * syncBridgeTransactions). Aucun client ne les appelait.
 */
import { describe, it, expect } from "vitest";
import { print } from "graphql";
import typeDefs from "../../src/schemas/index.js";
import bankingRoutes from "../../src/routes/banking.js";

const paths = bankingRoutes.stack
  .filter((layer) => layer.route)
  .map((layer) => layer.route.path);

describe("routes bancaires retirées", () => {
  for (const path of [
    "/status",
    "/admin/switch-provider",
    "/webhook/bridge",
    "/webhook/stripe",
    "/webhook/paypal",
  ]) {
    it(`/banking${path} n'existe plus`, () => {
      expect(paths).not.toContain(path);
    });
  }

  it("les routes de données bancaires restent montées", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  it("opérations GraphQL sans resolver retirées du schéma", () => {
    const schema = print(typeDefs);
    for (const name of [
      "getRecentTransactions",
      "getTransactionStats",
      "syncBridgeTransactions",
    ]) {
      expect(schema).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
