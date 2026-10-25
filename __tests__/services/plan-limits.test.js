import { describe, it, expect, vi, beforeEach } from "vitest";

const planMock = vi.hoisted(() => ({ getWorkspacePlan: vi.fn() }));
vi.mock("../../src/services/esignatureQuota.js", () => planMock);

import {
  assertPlanCapacity,
  assertPlanFeature,
  assertQualifiedSignatureAllowed,
} from "../../src/services/planLimits.js";

const WORKSPACE = "64b000000000000000000001";

beforeEach(() => {
  planMock.getWorkspacePlan.mockReset();
});

describe("assertPlanCapacity", () => {
  it("offre d'entrée : refuse le 6e champ personnalisé", async () => {
    planMock.getWorkspacePlan.mockResolvedValue("freelance");
    await expect(
      assertPlanCapacity(
        WORKSPACE,
        "customFields",
        async () => 5,
        "champs personnalisés",
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/pas plus de 5 champs personnalisés.*TPE/),
    });
  });

  it("offre d'entrée : accepte sous le plafond", async () => {
    planMock.getWorkspacePlan.mockResolvedValue("freelance");
    await expect(
      assertPlanCapacity(WORKSPACE, "customFields", async () => 4, "champs"),
    ).resolves.toBeUndefined();
  });

  it("offre illimitée : ne compte même pas", async () => {
    planMock.getWorkspacePlan.mockResolvedValue("pme");
    const count = vi.fn();
    await assertPlanCapacity(WORKSPACE, "documentTemplates", count, "modèles");
    expect(count).not.toHaveBeenCalled();
  });
});

describe("assertPlanFeature", () => {
  it("segments absents de l'offre d'entrée", async () => {
    planMock.getWorkspacePlan.mockResolvedValue("freelance");
    await expect(
      assertPlanFeature(WORKSPACE, "clientSegments", "les segments"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("segments compris dans l'offre TPE", async () => {
    planMock.getWorkspacePlan.mockResolvedValue("pme");
    await expect(
      assertPlanFeature(WORKSPACE, "clientSegments", "les segments"),
    ).resolves.toBeUndefined();
  });
});

describe("assertQualifiedSignatureAllowed", () => {
  it.each(["freelance", "pme"])("offre %s : refusée", async (plan) => {
    planMock.getWorkspacePlan.mockResolvedValue(plan);
    await expect(
      assertQualifiedSignatureAllowed(WORKSPACE),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("offre Entreprise : acceptée", async () => {
    planMock.getWorkspacePlan.mockResolvedValue("entreprise");
    await expect(
      assertQualifiedSignatureAllowed(WORKSPACE),
    ).resolves.toBeUndefined();
  });
});
