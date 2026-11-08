/**
 * E-mails des visiteurs d'un accès client (documents partagés) : code de
 * vérification de l'adresse, demande d'accès approuvée ou refusée. Mêmes
 * messages que pour un tableau kanban partagé, adaptés aux documents.
 */
import logger from "./logger.js";
import { escapeHtml, renderEmail, sendRenderedEmail } from "./trialEmails.js";

const paragraph = (html, margin = "0 0 16px 0") =>
  `<p style="font-size: 15px; color: #4b5563; margin: ${margin}; line-height: 1.6;">${html}</p>`;

async function deliver({ to, subject, html, text, label }) {
  try {
    await sendRenderedEmail({ to, subject, html, text });
    return true;
  } catch (error) {
    logger.error(
      `[DocumentShare] E-mail « ${label} » non envoyé : ${error.message}`,
    );
    return false;
  }
}

export function buildDocumentShareCodeEmail({ code, workspaceName }) {
  const from = workspaceName || "votre interlocuteur";
  return {
    subject: `Votre code d'accès : ${code}`,
    text: `Votre code pour accéder aux documents partagés par ${from} : ${code}\n\nIl est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
    html: renderEmail({
      preheader: `Votre code d'accès : ${code}`,
      badge: "CODE D'ACCÈS",
      title: "Vos documents partagés",
      bodyHtml: `
        ${paragraph(`Voici votre code pour accéder aux documents partagés par <strong style="color: #1a1a1a;">${escapeHtml(from)}</strong> :`, "0 0 24px 0")}
        <p style="text-align: center; font-size: 32px; font-weight: 600; letter-spacing: 8px; color: #1a1a1a; margin: 0 0 24px 0;">${escapeHtml(code)}</p>
        ${paragraph("Il est valable 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.", "0")}
      `,
      footerNoteHtml: "E-mail automatique, merci de ne pas répondre",
    }),
  };
}

export function buildDocumentShareApprovedEmail(
  to,
  { recipientName, workspaceName, shareUrl },
) {
  const from = workspaceName || "votre interlocuteur";
  return {
    subject: "Votre accès aux documents a été rétabli",
    text: `Bonjour ${recipientName || ""},\n\n${from} a approuvé votre demande d'accès. Vous pouvez de nouveau consulter les documents partagés : ${shareUrl}`,
    html: renderEmail({
      preheader: "Vous pouvez de nouveau consulter les documents.",
      badge: "ACCÈS APPROUVÉ",
      title: "Votre accès a été rétabli",
      bodyHtml: `
        ${paragraph(`Bonjour ${escapeHtml(recipientName || to)},`)}
        ${paragraph(`<strong style="color: #1a1a1a;">${escapeHtml(from)}</strong> a approuvé votre demande d'accès. Vous pouvez de nouveau consulter les documents partagés.`, "0 0 24px 0")}
      `,
      ctaLabel: "Accéder aux documents",
      ctaUrl: shareUrl,
      footerNoteHtml: "E-mail automatique, merci de ne pas répondre",
    }),
  };
}

export function buildDocumentShareRejectedEmail(
  to,
  { recipientName, workspaceName },
) {
  const from = workspaceName || "votre interlocuteur";
  return {
    subject: "Votre demande d'accès aux documents",
    text: `Bonjour ${recipientName || ""},\n\n${from} n'a pas donné suite à votre demande d'accès aux documents partagés. Si vous pensez qu'il s'agit d'une erreur, contactez directement votre interlocuteur.`,
    html: renderEmail({
      preheader: "Votre demande d'accès n'a pas été acceptée.",
      badge: "DEMANDE D'ACCÈS",
      title: "Votre demande n'a pas été acceptée",
      bodyHtml: `
        ${paragraph(`Bonjour ${escapeHtml(recipientName || to)},`)}
        ${paragraph(`<strong style="color: #1a1a1a;">${escapeHtml(from)}</strong> n'a pas donné suite à votre demande d'accès aux documents partagés.`)}
        ${paragraph("Si vous pensez qu'il s'agit d'une erreur, contactez directement votre interlocuteur.", "0")}
      `,
      footerNoteHtml: "E-mail automatique, merci de ne pas répondre",
    }),
  };
}

export const sendDocumentShareCodeEmail = (to, data) =>
  deliver({ to, label: "code", ...buildDocumentShareCodeEmail(data) });

export const sendDocumentShareApprovedEmail = (to, data) =>
  deliver({
    to,
    label: "accès approuvé",
    ...buildDocumentShareApprovedEmail(to, data),
  });

export const sendDocumentShareRejectedEmail = (to, data) =>
  deliver({
    to,
    label: "accès refusé",
    ...buildDocumentShareRejectedEmail(to, data),
  });
