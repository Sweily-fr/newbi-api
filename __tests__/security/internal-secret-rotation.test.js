/**
 * Rotation du secret interne partagé avec le site (x-internal-secret).
 *
 * La réception accepte INTERNAL_API_SECRET OU INTERNAL_API_SECRET_ALT
 * (facultative, ignorée si vide) ; l'envoi utilise toujours
 * INTERNAL_API_SECRET. Avant, seule la clé principale était acceptée :
 * changer le secret coupait les appels entre le site et l'API le temps que
 * les deux côtés soient à jour.
 *
 * Les routes réelles qui reçoivent le secret sont testées :
 * /api/superpdp/* (requireInternalSecret) et /document-annexes
 * (hasInternalSecret, sinon session).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
import express from "express";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/config/redis.js", () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: {
    getEInvoicingSettings: async () => null,
    getMemberCollection: () => ({ findOne: async () => null }),
  },
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { getDocumentAnnexBuffer: async () => Buffer.from("%PDF-1.4") },
}));
// Sans secret valide, /document-annexes retombe sur la session : refusée ici
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  validateJWT: (req, res) =>
    res.status(401).json({ error: "Non authentifié (session)" }),
}));

import {
  getAcceptedInternalSecrets,
  isAcceptedInternalSecret,
} from "../../src/middlewares/internal-secret.js";
import superpdpOAuthRoutes from "../../src/routes/superpdp-oauth.js";
import documentAnnexRoutes from "../../src/routes/documentAnnex.js";

const OLD = "ancienne-cle-interne-0123456789";
const NEW = "nouvelle-cle-interne-9876543210";

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/superpdp", superpdpOAuthRoutes);
  app.use("/document-annexes", documentAnnexRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const setReceiverEnv = ({ main, alt }) => {
  vi.stubEnv("INTERNAL_API_SECRET", main ?? "");
  vi.stubEnv("INTERNAL_API_SECRET_ALT", alt ?? "");
};

const headersWith = (secret) =>
  secret === undefined ? {} : { "x-internal-secret": secret };

// Avec un secret valide, /status répond 400 (organizationId manquant)
const callSuperPdpStatus = (secret) =>
  fetch(`${baseUrl}/api/superpdp/status`, { headers: headersWith(secret) });

const WORKSPACE_ID = "0123456789abcdef01234567";
const FILE_ID = "12345678-1234-1234-1234-123456789abc.pdf";
const callDocumentAnnex = (secret) =>
  fetch(`${baseUrl}/document-annexes/${WORKSPACE_ID}/${FILE_ID}`, {
    headers: headersWith(secret),
  });

describe("isAcceptedInternalSecret : clé principale et clé ALT", () => {
  it("accepte la clé principale", () => {
    expect(isAcceptedInternalSecret(OLD, { INTERNAL_API_SECRET: OLD })).toBe(
      true,
    );
  });

  it("accepte la clé ALT", () => {
    const env = { INTERNAL_API_SECRET: OLD, INTERNAL_API_SECRET_ALT: NEW };
    expect(isAcceptedInternalSecret(NEW, env)).toBe(true);
    expect(isAcceptedInternalSecret(OLD, env)).toBe(true);
  });

  it("refuse toute autre valeur, y compris un préfixe ou une valeur vide", () => {
    const env = { INTERNAL_API_SECRET: OLD, INTERNAL_API_SECRET_ALT: NEW };
    for (const value of [
      "autre-valeur",
      OLD.slice(0, -1),
      `${NEW}x`,
      "",
      undefined,
      null,
      [OLD],
    ]) {
      expect(isAcceptedInternalSecret(value, env)).toBe(false);
    }
  });

  it("ignore une clé ALT vide ou faite d'espaces", () => {
    for (const alt of ["", "   "]) {
      const env = { INTERNAL_API_SECRET: OLD, INTERNAL_API_SECRET_ALT: alt };
      expect(getAcceptedInternalSecrets(env)).toEqual([OLD]);
      expect(isAcceptedInternalSecret(alt, env)).toBe(false);
      expect(isAcceptedInternalSecret(OLD, env)).toBe(true);
    }
  });

  it("refuse tout quand aucun secret n'est configuré", () => {
    expect(getAcceptedInternalSecrets({})).toEqual([]);
    expect(isAcceptedInternalSecret("", {})).toBe(false);
    expect(isAcceptedInternalSecret("n-importe-quoi", {})).toBe(false);
  });
});

describe.each([
  ["/api/superpdp (requireInternalSecret)", callSuperPdpStatus, 400],
  ["/document-annexes (hasInternalSecret)", callDocumentAnnex, 200],
])("route %s", (_name, call, okStatus) => {
  it("accepte la clé principale", async () => {
    setReceiverEnv({ main: OLD, alt: NEW });
    expect((await call(OLD)).status).toBe(okStatus);
  });

  it("accepte la clé ALT", async () => {
    setReceiverEnv({ main: OLD, alt: NEW });
    expect((await call(NEW)).status).toBe(okStatus);
  });

  it("refuse une autre valeur ou l'absence d'en-tête", async () => {
    setReceiverEnv({ main: OLD, alt: NEW });
    expect((await call("autre-valeur")).status).toBe(401);
    expect((await call(undefined)).status).toBe(401);
  });

  it("ignore une clé ALT vide (en-tête vide refusé)", async () => {
    setReceiverEnv({ main: OLD, alt: "" });
    expect((await call("")).status).toBe(401);
    expect((await call(NEW)).status).toBe(401);
    expect((await call(OLD)).status).toBe(okStatus);
  });
});

describe("/api/superpdp sans aucun secret configuré", () => {
  it("répond 500 (configuration manquante) au lieu d'ouvrir l'accès", async () => {
    setReceiverEnv({ main: "", alt: "" });
    expect((await callSuperPdpStatus("")).status).toBe(500);
  });
});

describe("procédure de rotation entre un émetteur et un récepteur", () => {
  // État des variables d'un côté (site ou API) à chaque étape
  const STATES = [
    { label: "départ (ancienne seule)", main: OLD, alt: "" },
    { label: "état 1 (ALT nouvelle)", main: OLD, alt: NEW },
    { label: "état 2 (nouvelle, ALT ancienne)", main: NEW, alt: OLD },
    { label: "état 3 (nouvelle seule)", main: NEW, alt: "" },
  ];

  // Ce que tout émetteur envoie : toujours INTERNAL_API_SECRET
  const sentBy = (state) => state.main;

  // Pendant l'étape k, chaque côté (et chaque instance PM2 ou Vercel) est
  // soit encore à l'état k-1, soit déjà à l'état k, dans n'importe quel ordre.
  const PAIRS = [];
  for (let step = 1; step < STATES.length; step += 1) {
    for (const sender of [STATES[step - 1], STATES[step]]) {
      for (const receiver of [STATES[step - 1], STATES[step]]) {
        PAIRS.push([
          `étape ${step} : émetteur ${sender.label} vers récepteur ${receiver.label}`,
          sender,
          receiver,
        ]);
      }
    }
  }

  it.each(PAIRS)("%s : accepté", async (_name, sender, receiver) => {
    const receiverEnv = {
      INTERNAL_API_SECRET: receiver.main,
      INTERNAL_API_SECRET_ALT: receiver.alt,
    };
    expect(isAcceptedInternalSecret(sentBy(sender), receiverEnv)).toBe(true);

    setReceiverEnv(receiver);
    expect((await callSuperPdpStatus(sentBy(sender))).status).toBe(400);
    expect((await callDocumentAnnex(sentBy(sender))).status).toBe(200);
  });

  it("enchaîner deux étapes sans attendre l'autre côté provoque des refus", () => {
    // Un côté encore au départ, l'autre déjà à l'étape 2 : la nouvelle clé
    // envoyée n'est pas connue du premier. Chaque étape doit être terminée
    // des deux côtés avant de passer à la suivante.
    const [start, , step2] = STATES;
    expect(
      isAcceptedInternalSecret(sentBy(step2), {
        INTERNAL_API_SECRET: start.main,
        INTERNAL_API_SECRET_ALT: start.alt,
      }),
    ).toBe(false);
  });
});
