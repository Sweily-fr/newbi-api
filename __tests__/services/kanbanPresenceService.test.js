import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Sans Redis (getCacheClient → null) le service utilise sa Map mémoire :
// c'est ce chemin qu'on teste, la logique métier est identique côté Redis.
vi.mock("../../src/config/redis.js", () => ({
  getCacheClient: () => null,
}));

import {
  listTaskPresence,
  setTaskPresence,
  clearTaskPresenceIfIdle,
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

  it("purge les présences sans battement de cœur depuis STALE_MS et le signale", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    vi.advanceTimersByTime(STALE_MS - 1000);
    let res = await listTaskPresence({ workspaceId, boardId });
    expect(res.viewers).toHaveLength(1);
    expect(res.changed).toBe(false);
    vi.advanceTimersByTime(2000);
    res = await listTaskPresence({ workspaceId, boardId });
    expect(res.viewers).toHaveLength(0);
    // La purge est un changement visible : à diffuser
    expect(res.changed).toBe(true);
    // Relire ensuite ne change plus rien
    expect((await listTaskPresence({ workspaceId, boardId })).changed).toBe(
      false,
    );
  });

  it("le battement de Bob purge Alice périmée et le signale, même si Bob ne change pas", async () => {
    await setTaskPresence({ workspaceId, boardId, user: alice, taskId: "t1" });
    vi.advanceTimersByTime(STALE_MS / 2);
    await setTaskPresence({ workspaceId, boardId, user: bob, taskId: "t2" });
    vi.advanceTimersByTime(STALE_MS / 2 + 1000);
    // Alice est périmée, Bob (battu il y a STALE_MS/2 + 1 s) ne l'est pas
    const res = await setTaskPresence({
      workspaceId,
      boardId,
      user: bob,
      taskId: "t2",
    });
    expect(res.changed).toBe(true);
    expect(res.viewers.map((v) => v.userId)).toEqual(["u-bob"]);
  });

  it("deux onglets du même utilisateur = un seul avatar, fermer l'un ne retire pas l'autre", async () => {
    await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      clientId: "tab-1",
      taskId: "t1",
    });
    const second = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      clientId: "tab-2",
      taskId: "t1",
    });
    // Même couple utilisateur/tâche : rien de nouveau à diffuser
    expect(second.changed).toBe(false);
    expect(second.viewers).toHaveLength(1);

    const closeOne = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      clientId: "tab-1",
      taskId: null,
    });
    expect(closeOne.changed).toBe(false);
    expect(closeOne.viewers.map((v) => v.userId)).toEqual(["u-alice"]);

    const closeTwo = await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      clientId: "tab-2",
      taskId: null,
    });
    expect(closeTwo.changed).toBe(true);
    expect(closeTwo.viewers).toHaveLength(0);
  });

  it("délai de grâce : une reconnexion ré-annoncée n'est pas retirée, une vraie fermeture oui", async () => {
    await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      clientId: "tab-1",
      taskId: "t1",
    });
    const disconnectedAt = Date.now();

    // Reconnexion : l'onglet se ré-annonce après la coupure
    vi.advanceTimersByTime(500);
    await setTaskPresence({
      workspaceId,
      boardId,
      user: alice,
      clientId: "tab-1",
      taskId: "t1",
    });
    vi.advanceTimersByTime(5000);
    expect(
      await clearTaskPresenceIfIdle({
        workspaceId,
        boardId,
        userId: "u-alice",
        clientId: "tab-1",
        disconnectedAt,
      }),
    ).toBeNull();
    expect(
      (await listTaskPresence({ workspaceId, boardId })).viewers,
    ).toHaveLength(1);

    // Vraie fermeture : aucune ré-annonce depuis la coupure
    const closedAt = Date.now();
    vi.advanceTimersByTime(5000);
    const res = await clearTaskPresenceIfIdle({
      workspaceId,
      boardId,
      userId: "u-alice",
      clientId: "tab-1",
      disconnectedAt: closedAt,
    });
    expect(res?.changed).toBe(true);
    expect(res.viewers).toHaveLength(0);
  });
});
