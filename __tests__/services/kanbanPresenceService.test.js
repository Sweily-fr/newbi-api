import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Sans Redis (getCacheClient → null) le service utilise sa Map mémoire :
// c'est ce chemin qu'on teste, la logique métier est identique côté Redis.
vi.mock("../../src/config/redis.js", () => ({
  getCacheClient: () => null,
}));

import {
  listTaskPresence,
  setTaskPresence,
  STALE_MS,
} from "../../src/services/kanbanPresenceService.js";

const alice = { id: "u-alice", name: "Alice Martin", image: null };
const bob = { id: "u-bob", name: "Bob", image: "https://img/bob.png" };

describe("kanbanPresenceService", () => {
  let boardId;
  const workspaceId = "ws-1";

  beforeEach(() => {
    // Board unique par test : la Map mémoire est partagée entre les tests
    boardId = `board-${Math.random().toString(36).slice(2)}`;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enregistre une présence et la signale comme changement", async () => {
    const res = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      taskId: "t1",
    });
    expect(res.changed).toBe(true);
    expect(res.viewers).toEqual([
      {
        userId: "u-alice",
        taskId: "t1",
        name: "Alice Martin",
        image: null,
        since: "2026-09-17T10:00:00.000Z",
      },
    ]);
  });

  it("un battement de cœur sur la même tâche ne change rien et garde since", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    vi.advanceTimersByTime(30_000);
    const res = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      taskId: "t1",
    });
    expect(res.changed).toBe(false);
    expect(res.viewers[0].since).toBe("2026-09-17T10:00:00.000Z");
  });

  it("changer de tâche est un changement, et un seul utilisateur = une seule entrée", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    const res = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      taskId: "t2",
    });
    expect(res.changed).toBe(true);
    expect(res.viewers).toHaveLength(1);
    expect(res.viewers[0].taskId).toBe("t2");
  });

  it("taskId null retire la présence ; la retirer deux fois n'est pas un changement", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    await setTaskPresence({ workspaceId, boardId, user: bob, taskId: "t1" });
    const first = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      taskId: null,
    });
    expect(first.changed).toBe(true);
    expect(first.viewers.map((v) => v.userId)).toEqual(["u-bob"]);
    const second = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      taskId: null,
    });
    expect(second.changed).toBe(false);
  });

  it("purge les présences sans battement de cœur depuis STALE_MS", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    vi.advanceTimersByTime(STALE_MS - 1000);
    expect(await listTaskPresence({ workspaceId, boardId })).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(await listTaskPresence({ workspaceId, boardId })).toHaveLength(0);
  });

  it("une entrée périmée purgée au passage compte comme un changement", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    await setTaskPresence({ workspaceId, boardId, user: bob, taskId: "t2" });
    vi.advanceTimersByTime(STALE_MS + 1000);
    // Bob revient : Alice est périmée → l'état diffusé ne contient que Bob
    const res = await setTaskPresence({
      workspaceId,
      boardId,
      user: bob,
      taskId: "t2",
    });
    expect(res.changed).toBe(true);
    expect(res.viewers.map((v) => v.userId)).toEqual(["u-bob"]);
  });
});
