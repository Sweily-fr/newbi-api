/**
 * Relances de l'essai gratuit (pilotées depuis newbi-admin, page Relances).
 *
 * Trois e-mails, envoyés par services/trialNudgeService.js :
 *   - inactive_d7  : J+7, si l'espace est inactif depuis quelques jours
 *   - feedback_d14 : J+14, à tous les essais, « qu'est-ce qui vous manque ? »
 *   - inactive_d30 : fin d'essai, remplace l'e-mail standard de fin d'essai
 *                    (trialEmails.js) quand l'espace est inactif
 *
 * Même gabarit que les autres e-mails d'essai (renderEmail). Les réponses
 * arrivent sur l'adresse de réponse (TRIAL_NUDGE_REPLY_TO, contact@newbi.fr
 * par défaut) : c'est le canal prévu pour les suggestions.
 */
import {
  APP_URL,
  SUBSCRIBE_URL,
  escapeHtml,
  renderEmail,
} from "./trialEmails.js";

export const NUDGE_STEPS = ["inactive_d7", "feedback_d14", "inactive_d30"];

export const TRIAL_NUDGE_REPLY_TO =
  process.env.TRIAL_NUDGE_REPLY_TO || "contact@newbi.fr";

const P_STYLE =
  "font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;";
const LI_STYLE =
  "font-size: 15px; color: #4b5563; margin: 0 0 10px 0; line-height: 1.6;";
const STRONG_STYLE = "color: #1a1a1a;";

const paragraph = (html) => `<p style="${P_STYLE}">${html}</p>`;
const list = (items) =>
  `<ul style="margin: 0 0 20px 0; padding-left: 20px;">${items
    .map((item) => `<li style="${LI_STYLE}">${item}</li>`)
    .join("")}</ul>`;
const strong = (html) => `<strong style="${STRONG_STYLE}">${html}</strong>`;

function greeting(firstName) {
  const name = String(firstName || "").trim();
  return paragraph(name ? `Bonjour ${escapeHtml(name)},` : "Bonjour,");
}

function footerNote(unsubscribeUrl) {
  if (!unsubscribeUrl) return undefined;
  const href = String(unsubscribeUrl).replace(/&/g, "&amp;");
  return `Vous recevez cet e-mail car vous testez Newbi • <a href="${href}" style="color: #9ca3af; text-decoration: underline;">Ne plus recevoir ces e-mails</a>`;
}

function daysLabel(days) {
  return `${days} jour${days > 1 ? "s" : ""}`;
}

/**
 * Construit un e-mail de relance. Fonction pure (aperçus, tests).
 *
 * @param {string} step une valeur de NUDGE_STEPS
 * @param {{ firstName?: string, orgName?: string, daysRemaining?: number,
 *   unsubscribeUrl?: string }} data
 * @returns {{ subject: string, html: string }}
 */
export function buildTrialNudgeEmail(step, data = {}) {
  const org = strong(escapeHtml(data.orgName || "votre entreprise"));
  const footerNoteHtml = footerNote(data.unsubscribeUrl);

  if (step === "inactive_d7") {
    const days = Number.isFinite(data.daysRemaining)
      ? Math.max(1, data.daysRemaining)
      : null;
    return {
      subject: "Où en êtes-vous avec Newbi\u00a0?",
      html: renderEmail({
        preheader:
          "Trois choses à faire en quelques minutes pour profiter de votre essai.",
        badge: "VOTRE ESSAI",
        icon: "👋",
        iconLabel: days
          ? `Encore ${daysLabel(days)} d'essai`
          : "Essai gratuit en cours",
        iconBg: "#eef2ff",
        iconColor: "#4338ca",
        title: "Où en êtes-vous avec Newbi\u00a0?",
        bodyHtml: `
          ${greeting(data.firstName)}
          ${paragraph(`Vous avez créé l'espace ${org} sur Newbi il y a une semaine. Pour profiter pleinement de votre essai gratuit, voici trois choses qui ne prennent que quelques minutes\u00a0:`)}
          ${list([
            `${strong("Créer votre premier devis ou votre première facture")}, avec votre logo et vos mentions légales.`,
            `${strong("Connecter votre compte bancaire")} pour suivre votre trésorerie et rapprocher vos paiements.`,
            `${strong("Déposer une facture fournisseur")}\u00a0: elle est lue automatiquement, sans ressaisie.`,
          ])}
          ${paragraph("Une question, un blocage\u00a0? Répondez simplement à cet e-mail, l'équipe vous répond.")}`,
        ctaLabel: "Reprendre mon essai",
        ctaUrl: `${APP_URL}/dashboard`,
        footerNoteHtml,
      }),
    };
  }

  if (step === "feedback_d14") {
    const mailto = `mailto:${TRIAL_NUDGE_REPLY_TO}?subject=${encodeURIComponent("Mes idées pour Newbi")}`;
    return {
      subject: "Qu'est-ce qui vous manque sur Newbi\u00a0?",
      html: renderEmail({
        preheader:
          "Votre avis nous aide à choisir les prochaines fonctionnalités.",
        badge: "VOTRE AVIS",
        icon: "💡",
        iconLabel: "2 semaines d'essai",
        iconBg: "#fef9c3",
        iconColor: "#854d0e",
        title: "Qu'est-ce qui vous manque sur Newbi\u00a0?",
        bodyHtml: `
          ${greeting(data.firstName)}
          ${paragraph(`Cela fait deux semaines que vous testez Newbi avec ${org}. Nous construisons l'outil avec celles et ceux qui l'utilisent, et votre avis nous intéresse\u00a0:`)}
          ${list([
            "une fonctionnalité qui vous manque\u00a0;",
            "quelque chose qui vous a freiné ou paru compliqué\u00a0;",
            "une idée qui vous ferait gagner du temps.",
          ])}
          ${paragraph("Répondez simplement à cet e-mail, même en une phrase\u00a0: chaque message est lu par l'équipe.")}`,
        ctaLabel: "Partager mon idée",
        ctaUrl: mailto,
        footerNoteHtml,
      }),
    };
  }

  if (step === "inactive_d30") {
    return {
      subject: "Votre essai Newbi est terminé, vos données vous attendent",
      html: renderEmail({
        preheader: "Vos données sont conservées. Reprenez quand vous voulez.",
        badge: "ESSAI TERMINÉ",
        icon: "🔒",
        iconLabel: "Accès lecture seule",
        iconBg: "#f1f5f9",
        iconColor: "#475569",
        title: "Votre essai gratuit est terminé",
        bodyHtml: `
          ${greeting(data.firstName)}
          ${paragraph(`L'essai gratuit de ${org} vient de se terminer. Si vous n'avez pas eu le temps de tester Newbi comme vous le souhaitiez, rien n'est perdu\u00a0: vos données restent ${strong("en sécurité et consultables")} en lecture seule.`)}
          ${paragraph("Pour reprendre la création de vos factures, devis et clients, il vous suffit de choisir un plan.")}
          ${paragraph("Et si quelque chose vous a freiné pendant l'essai, dites-le-nous en répondant à cet e-mail\u00a0: nous lisons chaque message.")}`,
        ctaLabel: "Choisir un plan",
        ctaUrl: SUBSCRIBE_URL,
        trustHtml:
          "<strong>Vos données vous appartiennent\u00a0:</strong> elles sont conservées en sécurité et restent accessibles en lecture seule, sans limite de durée.",
        footerNoteHtml,
      }),
    };
  }

  throw new Error(`Relance d'essai inconnue : ${step}`);
}
