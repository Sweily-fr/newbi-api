/**
 * Formulaire de contact : plus de mutation GraphQL publique.
 *
 * Le site envoie son formulaire de contact par sa propre route (limite de
 * débit, longueurs plafonnées, destinataire fixe). La mutation
 * sendContactMessage de l'API n'était appelée ni par le site ni par
 * l'application mobile : elle est retirée du schéma et des resolvers, et
 * l'API n'envoie plus d'e-mail à une adresse saisie sans session.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { print } from "graphql";
import typeDefs from "../../src/schemas/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("sendContactMessage", () => {
  it("n'est plus dans le schéma GraphQL", () => {
    const schema = print(typeDefs);
    expect(schema).not.toMatch(/sendContactMessage/);
    expect(schema).not.toMatch(/\bContactInput\b/);
  });

  it("n'a plus de resolver", () => {
    expect(existsSync(path.join(root, "src/resolvers/contact.js"))).toBe(false);
    const index = readFileSync(
      path.join(root, "src/resolvers/index.js"),
      "utf8",
    );
    expect(index).not.toMatch(/contact\.js/);
  });

  it("les lots de requêtes HTTP sont refusés par le serveur GraphQL", () => {
    const server = readFileSync(path.join(root, "src/server.js"), "utf8");
    expect(server).toMatch(/allowBatchedHttpRequests:\s*false/);
  });
});
