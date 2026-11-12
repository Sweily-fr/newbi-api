/**
 * Accès anticipé (BETA_FEATURES / BETA_WORKSPACE_IDS) : fermé par défaut en
 * production, ouvert ailleurs ; une requête qui vise plusieurs espaces n'est
 * acceptée que si tous ont accès.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BETA_FEATURE_KEYS,
  FEATURE_NOT_AVAILABLE,
  assertFeatureForRequest,
  gateFeatureResolvers,
  isFeatureEnabled,
  restrictedFeatures,
  workspaceFeatures,
} from "../../src/utils/featureAccess.js";

const BETA = "69acc3e24ddf8f41fec80c04";
const OTHER = "68cda7820000000000000001";

const prodEnv = (extra = {}) => ({
  NODE_ENV: "production",
  BETA_WORKSPACE_IDS: BETA,
  ...extra,
});

const requestFor = ({ args = {}, headers = {} } = {}) => [
  args,
  { req: { headers } },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restrictedFeatures", () => {
  it("réserve tout en production quand BETA_FEATURES est absente", () => {
    expect([...restrictedFeatures({ NODE_ENV: "production" })]).toEqual([
      ...BETA_FEATURE_KEYS,
    ]);
  });

  it("réserve tout en production quand BETA_FEATURES est vide", () => {
    expect(
      restrictedFeatures({ NODE_ENV: "production", BETA_FEATURES: " " }).size,
    ).toBe(BETA_FEATURE_KEYS.length);
  });

  it.each(["development", "test", "staging", undefined])(
    "n'en réserve aucune hors production (%s) sans BETA_FEATURES",
    (nodeEnv) => {
      expect(restrictedFeatures({ NODE_ENV: nodeEnv }).size).toBe(0);
    },
  );

  it("« none » n'en réserve aucune, même en production", () => {
    expect(
      restrictedFeatures({ NODE_ENV: "production", BETA_FEATURES: "none" })
        .size,
    ).toBe(0);
  });

  it("suit la liste donnée, espaces autour compris", () => {
    expect([
      ...restrictedFeatures({ BETA_FEATURES: " vat , appointments " }),
    ]).toEqual(["vat", "appointments"]);
  });
});

describe("isFeatureEnabled", () => {
  it("ouvre une fonctionnalité réservée aux seuls espaces listés", () => {
    expect(isFeatureEnabled("vat", BETA, prodEnv())).toBe(true);
    expect(isFeatureEnabled("vat", OTHER, prodEnv())).toBe(false);
  });

  it("accepte un ObjectId comme identifiant d'espace", () => {
    const objectIdLike = { toString: () => BETA };
    expect(isFeatureEnabled("vat", objectIdLike, prodEnv())).toBe(true);
  });

  it("ferme une fonctionnalité réservée sans espace", () => {
    expect(isFeatureEnabled("vat", null, prodEnv())).toBe(false);
    expect(isFeatureEnabled("vat", "", prodEnv())).toBe(false);
  });

  it("ferme tout en production sans liste d'espaces", () => {
    expect(isFeatureEnabled("vat", BETA, { NODE_ENV: "production" })).toBe(
      false,
    );
  });

  it("ouvre à tous une fonctionnalité retirée de BETA_FEATURES", () => {
    const env = prodEnv({ BETA_FEATURES: "appointments" });
    expect(isFeatureEnabled("vat", OTHER, env)).toBe(true);
    expect(isFeatureEnabled("appointments", OTHER, env)).toBe(false);
  });

  it("refuse une fonctionnalité inconnue (faute de frappe dans le code)", () => {
    expect(() => isFeatureEnabled("tva", BETA, prodEnv())).toThrow(/inconnue/);
  });
});

describe("workspaceFeatures", () => {
  it("donne l'accès de l'espace à chaque fonctionnalité", () => {
    const env = prodEnv({ BETA_FEATURES: "vat,urssaf,socialPublishing" });
    expect(workspaceFeatures(OTHER, env)).toEqual({
      vat: false,
      urssaf: false,
      appointments: true,
      documentShares: true,
      socialPublishing: false,
    });
    expect(workspaceFeatures(BETA, env)).toEqual({
      vat: true,
      urssaf: true,
      appointments: true,
      documentShares: true,
      socialPublishing: true,
    });
  });
});

describe("assertFeatureForRequest", () => {
  const stubProd = () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "");
    vi.stubEnv("BETA_WORKSPACE_IDS", BETA);
  };

  it("laisse passer l'espace bêta (argument et en-tête)", () => {
    stubProd();
    expect(() =>
      assertFeatureForRequest(
        "vat",
        ...requestFor({
          args: { workspaceId: BETA },
          headers: { "x-organization-id": BETA },
        }),
      ),
    ).not.toThrow();
  });

  it("refuse un autre espace avec le code FEATURE_NOT_AVAILABLE", () => {
    stubProd();
    let error;
    try {
      assertFeatureForRequest(
        "vat",
        ...requestFor({ headers: { "x-organization-id": OTHER } }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.details).toEqual({ reason: FEATURE_NOT_AVAILABLE });
  });

  it("refuse si l'argument vise l'espace bêta mais l'en-tête un autre", () => {
    stubProd();
    expect(() =>
      assertFeatureForRequest(
        "vat",
        ...requestFor({
          args: { workspaceId: BETA },
          headers: { "x-organization-id": OTHER },
        }),
      ),
    ).toThrow(/pas encore disponible/);
  });

  it("refuse si x-workspace-id ou organizationId vise un autre espace", () => {
    stubProd();
    expect(() =>
      assertFeatureForRequest(
        "vat",
        ...requestFor({
          headers: { "x-organization-id": BETA, "x-workspace-id": OTHER },
        }),
      ),
    ).toThrow();
    expect(() =>
      assertFeatureForRequest(
        "vat",
        ...requestFor({
          args: { organizationId: OTHER },
          headers: { "x-organization-id": BETA },
        }),
      ),
    ).toThrow();
  });

  it("refuse une requête sans espace (espace par défaut inconnu ici)", () => {
    stubProd();
    expect(() => assertFeatureForRequest("vat", {}, {})).toThrow();
  });

  it("laisse tout passer quand la fonctionnalité n'est pas réservée", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BETA_FEATURES", "");
    expect(() => assertFeatureForRequest("vat", {}, {})).not.toThrow();
  });
});

describe("gateFeatureResolvers", () => {
  const build = () => ({
    Query: {
      status: vi.fn(async () => "statut"),
      list: vi.fn(async () => ["a"]),
    },
    Mutation: { create: vi.fn(async () => "créé") },
    Item: { id: (item) => item._id },
  });

  it("refuse Query et Mutation à un autre espace sans appeler le resolver", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "");
    vi.stubEnv("BETA_WORKSPACE_IDS", BETA);
    const resolvers = build();
    const gated = gateFeatureResolvers("vat", resolvers);
    const [args, context] = requestFor({
      headers: { "x-organization-id": OTHER },
    });
    await expect(gated.Query.list(null, args, context)).rejects.toThrow();
    await expect(gated.Mutation.create(null, args, context)).rejects.toThrow();
    expect(resolvers.Query.list).not.toHaveBeenCalled();
    expect(resolvers.Mutation.create).not.toHaveBeenCalled();
  });

  it("transmet tout au resolver pour l'espace bêta", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "");
    vi.stubEnv("BETA_WORKSPACE_IDS", BETA);
    const resolvers = build();
    const gated = gateFeatureResolvers("vat", resolvers);
    const [args, context] = requestFor({
      args: { workspaceId: BETA },
      headers: { "x-organization-id": BETA },
    });
    await expect(gated.Query.list("p", args, context, "i")).resolves.toEqual([
      "a",
    ]);
    expect(resolvers.Query.list).toHaveBeenCalledWith("p", args, context, "i");
  });

  it("laisse les champs exclus et les types ordinaires intacts", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "");
    vi.stubEnv("BETA_WORKSPACE_IDS", BETA);
    const resolvers = build();
    const gated = gateFeatureResolvers("vat", resolvers, {
      except: ["status"],
    });
    expect(gated.Query.status).toBe(resolvers.Query.status);
    expect(gated.Item).toBe(resolvers.Item);
    const [args, context] = requestFor({
      headers: { "x-organization-id": OTHER },
    });
    await expect(gated.Query.status(null, args, context)).resolves.toBe(
      "statut",
    );
  });
});
