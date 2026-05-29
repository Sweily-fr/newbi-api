import cron from "node-cron";
import logger from "../utils/logger.js";
import Event from "../models/Event.js";
import emailReminderService from "./emailReminderService.js";

// Marge après la fin d'un événement pendant laquelle un rappel encore en
// attente reste envoyable. Évite de perdre un rappel "à l'échéance" (0m) sur
// un événement à durée nulle (end == start) entre deux passages du cron, et
// rend le système résilient à une courte interruption.
const REMINDER_GRACE_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RETRIES = 3;

/**
 * Scheduler pour les rappels par email
 * Vérifie toutes les 5 minutes les événements nécessitant un rappel
 */
class EmailReminderScheduler {
  constructor() {
    this.task = null;
    this.isRunning = false;
  }

  /**
   * Démarre le scheduler
   */
  start() {
    if (this.task) {
      logger.warn("Le scheduler de rappels email est déjà démarré");
      return;
    }

    // Exécuter toutes les 2 minutes pour une meilleure précision
    this.task = cron.schedule("*/2 * * * *", async () => {
      await this.processReminders();
    });

    logger.info("✅ Scheduler de rappels email démarré (toutes les 2 minutes)");
  }

  /**
   * Arrête le scheduler
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info("Scheduler de rappels email arrêté");
    }
  }

  /**
   * Réserve atomiquement un événement pour l'envoi d'un rappel.
   * Utilise findOneAndUpdate pour éviter qu'une autre instance/exécution
   * ne traite le même rappel en parallèle.
   */
  async claimEventForReminder(eventId, reminderField) {
    const statusField =
      reminderField === "echeance"
        ? "emailReminder.echeanceStatus"
        : "emailReminder.status";
    const claimed = await Event.findOneAndUpdate(
      {
        _id: eventId,
        [statusField]: { $in: ["pending", "failed"] },
      },
      {
        $set: { [statusField]: "processing" },
      },
      { new: true },
    ).populate("userId");

    return claimed;
  }

