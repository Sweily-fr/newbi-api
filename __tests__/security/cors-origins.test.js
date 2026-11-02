/**
 * Origines autorisées par CORS (requêtes du navigateur avec cookies).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createOriginChecker } from "../../src/utils/corsOrigins.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const production = createOriginChecker({
  nodeEnv: "production",
  introspection: false,
  frontendUrl: "https://www.newbi.fr",
});
const staging = createOriginChecker({
  nodeEnv: "staging",
  introspection: false,
  frontendUrl: "https://staging.newbi.test",
});

describe("CORS en production", () => {
  it.each([
    "https://www.newbi.fr",
    "https://newbi.fr",
    "https://api.newbi.fr",
    "http://localhost:3000",
  ])("accepte %s", (origin) => {
    expect(production(origin)).toBe(true);
  });

  it("accepte une requête sans origine (mobile, serveur)", () => {
    expect(production(undefined)).toBe(true);
  });

  it.each([
    "https://studio.apollographql.com",
    "https://abcd.ngrok-free.app",
    "https://exemple.trycloudflare.com",
    "https://evil-ngrok.example",
    "https://www.newbi.fr.attacker.test",
    "null",
  ])("refuse %s", (origin) => {
    expect(production(origin)).toBe(false);
  });

  it("Apollo Studio seulement si l'introspection est ouverte", () => {
    const withIntrospection = createOriginChecker({
      nodeEnv: "production",
      introspection: true,
    });
    expect(withIntrospection("https://studio.apollographql.com")).toBe(true);
  });
});

describe("CORS hors production", () => {
  it.each([
    "https://staging.newbi.test",
    "https://studio.apollographql.com",
    "https://abcd-12.ngrok-free.app",
    "https://abcd.ngrok.io",
    "https://mon-tunnel.trycloudflare.com",
  ])("accepte %s", (origin) => {
    expect(staging(origin)).toBe(true);
  });

  it.each([
    "https://evil-ngrok.example",
    "https://ngrok.attacker.test",
    "https://trycloudflare.com.attacker.test",
    "https://attacker.test/?x=.ngrok.io",
    "https://.ngrok.io",
    "javascript://abcd.ngrok.io",
  ])("refuse %s", (origin) => {
    expect(staging(origin)).toBe(false);
  });

  it("la liste ne grossit pas avec les origines vues", () => {
    for (let i = 0; i < 1000; i++) staging(`https://t${i}.ngrok.io`);
    expect(staging("https://evil-ngrok.example")).toBe(false);
  });
});

describe("serveur", () => {
  it("CORS utilise ce contrôle, sans liste complétée à la volée", () => {
    const server = readFileSync(path.join(root, "src/server.js"), "utf8");
    expect(server).toMatch(/createOriginChecker\(\)/);
    expect(server).toMatch(/isAllowedOrigin\(origin\)/);
    expect(server).not.toMatch(/allowedOrigins\.push/);
  });
});
