/**
 * Boîtes d'envoi de la prospection : connexion (retour OAuth), jetons
 * (rafraîchis avant expiration), expiration (e-mail au membre, une fois),
 * déconnexion (révocation au mieux, jetons effacés, prospections en pause)
 * et envois du jour.
 */
import MailboxConnection, {
  DEFAULT_END_HOUR,
  DEFAULT_SEND_DAYS,
  DEFAULT_START_HOUR,
  decryptToken,
  encryptToken,
} from "../../models/MailboxConnection.js";
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import ProspectingSequence from "../../models/ProspectingSequence.js";
import logger from "../../utils/logger.js";
import { startOfParisDay } from "../../utils/parisDate.js";
import { isFreeEmailDomain } from "../emailCampaigns/sendingDomains.js";
import { defaultDailyLimit } from "./config.js";
import { notifyMailboxExpired } from "./notifications.js";
import { mailProvider } from "./providers/index.js";

// Jeton renouvelé s'il expire dans moins de 5 minutes
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

export const MAILBOX_PAUSE_REASONS = {
  disconnected:
    "Boîte d'envoi déconnectée : reconnectez-la, puis reprenez la prospection.",
  changed:
    "Une autre adresse a été connectée comme boîte d'envoi : vérifiez la prospection, puis reprenez-la.",
  reputation:
    "Boîte d'envoi suspendue pour protéger votre réputation : relisez votre message et votre liste, puis reprenez la prospection.",
  rights:
    "Le propriétaire de la boîte d'envoi n'a plus le droit d'envoyer de prospection dans cet espace.",
};

/** Adresse de messagerie gratuite (gmail.com, outlook.*, hotmail.*…). */
export const isPersonalAddress = (email) =>
  isFreeEmailDomain(String(email || "").split("@")[1] || "");

/** E-mails partis de la boîte aujourd'hui (jour de Paris, réels + simulés). */
export function countSentToday(mailboxId, now = new Date()) {
  return ProspectingRecipient.countDocuments({
    mailboxId,
    sentAt: { $gte: startOfParisDay(now) },
  });
}

const safeDecrypt = (value) => {
  try {
    return decryptToken(value);
  } catch (error) {
    logger.warn(`[prospection] jeton illisible : ${error.message}`);
    return null;
  }
};

/** Prospections en cours d'une boîte mises en pause (MAILBOX). */
export async function pauseMailboxSequences(mailboxId, reason) {
  const result = await ProspectingSequence.updateMany(
    { mailboxId, status: "ACTIVE" },
    { $set: { status: "PAUSED", pauseKind: "MAILBOX", pausedReason: reason } },
  );
  return result.modifiedCount || 0;
}

/**
 * Jeton d'accès valable, renouvelé si besoin (`force` : renouvelé même s'il
 * paraît valable, après un refus du fournisseur). Lève MailProviderError.
 */
export async function ensureAccessToken(
  mailbox,
  { now = new Date(), force = false } = {},
) {
  const access = safeDecrypt(mailbox.accessToken);
  const expiresAt = mailbox.tokenExpiresAt
    ? new Date(mailbox.tokenExpiresAt).getTime()
    : 0;
  if (!force && access && expiresAt - TOKEN_MARGIN_MS > now.getTime()) {
    return access;
  }
  const tokens = await mailProvider(mailbox.provider).refreshAccessToken(
    safeDecrypt(mailbox.refreshToken),
  );
  const set = {
    accessToken: encryptToken(tokens.accessToken),
    tokenExpiresAt: tokens.expiresAt,
  };
  if (tokens.refreshToken) set.refreshToken = encryptToken(tokens.refreshToken);
  await MailboxConnection.updateOne({ _id: mailbox._id }, { $set: set });
  mailbox.accessToken = set.accessToken;
  mailbox.tokenExpiresAt = set.tokenExpiresAt;
  if (set.refreshToken) mailbox.refreshToken = set.refreshToken;
  return tokens.accessToken;
}

/**
 * Jeton refusé par le fournisseur : boîte EXPIRED (ses prospections
 * attendent sa reconnexion), membre prévenu par e-mail une seule fois.
 */
