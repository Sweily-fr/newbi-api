import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';
import EmailLog from '../models/EmailLog.js';
import Event from '../models/Event.js';
import User from '../models/User.js';

/**
 * Service de gestion des rappels par email
 * Utilise Resend en priorité, fallback sur SMTP/nodemailer
 */
class EmailReminderService {
  constructor() {
    this.resend = null;
    this.transporter = null;
    this.useResend = false;
    this.fromEmail = process.env.FROM_EMAIL || 'no-reply@newbi.fr';
    this.resendFromEmail = process.env.RESEND_FROM_EMAIL || 'no-reply@newbi.sweily.fr';
    this.initEmailProvider();
  }

  /**
   * Initialise le fournisseur d'email (Resend ou SMTP)
   */
  initEmailProvider() {
    // Toujours initialiser SMTP (pour compatibilité avec les autres services)
    this.initTransporter();

    // Si Resend est configuré, l'utiliser en priorité pour les rappels
    if (process.env.RESEND_API_KEY) {
      try {
        this.resend = new Resend(process.env.RESEND_API_KEY);
        this.useResend = true;
        logger.info('✅ Service d\'email Resend initialisé (prioritaire pour les rappels)');
      } catch (error) {
        logger.error('❌ Erreur lors de l\'initialisation de Resend:', error);
      }
    }
  }

  /**
   * Initialise le transporteur nodemailer (fallback)
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
        fromEmail: this.fromEmail
      });

      this.transporter = nodemailer.createTransport(config);

      // Tester la connexion SMTP
      this.testConnection();

      logger.info('✅ Service d\'email initialisé avec SMTP (fallback)');
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
   * Envoie un email via Resend ou SMTP
   */
  async sendEmail({ to, subject, html }) {
    if (this.useResend && this.resend) {
      const { data, error } = await this.resend.emails.send({
        from: `Newbi <${this.resendFromEmail}>`,
        to: [to],
        subject,
        html
      });

      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }

      logger.info(`📧 Email envoyé via Resend (id: ${data?.id}) à ${to}`);
      return data;
    }

    // Fallback SMTP
    if (!this.transporter) {
      throw new Error('Aucun service d\'email configuré (ni Resend, ni SMTP)');
    }

    const result = await this.transporter.sendMail({
      from: `"Newbi" <${this.fromEmail}>`,
      to,
      subject,
      html
    });

    logger.info(`📧 Email envoyé via SMTP à ${to}`);
    return result;
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
        '5m': '5 minutes',
        '10m': '10 minutes',
        '15m': '15 minutes',
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

    const messageText = reminderType === 'anticipated'
      ? `Votre événement <strong>${event.title}</strong> arrive dans <strong>${anticipationText}</strong>.`
      : `Votre événement <strong>${event.title}</strong> est prévu <strong>aujourd'hui</strong>.`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          line-height: 1.6;
          color: #333;
          margin: 0;
          padding: 0;
          background-color: #f0eeff;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          padding: 20px;
          background-color: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .header {
          text-align: center;
          padding: 20px 0;
          border-bottom: 1px solid #e5e7eb;
        }
        .content {
          padding: 30px 20px;
        }
        h1 {
          color: #1f2937;
          font-size: 24px;
          font-weight: 700;
          margin-bottom: 20px;
        }
        p {
          margin-bottom: 16px;
          color: #4b5563;
        }
        .btn {
          display: inline-block;
          background-color: #5b50ff;
          color: white;
          font-weight: 600;
          text-decoration: none;
          padding: 12px 24px;
          border-radius: 6px;
          margin: 20px 0;
          text-align: center;
        }
        .footer {
          text-align: center;
          padding: 20px;
          color: #6b7280;
          font-size: 14px;
          border-top: 1px solid #e5e7eb;
        }
        .security-notice {
          background-color: #e6e1ff;
          padding: 15px;
          border-radius: 6px;
          margin-top: 30px;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #1f2937;">Rappel de calendrier</h1>
        </div>
        <div class="content">
          <div style="font-size: 15px; line-height: 1.6; color: #4b5563;">
            <p>Bonjour,</p>
            <p>${messageText}</p>
          </div>

          <div class="security-notice">
            <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; color: #1f2937; text-transform: uppercase; letter-spacing: 0.5px;">
              DÉTAILS DE L'ÉVÉNEMENT
            </h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Événement</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 600;">${event.title}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Date</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${eventDate}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Heure</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${eventTime}</td>
              </tr>
              ${event.location ? `<tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Lieu</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${event.location}</td>
              </tr>` : ''}
              ${event.description ? `<tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Description</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right;">${event.description}</td>
              </tr>` : ''}
            </table>
          </div>

          <div style="text-align: center; margin-top: 24px;">
            <a href="${frontendUrl}/dashboard/calendar?event=${event._id}" class="btn" style="display: inline-block; background-color: #5b50ff; color: white; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 6px;">
              Voir dans le calendrier
            </a>
          </div>

          <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
            Vous pouvez gérer vos rappels dans les <a href="${frontendUrl}/dashboard/settings" style="color: #5b50ff; text-decoration: none;">paramètres</a> de votre compte.
          </p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
          <p style="margin: 0; font-size: 12px; color: #9ca3af;">Ce rappel a été envoyé depuis la plateforme Newbi Logiciel de gestion.</p>
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

      // Envoyer l'email via Resend ou SMTP
      await this.sendEmail({
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
            recipientEmail: event.userId?.email || 'unknown',
            recipientUserId: event.userId?._id || event.userId,
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
   * Pour les événements "toute la journée", la base est 9h00 (au lieu de 00h00)
   */
  calculateScheduledTime(eventStart, anticipation, allDay = false) {
    const scheduledTime = new Date(eventStart);

    // Pour les événements "toute la journée", utiliser 9h00 comme référence
    if (allDay) {
      scheduledTime.setHours(9, 0, 0, 0);
    }

    if (!anticipation) {
      return scheduledTime;
    }

    switch (anticipation) {
      case '5m':
        scheduledTime.setMinutes(scheduledTime.getMinutes() - 5);
        break;
      case '10m':
        scheduledTime.setMinutes(scheduledTime.getMinutes() - 10);
        break;
      case '15m':
        scheduledTime.setMinutes(scheduledTime.getMinutes() - 15);
        break;
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
