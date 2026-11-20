/**
 * Validateur JWT : adresse du JWKS et pause après un échec.
 *
 * - Le JWKS est servi par Better Auth à sa baseURL (l'issuer des JWT) :
 *   l'adresse suit AUTH_JWKS_URL, puis AUTH_EXPECTED_ISSUER, puis
 *   FRONTEND_URL. En dev, FRONTEND_URL pointe sur l'IP du Mac pour le
 *   mobile ; quand cette IP change, chaque requête attendait 5 s.
 * - Après un échec, pas de nouvel appel pendant la pause : les requêtes ne
 *   paient plus le délai d'attente une à une, et l'indisponibilité ne compte
 *   jamais comme tentative suspecte (aucun blocage d'IP).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
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

const ENV_KEYS = [
  "NODE_ENV",
  "AUTH_JWKS_URL",
  "AUTH_EXPECTED_ISSUER",
  "FRONTEND_URL",
  "JWKS_FETCH_TIMEOUT_MS",
  "JWKS_FAILURE_BACKOFF_MS",
];
const ISSUER = "https://app.newbi.test";
const KID = "cle-de-test";
const CLIENT_IP = "203.0.113.5";

let privateKey;
let jwks;
let savedEnv;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: "EdDSA" }] };
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

const jwksResponse = (url) => ({
  ok: true,
  status: 200,
  url,
  json: async () => jwks,
});

describe("adresse du JWKS", () => {
  it("prend l'issuer avant FRONTEND_URL (IP du Mac périmée en dev)", () => {
    process.env.AUTH_EXPECTED_ISSUER = "http://localhost:3000/";
    process.env.FRONTEND_URL = "http://192.168.1.38:3000";
    expect(new JWKSValidator().jwksUrl).toBe(
      "http://localhost:3000/api/auth/jwks",
    );
  });

  it("AUTH_JWKS_URL l'emporte sur tout le reste", () => {
    process.env.AUTH_JWKS_URL = "https://auth.newbi.test/jwks";
    process.env.AUTH_EXPECTED_ISSUER = ISSUER;
    process.env.FRONTEND_URL = "https://www.newbi.test";
    expect(new JWKSValidator().jwksUrl).toBe("https://auth.newbi.test/jwks");
  });

  it("sans issuer : FRONTEND_URL, comme avant", () => {
    process.env.FRONTEND_URL = "https://www.newbi.test";
    expect(new JWKSValidator().jwksUrl).toBe(
      "https://www.newbi.test/api/auth/jwks",
    );
  });

  it("sans rien : le front local", () => {
    expect(new JWKSValidator().jwksUrl).toBe(
      "http://localhost:3000/api/auth/jwks",
    );
  });
});

describe("pause après un échec du JWKS", () => {
  it("n'appelle plus le JWKS pendant la pause, puis réessaie", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const validator = new JWKSValidator();

    await expect(validator.fetchJWKS()).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Pendant la pause : échec immédiat, sans nouvel appel réseau
    await expect(validator.fetchJWKS()).rejects.toThrow(
      /JWKS indisponible \(échec récent : fetch failed\), nouvelle tentative dans \d+s/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Pause écoulée : nouvel appel, et la réussite efface l'échec
    validator.lastFetchFailure.timestamp -= validator.failureBackoffMs + 1;
    fetchMock.mockResolvedValue(jwksResponse(validator.jwksUrl));
    await expect(validator.fetchJWKS()).resolves.toEqual(jwks);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(validator.lastFetchFailure).toBeNull();
  });

  it("pause et délai d'attente réglables", () => {
    process.env.JWKS_FAILURE_BACKOFF_MS = "1000";
    process.env.JWKS_FETCH_TIMEOUT_MS = "2000";
    const validator = new JWKSValidator();
    expect(validator.failureBackoffMs).toBe(1000);
    expect(validator.fetchTimeoutMs).toBe(2000);
  });

  it("pendant la pause, un jeton à clé inconnue est refusé sans bloquer l'IP", async () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_EXPECTED_ISSUER = ISSUER;
    const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const validator = new JWKSValidator();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: KID })
      .setSubject("utilisateur-1")
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    for (let i = 0; i < validator.maxFailedAttempts * 2; i++) {
      expect(await validator.validateJWT(token, CLIENT_IP)).toBeNull();
    }
    // Un seul appel réseau malgré les vingt requêtes, aucune tentative
    // suspecte comptée
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(validator.failedAttempts.size).toBe(0);
    expect(validator.checkIPBlocked(CLIENT_IP)).toBe(false);

    // JWKS revenu après la pause : le même jeton passe
    validator.lastFetchFailure.timestamp -= validator.failureBackoffMs + 1;
    fetchMock.mockResolvedValue(jwksResponse(validator.jwksUrl));
    expect((await validator.validateJWT(token, CLIENT_IP))?.sub).toBe(
      "utilisateur-1",
    );
  });
});
