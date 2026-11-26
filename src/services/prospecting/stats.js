/**
 * Compteurs d'une prospection : nombre de destinataires par statut actuel,
 * `recipients` = tous. Recalculés depuis les destinataires après chaque
 * changement (quelques dizaines d'envois par jour : un regroupement indexé
 * coûte peu et ne dérive jamais).
 */
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import ProspectingSequence, {
  EMPTY_SEQUENCE_STATS,
} from "../../models/ProspectingSequence.js";
import logger from "../../utils/logger.js";

/** Compteurs calculés : { recipients, pending, sent, … }. */
export async function computeSequenceStats(sequenceId) {
  const rows = await ProspectingRecipient.aggregate([
    { $match: { sequenceId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const stats = { ...EMPTY_SEQUENCE_STATS };
  for (const row of rows) {
    const key = String(row._id || "").toLowerCase();
    if (Object.hasOwn(stats, key) && key !== "recipients") {
      stats[key] = row.count;
    }
    stats.recipients += row.count;
  }
  return stats;
}

/** Recalcule et enregistre les compteurs. */
export async function refreshSequenceStats(sequenceId) {
  const stats = await computeSequenceStats(sequenceId);
  await ProspectingSequence.updateOne({ _id: sequenceId }, { $set: { stats } });
  return stats;
}

/**
 * Prospection en cours sans plus aucun envoi en attente : COMPLETED.
 * @returns {Promise<boolean>} terminée par cet appel
 */
export async function completeSequenceIfDone(sequenceId, now = new Date()) {
  const pending = await ProspectingRecipient.exists({
    sequenceId,
    status: "PENDING",
  });
  if (pending) return false;
  const result = await ProspectingSequence.updateOne(
    { _id: sequenceId, status: "ACTIVE" },
    { $set: { status: "COMPLETED", completedAt: now } },
  );
  if (result.modifiedCount) {
    logger.info(`[prospection] prospection ${sequenceId} terminée`);
  }
  return result.modifiedCount > 0;
}
