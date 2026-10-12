/**
 * Arrêt d'une instance sans couper les utilisateurs.
 *
 * En production, PM2 remplace les instances une par une (`pm2 reload`) :
 * l'ancienne reçoit SIGINT une fois la nouvelle prête. Elle cesse alors
 * d'accepter des connexions (PM2 envoie les suivantes aux autres instances),
 * ferme les WebSockets (les clients se reconnectent ailleurs), termine les
 * requêtes en cours, puis seulement libère Redis et quitte.
 */

import cron from "node-cron";
import logger from "./logger.js";

const IDLE_SWEEP_MS = 250;

/**
 * @param {object} [options]
 * @param {number} [options.drainTimeoutMs] attente maximale des requêtes en
 *   cours ; doit rester sous le kill_timeout de PM2 (ecosystem.production.cjs)
 * @param {(code: number) => void} [options.exit]
 */
export function createGracefulShutdown({
  drainTimeoutMs = 20000,
  exit = (code) => process.exit(code),
} = {}) {
  let shuttingDown = false;
  const pendingResponses = new Set();

  // Pendant l'arrêt, chaque réponse ferme sa connexion keep-alive : Caddy en
  // rouvre une, que PM2 confie à une instance qui reste. Les réponses déjà en
  // préparation au moment du signal sont suivies pour recevoir le même en-tête.
  const middleware = (req, res, next) => {
    if (shuttingDown) {
      res.setHeader("Connection", "close");
    } else {
      pendingResponses.add(res);
      res.once("close", () => pendingResponses.delete(res));
    }
    next();
  };

  /**
   * @param {string} signal
   * @param {object} resources
   * @param {import("http").Server} resources.httpServer
   * @param {() => Promise<void>} [resources.closeRealtime] WebSockets
   * @param {() => Promise<void>} [resources.cleanup] Redis, files d'attente
   */
  const shutdown = async (signal, { httpServer, closeRealtime, cleanup }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      `🛑 Arrêt de l'instance (${signal}), fin des requêtes en cours...`,
    );

    // Aucune tâche planifiée ne démarre plus ici : pendant un reload, la
    // nouvelle instance 0 a déjà lancé les siennes.
    for (const task of cron.getTasks().values()) task.stop();

    for (const res of pendingResponses) {
      if (!res.headersSent) res.setHeader("Connection", "close");
    }

    const drained = drainHttpServer(httpServer, drainTimeoutMs);
    await runStep("WebSockets", closeRealtime);
    await drained;
    await runStep("nettoyage", cleanup);

    logger.info("✅ Serveur arrêté proprement");
    exit(0);
  };

  return { middleware, shutdown, isShuttingDown: () => shuttingDown };
}

function drainHttpServer(httpServer, timeoutMs) {
  return new Promise((resolve) => {
    const finish = () => {
      clearInterval(idleSweep);
      clearTimeout(deadline);
      resolve();
    };
    // Une connexion keep-alive redevenue libre après sa réponse est fermée au
    // passage suivant, sans attendre son délai d'inactivité.
    const idleSweep = setInterval(
      () => httpServer.closeIdleConnections(),
      IDLE_SWEEP_MS,
    );
    const deadline = setTimeout(() => {
      logger.warn(
        `⚠️ Requêtes encore en cours après ${timeoutMs / 1000} s, fermeture forcée`,
      );
      httpServer.closeAllConnections();
      finish();
    }, timeoutMs);
    httpServer.close(finish);
  });
}

async function runStep(name, step) {
  try {
    await step?.();
  } catch (error) {
    logger.error(`❌ Erreur à l'arrêt (${name}):`, error);
  }
}
