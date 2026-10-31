/**
 * Validateur JWT : la limite de débit et le blocage par IP restent propres à
 * chaque client.
 *
 * - Un jeton valide signé par une clé déjà en cache passe toujours, même
 *   depuis une IP bloquée : le blocage ne protège que la récupération du JWKS
 *   pour un kid inconnu.
 * - Une IP loopback ou inconnue ne désigne aucun client : jamais comptée ni
 *   bloquée, production comprise.
 * - Les connexions WebSocket portent l'IP du client (requête d'upgrade).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import JWKSValidator from "../../src/services/jwks-validator.js";
import { clientIpOf } from "../../src/middlewares/better-auth-jwt.js";

const ISSUER = "https://app.newbi.test";
const KID = "cle-de-test";
const CLIENT_IP = "203.0.113.5";

let privateKey;
let jwks;
const previousEnv = {};

beforeAll(async () => {
  for (const key of ["NODE_ENV", "AUTH_EXPECTED_ISSUER"]) {
    previousEnv[key] = process.env[key];
  }
  process.env.NODE_ENV = "production";
  process.env.AUTH_EXPECTED_ISSUER = ISSUER;
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: "EdDSA" }] };
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const signToken = (kid = KID) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setSubject("utilisateur-1")
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

let validator;
beforeEach(() => {
  validator = new JWKSValidator();
  validator.fetchJWKS = vi.fn(async () => jwks);
});

const blockIp = async (ip) => {
  for (let i = 0; i < validator.maxFailedAttempts; i++) {
    await validator.validateJWT("x", ip);
  }
};

describe("blocage par IP du validateur JWT", () => {
  it("bloque une IP après des jetons illisibles", async () => {
    await blockIp(CLIENT_IP);
    expect(validator.checkIPBlocked(CLIENT_IP)).toBe(true);
  });

  it("accepte un jeton valide dont la clé est en cache, même depuis une IP bloquée", async () => {
    const token = await signToken();
    expect((await validator.validateJWT(token, CLIENT_IP))?.sub).toBe(
      "utilisateur-1",
    );
    await blockIp(CLIENT_IP);
    expect(validator.checkIPBlocked(CLIENT_IP)).toBe(true);
    expect((await validator.validateJWT(token, CLIENT_IP))?.sub).toBe(
      "utilisateur-1",
    );
  });

  it("ne récupère pas le JWKS pour un kid inconnu depuis une IP bloquée", async () => {
    await blockIp(CLIENT_IP);
    const token = await signToken("kid-inconnu");
    expect(await validator.validateJWT(token, CLIENT_IP)).toBeNull();
    expect(validator.fetchJWKS).not.toHaveBeenCalled();
  });

  it("le blocage d'une IP ne touche pas les autres clients", async () => {
    await blockIp(CLIENT_IP);
    const token = await signToken();
    expect((await validator.validateJWT(token, "198.51.100.7"))?.sub).toBe(
      "utilisateur-1",
    );
  });

  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown", ""]) {
    it(`ne compte ni ne bloque l'adresse « ${ip || "vide"} » en production`, async () => {
      for (let i = 0; i < validator.maxFailedAttempts * 2; i++) {
        await validator.validateJWT("x", ip);
      }
      expect(validator.checkIPBlocked(ip)).toBe(false);
      expect(validator.failedAttempts.size).toBe(0);
      const token = await signToken();
      expect((await validator.validateJWT(token, ip))?.sub).toBe(
        "utilisateur-1",
      );
    });
  }

  it("retire les compteurs périmés", async () => {
    await validator.validateJWT("x", CLIENT_IP);
    validator.requestCount.set("192.0.2.9", [Date.now() - 120000]);
    const attempt = validator.failedAttempts.get(CLIENT_IP);
    attempt.lastAttempt = Date.now() - validator.blockDuration - 1000;
    validator.lastTrackingPrune = 0;
    validator.pruneTracking();
    expect(validator.failedAttempts.has(CLIENT_IP)).toBe(false);
    expect(validator.requestCount.has("192.0.2.9")).toBe(false);
  });
});

describe("clientIpOf", () => {
  it("prend req.ip, calculé par Express d'après le proxy", () => {
    expect(
      clientIpOf({
        ip: CLIENT_IP,
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      }),
    ).toBe(CLIENT_IP);
  });

  it("requête d'upgrade : dernière entrée de x-forwarded-for, ajoutée par le proxy", () => {
    expect(
      clientIpOf({
        headers: { "x-forwarded-for": `1.2.3.4, ${CLIENT_IP}` },
        socket: { remoteAddress: "127.0.0.1" },
      }),
    ).toBe(CLIENT_IP);
  });

  it("sans en-tête de proxy : adresse de la socket", () => {
    expect(
      clientIpOf({ headers: {}, socket: { remoteAddress: CLIENT_IP } }),
    ).toBe(CLIENT_IP);
  });

  it("ignore x-real-ip, posé librement par le client", () => {
    expect(
      clientIpOf({
        headers: { "x-real-ip": "1.2.3.4" },
        socket: { remoteAddress: CLIENT_IP },
      }),
    ).toBe(CLIENT_IP);
  });

  it("renvoie « unknown » sans aucune indication", () => {
    expect(clientIpOf(undefined)).toBe("unknown");
    expect(clientIpOf({ headers: {} })).toBe("unknown");
  });
});
