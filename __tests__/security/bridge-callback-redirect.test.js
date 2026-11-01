/**
 * Retour de Bridge (GET /banking-connect/bridge/callback) : l'identifiant de
 * session reçu dans l'adresse est encodé dans la redirection vers le site,
 * il ne peut pas y ajouter de paramètre (texte de notification choisi par un
 * tiers, faux message d'erreur).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/banking/index.js", () => ({
  bankingService: { initialize: async () => {}, currentProvider: {} },
}));
vi.mock("../../src/services/banking/BankingCacheService.js", () => ({
  bankingCacheService: { invalidateAll: async () => {} },
}));

import express from "express";
import bankingConnectRoutes from "../../src/routes/banking-connect.js";

let server;
let baseUrl;
const ancienFrontend = process.env.FRONTEND_URL;

beforeAll(async () => {
  process.env.FRONTEND_URL = "https://site.test";
  const app = express();
  app.use("/banking-connect", bankingConnectRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  process.env.FRONTEND_URL = ancienFrontend;
  await new Promise((resolve) => server.close(resolve));
});

const retour = async (query) => {
  const res = await fetch(
    `${baseUrl}/banking-connect/bridge/callback?${query}`,
    {
      redirect: "manual",
    },
  );
  return { status: res.status, location: new URL(res.headers.get("location")) };
};

describe("Retour de Bridge : redirection vers le site", () => {
  it("un identifiant de session ordinaire est transmis tel quel", async () => {
    const { status, location } = await retour("session_id=abc-123");
    expect(status).toBe(302);
    expect(location.origin).toBe("https://site.test");
    expect(location.searchParams.get("banking_success")).toBe("true");
    expect(location.searchParams.get("session_id")).toBe("abc-123");
  });

  it("un identifiant qui contient « & » n'ajoute aucun paramètre", async () => {
    const { location } = await retour(
      "session_id=x%26banking_error%3DCompte%2520suspendu%26gmail_error%3D1",
    );
    expect(location.searchParams.get("banking_error")).toBeNull();
    expect(location.searchParams.get("gmail_error")).toBeNull();
    expect(location.searchParams.get("session_id")).toBe(
      "x&banking_error=Compte%20suspendu&gmail_error=1",
    );
  });

  it("une erreur de Bridge reste encodée", async () => {
    const { location } = await retour("error=refus%26banking_success%3Dtrue");
    expect(location.searchParams.get("banking_success")).toBeNull();
    expect(location.searchParams.get("banking_error")).toBe(
      "refus&banking_success=true",
    );
  });
});
