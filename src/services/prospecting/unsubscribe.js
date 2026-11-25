/**
 * Désinscription d'un destinataire de prospection et coupe-circuit de
 * réputation de sa boîte d'envoi.
 *
 * Désinscription (lien « Se désinscrire », désabonnement en un clic des
 * messageries, ou « Ne plus contacter » marqué par l'espace après une
 * réponse) : l'adresse entre dans la liste d'exclusion de l'espace, commune
 * avec les campagnes (motif UNSUBSCRIBED, jamais retirable), et le
 * destinataire passe en UNSUBSCRIBED (ou SKIPPED s'il attendait encore son
 * tour). Idempotent.
 *
 * Coupe-circuit, après chaque désinscription : si la boîte compte au moins
 * 30 vrais envois parmi ses 100 derniers et plus de 10 % de désinscrits,
 * elle est suspendue (PAUSED, pauseKind REPUTATION) et ses prospections en
 * cours passent en pause (MAILBOX). Reprise à la main : reprendre une
 * prospection réactive la boîte (sequences.js, resumeSequence).
 */
import MailboxConnection from "../../models/MailboxConnection.js";
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { upsertSuppression } from "../emailCampaigns/events.js";
import { MAILBOX_PAUSE_REASONS, pauseMailboxSequences } from "./mailboxes.js";
import { completeSequenceIfDone, refreshSequenceStats } from "./stats.js";

export const REPUTATION_WINDOW = 100;
export const REPUTATION_MIN_REAL_SENDS = 30;
export const MAX_UNSUBSCRIBE_RATE = 0.1;

// Statuts d'un message parti (le destinataire a pu le lire)
const SENT_STATUSES = ["SENT", "SIMULATED", "REPLIED", "BOUNCED"];

const percent = (rate) =>
  new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);

/**
 * Coupe-circuit de la boîte. @returns {Promise<boolean>} boîte suspendue
 * par cet appel
 */
export async function evaluateMailboxReputation(mailboxId) {
  const recent = await ProspectingRecipient.find({
    mailboxId,
    sentAt: { $ne: null },
  })
    .sort({ sentAt: -1, _id: -1 })
    .limit(REPUTATION_WINDOW)
    .select("simulated status unsubscribedAt")
    .lean();
  const real = recent.filter((recipient) => !recipient.simulated);
  if (real.length < REPUTATION_MIN_REAL_SENDS) return false;
  const unsubscribed = real.filter(
    (recipient) =>
      recipient.status === "UNSUBSCRIBED" || Boolean(recipient.unsubscribedAt),
  ).length;
  const rate = unsubscribed / real.length;
  if (rate <= MAX_UNSUBSCRIBE_RATE) return false;
  const reason = `Envois suspendus pour protéger votre réputation : ${percent(rate)} des destinataires de vos ${real.length} derniers envois se sont désinscrits (seuil : ${percent(MAX_UNSUBSCRIBE_RATE)}). Relisez votre message et votre liste, puis reprenez une prospection pour réactiver la boîte.`;
  const result = await MailboxConnection.updateOne(
    { _id: mailboxId, status: "ACTIVE" },
    {
      $set: {
        status: "PAUSED",
        pauseKind: "REPUTATION",
        pausedReason: reason,
        lockedUntil: null,
      },
    },
  );
  if (!result.modifiedCount) return false;
  await pauseMailboxSequences(mailboxId, MAILBOX_PAUSE_REASONS.reputation);
  logger.warn(
    `[prospection] boîte ${mailboxId} suspendue (réputation) : ${unsubscribed} désinscrits sur ${real.length} envois`,
  );
  return true;
}

/**
 * Désinscrit un destinataire (idempotent). `source` : prospecting-link,
 * prospecting-one-click ou prospecting-reply (« Ne plus contacter »).
 * @returns {Promise<object|null>} le destinataire (avant changement), null
 *   s'il n'existe pas
 */
export async function unsubscribeProspectingRecipient(
  recipientId,
  {
    source = "prospecting-link",
    skippedReason = "désinscrit",
    createdBy = null,
    now = new Date(),
  } = {},
) {
  const id = toObjectIdOrNull(String(recipientId));
  if (!id) return null;
  const recipient = await ProspectingRecipient.findById(id)
    .select("workspaceId sequenceId mailboxId clientId email status")
    .lean();
  if (!recipient) return null;
  await upsertSuppression({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
    reason: "UNSUBSCRIBED",
    sequenceId: recipient.sequenceId,
    source,
    createdBy,
  });
  // Message parti : désinscrit (une seule fois)
  const unsubscribed = await ProspectingRecipient.updateOne(
    { _id: id, status: { $in: SENT_STATUSES } },
    { $set: { status: "UNSUBSCRIBED", unsubscribedAt: now } },
  );
  let changed = unsubscribed.modifiedCount > 0;
  if (!changed) {
    // Pas encore parti (et pas en cours d'envoi) : écarté
    const skipped = await ProspectingRecipient.updateOne(
      { _id: id, status: "PENDING", lockedAt: null },
      { $set: { status: "SKIPPED", skippedReason, unsubscribedAt: now } },
    );
    changed = skipped.modifiedCount > 0;
  }
  if (changed) {
    await refreshSequenceStats(recipient.sequenceId);
    await completeSequenceIfDone(recipient.sequenceId, now);
  }
  await evaluateMailboxReputation(recipient.mailboxId);
  return recipient;
}
