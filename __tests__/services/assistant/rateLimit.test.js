import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAndConsume,
  RATE_LIMITS,
  _resetAll,
  _snapshot,
} from "../../../src/services/assistant/rateLimit.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("rateLimit — plafond horaire (30/h)", () => {
  beforeEach(() => _resetAll());

  it("autorise jusqu'au 30e appel dans l'heure", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 30; i++) {
      const r = checkAndConsume("ws1", t0 + i * 1000);
      expect(r.allowed).toBe(true);
    }
  });

  it("rejette le 31e appel avec scope='hour'", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 30; i++) checkAndConsume("ws1", t0 + i * 1000);
    const r = checkAndConsume("ws1", t0 + 30 * 1000);
    expect(r.allowed).toBe(false);
    expect(r.scope).toBe("hour");
    expect(r.limit).toBe(30);
    expect(r.used).toBe(30);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("ré-autorise dès que le plus ancien hit sort de la fenêtre horaire", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 30; i++) checkAndConsume("ws1", t0 + i * 1000);
    // 1 heure + 1s après le premier hit → il sort de la fenêtre horaire
    const t1 = t0 + HOUR_MS + 1000;
    const r = checkAndConsume("ws1", t1);
    expect(r.allowed).toBe(true);
  });
});

describe("rateLimit — plafond journalier (100/jour)", () => {
  beforeEach(() => _resetAll());

  it("rejette dès le 101e appel sur la journée même si étalé", () => {
    const t0 = 1_000_000_000_000;
    // 100 appels étalés sur 23h59 → tous OK (≤ 30/h sur chaque tranche)
    for (let i = 0; i < 100; i++) {
      // 1 toutes les ~14 min → 4.3/h (sous le plafond horaire)
      const t = t0 + i * 14 * 60 * 1000;
      const r = checkAndConsume("ws1", t);
      expect(r.allowed).toBe(true);
    }
    // 101e à 23h35 → toujours dans la journée glissante
    const r = checkAndConsume("ws1", t0 + 100 * 14 * 60 * 1000);
    expect(r.allowed).toBe(false);
    expect(r.scope).toBe("day");
    expect(r.limit).toBe(100);
  });

  it("ré-autorise dès que le plus ancien hit sort de la fenêtre journalière", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 100; i++) {
      checkAndConsume("ws1", t0 + i * 14 * 60 * 1000);
    }
    // 24h + 1s après le premier hit
    const r = checkAndConsume("ws1", t0 + DAY_MS + 1000);
    expect(r.allowed).toBe(true);
  });
});

describe("rateLimit — interactions horaire ↔ journalier", () => {
  beforeEach(() => _resetAll());

  it("le plafond HORAIRE bloque AVANT le journalier sur un burst", () => {
    const t0 = 1_000_000_000_000;
    // 30 burst immédiats → 31e bloqué par hour (pas par day, on n'a que 30)
    for (let i = 0; i < 30; i++) checkAndConsume("ws1", t0 + i);
    const r = checkAndConsume("ws1", t0 + 30);
    expect(r.allowed).toBe(false);
    expect(r.scope).toBe("hour");
  });

  it("retryAfterSec horaire est court (< 1h), journalier long (< 24h)", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 30; i++) checkAndConsume("ws1", t0 + i * 1000);
    const r1 = checkAndConsume("ws1", t0 + 30 * 1000);
    expect(r1.retryAfterSec).toBeLessThanOrEqual(3600);

    // Pour le journalier : on doit construire un scénario qui sature le jour
    // sans saturer l'heure. 100 hits étalés.
    _resetAll();
    for (let i = 0; i < 100; i++) {
      checkAndConsume("ws1", t0 + i * 14 * 60 * 1000);
    }
    const r2 = checkAndConsume("ws1", t0 + 100 * 14 * 60 * 1000);
    expect(r2.scope).toBe("day");
    expect(r2.retryAfterSec).toBeLessThanOrEqual(86400);
    expect(r2.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("rateLimit — isolation entre workspaces", () => {
  beforeEach(() => _resetAll());

  it("un workspace saturé n'affecte pas un autre", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 30; i++) checkAndConsume("ws1", t0 + i);
    expect(checkAndConsume("ws1", t0 + 30).allowed).toBe(false);
    expect(checkAndConsume("ws2", t0 + 30).allowed).toBe(true);
  });
});

describe("rateLimit — exposition des constantes", () => {
  it("RATE_LIMITS expose les valeurs", () => {
    expect(RATE_LIMITS.perHour).toBe(30);
    expect(RATE_LIMITS.perDay).toBe(100);
  });
});

describe("rateLimit — snapshot helper", () => {
  beforeEach(() => _resetAll());

  it("retourne { count: 0 } pour un workspace inconnu", () => {
    expect(_snapshot("inconnu")).toEqual({ count: 0 });
  });

  it("compte les hits consommés", () => {
    const t0 = 1_000_000_000_000;
    checkAndConsume("ws1", t0);
    checkAndConsume("ws1", t0 + 1);
    expect(_snapshot("ws1")).toEqual({ count: 2 });
  });
});
