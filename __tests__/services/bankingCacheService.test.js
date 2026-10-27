import { describe, it, expect, vi, beforeEach } from "vitest";

// Client Redis factice : tant que Redis est « arrêté », `connect()` ne se
// résout jamais, comme le vrai client avec un reconnectStrategy sans limite.
const redisState = { up: false };
const store = new Map();

vi.mock("redis", () => ({
  createClient: () => {
    const handlers = {};
    const client = {
      isReady: false,
      on: (event, fn) => {
        handlers[event] = fn;
        return client;
      },
      emit: (event, arg) => handlers[event]?.(arg),
      connect: () =>
        redisState.up
          ? Promise.resolve().then(() => {
              client.isReady = true;
              handlers.ready?.();
            })
          : new Promise(() => {}),
      get: async (key) => store.get(key) ?? null,
      setEx: async (key, _ttl, value) => {
        store.set(key, value);
      },
      del: async (key) => {
        store.delete(key);
      },
      ping: async () => "PONG",
    };
    return client;
  },
}));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Nouvelle instance du singleton à chaque test (le client est créé à l'import)
const loadService = async () => {
  vi.resetModules();
  const mod = await import("../../src/services/banking/BankingCacheService.js");
  return mod.bankingCacheService;
};

describe("BankingCacheService", () => {
  beforeEach(() => {
    store.clear();
  });

  it("Redis arrêté au démarrage : répond tout de suite, sans cache", async () => {
    redisState.up = false;
    const cache = await loadService();

    // Avant le correctif, ces appels attendaient la connexion pour toujours
    // (routes bancaires sans réponse, incident du 27/10/2026)
    expect(await cache.getAccounts("ws-1")).toEqual({
      data: null,
      fromCache: false,
    });
    await cache.setAccounts("ws-1", [{ id: "a" }]);
    expect(await cache.invalidateAll("ws-1")).toBe(true);
    expect(await cache.isAvailable()).toBe(false);
    expect(store.size).toBe(0);
  });

  it("Redis disponible : sert les données mises en cache", async () => {
    redisState.up = true;
    const cache = await loadService();
    await cache._initPromise;

    await cache.setAccounts("ws-1", [{ id: "a" }]);
    expect(await cache.getAccounts("ws-1")).toEqual({
      data: [{ id: "a" }],
      fromCache: true,
    });
    expect(await cache.isAvailable()).toBe(true);
  });

  it("Redis qui tombe en cours de route : repli sans cache", async () => {
    redisState.up = true;
    const cache = await loadService();
    await cache._initPromise;
    await cache.setAccounts("ws-1", [{ id: "a" }]);

    cache.client.isReady = false;
    cache.client.emit("error", new Error("Socket closed unexpectedly"));

    expect(await cache.getAccounts("ws-1")).toEqual({
      data: null,
      fromCache: false,
    });
  });
});
