import cron from 'node-cron';
import logger from '../utils/logger.js';
import Event from '../models/Event.js';
import emailReminderService from './emailReminderService.js';

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
      logger.warn('Le scheduler de rappels email est déjà démarré');
      return;
    }

    // Exécuter toutes les 5 minutes
    this.task = cron.schedule('*/5 * * * *', async () => {
      await this.processReminders();
    });

    logger.info('✅ Scheduler de rappels email démarré (toutes les 5 minutes)');
  }

  /**
   * Arrête le scheduler
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      logger.info('Scheduler de rappels email arrêté');
    }
  }

  /**
   * Traite les rappels en attente
   */
  async processReminders() {
    if (this.isRunning) {
      logger.debug('Traitement de rappels déjà en cours, passage ignoré');
      return;
    }

    this.isRunning = true;
    
    try {
      const now = new Date();
      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

      logger.debug(`🔍 Recherche de rappels à envoyer entre ${fiveMinutesAgo.toISOString()} et ${fiveMinutesFromNow.toISOString()}`);

      // Trouver les événements avec rappel activé et en attente
      // Inclut aussi les rappels récemment manqués (5 min dans le passé) pour ne rien perdre
      const events = await Event.find({
        'emailReminder.enabled': true,
        'emailReminder.status': { $in: ['pending', 'failed'] },
        'emailReminder.scheduledFor': {
          $gte: fiveMinutesAgo,
          $lte: fiveMinutesFromNow
        }
      }).populate('userId');

      logger.info(`📧 ${events.length} rappel(s) à traiter`);

      // Traiter chaque événement
      for (const event of events) {
        try {
          const reminderType = event.emailReminder.anticipation ? 'anticipated' : 'due';
          
          logger.info(`Envoi de rappel ${reminderType} pour l'événement "${event.title}" (${event._id})`);
          
          const result = await emailReminderService.sendReminder(
            event._id,
            reminderType,
            event.emailReminder.anticipation
          );

          if (result.success) {
            logger.info(`✅ Rappel envoyé avec succès pour "${event.title}"`);
          } else if (result.deferred) {
            logger.info(`⏰ Rappel différé pour "${event.title}" jusqu'à ${result.nextAttempt}`);
          } else if (result.cancelled) {
            logger.info(`❌ Rappel annulé pour "${event.title}": ${result.reason}`);
          } else {
            logger.error(`❌ Échec de l'envoi du rappel pour "${event.title}": ${result.reason}`);
            
            // Réessayer dans 5 minutes si échec (max 3 tentatives)
            const retryCount = event.emailReminder.retryCount || 0;
            if (retryCount < 3) {
              event.emailReminder.retryCount = retryCount + 1;
              event.emailReminder.scheduledFor = new Date(now.getTime() + 5 * 60 * 1000);
              await event.save();
              logger.info(`🔄 Nouvelle tentative programmée (${retryCount + 1}/3)`);
            } else {
              logger.error(`❌ Nombre maximum de tentatives atteint pour "${event.title}"`);
            }
          }
        } catch (error) {
          logger.error(`Erreur lors du traitement du rappel pour l'événement ${event._id}:`, error);
        }
      }

      // Nettoyer les anciens rappels (événements passés depuis plus de 7 jours)
      await this.cleanupOldReminders();

    } catch (error) {
      logger.error('Erreur lors du traitement des rappels:', error);
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
          'emailReminder.enabled': true,
          'emailReminder.status': { $in: ['sent', 'failed', 'cancelled'] },
          end: { $lt: sevenDaysAgo }
        },
        {
          $set: {
            'emailReminder.enabled': false
          }
        }
      );

      if (result.modifiedCount > 0) {
        logger.info(`🧹 ${result.modifiedCount} ancien(s) rappel(s) nettoyé(s)`);
      }
    } catch (error) {
      logger.error('Erreur lors du nettoyage des anciens rappels:', error);
    }
  }

  /**
   * Exécution manuelle pour test
   */
  async runNow() {
    logger.info('🚀 Exécution manuelle du scheduler de rappels');
    await this.processReminders();
  }
}

export default new EmailReminderScheduler();
