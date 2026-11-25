/**
 * Accords de suivi des campagnes e-mail, par adresse et par espace
 * (recommandation CNIL sur les pixels de suivi) : voir le modèle
 * EmailTrackingConsent.
 *
 *   - le destinataire choisit sur la page de préférences (CONTACT) : son
 *     choix l'emporte, l'espace ne peut ni le changer ni le retirer ;
 *   - l'espace saisit des accords qu'il atteste avoir recueillis, ou des
 *     refus (SENDER), et peut retirer ses propres saisies ;
 *   - un refus, ou un accord retiré, efface ce qui a été suivi pour
 *     l'adresse dans tout l'espace (dates et nombres d'ouvertures et de
 *     clics, chaque clic) et coupe le suivi des e-mails encore à envoyer.
 */
import EmailCampaignClick from "../../models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../models/EmailCampaignRecipient.js";
import EmailTrackingConsent from "../../models/EmailTrackingConsent.js";
import { isValidEmail } from "../../utils/validators.js";
import { normalizeEmail } from "./audience.js";

export const MAX_GRANT_EMAILS = 500;
const HISTORY_MAX = 20;
const NOTE_MAX = 200;

export const GRANT_SKIP_REASONS = Object.freeze({
  invalid: "INVALID",
  contactRefused: "CONTACT_REFUSED",
});

const historyEntry = ({ status, source, at, byName, note, campaignId }) => ({
  status,
  source,
  at,
  byName: byName || null,
  note: note || null,
  campaignId: campaignId || null,
});

/** Adresses de la liste qui ont accepté le suivi dans l'espace. */
export async function grantedEmailSet(workspaceId, emails) {
  const addresses = [...new Set((emails || []).map(normalizeEmail))].filter(
    Boolean,
  );
  if (!addresses.length) return new Set();
  const consents = await EmailTrackingConsent.find({
    workspaceId,
    email: { $in: addresses },
    status: "GRANTED",
  })
    .select("email")
    .lean();
  return new Set(consents.map((consent) => consent.email));
}

/**
 * Efface le suivi de l'adresse dans toutes les campagnes de l'espace : plus
 * rien n'est enregistré ni envoyé avec suivi pour elle.
 * @returns {Promise<number>} destinataires touchés
 */
export async function eraseRecipientTracking(workspaceId, email) {
  const address = normalizeEmail(email);
  if (!address) return 0;
  const recipients = await EmailCampaignRecipient.find({
    workspaceId,
    email: address,
  })
    .select("_id")
    .lean();
  if (!recipients.length) return 0;
  const ids = recipients.map((recipient) => recipient._id);
  await EmailCampaignRecipient.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        trackingAllowed: false,
        trackingExpired: true,
        openedAt: null,
        openCount: 0,
        clickedAt: null,
        clickCount: 0,
      },
    },
  );
  await EmailCampaignClick.deleteMany({ recipientId: { $in: ids } });
  return ids.length;
}

/** Enregistre un choix (création ou changement), historique compris. */
async function saveChoice(
  existing,
  { workspaceId, email, status, source, now, by, byName, note, campaignId },
) {
  const entry = historyEntry({
    status,
    source,
    at: now,
    byName,
    note,
    campaignId,
  });
  const fields = {
    status,
    source,
    note: note || null,
    decidedAt: now,
    decidedBy: by || null,
    decidedByName: byName || null,
    campaignId: campaignId || null,
  };
  if (existing) {
    return EmailTrackingConsent.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: fields,
        $push: { history: { $each: [entry], $slice: -HISTORY_MAX } },
      },
      { new: true },
    ).lean();
  }
  try {
    return (
      await EmailTrackingConsent.create({
        workspaceId,
        email,
        ...fields,
        history: [entry],
      })
    ).toObject();
  } catch (error) {
    // Choix enregistré en même temps ailleurs : on rejoue sur lui
    if (error?.code !== 11000) throw error;
    const raced = await EmailTrackingConsent.findOne({ workspaceId, email });
    if (!raced) throw error;
    return saveChoice(raced, {
      workspaceId,
      email,
      status,
      source,
      now,
      by,
      byName,
      note,
      campaignId,
    });
  }
}

