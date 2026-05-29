import { Resend } from "resend";
import nodemailer from "nodemailer";
import logger from "../utils/logger.js";
import EmailLog from "../models/EmailLog.js";
import Event from "../models/Event.js";
import User from "../models/User.js";

/**
 * Service de gestion des rappels par email
 * Utilise Resend en priorité, fallback sur SMTP/nodemailer
 */
class EmailReminderService {
  constructor() {
    this.resend = null;
    this.transporter = null;
    this.useResend = false;
    this.fromEmail = process.env.FROM_EMAIL || "no-reply@newbi.fr";
    this.resendFromEmail = process.env.RESEND_FROM_EMAIL || "no-reply@newbi.fr";
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
        logger.info(
          "✅ Service d'email Resend initialisé (prioritaire pour les rappels)",
        );
      } catch (error) {
        logger.error("❌ Erreur lors de l'initialisation de Resend:", error);
      }
    }
  }

  /**
   * Initialise le transporteur nodemailer (fallback)
   */
  initTransporter() {
    try {
      const config = {
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      };

      logger.info("🔧 Configuration SMTP:", {
        host: config.host,
        port: config.port,
        secure: config.secure,
        user: config.auth.user,
        passLength: config.auth.pass ? config.auth.pass.length : 0,
        fromEmail: this.fromEmail,
      });

      this.transporter = nodemailer.createTransport(config);

      // Tester la connexion SMTP
      this.testConnection();

      logger.info("✅ Service d'email initialisé avec SMTP (fallback)");
    } catch (error) {
      logger.error(
        "❌ Erreur lors de l'initialisation du service d'email:",
        error,
      );
    }
  }

  /**
   * Teste la connexion SMTP
   */
  async testConnection() {
    try {
      await this.transporter.verify();
      logger.info("✅ Connexion SMTP vérifiée avec succès");
    } catch (error) {
      logger.error("❌ Erreur de connexion SMTP:", error.message);
      logger.error("🔧 Vérifiez vos paramètres SMTP dans le fichier .env");
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
        html,
      });

      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }

      logger.info(`📧 Email envoyé via Resend (id: ${data?.id}) à ${to}`);
      return data;
    }

    // Fallback SMTP
    if (!this.transporter) {
      throw new Error("Aucun service d'email configuré (ni Resend, ni SMTP)");
    }

    const result = await this.transporter.sendMail({
      from: `"Newbi" <${this.fromEmail}>`,
      to,
      subject,
      html,
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
        return { enabled: false, reason: "Utilisateur non trouvé" };
      }

      // Vérifier les préférences email
      // Si l'utilisateur n'a pas explicitement configuré ses préférences,
      // on considère que les rappels sont autorisés (il a activé le rappel sur l'événement)
      const emailPreferences = user.emailPreferences || {};
      const reminders = emailPreferences.reminders || {};

      // Seulement bloquer si l'utilisateur a explicitement désactivé les rappels
      // (emailPreferences existe et reminders.enabled est explicitement false)
      if (user.emailPreferences?.reminders && reminders.enabled === false) {
        return {
          enabled: false,
          reason: "Rappels désactivés par l'utilisateur",
        };
      }

      return { enabled: true, preferences: reminders };
    } catch (error) {
      logger.error("Erreur lors de la vérification des préférences:", error);
      return { enabled: false, reason: "Erreur de vérification" };
    }
  }

  /**
   * Vérifie si l'heure actuelle est dans une plage "Ne pas déranger"
   */
  isInDoNotDisturbPeriod(preferences = {}) {
    const now = new Date();
    const parisTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
    );
    const hour = parisTime.getHours();
    const day = parisTime.getDay(); // 0 = dimanche, 6 = samedi
    const isWeekend = day === 0 || day === 6;

    const doNotDisturb = preferences.doNotDisturb || {};
    const weekdayPeriod = doNotDisturb.weekday || {
      start: "22:00",
      end: "08:00",
    };
    const weekendPeriod = doNotDisturb.weekend || {
      start: "22:00",
      end: "10:00",
    };

    const period = isWeekend ? weekendPeriod : weekdayPeriod;
    const startHour = parseInt(period.start.split(":")[0]);
    const endHour = parseInt(period.end.split(":")[0]);

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
    const parisTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
    );
    const day = parisTime.getDay();
    const isWeekend = day === 0 || day === 6;

    const doNotDisturb = preferences.doNotDisturb || {};
    const weekdayPeriod = doNotDisturb.weekday || {
      start: "22:00",
      end: "08:00",
    };
    const weekendPeriod = doNotDisturb.weekend || {
      start: "22:00",
      end: "10:00",
    };

    const period = isWeekend ? weekendPeriod : weekdayPeriod;
    const endHour = parseInt(period.end.split(":")[0]);

    const nextAllowed = new Date(parisTime);
    nextAllowed.setHours(endHour, 0, 0, 0);

    // Si l'heure de fin est déjà passée aujourd'hui, passer au lendemain
    if (nextAllowed <= parisTime) {
      nextAllowed.setDate(nextAllowed.getDate() + 1);
    }

    return nextAllowed;
  }

  /**
   * Échappe les caractères HTML pour éviter toute injection / casse de mise en
   * page lorsque les champs (titre, lieu, description) contiennent du HTML.
   */
  escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Génère le contenu HTML de l'email.
   * Layout en tableaux + styles 100 % inline pour un rendu fiable sur tous les
   * clients mail (Gmail supprime les balises <style> du <head>).
   *
   * @param {object} event
   * @param {"anticipated"|"due"} reminderType
   * @param {string|null} offset - valeur d'anticipation ("1h"…) ou d'échéance ("0m"…)
   */
  generateEmailContent(event, reminderType, offset = null) {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const tz = "Europe/Paris";

    const eventDate = new Date(event.start).toLocaleDateString("fr-FR", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: tz,
    });
    const eventTime = event.allDay
      ? "Toute la journée"
      : new Date(event.start).toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: tz,
        });

    const title = this.escapeHtml(event.title);

    // Libellés selon le type de rappel et le décalage choisi
    let subject = "";
    let messageText = "";
    let preheader = "";

    if (reminderType === "anticipated") {
      const anticipationMap = {
        "0m": "quelques instants",
        "5m": "5 minutes",
        "10m": "10 minutes",
        "15m": "15 minutes",
        "1h": "1 heure",
        "3h": "3 heures",
        "1d": "1 jour",
        "3d": "3 jours",
      };
      const delay = anticipationMap[offset] || "bientôt";
      subject = `Rappel : ${event.title} dans ${delay}`;
      messageText = `Votre événement <strong>${title}</strong> arrive dans <strong>${delay}</strong>.`;
      preheader = `${event.title} — dans ${delay}`;
    } else {
      // Rappel à l'échéance : message précis selon l'avance choisie
      const dueMap = {
        "0m": {
          subject: "ça commence maintenant",
          text: "commence <strong>maintenant</strong>",
        },
        "5m": {
          subject: "dans 5 minutes",
          text: "commence <strong>dans 5 minutes</strong>",
        },
        "10m": {
          subject: "dans 10 minutes",
          text: "commence <strong>dans 10 minutes</strong>",
        },
        "15m": {
          subject: "dans 15 minutes",
          text: "commence <strong>dans 15 minutes</strong>",
        },
      };
      const due = dueMap[offset] || dueMap["0m"];
      subject = `Rappel : ${event.title} — ${due.subject}`;
      messageText = `Votre événement <strong>${title}</strong> ${due.text}.`;
      preheader = `${event.title} — ${due.subject}`;
    }

    const detailRow = (label, value) => `
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280; font-family: Arial, Helvetica, sans-serif;">${label}</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 600; font-family: Arial, Helvetica, sans-serif;">${value}</td>
              </tr>`;

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f0eeff; font-family: Arial, Helvetica, sans-serif; color: #333;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: #f0eeff; font-size: 1px; line-height: 1px;">${this.escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0eeff; margin: 0; padding: 0;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width: 600px; max-width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 24px 20px; border-bottom: 1px solid #e5e7eb;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #1f2937; font-family: Arial, Helvetica, sans-serif;">Rappel de calendrier</h1>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding: 30px 24px;">
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #4b5563;">Bonjour,</p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #4b5563;">${messageText}</p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f3ff; border-radius: 6px;">
                <tr>
                  <td style="padding: 16px 18px;">
                    <p style="margin: 0 0 12px 0; font-size: 13px; font-weight: 700; color: #1f2937; text-transform: uppercase; letter-spacing: 0.5px; font-family: Arial, Helvetica, sans-serif;">Détails de l'événement</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      ${detailRow("Événement", title)}
                      ${detailRow("Date", this.escapeHtml(eventDate))}
                      ${detailRow("Heure", this.escapeHtml(eventTime))}
                      ${event.location ? detailRow("Lieu", this.escapeHtml(event.location)) : ""}
                      ${event.description ? detailRow("Description", this.escapeHtml(event.description)) : ""}
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding: 28px 0 8px 0;">
                    <a href="${frontendUrl}/dashboard/calendar?event=${event._id}" style="display: inline-block; background-color: #5b50ff; color: #ffffff; font-weight: 600; font-size: 14px; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-family: Arial, Helvetica, sans-serif;">Voir dans le calendrier</a>
                  </td>
                </tr>
              </table>

              <p style="margin: 16px 0 0 0; font-size: 13px; line-height: 1.6; color: #6b7280;">
                Vous pouvez gérer vos rappels dans les <a href="${frontendUrl}/dashboard/settings" style="color: #5b50ff; text-decoration: none;">paramètres</a> de votre compte.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 20px; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0 0 4px 0; font-size: 13px; color: #6b7280;">&copy; ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
              <p style="margin: 0; font-size: 12px; color: #9ca3af;">Ce rappel a été envoyé depuis la plateforme Newbi, logiciel de gestion.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    return { subject, html };
  }

  /**
   * Envoie un email de rappel
   */
  async sendReminder(
    eventId,
    reminderType,
    anticipation = null,
    {
      skipPreferencesCheck = false,
      reminderField = "anticipation",
      ignoreDoNotDisturb = false,
    } = {},
  ) {
    try {
      // Récupérer l'événement
      const event = await Event.findById(eventId).populate("userId");

      if (!event) {
        logger.error(`Événement ${eventId} non trouvé`);
        return { success: false, reason: "Événement non trouvé" };
      }

      const user = event.userId;

      if (!user || !user.email) {
        logger.error(
          `Utilisateur ou email non trouvé pour l'événement ${eventId}`,
        );
        return { success: false, reason: "Utilisateur ou email non trouvé" };
      }

      // Vérifier les préférences utilisateur (sauf si envoi immédiat depuis création d'événement)
      let preferences = {};
      if (!skipPreferencesCheck) {
        const preferencesCheck = await this.checkUserPreferences(user._id);

        if (!preferencesCheck.enabled) {
          logger.info(
            `Rappel annulé pour ${user.email}: ${preferencesCheck.reason}`,
          );

          // Mettre à jour le statut de l'événement
          event.emailReminder.status = "cancelled";
          event.emailReminder.failureReason = preferencesCheck.reason;
          await event.save();

          return {
            success: false,
            reason: preferencesCheck.reason,
            cancelled: true,
          };
        }

        preferences = preferencesCheck.preferences;
      }

      // Champs ciblés selon qu'il s'agit du rappel anticipé ou à l'échéance
      const isEcheance = reminderField === "echeance";
      const scheduledField = isEcheance
        ? "echeanceScheduledFor"
        : "scheduledFor";
      const statusField = isEcheance ? "echeanceStatus" : "status";
      const sentAtField = isEcheance ? "echeanceSentAt" : "sentAt";
      const currentScheduledFor =
        event.emailReminder?.[scheduledField] || event.start;

      // Vérifier la période "Ne pas déranger"
      // (ignorée pour les rappels de calendrier : ils doivent partir à l'heure
      // demandée, même la nuit)
      if (
        !skipPreferencesCheck &&
        !ignoreDoNotDisturb &&
        this.isInDoNotDisturbPeriod(preferences)
      ) {
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
          status: "deferred",
          sentAt: new Date(),
          scheduledFor: currentScheduledFor,
          deferredReason: 'Période "Ne pas déranger"',
          eventSnapshot: {
            title: event.title,
            description: event.description,
            start: event.start,
            end: event.end,
          },
        });

        // Reprogrammer pour plus tard, sur le bon champ, et remettre le rappel
        // en "pending" (il avait été passé en "processing" par le claim) pour
        // qu'il soit bien repris au prochain passage du scheduler.
        event.emailReminder[scheduledField] = nextAllowed;
        event.emailReminder[statusField] = "pending";
        await event.save();

        return {
          success: false,
          reason: "Différé (Ne pas déranger)",
          deferred: true,
          nextAttempt: nextAllowed,
        };
      }

      // Générer le contenu de l'email
      const { subject, html } = this.generateEmailContent(
        event,
        reminderType,
        anticipation,
      );

      // Envoyer l'email via Resend ou SMTP
      await this.sendEmail({
        to: user.email,
        subject,
        html,
      });

      logger.info(
        `✅ Email de rappel envoyé à ${user.email} pour l'événement "${event.title}"`,
      );

      // Mettre à jour l'événement (statut + horodatage du bon rappel)
      event.emailReminder[statusField] = "sent";
      event.emailReminder[sentAtField] = new Date();
      await event.save();

      // Enregistrer dans les logs
      await EmailLog.create({
        eventId: event._id,
        workspaceId: event.workspaceId,
        recipientEmail: user.email,
        recipientUserId: user._id,
        reminderType,
        anticipation,
        status: "sent",
        sentAt: new Date(),
        scheduledFor: currentScheduledFor,
        eventSnapshot: {
          title: event.title,
          description: event.description,
          start: event.start,
          end: event.end,
        },
      });

      return { success: true };
    } catch (error) {
      logger.error(
        `❌ Erreur lors de l'envoi du rappel pour l'événement ${eventId}:`,
        error,
      );

      // Enregistrer l'échec
      try {
        const event = await Event.findById(eventId);
        if (event) {
          const failScheduledField =
            reminderField === "echeance"
              ? "echeanceScheduledFor"
              : "scheduledFor";
          if (reminderField === "echeance") {
            event.emailReminder.echeanceStatus = "failed";
          } else {
            event.emailReminder.status = "failed";
          }
          event.emailReminder.failureReason = error.message;
          await event.save();

          await EmailLog.create({
            eventId: event._id,
            workspaceId: event.workspaceId,
            recipientEmail: event.userId?.email || "unknown",
            recipientUserId: event.userId?._id || event.userId,
            reminderType,
            anticipation,
            status: "failed",
            sentAt: new Date(),
            scheduledFor:
              event.emailReminder[failScheduledField] || event.start,
            failureReason: error.message,
            eventSnapshot: {
              title: event.title,
              description: event.description,
              start: event.start,
              end: event.end,
            },
          });
        }
      } catch (logError) {
        logger.error("Erreur lors de l'enregistrement de l'échec:", logError);
      }

      return { success: false, reason: error.message };
    }
  }

  /**
   * Décalage (en ms) d'un fuseau par rapport à UTC pour une date donnée.
   * Indépendant du fuseau du serveur (le décalage de parsing s'annule).
   */
  tzOffsetMs(timeZone, date) {
    const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
    const tz = new Date(date.toLocaleString("en-US", { timeZone }));
    return tz.getTime() - utc.getTime();
  }

  /**
   * Renvoie l'instant correspondant à `hours`:`minutes` heure de Paris,
   * pour le jour calendaire (en heure de Paris) de la date fournie.
   */
  atParisHour(date, hours, minutes = 0) {
    const tz = "Europe/Paris";
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date); // "YYYY-MM-DD"
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    // Heure murale interprétée comme UTC, puis corrigée du décalage Paris
    const naive = new Date(`${ymd}T${hh}:${mm}:00Z`);
    const offset = this.tzOffsetMs(tz, naive);
    return new Date(naive.getTime() - offset);
  }

  /**
   * Calcule la date d'envoi en fonction de l'anticipation
   * Pour les événements "toute la journée", la base est 9h00 (au lieu de 00h00)
   */
  calculateScheduledTime(eventStart, anticipation, allDay = false) {
    let scheduledTime = new Date(eventStart);

    // Pour les événements "toute la journée", utiliser 9h00 (heure de Paris)
    // comme référence, indépendamment du fuseau horaire du serveur.
    if (allDay) {
      scheduledTime = this.atParisHour(scheduledTime, 9, 0);
    }

    if (!anticipation) {
      return scheduledTime;
    }

    switch (anticipation) {
      case "0m":
        // Au début de l'événement, pas de soustraction
        break;
      case "5m":
        scheduledTime.setMinutes(scheduledTime.getMinutes() - 5);
        break;
      case "10m":
        scheduledTime.setMinutes(scheduledTime.getMinutes() - 10);
        break;
      case "15m":
        scheduledTime.setMinutes(scheduledTime.getMinutes() - 15);
        break;
      case "1h":
        scheduledTime.setHours(scheduledTime.getHours() - 1);
        break;
      case "3h":
        scheduledTime.setHours(scheduledTime.getHours() - 3);
        break;
      case "1d":
        scheduledTime.setDate(scheduledTime.getDate() - 1);
        break;
      case "3d":
        scheduledTime.setDate(scheduledTime.getDate() - 3);
        break;
    }

    return scheduledTime;
  }
}

export default new EmailReminderService();
