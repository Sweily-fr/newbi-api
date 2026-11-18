/**
 * Alertes internes par e-mail : incidents que l'équipe Newbi doit traiter
 * (service d'envoi indisponible, domaine d'envoi mal configuré...).
 *
 * Destinataires : ERROR_ALERT_EMAILS (adresses séparées par des virgules).
 * Variable absente : aucun e-mail (postes de développement), journal seul.
 * Envoi par emailReminderService (Resend des e-mails de documents, repli
 * SMTP), chargé seulement au premier envoi.
 *
 * Dédoublonnage : une alerte par empreinte (source + message) et par
 * période (`cooldownSeconds`, 15 minutes par défaut), partagée entre les
 * instances PM2 par Redis (repli en mémoire), et 20 alertes par heure au
 * plus par instance. Ne lève jamais d'erreur et ne bloque rien.
 */
import crypto from "crypto";
import os from "os";
import { recordAttempt } from "../utils/attemptLimiter.js";
import logger from "../utils/logger.js";

export const DEFAULT_ALERT_COOLDOWN_SECONDS = 15 * 60;
const HOURLY_CAP = 20;

let hourStart = 0;
let sentThisHour = 0;

export function alertRecipients(env = process.env) {
  return String(env.ERROR_ALERT_EMAILS || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

const escape = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Tests : remet le plafond horaire à zéro. */
export function resetErrorAlerts() {
  hourStart = 0;
  sentThisHour = 0;
}

/**
 * Envoie une alerte (une fois par empreinte et par période).
 *
 * @param {object} params
 * @param {string} params.source   origine, ex. « campagnes-domaines »
 * @param {string} params.message  message fixe (l'empreinte en dépend :
 *   les valeurs variables vont dans `context`)
 * @param {string} [params.stack]
 * @param {object} [params.context] paires affichées dans l'e-mail
 * @param {number} [params.cooldownSeconds]
 * @returns {Promise<boolean>} alerte envoyée
 */
export async function notifyError({
  source,
  message,
  stack,
  context = {},
  cooldownSeconds = DEFAULT_ALERT_COOLDOWN_SECONDS,
}) {
  try {
    const fingerprint = crypto
      .createHash("sha1")
      .update(`${source}:${String(message).slice(0, 200)}`)
      .digest("hex");
    const count = await recordAttempt(
      `error-alert:${fingerprint}`,
      Math.max(60, Math.round(cooldownSeconds)),
    );
    if (count > 1) {
      logger.debug(`[alerte] déjà signalée : ${source} : ${message}`);
      return false;
    }
    logger.error(`[alerte] ${source} : ${message}`);

    const recipients = alertRecipients();
    if (!recipients.length) return false;
    const now = Date.now();
    if (now - hourStart > 60 * 60 * 1000) {
      hourStart = now;
      sentThisHour = 0;
    }
    if (sentThisHour >= HOURLY_CAP) {
      logger.warn(
        `[alerte] plafond de ${HOURLY_CAP} alertes par heure atteint : ${source}`,
      );
      return false;
    }
    sentThisHour += 1;

    const env = process.env.NODE_ENV || "development";
    const subject = `[Newbi ${env}] Alerte ${source} : ${String(message).slice(0, 90)}`;
    const rows = Object.entries({
      Source: source,
      Environnement: env,
      Serveur: `${os.hostname()} (instance PM2 ${process.env.NODE_APP_INSTANCE ?? "?"})`,
      Date: new Date(now).toISOString(),
      ...context,
    })
      .filter(
        ([, value]) => value !== undefined && value !== null && value !== "",
      )
      .map(
        ([key, value]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap;vertical-align:top;">${escape(key)}</td><td style="padding:4px 0;">${escape(value)}</td></tr>`,
      )
      .join("");
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:640px;">
<p style="font-weight:600;">${escape(message)}</p>
<table style="border-collapse:collapse;font-size:13px;">${rows}</table>
${stack ? `<pre style="background:#f5f5f5;padding:12px;font-size:12px;white-space:pre-wrap;">${escape(stack)}</pre>` : ""}
<p style="color:#999;font-size:12px;">Alerte automatique de newbi-api, envoyée une fois par période pour un même incident.</p>
</div>`;

    const { default: emailReminderService } =
      await import("./emailReminderService.js");
    const results = await Promise.allSettled(
      recipients.map((to) =>
        emailReminderService.sendEmail({ to, subject, html }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error(
          `[alerte] envoi impossible : ${result.reason?.message || result.reason}`,
        );
      }
    }
    return results.some((result) => result.status === "fulfilled");
  } catch (error) {
    // L'alerte ne doit jamais faire échouer ce qui l'a déclenchée
    logger.error(`[alerte] erreur interne : ${error.message}`);
    return false;
  }
}
