/**
 * JWT après révocation de la session (audit D18, manque G32).
 *
 * Le site ajoute au JWT l'id de la session qui l'a émis (claim sid) ; l'API
 * vérifie que cette session existe encore. Un jeton sans sid (émis avant ce
 * changement, 15 minutes au plus) n'est accepté que si l'utilisateur a
 * encore une session valide.
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
import { clearJwtSessionCache } from "../../src/middlewares/jwt-session.js";

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateUserCache();
  clearJwtSessionCache();
});

const req = () => ({ headers: { authorization: "Bearer jeton.de.test" } });

async function seedUser() {
  const userId = new mongoose.Types.ObjectId();
  const email = `u${userId}@exemple.fr`;
  await mongoose.connection.db
    .collection("user")
    .insertOne({ _id: userId, email, password: "x" });
  return { userId, email };
}

async function seedSession(userId, expiresInMs = 3600_000) {
  const { insertedId } = await mongoose.connection.db
    .collection("session")
    .insertOne({
      token: `tok${new mongoose.Types.ObjectId()}`,
      userId,
      expiresAt: new Date(Date.now() + expiresInMs),
    });
  return String(insertedId);
}

const jeton = (userId, email, extra = {}) => ({
  sub: String(userId),
  id: String(userId),
  email,
  exp: Math.floor(Date.now() / 1000) + 600,
  ...extra,
});

describe("JWT : session révoquée", () => {
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

  it("jeton avec sid : accepté tant que sa session existe", async () => {
    const { userId, email } = await seedUser();
    const sid = await seedSession(userId);
    jwt.decoded = jeton(userId, email, { sid });
    const user = await betterAuthJWTMiddleware(req());
    expect(user?._id?.toString()).toBe(String(userId));
  });

  it("jeton avec sid : refusé quand cette session est supprimée, même si une autre reste ouverte", async () => {
    const { userId, email } = await seedUser();
    await seedSession(userId);
    const sid = String(new mongoose.Types.ObjectId());
    jwt.decoded = jeton(userId, email, { sid });
    expect(await betterAuthJWTMiddleware(req())).toBeNull();
  });

  it("jeton avec sid : refusé quand la session est expirée", async () => {
    const { userId, email } = await seedUser();
    const sid = await seedSession(userId, -1000);
    jwt.decoded = jeton(userId, email, { sid });
    expect(await betterAuthJWTMiddleware(req())).toBeNull();
  });

  it("jeton avec le sid de la session d'un autre utilisateur : refusé", async () => {
    const victime = await seedUser();
    const autre = await seedUser();
    const sid = await seedSession(autre.userId);
    jwt.decoded = jeton(victime.userId, victime.email, { sid });
    expect(await betterAuthJWTMiddleware(req())).toBeNull();
  });

  it("jeton avec un sid malformé : refusé", async () => {
    const { userId, email } = await seedUser();
    await seedSession(userId);
    for (const sid of ["pas-un-id", { $ne: null }, 12]) {
      clearJwtSessionCache();
      jwt.decoded = jeton(userId, email, { sid });
      expect(await betterAuthJWTMiddleware(req())).toBeNull();
    }
  });

  it("jeton sans sid (émis avant le claim) : accepté si l'utilisateur a une session valide", async () => {
    const { userId, email } = await seedUser();
    await seedSession(userId);
    jwt.decoded = jeton(userId, email);
    const user = await betterAuthJWTMiddleware(req());
    expect(user?._id?.toString()).toBe(String(userId));
  });
});
