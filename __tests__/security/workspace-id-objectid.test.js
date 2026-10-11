/**
 * Identifiant d'espace reçu du client : seule une chaîne d'ObjectId (24
 * caractères hexadécimaux) est acceptée.
 *
 * Un workspaceId lu dans un corps JSON ou une query string (parseur « qs »
 * d'Express 4 : ?workspaceId[$ne]=…) pouvait être un objet. Placé tel quel
 * dans un filtre MongoDB, il devenait un opérateur : le contrôle
 * d'appartenance trouvait n'importe quelle adhésion de l'utilisateur, puis
 * les filtres des routes ouvraient les données de tous les espaces.
 *
 * Même chose pour la priorité des sources : le middleware REST validait
 * x-organization-id alors que les handlers bancaires lisaient
 * x-workspace-id || ?workspaceId, donc un autre espace.
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
import { Readable } from "stream";

vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://app.test";
});

// Utilisateur de la requête (session simulée)
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    betterAuthJWTMiddleware: async () => auth.user,
  };
});

// Stockage R2 simulé : renvoie le contenu de la clé demandée
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(command) {
      return { Body: Readable.from([`contenu:${command.input.Key}`]) };
    }
  },
  GetObjectCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));
vi.mock("heic-convert", () => ({ default: async () => Buffer.from("") }));
vi.mock("sharp", () => ({ default: () => ({}) }));

// Banque : ni Bridge ni Redis
vi.mock("../../src/services/banking/BankingService.js", () => ({
  bankingService: {},
}));
vi.mock("../../src/services/banking/BankingCacheService.js", () => ({
  bankingCacheService: {
    TTL: { accounts: 60 },
    getAccounts: async () => ({ fromCache: false, data: null }),
    setAccounts: async () => {},
  },
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { getActiveOrganization } from "../../src/middlewares/org-resolver.js";
import {
  getActiveOrganizationCached,
  invalidateOrgCache,
} from "../../src/middlewares/org-cache.js";
import { withWorkspace } from "../../src/middlewares/better-auth-jwt.js";
import {
  getMemberRole,
  requireActiveSubscriptionREST,
} from "../../src/middlewares/rbac.js";
import {
  userBelongsToWorkspace,
  userHasWorkspaceAction,
} from "../../src/utils/workspace-membership.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import SharedDocument from "../../src/models/SharedDocument.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import sharedDocumentRoutes from "../../src/routes/sharedDocumentDownload.js";
import bankingRoutes from "../../src/routes/banking.js";

// Utilisateur A, membre de l'espace A seulement ; espace B : un autre client
const userA = buildUserId();
const orgA = buildOrganizationId();
const userB = buildUserId();
const orgB = buildOrganizationId();
const docB = new mongoose.Types.ObjectId();

const INVALID_IDS = [
  ["un objet { $ne: null }", { $ne: null }],
  ["un objet { $ne: <id> }", { $ne: "000000000000000000000000" }],
  ['un objet { $gt: "" }', { $gt: "" }],
  ["un tableau", [String(orgA)]],
  ["une chaîne quelconque", "espace-a"],
  ["une chaîne de 12 caractères", "aaaaaaaaaaaa"],
  ["un nombre", 42],
];

let server;
let baseUrl;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/api/shared-documents", sharedDocumentRoutes);
  app.use("/banking", bankingRoutes);
  app.post("/abonnement", requireActiveSubscriptionREST(), (req, res) =>
    res.json({ ok: true }),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  auth.user = { _id: userA, id: String(userA), email: "a@test.fr" };
  // B d'abord : la première organisation de la collection n'est pas celle de A
  await seedOrgMembership({ userId: userB, organizationId: orgB });
  await seedOrgMembership({
    userId: userA,
    organizationId: orgA,
    subscriptionStatus: null,
  });
  await SharedDocument.collection.insertOne({
    _id: docB,
    name: "bilan.pdf",
    originalName: "bilan.pdf",
    fileUrl: "https://r2.test/b/bilan.pdf",
    fileKey: "espace-b/bilan.pdf",
    mimeType: "application/pdf",
    fileSize: 10,
    workspaceId: orgB,
    uploadedBy: userB,
    trashedAt: null,
  });
  for (const [workspaceId, name] of [
    [orgA, "Compte A"],
    [orgB, "Compte B"],
  ]) {
    await AccountBanking.collection.insertOne({
      externalId: name,
      provider: "bridge",
      name,
      type: "checking",
      status: "active",
      workspaceId: String(workspaceId),
      createdAt: new Date(),
    });
  }
});

describe("Contrôle d'appartenance : identifiant d'espace non conforme", () => {
  it("accepte l'identifiant de son propre espace", async () => {
    const org = await getActiveOrganization(String(userA), String(orgA));
    expect(org?.id).toBe(String(orgA));
    expect(await userBelongsToWorkspace(String(userA), String(orgA))).toBe(
      true,
    );
  });

  for (const [label, value] of INVALID_IDS) {
    it(`getActiveOrganization refuse ${label}`, async () => {
      expect(await getActiveOrganization(String(userA), value)).toBeNull();
    });

    it(`userBelongsToWorkspace et userHasWorkspaceAction refusent ${label}`, async () => {
      expect(await userBelongsToWorkspace(String(userA), value)).toBe(false);
      expect(
        await userHasWorkspaceAction(String(userA), value, "banking", "view"),
      ).toBe(false);
    });

    it(`getMemberRole refuse ${label}`, async () => {
      expect(await getMemberRole(value, String(userA))).toBeNull();
    });
  }

  it("le cache ne confond pas un tableau avec l'identifiant qu'il contient", async () => {
    expect(
      (await getActiveOrganizationCached(String(userA), String(orgA)))?.id,
    ).toBe(String(orgA));
    expect(
      await getActiveOrganizationCached(String(userA), [String(orgA)]),
    ).toBeNull();
  });

  it("withWorkspace refuse un workspaceId objet (FORBIDDEN)", async () => {
    const resolver = vi.fn(async (_p, _a, ctx) => ctx.workspaceId);
    const wrapped = withWorkspace(resolver);
    await expect(
      wrapped(
        null,
        { workspaceId: { $ne: null } },
        { user: auth.user, req: { headers: {} } },
        {},
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("Routes REST des documents partagés", () => {
  it("refuse ?workspaceId[$ne]=… (le document d'un autre espace restait lisible)", async () => {
    const res = await fetch(
      `${baseUrl}/api/shared-documents/download-file/${docB}?workspaceId[$ne]=000000000000000000000000`,
    );
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain("espace-b/bilan.pdf");
  });

  it("refuse un workspaceId objet dans le corps JSON", async () => {
    const res = await fetch(`${baseUrl}/api/shared-documents/selection-info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documentIds: [String(docB)],
        workspaceId: { $ne: null },
      }),
    });
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).not.toContain("bilan.pdf");
  });
});

describe("Middleware REST d'appartenance (routes bancaires)", () => {
  const accounts = async (query, headers) => {
    const res = await fetch(
      `${baseUrl}/banking/accounts?skipCache=true&${query}`,
      { headers },
    );
    return { status: res.status, body: await res.json() };
  };

  it("x-organization-id de son espace + ?workspaceId=<autre espace> : seul son espace est lu", async () => {
    const { status, body } = await accounts(`workspaceId=${orgB}`, {
      "x-organization-id": String(orgA),
    });
    expect(status).toBe(200);
    expect(body.accounts.map((a) => a.name)).toEqual(["Compte A"]);
  });

  it("x-organization-id de son espace + ?workspaceId[$ne]=… : seul son espace est lu", async () => {
    const { status, body } = await accounts(
      "workspaceId[$ne]=000000000000000000000000",
      { "x-organization-id": String(orgA) },
    );
    expect(status).toBe(200);
    expect(body.accounts.map((a) => a.name)).toEqual(["Compte A"]);
  });

  it("refuse ?workspaceId[$ne]=… seul (403, comme un non-membre)", async () => {
    const { status } = await accounts(
      "workspaceId[$ne]=000000000000000000000000",
      {},
    );
    expect(status).toBe(403);
  });
});

describe("Contrôle d'abonnement REST", () => {
  it("refuse un workspaceId objet (l'abonnement actif d'un autre espace était trouvé)", async () => {
    const res = await fetch(`${baseUrl}/abonnement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: { $ne: null } }),
    });
    expect(res.status).toBe(400);
  });

  it("accepte l'identifiant d'un espace abonné", async () => {
    const res = await fetch(`${baseUrl}/abonnement`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: String(orgB) }),
    });
    expect(res.status).toBe(200);
  });
});
