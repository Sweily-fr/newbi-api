/**
 * App-managed trial emails — used by the trialCleanupCron.
 *
 * Two events:
 *   - J-3 reminder (sendTrialEndingEmail) — gentle nudge, "x days left"
 *   - J0 ended    (sendTrialEndedEmail)   — incitatif et rassurant
 *                                          (décision #7)
 *
 * Reuses the existing nodemailer transporter from emailService.js (SMTP).
 * Templates are intentionally minimal — formatted text + a single CTA URL.
 * If a richer design is needed later, swap to React-Email components like
 * the partner withdrawal emails.
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
const APP_URL = process.env.FRONTEND_URL || "https://newbi.fr";
const SUBSCRIBE_URL = `${APP_URL}/dashboard/parametres/abonnement`;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  const safeOrg = escapeHtml(orgName || "votre organisation");
  const safeDays = Number.isFinite(daysRemaining) ? daysRemaining : 3;
  const subject = `Votre essai Newbi se termine dans ${safeDays} jour${safeDays > 1 ? "s" : ""}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
      <h1 style="font-size:20px;margin:0 0 16px;">Votre essai gratuit se termine bientôt</h1>
      <p>Bonjour,</p>
      <p>L'essai gratuit de <strong>${safeOrg}</strong> sur Newbi se termine dans <strong>${safeDays} jour${safeDays > 1 ? "s" : ""}</strong>.</p>
      <p>Pour continuer à utiliser pleinement Newbi sans interruption, choisissez un plan dès maintenant.</p>
      <p style="margin:24px 0;">
        <a href="${SUBSCRIBE_URL}" style="background:#5b50fe;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Choisir un plan</a>
      </p>
      <p style="color:#666;font-size:13px;">Une question ? Répondez simplement à cet email, on vous aide.</p>
    </div>
  `;
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
 * J0 expiration — décision #7 : ton incitatif et rassurant.
 * Sent once per organization (anti-doublon via `trialEndedEmailSentAt`).
 */
export async function sendTrialEndedEmail({ to, orgName }) {
  if (!to) {
    logger.warn("[TrialEmails] sendTrialEndedEmail: missing recipient");
    return;
  }
  const safeOrg = escapeHtml(orgName || "votre organisation");
  const subject =
    "Votre essai Newbi est terminé — vos données sont en sécurité";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
      <h1 style="font-size:20px;margin:0 0 16px;">Votre essai gratuit est terminé</h1>
      <p>Bonjour,</p>
      <p>L'essai gratuit de <strong>${safeOrg}</strong> vient de se terminer. Vos données restent <strong>en sécurité et consultables</strong> à tout moment — rien n'est perdu, vous gardez l'accès en lecture seule.</p>
      <p>Pour reprendre la création et la modification de vos factures, devis, clients et automatisations, il vous suffit de choisir un plan :</p>
      <p style="margin:24px 0;">
        <a href="${SUBSCRIBE_URL}" style="background:#5b50fe;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:500;">Choisir un plan</a>
      </p>
      <p style="color:#666;font-size:13px;">Une question, un blocage ? Répondez à cet email, on vous accompagne avec plaisir.</p>
    </div>
  `;
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
