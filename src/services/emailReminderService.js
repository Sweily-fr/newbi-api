import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import EmailLog from '../models/EmailLog.js';
import Event from '../models/Event.js';
import User from '../models/User.js';

/**
 * Service de gestion des rappels par email
 */
class EmailReminderService {
  constructor() {
    this.transporter = null;
    this.initTransporter();
  }

  /**
   * Initialise le transporteur nodemailer
   */
  initTransporter() {
    try {
      const config = {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      };

      logger.info('🔧 Configuration SMTP:', {
        host: config.host,
        port: config.port,
        secure: config.secure,
        user: config.auth.user,
        passLength: config.auth.pass ? config.auth.pass.length : 0,
        fromEmail: process.env.FROM_EMAIL
      });

      this.transporter = nodemailer.createTransport(config);
      
      // Tester la connexion SMTP
      this.testConnection();
      
      logger.info('✅ Service d\'email initialisé avec succès');
    } catch (error) {
      logger.error('❌ Erreur lors de l\'initialisation du service d\'email:', error);
    }
  }

  /**
   * Teste la connexion SMTP
   */
  async testConnection() {
    try {
      await this.transporter.verify();
      logger.info('✅ Connexion SMTP vérifiée avec succès');
    } catch (error) {
      logger.error('❌ Erreur de connexion SMTP:', error.message);
      logger.error('🔧 Vérifiez vos paramètres SMTP dans le fichier .env');
    }
  }

  /**
   * Vérifie si l'utilisateur a activé les rappels par email
   */
  async checkUserPreferences(userId) {
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        return { enabled: false, reason: 'Utilisateur non trouvé' };
      }

      // Vérifier les préférences email
      // Si l'utilisateur n'a pas explicitement configuré ses préférences,
      // on considère que les rappels sont autorisés (il a activé le rappel sur l'événement)
      const emailPreferences = user.emailPreferences || {};
      const reminders = emailPreferences.reminders || {};

      // Seulement bloquer si l'utilisateur a explicitement désactivé les rappels
      // (emailPreferences existe et reminders.enabled est explicitement false)
      if (user.emailPreferences?.reminders && reminders.enabled === false) {
        return { enabled: false, reason: 'Rappels désactivés par l\'utilisateur' };
      }

