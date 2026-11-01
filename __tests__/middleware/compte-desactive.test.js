/**
 * Comptes désactivés : refusés par les deux chemins d'authentification.
 *
 * Le site désactive un compte en posant isActive: false sur le document de
 * la collection Better Auth « user ». Ce champ n'est pas déclaré dans le
 * schéma Mongoose du modèle User : user.isActive valait donc toujours
 * undefined côté API, et un compte désactivé restait authentifié (cookie de
 * session comme JWT). isDisabled (champ historique) reste refusé, et un
 * compte sans le champ isActive reste accepté.
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

// Validateur JWKS simulé : le décodage renvoie l'utilisateur choisi par le test
const jwt = vi.hoisted(() => ({ decoded: null }));
vi.mock("../../src/services/jwks-validator.js", () => ({
  getJWKSValidator: async () => ({
    validateJWT: async () => jwt.decoded,
  }),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { betterAuthMiddleware } from "../../src/middlewares/better-auth.js";
import { betterAuthJWTMiddleware } from "../../src/middlewares/better-auth-jwt.js";
import {
  invalidateUserCache,
  isUserAccessDenied,
} from "../../src/middlewares/user-cache.js";

const seedUser = async (extra = {}) => {
  const _id = new mongoose.Types.ObjectId();
  const email = `user-${_id}@example.com`;
  await mongoose.connection.db.collection("user").insertOne({
    _id,
    email,
    password: "x",
    ...extra,
  });
  return { _id, email };
};

const seedSession = async (userId) => {
  const token = `tok${new mongoose.Types.ObjectId()}`;
  await mongoose.connection.db.collection("session").insertOne({
    token,
    userId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return token;
};

const cookieReq = (token) => ({
  headers: { cookie: `better-auth.session_token=${token}` },
});
const jwtReq = () => ({ headers: { authorization: "Bearer jeton.de.test" } });

const CASES = [
  {
    label: "compte actif (isActive: true)",
    extra: { isActive: true },
    accepted: true,
  },
  { label: "compte sans champ isActive", extra: {}, accepted: true },
  {
    label: "compte désactivé par le site (isActive: false)",
    extra: { isActive: false },
    accepted: false,
  },
  {
    label: "compte désactivé (isDisabled: true)",
    extra: { isDisabled: true },
    accepted: false,
  },
];

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateUserCache();
  jwt.decoded = null;
});

describe("authentification par cookie de session (better-auth.js)", () => {
  for (const { label, extra, accepted } of CASES) {
    it(`${label} : ${accepted ? "accepté" : "refusé"}`, async () => {
      const { _id } = await seedUser(extra);
      const token = await seedSession(_id);
      const user = await betterAuthMiddleware(cookieReq(token));
      if (accepted) {
        expect(user?._id?.toString()).toBe(_id.toString());
      } else {
        expect(
          user,
          "un compte désactivé ne doit pas être authentifié",
        ).toBeNull();
      }
    });
  }
});

describe("authentification par JWT (better-auth-jwt.js, aussi utilisé par les WebSockets)", () => {
  for (const { label, extra, accepted } of CASES) {
    it(`${label} : ${accepted ? "accepté" : "refusé"}`, async () => {
      const { _id, email } = await seedUser(extra);
      jwt.decoded = { sub: _id.toString(), email };
      const user = await betterAuthJWTMiddleware(jwtReq());
      if (accepted) {
        expect(user?._id?.toString()).toBe(_id.toString());
      } else {
        expect(
          user,
          "un compte désactivé ne doit pas être authentifié",
        ).toBeNull();
      }
    });
  }

  it("un compte désactivé n'est pas mis en cache puis servi à la requête suivante", async () => {
    const { _id, email } = await seedUser({ isActive: false });
    jwt.decoded = { sub: _id.toString(), email };
    expect(await betterAuthJWTMiddleware(jwtReq())).toBeNull();
    expect(await betterAuthJWTMiddleware(jwtReq())).toBeNull();
  });
});

describe("isUserAccessDenied", () => {
  it("lit isActive sur un objet simple comme sur un document Mongoose", () => {
    expect(isUserAccessDenied(null)).toBe(true);
    expect(isUserAccessDenied({ isActive: false })).toBe(true);
    expect(isUserAccessDenied({ isDisabled: true })).toBe(true);
    expect(isUserAccessDenied({})).toBe(false);
    expect(isUserAccessDenied({ isActive: true })).toBe(false);
  });
});
