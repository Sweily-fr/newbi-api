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

      // Vérifier les préférences email (à adapter selon votre structure Better Auth)
      const emailPreferences = user.emailPreferences || {};
      const reminders = emailPreferences.reminders || {};
      
      if (!reminders.enabled) {
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
      subject = `⏰ Rappel : ${event.title} dans ${anticipationText}`;
    } else {
      subject = `🔔 Échéance aujourd'hui : ${event.title}`;
    }

    const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { padding: 30px 20px; }
    .event-card { background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0; border-radius: 4px; }
    .event-title { font-size: 20px; font-weight: bold; margin: 0 0 10px 0; color: #2d3748; }
    .event-details { margin: 10px 0; }
    .event-details p { margin: 5px 0; color: #4a5568; }
    .event-details strong { color: #2d3748; }
    .actions { margin: 30px 0; }
    .button { display: inline-block; padding: 12px 24px; margin: 5px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; }
    .button:hover { background: #5568d3; }
    .button-secondary { background: #718096; }
    .button-secondary:hover { background: #4a5568; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #e2e8f0; }
    .footer a { color: #667eea; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${reminderType === 'anticipated' ? '⏰ Rappel de tâche' : '🔔 Échéance aujourd\'hui'}</h1>
    </div>
    
    <div class="content">
      <p>Bonjour,</p>
      
      ${reminderType === 'anticipated' 
        ? `<p>Votre tâche arrive à échéance dans <strong>${anticipationText}</strong> :</p>`
        : `<p>Votre tâche arrive à échéance aujourd'hui :</p>`
      }
      
      <div class="event-card">
        <div class="event-title">📋 ${event.title}</div>
        <div class="event-details">
          <p><strong>📅 Date :</strong> ${eventDate}</p>
          <p><strong>🕐 Heure :</strong> ${eventTime}</p>
          ${event.location ? `<p><strong>📍 Lieu :</strong> ${event.location}</p>` : ''}
          ${event.description ? `<p><strong>📝 Description :</strong> ${event.description}</p>` : ''}
        </div>
      </div>
      
      <div class="actions">
        <p><strong>Actions rapides :</strong></p>
        <a href="${frontendUrl}/dashboard/calendar?event=${event._id}" class="button">Voir les détails</a>
        <a href="${frontendUrl}/dashboard/calendar" class="button button-secondary">Ouvrir le calendrier</a>
      </div>
    </div>
    
    <div class="footer">
      <p>Vous recevez cet email car vous avez activé les rappels d'échéance.</p>
      <p><a href="${frontendUrl}/dashboard/settings">Gérer mes préférences</a></p>
      <p style="margin-top: 15px;">L'équipe Newbi</p>
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
  async sendReminder(eventId, reminderType, anticipation = null) {
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

      // Vérifier les préférences utilisateur
      const preferencesCheck = await this.checkUserPreferences(user._id);
      
      if (!preferencesCheck.enabled) {
        logger.info(`Rappel annulé pour ${user.email}: ${preferencesCheck.reason}`);
        
        // Mettre à jour le statut de l'événement
        event.emailReminder.status = 'cancelled';
        event.emailReminder.failureReason = preferencesCheck.reason;
        await event.save();
        
        return { success: false, reason: preferencesCheck.reason, cancelled: true };
      }

      const preferences = preferencesCheck.preferences;

      // Vérifier la période "Ne pas déranger"
      if (this.isInDoNotDisturbPeriod(preferences)) {
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
