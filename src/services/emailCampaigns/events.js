/**
 * Événements des campagnes e-mail après l'envoi :
 *   - suivi maison : ouverture (pixel), clic (redirection), désinscription ;
 *   - événements de Resend (webhook) : remis, rejeté, plainte, échec,
 *     adresse bloquée ;
 *   - liste d'exclusion de l'espace ;
 *   - coupe-circuit de réputation : après au moins 100 envois réels, plus
 *     de 3 % de rejets ou plus de 0,05 % de plaintes mettent la campagne en
 *     pause (elle ne reprend pas : la réputation du domaine d'envoi et du
 *     compte Resend est commune à tous les clients de Newbi).
 *
 * Compteurs de la campagne en `$inc` atomiques, comptés une fois : la mise à
 * jour du destinataire est conditionnée à la date encore vide.
 */
import EmailCampaign from "../../models/EmailCampaign.js";
import EmailCampaignClick from "../../models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../models/EmailCampaignRecipient.js";
import EmailSuppression from "../../models/EmailSuppression.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { normalizeEmail } from "./audience.js";
import { recipientTracked } from "./tracking.js";

// Seuils sous ceux que Resend impose au compte entier (rejets sous 4 %,
// plaintes sous 0,08 %, sous peine de pause des envois, voire de fermeture
// du compte : https://resend.com/docs/knowledge-base/account-quotas-and-limits
// et https://resend.com/legal/acceptable-use) : une campagne ne peut pas, à
// elle seule, emmener le compte au-delà.
export const REPUTATION_MIN_SENT = 100;
export const MAX_BOUNCE_RATE = 0.03;
export const MAX_COMPLAINT_RATE = 0.0005;

const REASON_RANK = { MANUAL: 0, UNSUBSCRIBED: 1, BOUNCED: 2, COMPLAINED: 3 };

const incrementStats = (campaignId, inc) =>
  Object.keys(inc).length
    ? EmailCampaign.updateOne({ _id: campaignId }, { $inc: inc })
    : null;

/**
 * Ajoute une adresse à la liste d'exclusion de l'espace (idempotent). Un
 * motif plus fort remplace le précédent (MANUAL < UNSUBSCRIBED < BOUNCED <
 * COMPLAINED).
 */
export async function upsertSuppression({
  workspaceId,
  email,
  reason,
  campaignId = null,
  source = null,
  createdBy = null,
}) {
  const address = normalizeEmail(email);
  if (!address || !Object.hasOwn(REASON_RANK, reason)) return null;
  const filter = { workspaceId, email: address };
  let existing = await EmailSuppression.findOne(filter);
  if (!existing) {
    try {
      return await EmailSuppression.create({
        ...filter,
        reason,
        campaignId,
        source,
        createdBy,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      existing = await EmailSuppression.findOne(filter);
      if (!existing) throw error;
    }
  }
  if (REASON_RANK[reason] > REASON_RANK[existing.reason]) {
    existing.reason = reason;
    existing.source = source;
    if (campaignId) existing.campaignId = campaignId;
    await existing.save();
  }
  return existing;
}

// Destinataire sans accord de suivi, ou suivi effacé (durée de conservation
// dépassée, refus de l'adresse) : rien n'est enregistré pour lui
const STILL_TRACKED = {
  trackingAllowed: { $ne: false },
  trackingExpired: { $ne: true },
};

/** Ouverture (pixel) : première ouverture et ouvertures totales. */
export async function recordOpen(recipientId, now = new Date()) {
  const id = toObjectIdOrNull(recipientId);
  if (!id) return false;
  const first = await EmailCampaignRecipient.findOneAndUpdate(
    { _id: id, openedAt: null, ...STILL_TRACKED },
    { $set: { openedAt: now }, $inc: { openCount: 1 } },
    { projection: { campaignId: 1 } },
  ).lean();
  if (first) {
    await incrementStats(first.campaignId, {
      "stats.opened": 1,
      "stats.opens": 1,
    });
    return true;
  }
  const again = await EmailCampaignRecipient.findOneAndUpdate(
    { _id: id, ...STILL_TRACKED },
    { $inc: { openCount: 1 } },
    { projection: { campaignId: 1 } },
  ).lean();
  if (!again) return false;
  await incrementStats(again.campaignId, { "stats.opens": 1 });
  return true;
}

/**
 * Clic sur le lien n° `linkIndex` (vaut aussi ouverture si aucune). Rien
 * n'est enregistré pour un destinataire non suivi (`trackingAllowed`,
 * `trackingExpired`, à lire avec lui).
 */
export async function recordClick(recipient, linkIndex, now = new Date()) {
  if (!recipientTracked(recipient)) return;
  await EmailCampaignClick.create({
    workspaceId: recipient.workspaceId,
    campaignId: recipient.campaignId,
    recipientId: recipient._id,
    linkIndex,
    at: now,
  });
  const inc = { "stats.clicks": 1 };
  const first = await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, clickedAt: null, ...STILL_TRACKED },
    { $set: { clickedAt: now }, $inc: { clickCount: 1 } },
  );
  if (first.modifiedCount) {
    inc["stats.clicked"] = 1;
  } else {
    await EmailCampaignRecipient.updateOne(
      { _id: recipient._id, ...STILL_TRACKED },
      { $inc: { clickCount: 1 } },
    );
  }
  const opened = await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, openedAt: null, ...STILL_TRACKED },
    { $set: { openedAt: now }, $inc: { openCount: 1 } },
  );
  if (opened.modifiedCount) {
    inc["stats.opened"] = 1;
    inc["stats.opens"] = 1;
  }
  await incrementStats(recipient.campaignId, inc);
}