/**
 * Choix du destinataire sur la page de préférences (accepter ou refuser).
 * Un refus efface ce qui a été suivi pour son adresse.
 *
 * @param {{ workspaceId, email, campaignId }} recipient
 * @param {"GRANTED"|"REFUSED"} status
 */
export async function recordContactChoice(
  recipient,
  status,
  { now = new Date() } = {},
) {
  const email = normalizeEmail(recipient?.email);
  if (!email || !["GRANTED", "REFUSED"].includes(status)) return null;
  const workspaceId = recipient.workspaceId;
  const existing = await EmailTrackingConsent.findOne({ workspaceId, email });
  const consent = await saveChoice(existing, {
    workspaceId,
    email,
    status,
    source: "CONTACT",
    now,
    campaignId: recipient.campaignId,
  });
  if (status === "REFUSED") await eraseRecipientTracking(workspaceId, email);
  return consent;
}

/**
 * Accords recueillis par l'espace (attestation vérifiée par l'appelant) :
 * adresses invalides et refus du contact lui-même écartés ; un accord déjà
 * donné par le contact est gardé tel quel.
 *
 * @returns {Promise<{ granted: number, skipped: Array<{ email, reason }> }>}
 */
export async function grantBySender({
  workspaceId,
  emails,
  note = null,
  userId = null,
  userName = null,
  now = new Date(),
}) {
  const skipped = [];
  const addresses = [];
  const seen = new Set();
  for (const raw of emails || []) {
    const email = normalizeEmail(raw);
    if (!email || !isValidEmail(email)) {
      skipped.push({
        email: String(raw ?? "").trim(),
        reason: GRANT_SKIP_REASONS.invalid,
      });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    addresses.push(email);
  }
  const cleanNote =
    String(note ?? "")
      .trim()
      .slice(0, NOTE_MAX) || null;
  const existing = new Map(
    (
      await EmailTrackingConsent.find({
        workspaceId,
        email: { $in: addresses },
      })
    ).map((consent) => [consent.email, consent]),
  );
  let granted = 0;
  for (const email of addresses) {
    const current = existing.get(email);
    if (current?.source === "CONTACT") {
      if (current.status === "REFUSED") {
        skipped.push({ email, reason: GRANT_SKIP_REASONS.contactRefused });
      } else {
        granted += 1;
      }
      continue;
    }
    if (current?.status === "GRANTED") {
      granted += 1;
      continue;
    }
    await saveChoice(current, {
      workspaceId,
      email,
      status: "GRANTED",
      source: "SENDER",
      now,
      by: userId,
      byName: userName,
      note: cleanNote,
    });
    granted += 1;
  }
  return { granted, skipped };
}

/**
 * Refus noté par l'espace : suivi coupé et effacé pour l'adresse. Un refus
 * déjà donné par le contact reste le sien.
 */
export async function refuseBySender({
  workspaceId,
  email,
  userId = null,
  userName = null,
  now = new Date(),
}) {
  const address = normalizeEmail(email);
  const existing = await EmailTrackingConsent.findOne({
    workspaceId,
    email: address,
  });
  let consent;
  if (existing?.status === "REFUSED" && existing.source === "CONTACT") {
    consent = existing.toObject();
  } else {
    consent = await saveChoice(existing, {
      workspaceId,
      email: address,
      status: "REFUSED",
      source: "SENDER",
      now,
      by: userId,
      byName: userName,
    });
  }
  await eraseRecipientTracking(workspaceId, address);
  return consent;
}

/**
 * Retire une saisie de l'espace (retour à « aucun choix ») ; un accord
 * retiré efface ce qui a été suivi pour l'adresse.
 * @returns {Promise<"removed"|"not_found"|"contact_choice">}
 */
export async function removeSenderConsent({ workspaceId, id }) {
  const consent = await EmailTrackingConsent.findOne({ _id: id, workspaceId });
  if (!consent) return "not_found";
  if (consent.source !== "SENDER") return "contact_choice";
  await EmailTrackingConsent.deleteOne({
    _id: consent._id,
    workspaceId,
    source: "SENDER",
  });
  if (consent.status === "GRANTED") {
    await eraseRecipientTracking(workspaceId, consent.email);
  }
  return "removed";
}
