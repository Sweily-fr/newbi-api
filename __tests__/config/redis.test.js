import { describe, it, expect, vi, beforeEach } from "vitest";

// Faux Redis partagé par tous les clients ioredis du test : le test démarre,
// coupe et relance « le serveur » comme une vraie panne
const fake = vi.hoisted(() => ({
  up: false,
  clients: new Set(),
  store: new Map(),
  FakeRedis: null,
}));

vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeRedis extends EventEmitter {
    constructor(...args) {
      super();
      this.options =
        typeof args[0] === "string"
          ? { url: args[0], ...(args[1] || {}) }
          : { ...(args[0] || {}) };
      this.status = fake.up ? "ready" : "connecting";
      this.channels = new Set();
      this.waiting = [];
      fake.clients.add(this);
    }

    ensureReady() {
      if (this.status !== "ready") {
        throw new Error(
          "Stream isn't writeable and enableOfflineQueue options is false",
        );
      }
    }

    // Abonnement : mis en attente pendant une coupure, comme ioredis avec
    // maxRetriesPerRequest: null
    subscribe(channel, callback) {
      const run = () => {
        this.channels.add(channel);
        callback?.(null, this.channels.size);
      };
      if (this.status === "ready") run();
      else this.waiting.push(run);
      return Promise.resolve();
    }

    unsubscribe(channel) {
      this.channels.delete(channel);
      return Promise.resolve();
    }

    punsubscribe() {
      return Promise.resolve();
    }

    async publish(channel, message) {
      this.ensureReady();
      let receivers = 0;
      for (const client of fake.clients) {
        if (client.status === "ready" && client.channels.has(channel)) {
          client.emit("message", channel, message);
          receivers += 1;
        }
      }
      return receivers;
    }

    async get(key) {
      this.ensureReady();
      return fake.store.get(key) ?? null;
    }

    async set(key, value) {
      this.ensureReady();
      fake.store.set(key, value);
      return "OK";
    }

    async del(...keys) {
      this.ensureReady();
      keys.forEach((key) => fake.store.delete(key));
      return keys.length;
    }

    async quit() {
      this.status = "end";
      return "OK";
    }

    disconnect() {
      this.status = "end";
    }
  }

  fake.FakeRedis = FakeRedis;
  return { default: FakeRedis };
});

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Redis répond de nouveau : chaque client se reconnecte et reprend ses
// abonnements en attente
const bringRedisUp = () => {
  fake.up = true;
  for (const client of fake.clients) {
    if (client.status === "end") continue;
    client.status = "ready";
    client.waiting.splice(0).forEach((run) => run());
    client.emit("ready");
  }
};

// Redis tombe : chaque client émet une erreur à chaque tentative
const takeRedisDown = ({ attempts = 1 } = {}) => {
  fake.up = false;
  for (const client of fake.clients) {
    if (client.status === "end") continue;
    client.status = "reconnecting";
    for (let i = 0; i < attempts; i += 1) {
      client.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    }
  }
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const nothingWithin = (promise, ms = 30) =>
  Promise.race([
    promise.then(() => "reçu"),
    new Promise((resolve) => setTimeout(() => resolve("rien"), ms)),
  ]);

const loadModule = async () => {
  vi.resetModules();
  const redis = await import("../../src/config/redis.js");
  const { default: logger } = await import("../../src/utils/logger.js");
  return { ...redis, logger };
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.up = false;
  fake.clients.clear();
  fake.store.clear();
});

