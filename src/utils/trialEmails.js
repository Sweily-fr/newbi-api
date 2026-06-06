/**
 * App-managed trial emails — used by the trialCleanupCron.
 *
 * Two events:
 *   - J-3 reminder (sendTrialEndingEmail) — gentle nudge, "x days left"
 *   - J0 ended    (sendTrialEndedEmail)   — incitatif et rassurant
 *                                          (décision #7)
 *
 * Reuses the existing nodemailer transporter from emailService.js (SMTP).
 * Templates follow the shared Newbi email design (cf. NewbiV2
 * src/lib/email-templates) : logo header, notification badge, white card,
 * black CTA, legal footer — built here via `renderEmail` so the look stays
 * consistent with the rest of the product emails.
 */
import nodemailer from "nodemailer";
import logger from "./logger.js";

let _transporter = null;
function transporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: false },
  });
  return _transporter;
}

const FROM =
  process.env.SMTP_FROM || process.env.SMTP_USER || "noreply@newbi.fr";
const APP_URL = process.env.FRONTEND_URL || "https://www.newbi.fr";
// L'abonnement (choix des plans) s'ouvre via la modale de paramètres du
// dashboard, pilotée par les query params lus par OAuthCallbackHandler.
// `APP_URL` vient de FRONTEND_URL → s'adapte localhost / staging / prod.
const SUBSCRIBE_URL = `${APP_URL}/dashboard?openSettings=true&settingsTab=subscription`;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LOGO_BLACK =
  "https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png";
const LOGO_PURPLE =
  "https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png";

function formatTodayFr() {
  return new Date()
    .toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    })
    .toUpperCase();
}

/**
 * Shared Newbi email layout — mirrors the design used across the product
 * emails (NewbiV2 src/lib/email-templates). All sub-templates feed it their
 * content so the header, card, CTA and footer stay identical everywhere.
 */
function renderEmail({
  preheader,
  badge,
  icon,
  iconLabel,
  iconBg,
  iconColor,
  title,
  bodyHtml,
  ctaLabel,
  ctaUrl,
  trustHtml,
}) {
  return `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(title)}</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
      ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>` : ""}
      <div style="max-width: 600px; margin: 0 auto; padding: 0 20px; background-color: #fafafa;">

        <!-- Logo -->
        <div style="text-align: center; padding: 40px 0 24px 0;">
          <img src="${LOGO_BLACK}" alt="Newbi" style="height: 32px; width: auto;">
        </div>

        <!-- Type de notification -->
        <div style="text-align: center; margin-bottom: 8px;">
          <span style="font-size: 11px; font-weight: 600; color: #1a1a1a; letter-spacing: 0.5px; text-transform: uppercase;">
            ${escapeHtml(badge)}
          </span>
        </div>

        <!-- Date -->
        <div style="text-align: center; margin-bottom: 32px;">
          <span style="font-size: 12px; color: #6b7280;">${formatTodayFr()}</span>
        </div>

        <!-- Carte principale -->
        <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 24px; margin-bottom: 32px;">

          ${
            icon
              ? `<!-- Badge d'icône -->
          <div style="margin-bottom: 20px;">
            <div style="display: inline-flex; align-items: center; background-color: ${iconBg}; border-radius: 6px; padding: 8px 12px;">
              <span style="font-size: 16px; margin-right: 8px;">${icon}</span>
              <span style="font-size: 11px; font-weight: 500; color: ${iconColor}; letter-spacing: 0.3px; text-transform: uppercase;">${escapeHtml(iconLabel)}</span>
            </div>
          </div>`
              : ""
          }

          <!-- Titre -->
          <h1 style="font-size: 26px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0; line-height: 1.3;">
            ${escapeHtml(title)}
          </h1>

          ${bodyHtml}

          <!-- Bouton CTA -->
          <a href="${String(ctaUrl).replace(/&/g, "&amp;")}" style="display: block; background-color: #1a1a1a; color: #ffffff; text-decoration: none; padding: 16px 24px; border-radius: 6px; font-weight: 500; font-size: 15px; text-align: center; margin-top: 8px;">
            ${escapeHtml(ctaLabel)}
          </a>
        </div>

        ${
          trustHtml
            ? `<!-- Encart confiance -->
        <div style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin-bottom: 32px;">
          <p style="font-size: 14px; color: #166534; margin: 0; line-height: 1.6;">${trustHtml}</p>
        </div>`
            : ""
        }

        <div style="height: 48px;"></div>

        <!-- Footer -->
        <div style="border-top: 1px solid #e5e7eb; padding-top: 32px; text-align: center;">
          <div style="margin-bottom: 16px;">
            <img src="${LOGO_PURPLE}" alt="Newbi" style="height: 28px; width: auto;">
          </div>
          <p style="font-size: 13px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0;">
            Votre gestion, simplifiée.
          </p>
          <p style="font-size: 12px; color: #9ca3af; margin: 0 0 24px 0; line-height: 1.8;">
            Vous pouvez gérer vos notifications dans les paramètres de votre compte • <a href="${APP_URL}/aide" style="color: #9ca3af; text-decoration: underline;">FAQ</a>
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
}