      return { enabled: true, preferences: reminders };
    } catch (error) {
      logger.error('Erreur lors de la vérification des préférences:', error);
      return { enabled: false, reason: 'Erreur de vérification' };
    }
  }

  /**
   * Vérifie si l'heure actuelle est dans une plage "Ne pas déranger"
   */
  isInDoNotDisturbPeriod(preferences = {}) {
    const now = new Date();
    const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const hour = parisTime.getHours();
    const day = parisTime.getDay(); // 0 = dimanche, 6 = samedi
    const isWeekend = day === 0 || day === 6;

    const doNotDisturb = preferences.doNotDisturb || {};
    const weekdayPeriod = doNotDisturb.weekday || { start: '22:00', end: '08:00' };
    const weekendPeriod = doNotDisturb.weekend || { start: '22:00', end: '10:00' };

    const period = isWeekend ? weekendPeriod : weekdayPeriod;
    const startHour = parseInt(period.start.split(':')[0]);
    const endHour = parseInt(period.end.split(':')[0]);

    // Si la période traverse minuit (ex: 22h-8h)
    if (startHour > endHour) {
      return hour >= startHour || hour < endHour;
    }
    
    return hour >= startHour && hour < endHour;
  }

  /**
   * Calcule la prochaine heure autorisée (hors période "Ne pas déranger")
   */
  getNextAllowedTime(preferences = {}) {
    const now = new Date();
    const parisTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const day = parisTime.getDay();
    const isWeekend = day === 0 || day === 6;

    const doNotDisturb = preferences.doNotDisturb || {};
    const weekdayPeriod = doNotDisturb.weekday || { start: '22:00', end: '08:00' };
    const weekendPeriod = doNotDisturb.weekend || { start: '22:00', end: '10:00' };

    const period = isWeekend ? weekendPeriod : weekdayPeriod;
    const endHour = parseInt(period.end.split(':')[0]);

    const nextAllowed = new Date(parisTime);
    nextAllowed.setHours(endHour, 0, 0, 0);

    // Si l'heure de fin est déjà passée aujourd'hui, passer au lendemain
    if (nextAllowed <= parisTime) {
      nextAllowed.setDate(nextAllowed.getDate() + 1);
    }

    return nextAllowed;
  }

  /**
   * Génère le contenu HTML de l'email
   */
  generateEmailContent(event, reminderType, anticipation = null) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const eventDate = new Date(event.start).toLocaleDateString('fr-FR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const eventTime = event.allDay ? 'Toute la journée' : new Date(event.start).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit'
    });
    const formattedDate = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

    let subject = '';
    let anticipationText = '';

    if (reminderType === 'anticipated') {
      const anticipationMap = {
        '1h': '1 heure',
        '3h': '3 heures',
        '1d': '1 jour',
        '3d': '3 jours'
      };
      anticipationText = anticipationMap[anticipation] || '';
      subject = `Rappel : ${event.title} dans ${anticipationText}`;
    } else {
      subject = `Rappel : ${event.title} - aujourd'hui`;
    }

    const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
  <div style="max-width: 600px; margin: 0 auto; padding: 0 20px; background-color: #fafafa;">

    <!-- Logo -->
    <div style="text-align: center; padding: 40px 0 24px 0;">
      <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png" alt="Newbi" style="height: 32px; width: auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align: center; margin-bottom: 8px;">
      <span style="font-size: 11px; font-weight: 600; color: #1a1a1a; letter-spacing: 0.5px; text-transform: uppercase;">
        RAPPEL DE CALENDRIER
      </span>
    </div>

    <!-- Date -->
    <div style="text-align: center; margin-bottom: 32px;">
      <span style="font-size: 12px; color: #6b7280;">
        ${formattedDate}
      </span>
    </div>

    <!-- Carte principale -->
    <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 24px; margin-bottom: 32px;">

      <!-- Badge -->
      <div style="margin-bottom: 20px;">
        <div style="display: inline-flex; align-items: center; background-color: #f3f4f6; border-radius: 6px; padding: 8px 12px;">
          <img src="https://pub-f5ac1d55852142ab931dc75bdc939d68.r2.dev/mail.png" alt="Rappel" style="height: 16px; width: 16px; margin-right: 8px;">
          <span style="font-size: 11px; font-weight: 500; color: #374151; letter-spacing: 0.3px; text-transform: uppercase;">${reminderType === 'anticipated' ? 'RAPPEL' : 'ECHEANCE'}</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size: 26px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0; line-height: 1.3;">
        ${event.title}
      </h1>

      <!-- Salutation -->
      <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">
        Bonjour,
      </p>

      <!-- Message -->
      <p style="font-size: 15px; color: #4b5563; margin: 0 0 24px 0; line-height: 1.6;">
        ${reminderType === 'anticipated'
          ? `Votre événement arrive dans <strong style="color: #1a1a1a;">${anticipationText}</strong>.`
          : `Votre événement est prévu <strong style="color: #1a1a1a;">aujourd'hui</strong>.`
        }
      </p>

      <!-- Détails de l'événement -->
      <div style="background-color: #f9fafb; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280; width: 100px;">Date</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${eventDate}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Heure</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${eventTime}</td>
          </tr>
          ${event.location ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Lieu</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; font-weight: 500;">${event.location}</td>
          </tr>` : ''}
          ${event.description ? `<tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280; vertical-align: top;">Description</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a;">${event.description}</td>
          </tr>` : ''}
        </table>
      </div>

      <!-- Bouton CTA -->
      <a href="${frontendUrl}/dashboard/calendar?event=${event._id}" style="display: block; background-color: #1a1a1a; color: #ffffff; text-decoration: none; padding: 16px 24px; border-radius: 6px; font-weight: 500; font-size: 15px; text-align: center;">
        Voir dans le calendrier
      </a>
    </div>

    <!-- Aide -->
    <p style="font-size: 14px; color: #4b5563; margin: 0 0 32px 0; padding: 0 8px; line-height: 1.6;">
      Vous pouvez gérer vos rappels dans les <a href="${frontendUrl}/dashboard/settings" style="color: #5B4FFF; text-decoration: none;">paramètres</a> de votre compte.
    </p>

    <!-- Signature -->
    <div style="padding: 0 8px;">
      <p style="font-size: 14px; color: #4b5563; margin: 0 0 8px 0;">Merci,</p>
      <p style="font-size: 14px; color: #4b5563; margin: 0 0 48px 0; font-weight: 500;">L'équipe Newbi</p>
    </div>

    <!-- Footer -->
    <div style="border-top: 1px solid #e5e7eb; padding-top: 32px; text-align: center;">
      <div style="margin-bottom: 16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height: 28px; width: auto;">
      </div>
      <p style="font-size: 13px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0;">
        Votre gestion, simplifiée.
      </p>
      <p style="font-size: 12px; color: #9ca3af; margin: 0 0 24px 0; line-height: 1.8;">
        Vous pouvez gérer vos notifications dans les paramètres de votre compte
      </p>
      <div style="font-size: 11px; color: #9ca3af; line-height: 1.6;">
        <p style="margin: 0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin: 0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
</body>
</html>
    `;

    return { subject, html };
  }

  /**
   * Envoie un email de rappel
   */
  async sendReminder(eventId, reminderType, anticipation = null, { skipPreferencesCheck = false } = {}) {
    try {
      // Récupérer l'événement
      const event = await Event.findById(eventId).populate('userId');
      
      if (!event) {
        logger.error(`Événement ${eventId} non trouvé`);
        return { success: false, reason: 'Événement non trouvé' };
      }

      const user = event.userId;
      
      if (!user || !user.email) {
        logger.error(`Utilisateur ou email non trouvé pour l'événement ${eventId}`);
        return { success: false, reason: 'Utilisateur ou email non trouvé' };
      }

      // Vérifier les préférences utilisateur (sauf si envoi immédiat depuis création d'événement)
      let preferences = {};
      if (!skipPreferencesCheck) {
        const preferencesCheck = await this.checkUserPreferences(user._id);

        if (!preferencesCheck.enabled) {
          logger.info(`Rappel annulé pour ${user.email}: ${preferencesCheck.reason}`);

          // Mettre à jour le statut de l'événement
          event.emailReminder.status = 'cancelled';
          event.emailReminder.failureReason = preferencesCheck.reason;
          await event.save();

          return { success: false, reason: preferencesCheck.reason, cancelled: true };
        }

        preferences = preferencesCheck.preferences;
      }

      // Vérifier la période "Ne pas déranger"
      if (!skipPreferencesCheck && this.isInDoNotDisturbPeriod(preferences)) {
        const nextAllowed = this.getNextAllowedTime(preferences);
        logger.info(`Email différé pour ${user.email} jusqu'à ${nextAllowed}`);
        
        // Enregistrer le report dans les logs
        await EmailLog.create({
          eventId: event._id,
          workspaceId: event.workspaceId,
          recipientEmail: user.email,
          recipientUserId: user._id,
          reminderType,
          anticipation,
          status: 'deferred',
          sentAt: new Date(),
          scheduledFor: event.emailReminder.scheduledFor || event.start,
          deferredReason: 'Période "Ne pas déranger"',
          eventSnapshot: {
            title: event.title,
            description: event.description,
            start: event.start,
            end: event.end
          }
        });
        
        // Reprogrammer pour plus tard
        event.emailReminder.scheduledFor = nextAllowed;
        await event.save();
        
        return { success: false, reason: 'Différé (Ne pas déranger)', deferred: true, nextAttempt: nextAllowed };
      }

      // Générer le contenu de l'email
      const { subject, html } = this.generateEmailContent(event, reminderType, anticipation);

      // Envoyer l'email
      await this.transporter.sendMail({
        from: `"Newbi" <${process.env.FROM_EMAIL || process.env.SMTP_USER}>`,
        to: user.email,
        subject,
        html
      });

      logger.info(`✅ Email de rappel envoyé à ${user.email} pour l'événement "${event.title}"`);

      // Mettre à jour l'événement
      event.emailReminder.status = 'sent';
      event.emailReminder.sentAt = new Date();
      await event.save();

      // Enregistrer dans les logs
      await EmailLog.create({
        eventId: event._id,
        workspaceId: event.workspaceId,
        recipientEmail: user.email,
        recipientUserId: user._id,
        reminderType,
        anticipation,
        status: 'sent',
        sentAt: new Date(),
        scheduledFor: event.emailReminder.scheduledFor || event.start,
        eventSnapshot: {
          title: event.title,
          description: event.description,
          start: event.start,
          end: event.end
        }
      });

      return { success: true };
    } catch (error) {
      logger.error(`❌ Erreur lors de l'envoi du rappel pour l'événement ${eventId}:`, error);

      // Enregistrer l'échec
      try {
        const event = await Event.findById(eventId);
        if (event) {
          event.emailReminder.status = 'failed';
          event.emailReminder.failureReason = error.message;
          await event.save();

          await EmailLog.create({
            eventId: event._id,
            workspaceId: event.workspaceId,
            recipientEmail: event.userId.email || 'unknown',
            recipientUserId: event.userId,
            reminderType,
            anticipation,
            status: 'failed',
            sentAt: new Date(),
            scheduledFor: event.emailReminder.scheduledFor || event.start,
            failureReason: error.message,
            eventSnapshot: {
              title: event.title,
              description: event.description,
              start: event.start,
              end: event.end
            }
          });
        }
      } catch (logError) {
        logger.error('Erreur lors de l\'enregistrement de l\'échec:', logError);
      }

      return { success: false, reason: error.message };
    }
  }

  /**
   * Calcule la date d'envoi en fonction de l'anticipation
   */
  calculateScheduledTime(eventStart, anticipation) {
    const scheduledTime = new Date(eventStart);
    
    if (!anticipation) {
      return scheduledTime;
    }

    switch (anticipation) {
      case '1h':
        scheduledTime.setHours(scheduledTime.getHours() - 1);
        break;
      case '3h':
        scheduledTime.setHours(scheduledTime.getHours() - 3);
        break;
      case '1d':
        scheduledTime.setDate(scheduledTime.getDate() - 1);
        break;
      case '3d':
        scheduledTime.setDate(scheduledTime.getDate() - 3);
        break;
    }

    return scheduledTime;
  }
}

export default new EmailReminderService();
