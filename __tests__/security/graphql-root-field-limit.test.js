/**
 * Champs racine d'une opération GraphQL bornés (règle de validation).
 *
 * Une requête HTTP ne contient qu'une opération (lots refusés) ; des alias
 * ne permettent pas non plus d'y répéter un même champ racine : chaque
 * tentative (mot de passe d'un lien partagé, adresse d'un invité, jeton de
 * retour de paiement...) coûte une requête HTTP, comptée par la limite de
 * débit. Le site et l'application mobile n'envoient qu'un champ racine par
 * opération.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildASTSchema, parse, validate, specifiedRules } from "graphql";
import typeDefs from "../../src/schemas/index.js";
import {
  MAX_ROOT_FIELDS,
  rootFieldLimitRule,
} from "../../src/utils/graphqlOperationLimits.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const schema = buildASTSchema(typeDefs, { assumeValidSDL: true });

const errorsOf = (query) =>
  validate(schema, parse(query), [...specifiedRules, rootFieldLimitRule()]).map(
    (error) => error.message,
  );

const repeat = (count, field) =>
  Array.from({ length: count }, (_, i) => `a${i}: ${field}`).join("\n");

describe("champs racine d'une opération", () => {
  it("une opération d'un champ passe", () => {
    expect(errorsOf("query { me { id } }")).toEqual([]);
    expect(
      errorsOf(
        'mutation { checkInvitedEmail(email: "a@b.fr") { exists } }',
      ).filter((m) => /opération|champs à la fois/.test(m)),
    ).toEqual([]);
  });

  it("plusieurs champs différents passent jusqu'au plafond", () => {
    const fields = [
      "me { id }",
      "roleCatalog { key }",
      "myPermissions { role }",
    ];
    const messages = errorsOf(`query { ${fields.join(" ")} }`);
    expect(messages.filter((m) => /une fois|à la fois/.test(m))).toEqual([]);
  });

  it("au-delà du plafond, l'opération est refusée", () => {
    // Noms distincts (inconnus du schéma : seule la règle est observée ici)
    const fields = Array.from(
      { length: MAX_ROOT_FIELDS + 1 },
      (_, i) => `champ${i}`,
    );
    const messages = errorsOf(`query { ${fields.join(" ")} }`);
    expect(
      messages.some((m) =>
        m.includes(`plus de ${MAX_ROOT_FIELDS} champs à la fois`),
      ),
    ).toBe(true);
    const atLimit = errorsOf(
      `query { ${fields.slice(0, MAX_ROOT_FIELDS).join(" ")} }`,
    );
    expect(atLimit.filter((m) => /à la fois|une fois/.test(m))).toEqual([]);
  });

  it.each([
    ["getPublicBoard", 'getPublicBoard(token: "x", password: "p") { id }'],
    ["validatePublicToken", 'validatePublicToken(token: "x") { isValid }'],
    ["checkInvitedEmail", 'checkInvitedEmail(email: "a@b.fr") { exists }'],
    [
      "consumePaymentReturnToken",
      'consumePaymentReturnToken(token: "x") { success }',
    ],
  ])("%s répété par des alias est refusé", (name, field) => {
    const operation = name === "getPublicBoard" ? "query" : null;
    const type =
      operation ||
      (schema.getMutationType().getFields()[name] ? "mutation" : "query");
    const messages = errorsOf(`${type} { ${repeat(2, field)} }`);
    expect(
      messages.some((m) =>
        m.includes(`« ${name} » ne peut être demandé qu'une fois`),
      ),
    ).toBe(true);
  });

  it("un même champ répété par un fragment est refusé", () => {
    const messages = errorsOf(`
      query { ...A me { id } }
      fragment A on Query { me { email } }
    `);
    expect(messages.some((m) => m.includes("« me »"))).toBe(true);
  });

  it("les champs d'introspection ne comptent pas", () => {
    expect(
      errorsOf("query { __typename a: __typename me { id } }").filter((m) =>
        /une fois|à la fois/.test(m),
      ),
    ).toEqual([]);
  });

  it("la règle est posée sur le serveur GraphQL", () => {
    const server = readFileSync(path.join(root, "src/server.js"), "utf8");
    expect(server).toMatch(
      /validationRules:\s*\[[^\]]*rootFieldLimitRule\(\)[^\]]*\]/,
    );
  });

  it("les opérations reçues par WebSocket suivent les mêmes règles", () => {
    const server = readFileSync(path.join(root, "src/server.js"), "utf8");
    const subscriptionServer = server.slice(
      server.indexOf("SubscriptionServer.create("),
      server.indexOf("onConnect:"),
    );
    expect(subscriptionServer).toMatch(/validationRules:/);
    expect(subscriptionServer).toMatch(/\.\.\.specifiedRules/);
    expect(subscriptionServer).toMatch(/depthLimit\(10\)/);
    expect(subscriptionServer).toMatch(/rootFieldLimitRule\(\)/);
    // Introspection fermée en WebSocket comme en HTTP hors dev local
    expect(subscriptionServer).toMatch(
      /graphqlIntrospection \? \[\] : \[NoSchemaIntrospectionCustomRule\]/,
    );
    expect(server).toMatch(/introspection: graphqlIntrospection/);
  });
});
