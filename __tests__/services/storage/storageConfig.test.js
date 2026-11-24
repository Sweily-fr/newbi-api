import { describe, it, expect } from "vitest";
import {
  BYTES_PER_GB,
  canBuyPacks,
  computeStorageQuota,
  formatBytes,
  nextPlan,
  normalizePlan,
  packsNeededFor,
  PLAN_STORAGE_GB,
  recommendStorageOptions,
  STORAGE_PACK_BYTES,
  upgradeTargetFor,
} from "../../../src/services/storage/storageConfig.js";

const GB = BYTES_PER_GB;

describe("Stockage : quota par offre", () => {
  it("donne 100 Go à Freelance, 500 Go à TPE, 5 To à Entreprise", () => {
    expect(computeStorageQuota({ plan: "freelance" }).quotaBytes).toBe(
      100 * GB,
    );
    expect(computeStorageQuota({ plan: "pme" }).quotaBytes).toBe(500 * GB);
    expect(computeStorageQuota({ plan: "entreprise" }).quotaBytes).toBe(
      5000 * GB,
    );
  });

  it("reconnaît les noms d'offre de la base (pro, enterprise)", () => {
    expect(normalizePlan("pro")).toBe("pme");
    expect(normalizePlan("PME")).toBe("pme");
    expect(normalizePlan("enterprise")).toBe("entreprise");
    expect(normalizePlan(undefined)).toBe("freelance");
    expect(normalizePlan("inconnue")).toBe("freelance");
  });

  it("ajoute 50 Go par pack, cumulables", () => {
    const quota = computeStorageQuota({ plan: "freelance", packs: 3 });
    expect(quota.packBytes).toBe(150 * GB);
    expect(quota.quotaBytes).toBe(250 * GB);
  });

  it("ne descend jamais sous le quota de l'offre", () => {
    expect(computeStorageQuota({ plan: "pme", packs: -4 }).quotaBytes).toBe(
      500 * GB,
    );
    expect(computeStorageQuota({ plan: "pme", packs: "abc" }).quotaBytes).toBe(
      500 * GB,
    );
  });

  it("ne dépend pas du nombre d'utilisateurs", () => {
    expect(computeStorageQuota({ plan: "pme", users: 10 }).quotaBytes).toBe(
      PLAN_STORAGE_GB.pme * GB,
    );
  });

  it("enchaîne Freelance, TPE puis Entreprise", () => {
    expect(nextPlan("freelance")).toBe("pme");
    expect(nextPlan("pro")).toBe("entreprise");
    expect(nextPlan("entreprise")).toBeNull();
  });

  it("compte les packs nécessaires au-delà du quota de l'offre", () => {
    expect(packsNeededFor("freelance", 95 * GB)).toBe(0);
    expect(packsNeededFor("freelance", 101 * GB)).toBe(1);
    expect(packsNeededFor("freelance", 150 * GB)).toBe(1);
    expect(packsNeededFor("freelance", 151 * GB)).toBe(2);
    expect(STORAGE_PACK_BYTES).toBe(50 * GB);
  });
});

describe("Stockage : packs réservés à Entreprise", () => {
  it("ne vend des packs que sur l'offre Entreprise", () => {
    expect(canBuyPacks("freelance")).toBe(false);
    expect(canBuyPacks("pme")).toBe(false);
    expect(canBuyPacks("pro")).toBe(false);
    expect(canBuyPacks("entreprise")).toBe(true);
    expect(canBuyPacks("enterprise")).toBe(true);
    expect(canBuyPacks(undefined)).toBe(false);
  });

  it("vise la première offre supérieure qui contient l'espace nécessaire", () => {
    expect(upgradeTargetFor("freelance", 300 * GB)).toBe("pme");
    expect(upgradeTargetFor("freelance", 500 * GB)).toBe("pme");
    expect(upgradeTargetFor("freelance", 501 * GB)).toBe("entreprise");
    expect(upgradeTargetFor("pro", 600 * GB)).toBe("entreprise");
    expect(upgradeTargetFor("pme", 5000 * GB)).toBe("entreprise");
    expect(upgradeTargetFor("entreprise", 5000 * GB)).toBeNull();
  });
});