describe("Redis absent au démarrage de l'API", () => {
  it("démarre en mode dégradé sans lever, puis se reconnecte seule à son retour", async () => {
    const {
      initializeRedis,
      getPubSub,
      getCacheClient,
      cacheGet,
      cacheSet,
      logger,
    } = await loadModule();

    await initializeRedis({ startupWaitMs: 20 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Injoignable au démarrage"),
    );

    // Cache coupé : réponse immédiate, sans attente de reconnexion
    expect(getCacheClient()).toBeNull();
    expect(await cacheGet("clé")).toBeNull();

    // Temps réel : livré sur cette instance pendant la coupure
    const pubsub = getPubSub();
    const iterator = pubsub.asyncIterableIterator("TASK_UPDATED");
    const first = iterator.next();
    await flush();
    await pubsub.publish("TASK_UPDATED", { id: 1 });
    expect((await first).value).toEqual({ id: 1 });

    // Retour de Redis, sans redémarrage de l'API
    bringRedisUp();
    await flush();
    expect(getCacheClient()).not.toBeNull();
    await cacheSet("clé", { valeur: 1 });
    expect(await cacheGet("clé")).toEqual({ valeur: 1 });

    // L'abonnement pris pendant la coupure reçoit les messages des autres
    // instances…
    const otherInstance = new fake.FakeRedis();
    const second = iterator.next();
    await otherInstance.publish("TASK_UPDATED", JSON.stringify({ id: 2 }));
    expect((await second).value).toEqual({ id: 2 });

    // … et nos publications repartent par Redis, sans doublon local
    const seenElsewhere = [];
    otherInstance.on("message", (_channel, message) =>
      seenElsewhere.push(JSON.parse(message)),
    );
    await otherInstance.subscribe("TASK_UPDATED");
    const third = iterator.next();
    await pubsub.publish("TASK_UPDATED", { id: 3 });
    expect(seenElsewhere).toEqual([{ id: 3 }]);
    expect((await third).value).toEqual({ id: 3 });
    expect(await nothingWithin(iterator.next())).toBe("rien");

    await iterator.return();
  });
});

describe("coupure de Redis pendant que l'API tourne", () => {
  it("bascule sur la mémoire sans attendre, n'écrit qu'une ligne par client, et revient seule", async () => {
    fake.up = true;
    const { initializeRedis, getPubSub, getCacheClient, cacheGet, logger } =
      await loadModule();

    await initializeRedis({ startupWaitMs: 20 });
    expect(logger.info).toHaveBeenCalledWith(
      "🚀 [Redis] PubSub + Cache initialisés avec succès",
    );

    const pubsub = getPubSub();
    const iterator = pubsub.asyncIterableIterator("NOTIFICATION");
    const first = iterator.next();
    await flush();

    // Des centaines de tentatives de reconnexion…
    takeRedisDown({ attempts: 200 });
    // … une seule ligne par client (publication, abonnements, cache)
    expect(logger.warn).toHaveBeenCalledTimes(3);

    expect(getCacheClient()).toBeNull();
    const startedAt = Date.now();
    expect(await cacheGet("clé")).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(50);

    await pubsub.publish("NOTIFICATION", { id: "pendant la coupure" });
    expect((await first).value).toEqual({ id: "pendant la coupure" });

    bringRedisUp();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Cache : connexion rétablie après"),
    );

    const second = iterator.next();
    const otherInstance = new fake.FakeRedis();
    await otherInstance.publish(
      "NOTIFICATION",
      JSON.stringify({ id: "après" }),
    );
    expect((await second).value).toEqual({ id: "après" });

    await iterator.return();
  });

  it("garde les réglages de connexion et ajoute la reconnexion sans fin", async () => {
    const { createRedisClient } = await loadModule();
    const client = createRedisClient("Kanban collaboratif", {
      maxRetriesPerRequest: null,
    });
    expect(client.options).toMatchObject({ maxRetriesPerRequest: null });
    expect(client.options.retryStrategy(1)).toBe(100);
    expect(client.options.retryStrategy(500)).toBe(2000);
    // Écouteur « error » branché : plus d'« Unhandled error event »
    expect(client.listenerCount("error")).toBe(1);
  });
});

