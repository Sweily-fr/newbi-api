import DocumentEmailLog from "../models/DocumentEmailLog.js";
import cloudflareService from "./cloudflareService.js";
import { APP_URL } from "../utils/trialEmails.js";
import logger from "../utils/logger.js";

/**
 * Journal des envois de documents par e-mail (DocumentEmailLog) : création à
 * l'envoi, puis remise et ouverture de chaque envoi, y compris les envois
 * plus anciens que le dernier (qui seul reste sur le document).
 */

// États depuis lesquels chaque issue s'applique : un rejet l'emporte sur une
// remise (rejet différé du serveur), jamais l'inverse ; null = envoi antérieur
// au suivi de remise
export const FROM_STATUSES = {
  DELIVERED: [null, "SENT", "DELAYED"],
  DELAYED: [null, "SENT"],
  FAILED: [null, "SENT", "DELAYED", "DELIVERED"],
};

function normalizeAddress(address) {
  const value = String(address || "");
  const bracketed = value.match(/<([^>]+)>/);
  return (bracketed ? bracketed[1] : value).trim().toLowerCase();
}

/**
 * Un événement vise-t-il le destinataire principal ? Resend liste dans `to`
 * les adresses concernées : un rejet d'une copie (Cc, Cci) ne doit pas marquer
 * l'envoi comme non remis au client.
 */
export function concernsRecipient(recipientEmail, to) {
  const recipient = normalizeAddress(recipientEmail);
  if (!recipient || !Array.isArray(to) || to.length === 0) return true;
  return to.some((address) => normalizeAddress(address) === recipient);
}

/**
 * Page Newbi qui montre l'e-mail tel que le client l'a reçu
 */
export function emailLogPreviewUrl(logId) {
  return logId ? `${APP_URL}/dashboard/emails-envoyes/${logId}` : null;
}

/**
 * Enregistre un envoi. Un échec n'annule pas l'envoi, déjà parti : il est
 * seulement journalisé.
 * @returns {Promise<object|null>} l'entrée créée
 */
export async function createEmailLog(entry) {
  try {
    return await DocumentEmailLog.create(entry);
  } catch (error) {
    logger.warn(
      `[DocumentEmailLog] envoi non journalisé (${entry.documentType} ${entry.documentId}): ${error.message}`,
    );
    return null;
  }
}

/**
 * Conserve les fichiers ajoutés à la main à un envoi (bucket privé), pour
 * les rouvrir depuis la page de l'e-mail envoyé. Lancé après l'envoi, déjà
 * parti : un fichier non conservé garde seulement son nom.
 * @param {object} log - entrée créée par createEmailLog
 * @param {Array<{filename: string, content: Buffer, contentType?: string}>} files
 *   fichiers dans l'ordre de log.attachments (hors PDF du document)
 */
export async function storeEmailLogAttachments(log, files) {
  if (!log?._id || !files?.length) return;
  const extraIndexes = log.attachments
    .map((attachment, index) => (attachment.isDocument ? null : index))
    .filter((index) => index !== null);

  const updates = {};
  await Promise.all(
    files.map(async (file, position) => {
      const index = extraIndexes[position];
      if (index === undefined) return;
      const key = `email-attachments/${log.workspaceId}/${log._id}/${index}-${cloudflareService.sanitizeFileName(file.filename)}`;
      try {
        await cloudflareService.uploadEmailAttachment(
          key,
          file.content,
          file.contentType,
          log.workspaceId,
        );
        updates[`attachments.${index}.storageKey`] = key;
        updates[`attachments.${index}.contentType`] = file.contentType || null;
      } catch (error) {
        logger.warn(
          `[DocumentEmailLog] pièce jointe non conservée (${log._id}, ${file.filename}): ${error.message}`,
        );
      }
    }),
  );

  if (Object.keys(updates).length > 0) {
    await DocumentEmailLog.updateOne({ _id: log._id }, { $set: updates });
  }
}

export async function findEmailLogId(resendMessageId) {
  if (!resendMessageId) return null;
  const log = await DocumentEmailLog.findOne({ resendMessageId })
    .select("_id")
    .lean();
  return log?._id || null;
}

/**
 * Applique une issue de remise (DELIVERED, DELAYED, FAILED) à l'envoi
 * @returns {Promise<boolean>} true si l'envoi est journalisé
 */
export async function recordEmailLogDelivery({
  resendMessageId,
  to = null,
  status,
  reason = null,
  at = new Date(),
}) {
  if (!resendMessageId) return false;
  const log = await DocumentEmailLog.findOne({ resendMessageId })
    .select("_id to")
    .lean();
  if (!log) return false;
  if (!concernsRecipient(log.to, to)) return true;

  const set = { deliveryStatus: status };
  if (status === "DELIVERED") set.deliveredAt = at;
  if (status === "FAILED") {
    set.deliveryFailedAt = at;
    set.deliveryFailureReason = reason;
  }
  await DocumentEmailLog.updateOne(
    { _id: log._id, deliveryStatus: { $in: FROM_STATUSES[status] } },
    { $set: set },
  );
  return true;
}

/**
 * Première ouverture d'un envoi, par le pixel (trackingToken) ou par le
 * webhook Resend (resendMessageId)
 */
export async function markEmailLogOpened(
  { trackingToken, resendMessageId },
  at = new Date(),
) {
  const filter = trackingToken
    ? { trackingToken }
    : resendMessageId
      ? { resendMessageId }
      : null;
  if (!filter) return;
  try {
    await DocumentEmailLog.updateOne(
      { ...filter, openedAt: null },
      { $set: { openedAt: at } },
    );
  } catch (error) {
    logger.warn(`[DocumentEmailLog] ouverture non notée: ${error.message}`);
  }
}
