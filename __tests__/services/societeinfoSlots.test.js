import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config/redis.js", () => ({ getCacheClient: () => null }));

import {
  acquireSocieteinfoSlot,
  MAX_CONCURRENT_CALLS,
  SLOTS_KEY,
  SlotTimeoutError,
} from "../../src/services/prospects/societeinfoSlots.js";

// Redis simulé : même effet que le script Lua (jetons rangés par heure)
function fakeRedis({ failEval = false } = {}) {
  const sets = new Map();
  return {
    sets,
    async eval(_script, _numKeys, key, nowArg, ttlArg, maxArg, token) {
      if (failEval) throw new Error("connexion perdue");
      const now = Number(nowArg);
      const set = sets.get(key) ?? new Map();
      for (const [t, takenAt] of set) {
        if (takenAt <= now - Number(ttlArg)) set.delete(t);
      }
      sets.set(key, set);
      if (set.size < Number(maxArg)) {
        set.set(token, now);
        return 1;
      }
      return 0;
    },
    async zrem(key, token) {
      sets.get(key)?.delete(token);
      return 1;
    },
  };
}

const rapide = { stepMs: 5, maxWaitMs: 500 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("file des appels Societeinfo, avec Redis", () => {
  it("laisse passer 3 appels à la fois, pas un de plus", async () => {
    const client = fakeRedis();
    const releases = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_CALLS }, () =>
        acquireSocieteinfoSlot({ client, ...rapide }),
      ),
    );
    expect(client.sets.get(SLOTS_KEY).size).toBe(3);

    let quatriemePasse = false;
    const quatrieme = acquireSocieteinfoSlot({ client, ...rapide }).then(
      (release) => {
        quatriemePasse = true;
        return release;
      },
    );
    await pause(30);
    expect(quatriemePasse).toBe(false);

    await releases[0]();
    const releaseQuatrieme = await quatrieme;
    expect(quatriemePasse).toBe(true);
    expect(client.sets.get(SLOTS_KEY).size).toBe(3);

    await Promise.all([releases[1](), releases[2](), releaseQuatrieme()]);
    expect(client.sets.get(SLOTS_KEY).size).toBe(0);
  });

  it("abandonne quand aucune place ne se libère à temps", async () => {
    const client = fakeRedis();
    await Promise.all(
      [1, 2, 3].map(() => acquireSocieteinfoSlot({ client, ...rapide })),
    );
    await expect(
      acquireSocieteinfoSlot({ client, stepMs: 5, maxWaitMs: 30 }),
    ).rejects.toBeInstanceOf(SlotTimeoutError);
  });

  it("reprend les places d'appels jamais rendus (instance arrêtée)", async () => {
    const client = fakeRedis();
    let t = 1_000_000;
    const now = () => t;
    await Promise.all(
      [1, 2, 3].map(() =>
        acquireSocieteinfoSlot({ client, now, ttlMs: 30_000, ...rapide }),
      ),
    );
    t += 30_001;
    const release = await acquireSocieteinfoSlot({
      client,
      now,
      ttlMs: 30_000,
      ...rapide,
    });
    expect(client.sets.get(SLOTS_KEY).size).toBe(1);
    await release();
  });

  it("ne libère qu'une place, même si on libère deux fois", async () => {
    const client = fakeRedis();
    const premier = await acquireSocieteinfoSlot({ client, ...rapide });
    const second = await acquireSocieteinfoSlot({ client, ...rapide });
    await premier();
    await premier();
    expect(client.sets.get(SLOTS_KEY).size).toBe(1);
    await second();
  });
});

describe("file des appels Societeinfo, sans Redis", () => {
  it("passe les appels un par un", async () => {
    const premier = await acquireSocieteinfoSlot({ client: null });
    let secondPasse = false;
    const second = acquireSocieteinfoSlot({ client: null }).then((release) => {
      secondPasse = true;
      return release;
    });
    await pause(20);
    expect(secondPasse).toBe(false);

    await premier();
    const releaseSecond = await second;
    expect(secondPasse).toBe(true);
    await releaseSecond();
  });

  it("bascule sur la file locale si Redis répond mal", async () => {
    const release = await acquireSocieteinfoSlot({
      client: fakeRedis({ failEval: true }),
    });
    const suivant = acquireSocieteinfoSlot({ client: null });
    await release();
    await (
      await suivant
    )();
  });
});