// PubSub seul, avec un faux bus Redis partagé entre deux instances
describe("ResilientPubSub", () => {
  const makeBus = () => ({ handlers: new Map() });

  const makeInstance = (ResilientPubSub, bus, { subscribeGate } = {}) => {
    const publisher = { status: "ready" };
    const subscriber = { status: "ready" };
    let nextRedisId = 0;
    const redisSubs = new Map();
    const redisPubSub = {
      publish: vi.fn(async (trigger, payload) => {
        for (const { onMessage, owner } of bus.handlers.get(trigger) || []) {
          if (owner.status === "ready")
            onMessage(JSON.parse(JSON.stringify(payload)));
        }
      }),
      subscribe: vi.fn(async (trigger, onMessage) => {
        if (subscribeGate) await subscribeGate;
        const id = nextRedisId++;
        const handler = { onMessage, owner: subscriber };
        if (!bus.handlers.has(trigger)) bus.handlers.set(trigger, new Set());
        bus.handlers.get(trigger).add(handler);
        redisSubs.set(id, { trigger, handler });
        return id;
      }),
      unsubscribe: vi.fn((id) => {
        const sub = redisSubs.get(id);
        bus.handlers.get(sub.trigger).delete(sub.handler);
        redisSubs.delete(id);
      }),
    };
    const pubsub = new ResilientPubSub({ publisher, subscriber, redisPubSub });
    return { pubsub, publisher, subscriber, redisPubSub };
  };

  const collect = async (pubsub, trigger) => {
    const received = [];
    const id = await pubsub.subscribe(trigger, (payload) =>
      received.push(payload),
    );
    await flush();
    return { received, id };
  };

  it("livre un message d'une instance à l'autre, une seule fois", async () => {
    const { ResilientPubSub } = await loadModule();
    const bus = makeBus();
    const a = makeInstance(ResilientPubSub, bus);
    const b = makeInstance(ResilientPubSub, bus);
    const onA = await collect(a.pubsub, "T");
    const onB = await collect(b.pubsub, "T");

    await b.pubsub.publish("T", { n: 1 });
    expect(onA.received).toEqual([{ n: 1 }]);
    expect(onB.received).toEqual([{ n: 1 }]);
  });

  it("pendant une coupure, ne livre que sur l'instance qui publie", async () => {
    const { ResilientPubSub } = await loadModule();
    const bus = makeBus();
    const a = makeInstance(ResilientPubSub, bus);
    const b = makeInstance(ResilientPubSub, bus);
    const onA = await collect(a.pubsub, "T");
    const onB = await collect(b.pubsub, "T");

    b.publisher.status = "reconnecting";
    await b.pubsub.publish("T", { n: 2 });
    expect(b.redisPubSub.publish).not.toHaveBeenCalled();
    expect(onB.received).toEqual([{ n: 2 }]);
    expect(onA.received).toEqual([]);
  });

  it("se replie sur la mémoire si l'envoi à Redis échoue", async () => {
    const { ResilientPubSub } = await loadModule();
    const a = makeInstance(ResilientPubSub, makeBus());
    const onA = await collect(a.pubsub, "T");
    a.redisPubSub.publish.mockRejectedValueOnce(
      new Error("Connection is closed."),
    );

    await a.pubsub.publish("T", { n: 3 });
    expect(onA.received).toEqual([{ n: 3 }]);
  });

  it("livre aussi en local tant que les abonnements de l'instance ne sont pas repris", async () => {
    const { ResilientPubSub } = await loadModule();
    const bus = makeBus();
    const a = makeInstance(ResilientPubSub, bus);
    const b = makeInstance(ResilientPubSub, bus);
    const onA = await collect(a.pubsub, "T");
    const onB = await collect(b.pubsub, "T");

    a.subscriber.status = "reconnecting";
    await a.pubsub.publish("T", { n: 4 });
    expect(onB.received).toEqual([{ n: 4 }]);
    expect(onA.received).toEqual([{ n: 4 }]);
  });

  it("n'attend pas Redis pour s'abonner, et l'abonnement Redis prend effet à son retour", async () => {
    const { ResilientPubSub } = await loadModule();
    const bus = makeBus();
    let openRedis;
    const subscribeGate = new Promise((resolve) => {
      openRedis = resolve;
    });
    const a = makeInstance(ResilientPubSub, bus, { subscribeGate });
    const b = makeInstance(ResilientPubSub, bus);

    const onA = await collect(a.pubsub, "T");
    await b.pubsub.publish("T", { n: 5 });
    expect(onA.received).toEqual([]);

    openRedis();
    await flush();
    await b.pubsub.publish("T", { n: 6 });
    expect(onA.received).toEqual([{ n: 6 }]);
  });

  it("retire l'abonnement Redis arrivé après le désabonnement", async () => {
    const { ResilientPubSub } = await loadModule();
    const bus = makeBus();
    let openRedis;
    const subscribeGate = new Promise((resolve) => {
      openRedis = resolve;
    });
    const a = makeInstance(ResilientPubSub, bus, { subscribeGate });
    const b = makeInstance(ResilientPubSub, bus);

    const onA = await collect(a.pubsub, "T");
    a.pubsub.unsubscribe(onA.id);
    openRedis();
    await flush();

    expect(a.redisPubSub.unsubscribe).toHaveBeenCalledTimes(1);
    await b.pubsub.publish("T", { n: 7 });
    await a.pubsub.publish("T", { n: 8 });
    expect(onA.received).toEqual([]);
  });

  it("se désabonne de la mémoire et de Redis", async () => {
    const { ResilientPubSub } = await loadModule();
    const bus = makeBus();
    const a = makeInstance(ResilientPubSub, bus);
    const onA = await collect(a.pubsub, "T");

    a.pubsub.unsubscribe(onA.id);
    a.pubsub.unsubscribe(onA.id);
    await a.pubsub.publish("T", { n: 9 });
    a.publisher.status = "reconnecting";
    await a.pubsub.publish("T", { n: 10 });
    expect(onA.received).toEqual([]);
    expect(a.redisPubSub.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