describe("Stockage : proposition pack ou offre supérieure", () => {
  it("Standard plein : propose Premium, sans pack", () => {
    const offer = recommendStorageOptions({
      plan: "freelance",
      usedBytes: 99 * GB,
      incomingBytes: 2 * GB,
    });
    expect(offer.packs).toBeNull();
    expect(offer.upgrade).toMatchObject({
      plan: "pme",
      label: "Premium",
      packs: 0,
      monthlyCost: 50,
      quotaBytes: 500 * GB,
    });
    expect(offer.recommended).toBe("upgrade");
  });

  it("Standard au-delà de 500 Go : propose directement Entreprise", () => {
    const offer = recommendStorageOptions({
      plan: "freelance",
      usedBytes: 600 * GB,
    });
    expect(offer.packs).toBeNull();
    expect(offer.upgrade).toMatchObject({
      plan: "entreprise",
      packs: 0,
      monthlyCost: 200,
    });
    expect(offer.recommended).toBe("upgrade");
  });

  it("Premium plein : propose Entreprise, sans pack", () => {
    const offer = recommendStorageOptions({
      plan: "pro",
      usedBytes: 500 * GB,
      incomingBytes: GB,
    });
    expect(offer.packs).toBeNull();
    expect(offer.upgrade).toMatchObject({
      plan: "entreprise",
      label: "Entreprise",
      packs: 0,
      monthlyCost: 200,
      quotaBytes: 5000 * GB,
    });
    expect(offer.recommended).toBe("upgrade");
  });

  it("au-delà de 5 To : Entreprise avec les packs nécessaires", () => {
    // 5 100 Go : Entreprise + 2 packs = 200 + 5,98 = 205,98
    const offer = recommendStorageOptions({
      plan: "freelance",
      usedBytes: 5100 * GB,
    });
    expect(offer.upgrade).toMatchObject({
      plan: "entreprise",
      packs: 2,
      monthlyCost: 205.98,
      quotaBytes: 5100 * GB,
    });
  });

  it("Entreprise pleine : propose des packs, pas d'offre supérieure", () => {
    const offer = recommendStorageOptions({
      plan: "entreprise",
      usedBytes: 5000 * GB,
      incomingBytes: GB,
    });
    expect(offer.upgrade).toBeNull();
    expect(offer.recommended).toBe("packs");
    expect(offer.packs).toMatchObject({
      additionalPacks: 1,
      totalPacks: 1,
      monthlyCost: 202.99,
      extraMonthlyCost: 2.99,
    });
  });

  it("compte les packs déjà actifs", () => {
    const offer = recommendStorageOptions({
      plan: "entreprise",
      usedBytes: 5050 * GB,
      currentPacks: 1,
      incomingBytes: GB,
    });
    expect(offer.packs.totalPacks).toBe(2);
    expect(offer.packs.additionalPacks).toBe(1);
    expect(offer.currentMonthlyCost).toBe(202.99);
  });

  it("garde les packs déjà achetés sur Premium sans en proposer d'autres", () => {
    const offer = recommendStorageOptions({
      plan: "pme",
      usedBytes: 600 * GB,
      currentPacks: 2,
      incomingBytes: GB,
    });
    expect(offer.packs).toBeNull();
    expect(offer.currentMonthlyCost).toBe(55.98);
    expect(offer.upgrade.plan).toBe("entreprise");
  });

  it("utilise les prix annuels pour un abonnement annuel", () => {
    const offer = recommendStorageOptions({
      plan: "entreprise",
      interval: "year",
      usedBytes: 5000 * GB,
      incomingBytes: 1,
    });
    expect(offer.packs.billedPrice).toBe(29.9);
    expect(offer.packs.interval).toBe("year");
    expect(offer.packs.monthlyCost).toBe(
      Math.round((180 + 29.9 / 12) * 100) / 100,
    );
    const standard = recommendStorageOptions({
      plan: "freelance",
      interval: "year",
      usedBytes: 100 * GB,
      incomingBytes: 1,
    });
    expect(standard.upgrade.planMonthlyPrice).toBe(45);
  });
});

describe("Stockage : affichage des tailles", () => {
  it("écrit les tailles en unités françaises", () => {
    expect(formatBytes(75 * GB)).toBe("75 Go");
    expect(formatBytes(1000 * GB)).toBe("1 To");
    expect(formatBytes(1.5 * GB)).toBe("1,5 Go");
    expect(formatBytes(12_000_000)).toBe("12 Mo");
    expect(formatBytes(0)).toBe("0 Go");
    expect(formatBytes(512)).toBe("512 octets");
  });
});
