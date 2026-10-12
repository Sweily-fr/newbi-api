import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "http";
import cron from "node-cron";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createGracefulShutdown } from "../../src/utils/gracefulShutdown.js";

// Serveur de test : /slow attend qu'on le libère, /fast répond tout de suite
function startServer(middleware) {
  let releaseSlow;
  let slowEntered;
  const slowStarted = new Promise((resolve) => (slowEntered = resolve));
  const app = express();
  app.use(middleware);
  app.get("/slow", (req, res) => {
    slowEntered();
    releaseSlow = () => res.send("fini");
  });
  app.get("/fast", (req, res) => res.send("ok"));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        slowStarted,
        release: () => releaseSlow(),
      }),
    );
  });
}

function get(port, path, agent) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ res, body }));
      })
      .on("error", reject);
  });
}

describe("createGracefulShutdown", () => {
  let ctx;
  let agent;

  beforeEach(() => {
    agent = new http.Agent({ keepAlive: true });
  });

  afterEach(() => {
    agent.destroy();
    if (ctx?.server.listening) ctx.server.close();
  });

  it("termine la requête en cours, refuse les nouvelles connexions puis quitte", async () => {
    const exit = vi.fn();
    const steps = [];
    const graceful = createGracefulShutdown({ exit });
    ctx = await startServer(graceful.middleware);

    const slow = get(ctx.port, "/slow", agent);
    await ctx.slowStarted;

    const done = graceful.shutdown("SIGINT", {
      httpServer: ctx.server,
      closeRealtime: async () => steps.push("websockets"),
      cleanup: async () => steps.push("nettoyage"),
    });

    await expect(get(ctx.port, "/fast")).rejects.toThrow(/ECONNREFUSED/);
    expect(exit).not.toHaveBeenCalled();

    ctx.release();
    const { res, body } = await slow;
    expect(body).toBe("fini");
    // La connexion keep-alive se ferme : Caddy en rouvre une ailleurs
    expect(res.headers.connection).toBe("close");

    await done;
    expect(steps).toEqual(["websockets", "nettoyage"]);
    expect(exit).toHaveBeenCalledWith(0);
    expect(graceful.isShuttingDown()).toBe(true);
  });

  it("ferme sans attendre une connexion keep-alive au repos", async () => {
    const exit = vi.fn();
    const graceful = createGracefulShutdown({ exit, drainTimeoutMs: 5000 });
    ctx = await startServer(graceful.middleware);

    await get(ctx.port, "/fast", agent);
    const startedAt = Date.now();
    await graceful.shutdown("SIGINT", { httpServer: ctx.server });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("force la fermeture au-delà du délai d'attente", async () => {
    const exit = vi.fn();
    const graceful = createGracefulShutdown({ exit, drainTimeoutMs: 200 });
    ctx = await startServer(graceful.middleware);

    const slow = get(ctx.port, "/slow", agent).catch((error) => error);
    await ctx.slowStarted;
    await graceful.shutdown("SIGINT", { httpServer: ctx.server });

    expect(exit).toHaveBeenCalledWith(0);
    expect((await slow).code).toBe("ECONNRESET");
  });

  it("arrête les tâches planifiées et ignore un second signal", async () => {
    const exit = vi.fn();
    const graceful = createGracefulShutdown({ exit });
    ctx = await startServer(graceful.middleware);
    const task = cron.schedule("0 3 * * *", () => {});
    const stop = vi.spyOn(task, "stop");

    await Promise.all([
      graceful.shutdown("SIGINT", { httpServer: ctx.server }),
      graceful.shutdown("SIGTERM", { httpServer: ctx.server }),
    ]);

    expect(stop).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("va jusqu'au bout même si une étape échoue", async () => {
    const exit = vi.fn();
    const cleanup = vi.fn();
    const graceful = createGracefulShutdown({ exit });
    ctx = await startServer(graceful.middleware);

    await graceful.shutdown("SIGINT", {
      httpServer: ctx.server,
      closeRealtime: async () => {
        throw new Error("collab");
      },
      cleanup,
    });

    expect(cleanup).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
