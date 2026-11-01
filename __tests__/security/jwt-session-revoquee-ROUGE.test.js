/**
 * JWT après révocation de la session : comportement attendu, NON IMPLÉMENTÉ.
 *
 * Test ROUGE volontaire (audit D18, manque G32). better-auth-jwt.js vérifie
 * la signature du JWT (JWKS) puis charge l'utilisateur, sans vérifier que
 * la session d'origine existe encore : après une déconnexion, une
 * révocation de session (« déconnecter les autres appareils ») ou une
 * désactivation, le JWT reste accepté jusqu'à son expiration (15 minutes
 * par défaut).
 *
 * Le site émet le JWT avec jwt({ disableSettingJwtHeader: true }) : la
 * charge utile par défaut de Better Auth est session.user (sub = id de
 * l'utilisateur), sans identifiant de session. L'API ne peut donc pas
 * relier un JWT à sa session sans changer l'émission côté site (par
 * exemple definePayload qui ajoute l'id de session, contrôlé ensuite par
 * l'API, au prix d'une lecture, éventuellement mise en cache, par requête).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

const jwt = vi.hoisted(() => ({ decoded: null }));
vi.mock("../../src/services/jwks-validator.js", () => ({
  getJWKSValidator: async () => ({
    validateJWT: async () => jwt.decoded,
  }),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { betterAuthJWTMiddleware } from "../../src/middlewares/better-auth-jwt.js";
import { invalidateUserCache } from "../../src/middlewares/user-cache.js";

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateUserCache();
});

describe("JWT (ROUGE, nécessite un changement côté site) : session révoquée", () => {
  it("un JWT encore valide dont la session a été supprimée n'authentifie plus", async () => {
    const userId = new mongoose.Types.ObjectId();
    const email = "revoque@exemple.fr";
    await mongoose.connection.db
      .collection("user")
      .insertOne({ _id: userId, email, password: "x" });
    // Session supprimée (déconnexion ou révocation) : aucune session en base.
    // Charge utile par défaut de Better Auth : session.user, sans id de session.
    jwt.decoded = {
      sub: String(userId),
      id: String(userId),
      email,
      exp: Math.floor(Date.now() / 1000) + 600,
    };

    const user = await betterAuthJWTMiddleware({
      headers: { authorization: "Bearer jeton.de.test" },
    });

    expect(
      user,
      "un JWT dont la session a été révoquée ne doit plus authentifier (aujourd'hui accepté jusqu'à 15 min)",
    ).toBeNull();
  });
});
