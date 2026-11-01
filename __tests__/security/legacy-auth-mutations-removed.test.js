/**
 * Anciennes mutations GraphQL de compte : retirées du schéma.
 *
 * L'inscription, la connexion, le mot de passe oublié, la vérification de
 * l'adresse, la désactivation et la réactivation du compte passent par Better
 * Auth et les routes du site. Les mutations GraphQL historiques n'étaient
 * appelées ni par le site ni par l'application mobile ; certaines étaient
 * publiques (sans session) : register créait un document User hors Better
 * Auth et envoyait un e-mail, login répondait différemment selon que
 * l'adresse existait ou non, requestPasswordReset envoyait un lien mort.
 * setStripeCustomerId (identifiant client Stripe libre sur son propre compte)
 * et disableAccount (désactivation via l'ancien mot de passe, sans
 * réactivation possible côté site) sont retirées aussi.
 *
 * L'API répond désormais à chacune par une erreur de validation GraphQL
 * uniforme (code GRAPHQL_VALIDATION_FAILED, « Cannot query field "<nom>" on
 * type "Mutation". », parfois suivi d'une suggestion « Did you mean ... ? »),
 * sans aucune lecture ni écriture en base ni e-mail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mailer = vi.hoisted(() => ({
  sendPasswordResetEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendPasswordResetConfirmationEmail: vi.fn(),
}));
vi.mock("../../src/utils/mailer.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ...mailer,
}));

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { ApolloServer } from "apollo-server-express";
import typeDefs from "../../src/schemas/index.js";
import User from "../../src/models/User.js";
import userResolvers from "../../src/resolvers/user.js";

const REMOVED = {
  register: `mutation { register(input: { email: "a@exemple.fr", password: "Motdepasse1!" }) { message } }`,
  login: `mutation { login(input: { email: "a@exemple.fr", password: "x" }) { token } }`,
  requestPasswordReset: `mutation { requestPasswordReset(input: { email: "a@exemple.fr" }) }`,
  resetPassword: `mutation { resetPassword(input: { token: "t", newPassword: "Motdepasse1!" }) { success } }`,
  verifyEmail: `mutation { verifyEmail(token: "t") { success } }`,
  resendVerificationEmail: `mutation { resendVerificationEmail(email: "a@exemple.fr") }`,
  reactivateAccount: `mutation { reactivateAccount(email: "a@exemple.fr", password: "x") { success } }`,
  disableAccount: `mutation { disableAccount(password: "x") { success } }`,
  setStripeCustomerId: `mutation { setStripeCustomerId(stripeCustomerId: "cus_x") { id } }`,
};

const server = new ApolloServer({ typeDefs, resolvers: userResolvers });

const spies = () => [
  vi.spyOn(User, "findOne"),
  vi.spyOn(User, "findById"),
  vi.spyOn(User, "create"),
  vi.spyOn(User.prototype, "save"),
];

beforeEach(() => {
  vi.restoreAllMocks();
  Object.values(mailer).forEach((fn) => fn.mockClear());
});

describe("anciennes mutations de compte retirées", () => {
  for (const [name, query] of Object.entries(REMOVED)) {
    it(`${name} : erreur de validation uniforme, sans base ni e-mail`, async () => {
      const watched = spies();
      const result = await server.executeOperation(
        { query },
        { req: { headers: {} }, user: null },
      );

      expect(result.data).toBeUndefined();
      expect(result.errors).toHaveLength(1);
      // graphql-js peut ajouter une suggestion (« Did you mean ... ? »)
      expect(
        result.errors[0].message.startsWith(
          `Cannot query field "${name}" on type "Mutation".`,
        ),
        result.errors[0].message,
      ).toBe(true);
      expect(result.errors[0].extensions.code).toBe(
        "GRAPHQL_VALIDATION_FAILED",
      );
      for (const spy of watched) expect(spy).not.toHaveBeenCalled();
      for (const fn of Object.values(mailer)) expect(fn).not.toHaveBeenCalled();
    });
  }

  it("aucun resolver ne subsiste pour ces mutations", () => {
    for (const name of Object.keys(REMOVED)) {
      expect(userResolvers.Mutation[name], name).toBeUndefined();
    }
  });

  it("les mutations encore appelées par le site restent dans le schéma", async () => {
    const result = await server.executeOperation(
      {
        query: `mutation { updateCompany(input: {}) { id } }`,
      },
      { req: { headers: {} }, user: null },
    );
    // Validation passée : seul le contrôle de session refuse l'appel
    expect(result.errors?.[0]?.extensions?.code).not.toBe(
      "GRAPHQL_VALIDATION_FAILED",
    );
    expect(result.errors?.[0]?.message).toMatch(/connecté/);
  });
});
