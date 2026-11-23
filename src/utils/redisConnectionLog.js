import logger from "./logger.js";

// Pendant une coupure de Redis, chaque client émet une erreur à chaque
// tentative de reconnexion, plusieurs fois par seconde : le 23/11/2026,
// environ 87 000 lignes par heure dans les journaux de la prod pour une seule
// panne. On ne garde que l'essentiel : la première erreur d'une coupure, un
// rappel toutes les 5 minutes tant qu'elle dure, puis le retour de Redis.

const REMINDER_INTERVAL_MS = 5 * 60 * 1000;

// Les files BullMQ ne signalent pas toujours leur reconnexion : une erreur qui
// survient après 2 minutes sans erreur ouvre une nouvelle coupure.
const QUIET_RESET_MS = 2 * 60 * 1000;

export const formatOutageDuration = (ms) => {
  if (ms < 60 * 1000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

/**
 * Journal limité des erreurs de connexion d'un client Redis.
 * `onError` est à brancher sur l'événement « error » du client, `onReady` sur
 * l'événement « ready » (s'il existe).
 */
export const createRedisErrorReporter = (
  label,
  {
    now = Date.now,
    reminderIntervalMs = REMINDER_INTERVAL_MS,
    quietResetMs = QUIET_RESET_MS,
  } = {},
) => {
  let downSince = null;
  let lastErrorAt = 0;
  let lastLogAt = 0;
  let hidden = 0;

  const onError = (error) => {
    const at = now();
    const message = error?.message || String(error);

    if (downSince === null || at - lastErrorAt > quietResetMs) {
      downSince = at;
      lastLogAt = at;
      hidden = 0;
      logger.warn(
        `⚠️ [Redis] ${label} : connexion perdue (${message}), nouvelles tentatives en cours`,
      );
    } else if (at - lastLogAt >= reminderIntervalMs) {
      logger.warn(
        `⚠️ [Redis] ${label} : toujours injoignable depuis ${formatOutageDuration(at - downSince)} (${hidden} autre(s) erreur(s) masquée(s)) : ${message}`,
      );
      lastLogAt = at;
      hidden = 0;
    } else {
      hidden += 1;
    }

    lastErrorAt = at;
  };

  const onReady = () => {
    if (downSince === null) return;
    logger.info(
      `✅ [Redis] ${label} : connexion rétablie après ${formatOutageDuration(now() - downSince)}`,
    );
    downSince = null;
    hidden = 0;
  };

  return { onError, onReady, isDown: () => downSince !== null };
};

/**
 * Branche le journal limité sur un client ioredis. L'écouteur « error »
 * évite aussi les « [ioredis] Unhandled error event » qu'imprime un client
 * sans écouteur.
 */
export const watchRedisClient = (client, label, options) => {
  const reporter = createRedisErrorReporter(label, options);
  client.on("error", reporter.onError);
  client.on("ready", reporter.onReady);
  return client;
};
