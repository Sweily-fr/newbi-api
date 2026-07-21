import logger from "../utils/logger.js";
import cron from "node-cron";
import InvoiceReminderSettings from "../models/InvoiceReminderSettings.js";
import {
  startReminderWorker,
  stopReminderWorker,
  scheduleWorkspaceReminders,
  getQueueStats,
} from "../queues/reminderQueue.js";

let workerStarted = false;

/**
 * Cron job pour planifier les relances automatiques via la queue
 * S'exécute toutes les heures pour vérifier les workspaces à traiter
 */
function startInvoiceReminderCron() {
  // Démarrer le worker de traitement
  if (!workerStarted) {
    startReminderWorker();
    workerStarted = true;
  }

  // Cron expression: '0 * * * *' = toutes les heures à la minute 0
  const cronExpression = "0 * * * *";

  const task = cron.schedule(
    cronExpression,
    async () => {
      const currentHour = new Date().getHours();
      logger.debug(
        `⏰ [Cron] Vérification des relances pour l'heure ${currentHour}h`,
      );

      try {
        await scheduleRemindersForHour(currentHour);

        // Afficher les stats de la queue
        const stats = await getQueueStats();
        if (stats.waiting > 0 || stats.delayed > 0) {
          logger.debug(
            `📊 [Cron] Queue stats: ${stats.waiting} en attente, ${stats.delayed} différés`,
          );
        }
      } catch (error) {
        console.error("❌ [Cron] Erreur lors de la planification:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Europe/Paris",
    },
  );

  logger.debug(
    `🕐 [Cron] Job de relance automatique configuré (toutes les heures)`,
  );
  logger.debug("🚀 [Cron] Worker de traitement des relances actif");

  return task;
}

/**
 * Planifie les relances pour les workspaces configurés à cette heure
 */
async function scheduleRemindersForHour(hour) {
  // Trouver les workspaces dont l'heure de relance correspond
  const activeSettings = await InvoiceReminderSettings.find({
    enabled: true,
    reminderHour: hour,
  });

  if (activeSettings.length === 0) {
    return 0;
  }

  logger.debug(
    `📊 [Cron] ${activeSettings.length} workspace(s) configuré(s) pour ${hour}h`,
  );

  let totalScheduled = 0;

  for (const settings of activeSettings) {
    try {
      const count = await scheduleWorkspaceReminders(
        settings.workspaceId,
        settings,
      );
      totalScheduled += count;
      if (count > 0) {
        logger.debug(
          `✅ [Cron] Workspace ${settings.workspaceId}: ${count} relance(s) planifiée(s)`,
        );
      }
    } catch (error) {
      console.error(
        `❌ [Cron] Erreur workspace ${settings.workspaceId}:`,
        error.message,
      );
    }
  }

  if (totalScheduled > 0) {
    logger.debug(
      `📧 [Cron] Total: ${totalScheduled} relance(s) ajoutée(s) à la queue`,
    );
  }

  return totalScheduled;
}

/**
 * Planifie les relances pour tous les workspaces actifs (toutes heures confondues)
 */
async function scheduleAllReminders() {
  const activeSettings = await InvoiceReminderSettings.find({ enabled: true });

  logger.debug(
    `📊 [Cron] ${activeSettings.length} workspace(s) avec relances activées`,
  );

  let totalScheduled = 0;

  for (const settings of activeSettings) {
    try {
      const count = await scheduleWorkspaceReminders(
        settings.workspaceId,
        settings,
      );
      totalScheduled += count;
      logger.debug(
        `✅ [Cron] Workspace ${settings.workspaceId}: ${count} relance(s) planifiée(s)`,
      );
    } catch (error) {
      console.error(
        `❌ [Cron] Erreur workspace ${settings.workspaceId}:`,
        error.message,
      );
    }
  }

  logger.debug(
    `📧 [Cron] Total: ${totalScheduled} relance(s) ajoutée(s) à la queue`,
  );

  return totalScheduled;
}

/**
 * Fonction pour exécuter manuellement le processus de relance
 * Utile pour les tests
 */
async function runManualReminder() {
  logger.debug(
    "🔧 [Manual] Exécution manuelle de la planification des relances",
  );

  // S'assurer que le worker est démarré
  if (!workerStarted) {
    startReminderWorker();
    workerStarted = true;
  }

  try {
    const count = await scheduleAllReminders();
    const stats = await getQueueStats();

    logger.debug("✅ [Manual] Planification terminée");
    logger.debug(`📊 [Manual] ${count} relance(s) planifiée(s)`);
    logger.debug(
      `📊 [Manual] Queue: ${stats.waiting} en attente, ${stats.active} en cours`,
    );

    return { scheduled: count, stats };
  } catch (error) {
    console.error("❌ [Manual] Erreur:", error);
    throw error;
  }
}

/**
 * Arrête proprement le système de queue
 */
async function stopInvoiceReminderCron() {
  await stopReminderWorker();
  workerStarted = false;
}

export {
  startInvoiceReminderCron,
  stopInvoiceReminderCron,
  runManualReminder,
  scheduleAllReminders,
};