/**
 * Désinscription d'un destinataire : son adresse ne reçoit plus aucune
 * campagne de l'espace. Idempotent.
 */
export async function unsubscribeRecipient(
  recipientId,
  { source = "link", now = new Date() } = {},
) {
  const id = toObjectIdOrNull(recipientId);
  if (!id) return null;
  const recipient = await EmailCampaignRecipient.findById(id)
    .select("workspaceId campaignId email unsubscribedAt")
    .lean();
  if (!recipient) return null;
  await upsertSuppression({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
    reason: "UNSUBSCRIBED",
    campaignId: recipient.campaignId,
    source,
  });
  const first = await EmailCampaignRecipient.updateOne(
    { _id: id, unsubscribedAt: null },
    { $set: { unsubscribedAt: now } },
  );
  if (first.modifiedCount) {
    await incrementStats(recipient.campaignId, { "stats.unsubscribed": 1 });
  }
  return recipient;
}

const percent = (rate) =>
  new Intl.NumberFormat("fr-FR", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(rate);

/**
 * Coupe-circuit : met en pause une campagne en cours dont les rejets ou les
 * plaintes dépassent les seuils. @returns {Promise<boolean>} pause posée
 */
export async function evaluateReputation(campaignId) {
  const campaign = await EmailCampaign.findById(campaignId)
    .select("status stats")
    .lean();
  if (!campaign || campaign.status !== "SENDING") return false;
  const sent = campaign.stats?.sent || 0;
  if (sent < REPUTATION_MIN_SENT) return false;
  const bounceRate = (campaign.stats?.bounced || 0) / sent;
  const complaintRate = (campaign.stats?.complained || 0) / sent;
  let reason = null;
  if (bounceRate > MAX_BOUNCE_RATE) {
    reason = `Envoi suspendu pour protéger votre réputation : ${percent(bounceRate)} des e-mails ont été rejetés (seuil : ${percent(MAX_BOUNCE_RATE)}). Vérifiez les adresses de vos contacts avant un nouvel envoi.`;
  } else if (complaintRate > MAX_COMPLAINT_RATE) {
    reason = `Envoi suspendu pour protéger votre réputation : ${percent(complaintRate)} des destinataires ont signalé l'e-mail comme indésirable (seuil : ${percent(MAX_COMPLAINT_RATE)}). N'écrivez qu'à des contacts qui vous connaissent.`;
  }
  if (!reason) return false;
  const result = await EmailCampaign.updateOne(
    { _id: campaignId, status: "SENDING" },
    {
      $set: {
        status: "PAUSED",
        pauseKind: "REPUTATION",
        pausedReason: reason,
        lockedUntil: null,
      },
    },
  );
  if (result.modifiedCount) {
    logger.warn(
      `[campagnes] campagne ${campaignId} suspendue (réputation) : rejets ${percent(bounceRate)}, plaintes ${percent(complaintRate)} sur ${sent} envois`,
    );
  }
  return result.modifiedCount > 0;
}

const DELIVERED_STATUSES = ["SENT", "DELIVERED"];

async function markDelivered(recipient, now) {
  const first = await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, deliveredAt: null },
    { $set: { deliveredAt: now } },
  );
  if (first.modifiedCount) {
    await incrementStats(recipient.campaignId, { "stats.delivered": 1 });
  }
  await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, status: "SENT" },
    { $set: { status: "DELIVERED" } },
  );
}

