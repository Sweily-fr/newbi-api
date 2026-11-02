import { describe, it, expect } from "vitest";
import {
  BYTES_PER_GB,
  computeStorageQuota,
  formatBytes,
  nextPlan,
  normalizePlan,
  packsNeededFor,
  PLAN_STORAGE_GB,
  recommendStorageOptions,
  STORAGE_PACK_BYTES,
} from "../../../src/services/storage/storageConfig.js";

const GB = BYTES_PER_GB;

describe("Stockage : quota par offre", () => {
  it("donne 75 Go à Freelance, 400 Go à TPE, 1 To à Entreprise", () => {
    expect(computeStorageQuota({ plan: "freelance" }).quotaBytes).toBe(75 * GB);
    expect(computeStorageQuota({ plan: "pme" }).quotaBytes).toBe(400 * GB);
    expect(computeStorageQuota({ plan: "entreprise" }).quotaBytes).toBe(1000 * GB);
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
    expect(quota.quotaBytes).toBe(225 * GB);
  });

  it("ne descend jamais sous le quota de l'offre", () => {
    expect(computeStorageQuota({ plan: "pme", packs: -4 }).quotaBytes).toBe(400 * GB);
    expect(computeStorageQuota({ plan: "pme", packs: "abc" }).quotaBytes).toBe(400 * GB);
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
    expect(packsNeededFor("freelance", 70 * GB)).toBe(0);
    expect(packsNeededFor("freelance", 76 * GB)).toBe(1);
    expect(packsNeededFor("freelance", 125 * GB)).toBe(1);
    expect(packsNeededFor("freelance", 126 * GB)).toBe(2);
    expect(STORAGE_PACK_BYTES).toBe(50 * GB);
  });
});

describe("Stockage : proposition pack ou offre supérieure", () => {
  it("propose un pack sur Freelance juste au-dessus de la limite", () => {
    const offer = recommendStorageOptions({
      plan: "freelance",
      usedBytes: 74 * GB,
      incomingBytes: 2 * GB,
    });
    expect(offer.packs.additionalPacks).toBe(1);
    expect(offer.packs.monthlyCost).toBe(20.98);
    expect(offer.upgrade.plan).toBe("pme");
    expect(offer.upgrade.monthlyCost).toBe(48.99);
    expect(offer.recommended).toBe("packs");
  });

  it("garde les packs quand l'offre supérieure coûte plus de 10 % de plus", () => {
    // 600 Go sur Freelance : 11 packs, 17,99 + 32,89 = 50,88 ;
    // TPE + 4 packs = 48,99 + 11,96 = 60,95 (> 55,97)
    const offer = recommendStorageOptions({ plan: "freelance", usedBytes: 600 * GB });
    expect(offer.packs.totalPacks).toBe(11);
    expect(offer.packs.monthlyCost).toBe(50.88);
    expect(offer.upgrade.packs).toBe(4);
    expect(offer.upgrade.monthlyCost).toBe(60.95);
    expect(offer.recommended).toBe("packs");
  });

  it("met en avant TPE quand elle coûte au plus 10 % de plus", () => {
    // 2 000 Go : Freelance + 39 packs = 134,60 ; TPE + 32 packs = 144,67
    // (≤ 148,06)
    const offer = recommendStorageOptions({ plan: "freelance", usedBytes: 2000 * GB });
    expect(offer.packs.monthlyCost).toBe(134.6);
    expect(offer.upgrade.monthlyCost).toBe(144.67);
    expect(offer.recommended).toBe("upgrade");
  });

  it("met en avant Entreprise quand elle coûte au plus 10 % de plus", () => {
    // 1 300 Go : TPE + 18 packs = 102,81 ; Entreprise + 6 packs = 112,93
    // (≤ 113,09)
    const offer = recommendStorageOptions({ plan: "pro", usedBytes: 1300 * GB });
    expect(offer.packs.monthlyCost).toBe(102.81);
    expect(offer.upgrade.plan).toBe("entreprise");
    expect(offer.upgrade.monthlyCost).toBe(112.93);
    expect(offer.recommended).toBe("upgrade");
  });

  it("met en avant l'offre supérieure quand elle est moins chère", () => {
    // Abonnement déjà chargé de packs : 25 packs sur TPE pour 1 300 Go,
    // un de plus = 126,73 ; Entreprise + 6 packs = 112,93
    const offer = recommendStorageOptions({
      plan: "pme",
      usedBytes: 1300 * GB,
      currentPacks: 25,
    });
    expect(offer.packs.totalPacks).toBe(26);
    expect(offer.upgrade.monthlyCost).toBeLessThan(offer.packs.monthlyCost);
    expect(offer.recommended).toBe("upgrade");
  });

  it("ne propose que des packs sur Entreprise", () => {
    const offer = recommendStorageOptions({ plan: "entreprise", usedBytes: 1000 * GB, incomingBytes: GB });
    expect(offer.upgrade).toBeNull();
    expect(offer.recommended).toBe("packs");
    expect(offer.packs.additionalPacks).toBe(1);
  });

  it("compte les packs déjà actifs", () => {
    const offer = recommendStorageOptions({
      plan: "freelance",
      usedBytes: 125 * GB,
      currentPacks: 1,
      incomingBytes: GB,
    });
    expect(offer.packs.totalPacks).toBe(2);
    expect(offer.packs.additionalPacks).toBe(1);
    expect(offer.currentMonthlyCost).toBe(20.98);
  });

  it("utilise les prix annuels pour un abonnement annuel", () => {
    const offer = recommendStorageOptions({
      plan: "freelance",
      interval: "year",
      usedBytes: 75 * GB,
      incomingBytes: 1,
    });
    expect(offer.packs.billedPrice).toBe(29.9);
    expect(offer.packs.interval).toBe("year");
    expect(offer.packs.monthlyCost).toBe(Math.round((16.19 + 29.9 / 12) * 100) / 100);
    expect(offer.upgrade.planMonthlyPrice).toBe(44.09);
  });
});

describe("Stockage : affichage des tailles", () => {
  it("écrit les tailles en unités françaises", () => {
    expect(formatBytes(75 * GB)).toBe("75 Go");
    expect(formatBytes(1000 * GB)).toBe("1 To");
    expect(formatBytes(1.5 * GB)).toBe("1,5 Go");
    expect(formatBytes(12_000_000)).toBe("12 Mo");
    expect(formatBytes(0)).toBe("0 octets");
  });
});
