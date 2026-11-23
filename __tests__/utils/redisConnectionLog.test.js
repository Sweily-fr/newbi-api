import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import logger from "../../src/utils/logger.js";
import {
  createRedisErrorReporter,
  formatOutageDuration,
  watchRedisClient,
} from "../../src/utils/redisConnectionLog.js";

const MINUTE = 60 * 1000;
const refused = new Error("connect ECONNREFUSED 127.0.0.1:6379");

describe("journal limité des erreurs Redis", () => {
  let clock;
  let reporter;

  beforeEach(() => {
    vi.clearAllMocks();
    clock = 0;
    reporter = createRedisErrorReporter("Cache", { now: () => clock });
  });

  it("n'écrit qu'une ligne pour une rafale d'erreurs de reconnexion", () => {
    for (let i = 0; i < 500; i += 1) {
      reporter.onError(refused);
      clock += 500;
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(
      "[Redis] Cache : connexion perdue (connect ECONNREFUSED",
    );
    expect(reporter.isDown()).toBe(true);
  });

  it("rappelle la coupure toutes les 5 minutes avec le nombre d'erreurs masquées", () => {
    reporter.onError(refused);
    for (let i = 0; i < 10; i += 1) {
      clock += 30 * 1000;
      reporter.onError(refused);
    }
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1][0]).toContain(
      "toujours injoignable depuis 5 min (9 autre(s) erreur(s) masquée(s))",
    );
  });

  it("annonce le retour de Redis avec la durée de la coupure, une seule fois", () => {
    reporter.onError(refused);
    clock += 7 * 60 * MINUTE + 53 * MINUTE;
    reporter.onReady();
    reporter.onReady();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toBe(
      "✅ [Redis] Cache : connexion rétablie après 7 h 53 min",
    );
    expect(reporter.isDown()).toBe(false);
  });

  it("ne dit rien au premier « ready » d'une connexion qui n'a jamais échoué", () => {
    reporter.onReady();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("ouvre une nouvelle coupure après 2 minutes sans erreur (files sans événement de reconnexion)", () => {
    reporter.onError(refused);
    clock += 3 * MINUTE;
    reporter.onError(refused);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1][0]).toContain("connexion perdue");
  });

  it("branche les écouteurs sur un client ioredis (plus d'« Unhandled error event »)", () => {
    const client = new EventEmitter();
    watchRedisClient(client, "PubSub (abonnements)");
    // Sans écouteur « error », un EventEmitter lève l'erreur émise
    expect(() => client.emit("error", refused)).not.toThrow();
    client.emit("ready");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("formate les durées de coupure", () => {
    expect(formatOutageDuration(400)).toBe("1 s");
    expect(formatOutageDuration(42 * 1000)).toBe("42 s");
    expect(formatOutageDuration(5 * MINUTE)).toBe("5 min");
    expect(formatOutageDuration(120 * MINUTE)).toBe("2 h");
    expect(formatOutageDuration(473 * MINUTE)).toBe("7 h 53 min");
  });
});