  /**
   * Traite les rappels en attente
   */
  async processReminders() {
    if (this.isRunning) {
      logger.debug("Traitement de rappels déjà en cours, passage ignoré");
      return;
    }

    this.isRunning = true;

    try {
      const now = new Date();
      const graceCutoff = new Date(now.getTime() - REMINDER_GRACE_MS);

      logger.debug(
        `🔍 Recherche de rappels à envoyer (scheduledFor <= ${now.toISOString()})`,
      );

      // Trouver les événements avec rappel activé et au moins un rappel en attente.
      // end >= graceCutoff : on tolère une marge après la fin pour ne pas perdre
      // un rappel dû juste avant la fin (ex. échéance 0m sur durée nulle).
      const events = await Event.find({
        "emailReminder.enabled": true,
        end: { $gte: graceCutoff },
        $or: [
          {
            "emailReminder.status": { $in: ["pending", "failed"] },
            "emailReminder.scheduledFor": { $lte: now },
          },
          {
            "emailReminder.echeanceStatus": { $in: ["pending", "failed"] },
            "emailReminder.echeanceScheduledFor": { $lte: now },
          },
        ],
      });

      // Annuler les rappels d'événements terminés depuis plus que la marge
      await Event.updateMany(
        {
          "emailReminder.enabled": true,
          $or: [
            { "emailReminder.status": { $in: ["pending", "failed"] } },
            { "emailReminder.echeanceStatus": { $in: ["pending", "failed"] } },
          ],
          end: { $lt: graceCutoff },
        },
        {
          $set: {
            "emailReminder.status": "cancelled",
            "emailReminder.echeanceStatus": "cancelled",
            "emailReminder.failureReason": "Événement déjà terminé",
          },
        },
      );

      logger.info(`📧 ${events.length} rappel(s) à traiter`);

      // Traiter chaque événement
      for (const event of events) {
        try {
          // Rappel anticipé
          if (
            event.emailReminder.status === "pending" &&
            event.emailReminder.scheduledFor &&
            event.emailReminder.scheduledFor <= now
          ) {
            // Réserver atomiquement l'événement pour éviter les doublons
            const claimed = await this.claimEventForReminder(
              event._id,
              "anticipation",
            );
            if (!claimed) {
              logger.debug(
                `Rappel anticipé pour "${event.title}" déjà pris en charge par une autre instance`,
              );
              continue;
            }

            logger.info(
              `Envoi de rappel anticipé pour "${event.title}" (${event._id})`,
            );

            const result = await emailReminderService.sendReminder(
              event._id,
              "anticipated",
              event.emailReminder.anticipation,
              { ignoreDoNotDisturb: true },
            );

            if (result.success) {
              logger.info(`✅ Rappel anticipé envoyé pour "${event.title}"`);
            } else if (result.deferred) {
              logger.info(
                `⏰ Rappel différé pour "${event.title}" jusqu'à ${result.nextAttempt}`,
              );
            } else if (result.cancelled) {
              logger.info(
                `❌ Rappel annulé pour "${event.title}": ${result.reason}`,
              );
            } else {
              logger.error(
                `❌ Échec rappel anticipé pour "${event.title}": ${result.reason}`,
              );
              const retryCount = event.emailReminder.retryCount || 0;
              if (retryCount < MAX_RETRIES) {
                // Reprogrammer dans 2 min pour une nouvelle tentative
                await Event.updateOne(
                  { _id: event._id },
                  {
                    $set: {
                      "emailReminder.status": "failed",
                      "emailReminder.retryCount": retryCount + 1,
                      "emailReminder.scheduledFor": new Date(
                        now.getTime() + 2 * 60 * 1000,
                      ),
                    },
                  },
                );
              } else {
                // Tentatives épuisées : abandonner pour ne pas boucler
                await Event.updateOne(
                  { _id: event._id },
                  {
                    $set: {
                      "emailReminder.status": "cancelled",
                      "emailReminder.failureReason": `Abandon après ${MAX_RETRIES} tentatives: ${result.reason}`,
                    },
                  },
                );
                logger.error(
                  `⛔ Rappel anticipé abandonné pour "${event.title}" après ${MAX_RETRIES} tentatives`,
                );
              }
            }
          }

          // Rappel à l'échéance
          if (
            event.emailReminder.echeanceStatus === "pending" &&
            event.emailReminder.echeanceScheduledFor &&
            event.emailReminder.echeanceScheduledFor <= now
          ) {
            // Réserver atomiquement l'événement pour éviter les doublons
            const claimed = await this.claimEventForReminder(
              event._id,
              "echeance",
            );
            if (!claimed) {
              logger.debug(
                `Rappel échéance pour "${event.title}" déjà pris en charge par une autre instance`,
              );
              continue;
            }

            logger.info(
              `Envoi de rappel échéance pour "${event.title}" (${event._id})`,
            );

            const result = await emailReminderService.sendReminder(
              event._id,
              "due",
              event.emailReminder.echeance,
              { reminderField: "echeance", ignoreDoNotDisturb: true },
            );

            if (result.success) {
              logger.info(`✅ Rappel échéance envoyé pour "${event.title}"`);
            } else if (!result.deferred && !result.cancelled) {
              logger.error(
                `❌ Échec rappel échéance pour "${event.title}": ${result.reason}`,
              );
              const retryCount = event.emailReminder.echeanceRetryCount || 0;
              if (retryCount < MAX_RETRIES) {
                // Reprogrammer dans 2 min pour une nouvelle tentative
                await Event.updateOne(
                  { _id: event._id },
                  {
                    $set: {
                      "emailReminder.echeanceStatus": "failed",
                      "emailReminder.echeanceRetryCount": retryCount + 1,
                      "emailReminder.echeanceScheduledFor": new Date(
                        now.getTime() + 2 * 60 * 1000,
                      ),
                    },
                  },
                );
              } else {
                // Tentatives épuisées : abandonner pour ne pas boucler
                await Event.updateOne(
                  { _id: event._id },
                  {
                    $set: {
                      "emailReminder.echeanceStatus": "cancelled",
                      "emailReminder.failureReason": `Abandon échéance après ${MAX_RETRIES} tentatives: ${result.reason}`,
                    },
                  },
                );
                logger.error(
                  `⛔ Rappel échéance abandonné pour "${event.title}" après ${MAX_RETRIES} tentatives`,
                );
              }
            }
          }
        } catch (error) {
          logger.error(
            `Erreur lors du traitement du rappel pour l'événement ${event._id}:`,
            error,
          );
        }
      }

      // Nettoyer les anciens rappels (événements passés depuis plus de 7 jours)
      await this.cleanupOldReminders();
    } catch (error) {
      logger.error("Erreur lors du traitement des rappels:", error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Nettoie les anciens rappels
   */
  async cleanupOldReminders() {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const result = await Event.updateMany(
        {
          "emailReminder.enabled": true,
          "emailReminder.status": { $in: ["sent", "failed", "cancelled"] },
          end: { $lt: sevenDaysAgo },
        },
        {
          $set: {
            "emailReminder.enabled": false,
          },
        },
      );

      if (result.modifiedCount > 0) {
        logger.info(
          `🧹 ${result.modifiedCount} ancien(s) rappel(s) nettoyé(s)`,
        );
      }
    } catch (error) {
      logger.error("Erreur lors du nettoyage des anciens rappels:", error);
    }
  }

  /**
   * Exécution manuelle pour test
   */
  async runNow() {
    logger.info("🚀 Exécution manuelle du scheduler de rappels");
    await this.processReminders();
  }
}

export default new EmailReminderScheduler();