/**
 * Pure builder for the J-3 reminder email — returns `{ subject, html }`.
 * Kept separate from sending so it can be rendered for previews/tests.
 */
export function buildTrialEndingEmail({ orgName, daysRemaining } = {}) {
  const safeOrg = escapeHtml(orgName || "votre organisation");
  const safeDays = Number.isFinite(daysRemaining) ? daysRemaining : 3;
  const dayLabel = `${safeDays} jour${safeDays > 1 ? "s" : ""}`;
  const subject = `Votre essai Newbi se termine dans ${dayLabel}`;
  const html = renderEmail({
    preheader: `Il vous reste ${dayLabel} pour choisir votre plan Newbi.`,
    badge: "FIN D'ESSAI IMMINENTE",
    icon: "⏰",
    iconLabel: `${dayLabel} restant${safeDays > 1 ? "s" : ""}`,
    iconBg: "#fef3c7",
    iconColor: "#92400e",
    title: "Votre essai gratuit se termine bientôt",
    bodyHtml: `
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">Bonjour,</p>
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">
            L'essai gratuit de <strong style="color: #1a1a1a;">${safeOrg}</strong> sur Newbi se termine dans <strong style="color: #1a1a1a;">${dayLabel}</strong>.
          </p>
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 24px 0; line-height: 1.6;">
            Pour continuer à utiliser pleinement Newbi sans interruption, choisissez un plan dès maintenant.
          </p>`,
    ctaLabel: "Choisir un plan",
    ctaUrl: SUBSCRIBE_URL,
  });
  return { subject, html };
}

/**
 * J-3 reminder. Sent once per organization (anti-double-send handled by the
 * cron via `trialEndingEmailSentAt` on the organization document).
 */
export async function sendTrialEndingEmail({ to, orgName, daysRemaining }) {
  if (!to) {
    logger.warn("[TrialEmails] sendTrialEndingEmail: missing recipient");
    return;
  }
  const { subject, html } = buildTrialEndingEmail({ orgName, daysRemaining });
  try {
    await transporter().sendMail({ from: FROM, to, subject, html });
    logger.info(`[TrialEmails] J-3 reminder sent to ${to} (org=${orgName})`);
  } catch (error) {
    logger.error(
      `[TrialEmails] J-3 reminder failed for ${to}: ${error.message}`,
    );
    throw error;
  }
}

/**
 * Pure builder for the J0 expiration email (décision #7 : ton incitatif et
 * rassurant) — returns `{ subject, html }`. Sending lives in the function below.
 */
export function buildTrialEndedEmail({ orgName } = {}) {
  const safeOrg = escapeHtml(orgName || "votre organisation");
  const subject =
    "Votre essai Newbi est terminé — vos données sont en sécurité";
  const html = renderEmail({
    preheader: "Vos données sont en sécurité. Choisissez un plan pour reprendre.",
    badge: "ESSAI TERMINÉ",
    icon: "🔒",
    iconLabel: "Accès lecture seule",
    iconBg: "#f1f5f9",
    iconColor: "#475569",
    title: "Votre essai gratuit est terminé",
    bodyHtml: `
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">Bonjour,</p>
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">
            L'essai gratuit de <strong style="color: #1a1a1a;">${safeOrg}</strong> vient de se terminer. Vos données restent <strong style="color: #1a1a1a;">en sécurité et consultables</strong> à tout moment — rien n'est perdu, vous gardez l'accès en lecture seule.
          </p>
          <p style="font-size: 15px; color: #4b5563; margin: 0 0 24px 0; line-height: 1.6;">
            Pour reprendre la création et la modification de vos factures, devis, clients et automatisations, il vous suffit de choisir un plan :
          </p>`,
    ctaLabel: "Choisir un plan",
    ctaUrl: SUBSCRIBE_URL,
    trustHtml:
      "<strong>Vos données vous appartiennent :</strong> elles sont conservées en sécurité et restent accessibles en lecture seule, sans limite de durée.",
  });
  return { subject, html };
}

/**
 * J0 expiration — décision #7 : ton incitatif et rassurant.
 * Sent once per organization (anti-doublon via `trialEndedEmailSentAt`).
 */
export async function sendTrialEndedEmail({ to, orgName }) {
  if (!to) {
    logger.warn("[TrialEmails] sendTrialEndedEmail: missing recipient");
    return;
  }
  const { subject, html } = buildTrialEndedEmail({ orgName });
  try {
    await transporter().sendMail({ from: FROM, to, subject, html });
    logger.info(`[TrialEmails] J0 ended email sent to ${to} (org=${orgName})`);
  } catch (error) {
    logger.error(
      `[TrialEmails] J0 ended email failed for ${to}: ${error.message}`,
    );
    throw error;
  }
}