export async function markMailboxExpired(mailbox, message, now = new Date()) {
  const updated = await MailboxConnection.findOneAndUpdate(
    { _id: mailbox._id, status: { $ne: "DISCONNECTED" } },
    {
      $set: {
        status: "EXPIRED",
        lastError: String(message || "Autorisation refusée").slice(0, 500),
        lockedUntil: null,
        nextSendAfter: null,
      },
    },
    { new: true },
  ).lean();
  if (!updated) return false;
  logger.warn(
    `[prospection] boîte ${mailbox._id} expirée : ${String(message).slice(0, 200)}`,
  );
  const claimed = await MailboxConnection.updateOne(
    { _id: mailbox._id, expiredNotifiedAt: null },
    { $set: { expiredNotifiedAt: now } },
  );
  if (claimed.modifiedCount) await notifyMailboxExpired(updated);
  return true;
}

/**
 * Boîte connectée (retour OAuth) : création, ou remplacement de la boîte du
 * membre dans l'espace. Reconnecter remet ACTIVE et garde les réglages ;
 * une autre adresse repart de zéro pour la montée progressive, et les
 * prospections en cours sont mises en pause (le message partirait d'une
 * autre adresse que celle choisie au lancement).
 */
export async function connectMailbox({
  workspaceId,
  userId,
  provider,
  tokens,
  userInfo,
  now = new Date(),
}) {
  const existing = await MailboxConnection.findOne({
    workspaceId,
    userId,
  }).lean();
  const accountEmail = String(userInfo.email).trim().toLowerCase();
  const sameAccount =
    existing &&
    existing.accountEmail === accountEmail &&
    existing.provider === provider;
  const set = {
    provider,
    accountEmail,
    accountName: userInfo.name || null,
    accessToken: encryptToken(tokens.accessToken),
    tokenExpiresAt: tokens.expiresAt || null,
    scopes: Array.isArray(tokens.scopes) ? tokens.scopes : [],
    status: "ACTIVE",
    pausedReason: null,
    pauseKind: null,
    lastError: null,
    expiredNotifiedAt: null,
    lockedUntil: null,
  };
  // Sans nouveau jeton de rafraîchissement, l'ancien sert encore (même compte)
  if (tokens.refreshToken) {
    set.refreshToken = encryptToken(tokens.refreshToken);
  } else if (!sameAccount) {
    set.refreshToken = null;
  }
  if (existing && !sameAccount) {
    set.connectedAt = now;
    set.nextSendAfter = null;
  }
  const mailbox = await MailboxConnection.findOneAndUpdate(
    { workspaceId, userId },
    {
      $set: set,
      $setOnInsert: {
        dailyLimit: defaultDailyLimit(),
        sendWindow: {
          days: [...DEFAULT_SEND_DAYS],
          startHour: DEFAULT_START_HOUR,
          endHour: DEFAULT_END_HOUR,
        },
        signatureId: null,
        ...(existing ? {} : { connectedAt: now }),
      },
    },
    { upsert: true, new: true },
  );
  if (existing && !sameAccount) {
    await pauseMailboxSequences(existing._id, MAILBOX_PAUSE_REASONS.changed);
    // Ancien compte Google : accès révoqué au mieux
    if (existing.provider === "GOOGLE") {
      const oldToken = safeDecrypt(existing.refreshToken);
      if (oldToken && oldToken !== tokens.refreshToken) {
        mailProvider("GOOGLE")
          .revokeToken(oldToken)
          .catch(() => false);
      }
    }
  }
  return mailbox;
}

/**
 * Déconnexion par le membre : accès révoqué chez le fournisseur si possible
 * (Google), jetons effacés, prospections en cours mises en pause (MAILBOX).
 */
export async function disconnectMailbox(mailbox) {
  const token =
    safeDecrypt(mailbox.refreshToken) || safeDecrypt(mailbox.accessToken);
  if (token) {
    try {
      await mailProvider(mailbox.provider).revokeToken(token);
    } catch (error) {
      logger.warn(
        `[prospection] révocation impossible (${mailbox._id}) : ${error.message}`,
      );
    }
  }
  await MailboxConnection.updateOne(
    { _id: mailbox._id },
    {
      $set: {
        status: "DISCONNECTED",
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        scopes: [],
        lockedUntil: null,
        nextSendAfter: null,
        pauseKind: null,
        pausedReason: null,
      },
    },
  );
  await pauseMailboxSequences(mailbox._id, MAILBOX_PAUSE_REASONS.disconnected);
  return true;
}