async function markBounced(recipient, bounce, now) {
  const first = await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, bouncedAt: null },
    {
      $set: {
        bouncedAt: now,
        bounceType: typeof bounce?.type === "string" ? bounce.type : null,
        error:
          typeof bounce?.message === "string"
            ? bounce.message.slice(0, 500)
            : "Adresse rejetée par la messagerie du destinataire",
      },
    },
  );
  if (first.modifiedCount) {
    await incrementStats(recipient.campaignId, { "stats.bounced": 1 });
  }
  await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, status: { $in: DELIVERED_STATUSES } },
    { $set: { status: "BOUNCED" } },
  );
  // Rejet définitif (type « Permanent » ou non précisé) : plus jamais
  const permanent =
    typeof bounce?.type !== "string" || /permanent/i.test(bounce.type);
  if (permanent) {
    await upsertSuppression({
      workspaceId: recipient.workspaceId,
      email: recipient.email,
      reason: "BOUNCED",
      campaignId: recipient.campaignId,
      source: "webhook",
    });
  }
  await evaluateReputation(recipient.campaignId);
}

async function markComplained(recipient, now) {
  const first = await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, complainedAt: null },
    { $set: { complainedAt: now } },
  );
  if (first.modifiedCount) {
    await incrementStats(recipient.campaignId, { "stats.complained": 1 });
  }
  await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, status: { $in: [...DELIVERED_STATUSES, "BOUNCED"] } },
    { $set: { status: "COMPLAINED" } },
  );
  await upsertSuppression({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
    reason: "COMPLAINED",
    campaignId: recipient.campaignId,
    source: "webhook",
  });
  await evaluateReputation(recipient.campaignId);
}

async function markFailed(recipient, message) {
  const result = await EmailCampaignRecipient.updateOne(
    { _id: recipient._id, status: { $in: DELIVERED_STATUSES } },
    { $set: { status: "FAILED", error: String(message).slice(0, 500) } },
  );
  if (result.modifiedCount) {
    await incrementStats(recipient.campaignId, { "stats.failed": 1 });
  }
}

/**
 * Événement Resend concernant un e-mail de campagne. @returns {Promise<boolean>}
 * true si l'e-mail appartient à une campagne (événement traité ou ignoré),
 * false sinon (le webhook passe aux autres e-mails : documents, relances).
 */
export async function recordCampaignEmailEvent(type, data, now = new Date()) {
  const emailId = data?.email_id;
  if (typeof emailId !== "string" || !emailId || emailId.length > 200) {
    return false;
  }
  const recipient = await EmailCampaignRecipient.findOne({ resendId: emailId })
    .select("_id workspaceId campaignId email status")
    .lean();
  if (!recipient) return false;

  switch (type) {
    case "email.delivered":
      await markDelivered(recipient, now);
      break;
    case "email.bounced":
      await markBounced(recipient, data.bounce, now);
      break;
    case "email.complained":
      await markComplained(recipient, now);
      break;
    case "email.failed":
      await markFailed(
        recipient,
        typeof data.failed?.reason === "string"
          ? data.failed.reason
          : "Envoi impossible",
      );
      break;
    case "email.suppressed": {
      await markFailed(
        recipient,
        "Adresse bloquée par le service d'envoi (rejet ou plainte antérieurs)",
      );
      const complaint = /complain/i.test(String(data.suppressed?.type || ""));
      await upsertSuppression({
        workspaceId: recipient.workspaceId,
        email: recipient.email,
        reason: complaint ? "COMPLAINED" : "BOUNCED",
        campaignId: recipient.campaignId,
        source: "webhook",
      });
      break;
    }
    default:
      // Envoyé, retardé, ouvert, cliqué : le suivi des campagnes est fait
      // par l'API (pixel et redirection), le suivi de Resend est coupé
      break;
  }
  return true;
}
