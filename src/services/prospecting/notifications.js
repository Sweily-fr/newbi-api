/**
 * E-mails envoyés par Newbi au membre propriétaire d'une boîte de
 * prospection (e-mails de service de Newbi, par Resend comme les autres :
 * aucun ne part de la boîte du membre).
 */
import mongoose from "mongoose";
import logger from "../../utils/logger.js";
import {
  escapeHtml,
  renderEmail,
  sendRenderedEmail,
} from "../../utils/trialEmails.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { prospectingPageUrl } from "./config.js";
import { PROVIDER_LABELS } from "./providers/index.js";

const P = `style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;"`;

/** E-mail « reconnectez votre boîte » : { subject, html, text }. */
export function buildMailboxExpiredEmail({ accountEmail, provider }) {
  const label = PROVIDER_LABELS[provider] || "de messagerie";
  const address = escapeHtml(accountEmail || "");
  const subject =
    "Reconnectez votre boîte d'envoi pour reprendre vos prospections";
  const url = prospectingPageUrl();
  const html = renderEmail({
    preheader: "Vos prospections sont en attente : reconnectez votre boîte.",
    badge: "PROSPECTION",
    title: "Votre boîte d'envoi doit être reconnectée",
    bodyHtml: `
          <p ${P}>Bonjour,</p>
          <p ${P}>Newbi n'a plus accès à votre boîte ${escapeHtml(label)} <strong style="color: #1a1a1a;">${address}</strong> : l'autorisation a expiré ou a été retirée.</p>
          <p ${P}>Vos prospections sont en attente. Elles reprendront d'elles-mêmes dès que vous aurez reconnecté votre boîte, sans qu'aucun message ne soit envoyé deux fois.</p>`,
    ctaLabel: "Reconnecter ma boîte",
    ctaUrl: url,
  });
  const text = [
    "Bonjour,",
    `Newbi n'a plus accès à votre boîte ${label} ${accountEmail || ""} : l'autorisation a expiré ou a été retirée.`,
    "Vos prospections sont en attente. Elles reprendront d'elles-mêmes dès que vous aurez reconnecté votre boîte, sans qu'aucun message ne soit envoyé deux fois.",
    `Reconnecter ma boîte : ${url}`,
  ].join("\n\n");
  return { subject, html, text };
}

/** Adresse e-mail d'un utilisateur (collection Better Auth). */
export async function userEmail(userId) {
  const id = toObjectIdOrNull(String(userId));
  if (!id) return null;
  const user = await mongoose.connection.db
    .collection("user")
    .findOne({ _id: id }, { projection: { email: 1 } });
  return typeof user?.email === "string" && user.email ? user.email : null;
}

/** Prévient le propriétaire d'une boîte expirée. @returns {Promise<boolean>} */
export async function notifyMailboxExpired(mailbox) {
  const to = await userEmail(mailbox.userId);
  if (!to) return false;
  try {
    await sendRenderedEmail({
      to,
      ...buildMailboxExpiredEmail({
        accountEmail: mailbox.accountEmail,
        provider: mailbox.provider,
      }),
    });
    return true;
  } catch (error) {
    logger.warn(
      `[prospection] e-mail de boîte expirée non envoyé (${mailbox._id}) : ${error.message}`,
    );
    return false;
  }
}
