/**
 * Réservation atomique d'une adresse prospectée par un espace (collection
 * `prospecting_contacts`, une fiche par adresse et par espace).
 *
 * Juste avant l'appel au fournisseur, l'envoi réserve l'adresse : mise à
 * jour conditionnelle « jamais prospectée, ou plus de 30 jours » (ou déjà
 * réservée par ce même destinataire, après un arrêt), en upsert. Si une
 * autre boîte de l'espace l'a réservée entre-temps, la condition échoue,
 * l'insertion heurte l'index unique (E11000) : l'adresse est déjà prise.
 *
 * Message qui n'est pas parti (jeton refusé, quota, adresse refusée…) :
 * réservation annulée. Message parti, ou peut-être parti (envoi incertain
 * ou interrompu) : réservation gardée.
 */
import ProspectingContact from "../../models/ProspectingContact.js";
import { recentContactSince } from "./audience.js";

/**
 * @returns {Promise<{ reserved: boolean, previous?: object|null }>}
 *   `previous` : fiche d'avant la réservation (null si elle est nouvelle)
 */
export async function reserveContact({
  workspaceId,
  email,
  sequenceId,
  recipientId,
  now = new Date(),
}) {
  try {
    const previous = await ProspectingContact.findOneAndUpdate(
      {
        workspaceId,
        email,
        $or: [
          { lastSentAt: null },
          { lastSentAt: { $lt: recentContactSince(now) } },
          { recipientId },
        ],
      },
      { $set: { lastSentAt: now, sequenceId, recipientId } },
      { upsert: true, new: false },
    ).lean();
    return { reserved: true, previous };
  } catch (error) {
    if (error?.code === 11000) return { reserved: false };
    throw error;
  }
}

/** Annule une réservation : le message n'est pas parti. */
export async function releaseContact({
  workspaceId,
  email,
  recipientId,
  previous,
}) {
  if (previous) {
    await ProspectingContact.updateOne(
      { workspaceId, email, recipientId },
      {
        $set: {
          lastSentAt: previous.lastSentAt ?? null,
          sequenceId: previous.sequenceId ?? null,
          recipientId: previous.recipientId ?? null,
        },
      },
    );
  } else {
    await ProspectingContact.deleteOne({ workspaceId, email, recipientId });
  }
}
