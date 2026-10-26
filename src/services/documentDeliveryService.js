import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";
import CreditNote from "../models/CreditNote.js";
import emailReminderService from "./emailReminderService.js";
import {
  buildDocumentSummary,
  sendSenderConfirmationEmail,
  sendSenderFailureEmail,
} from "./documentEmailService.js";
import { publishEmailTrackingUpdate } from "../resolvers/documentEmail.js";
import logger from "../utils/logger.js";

/**
 * Remise des e-mails de documents (factures, devis, avoirs, bons).
 *
 * Resend accepte l'e-mail tout de suite, mais le serveur du destinataire peut
 * encore le refuser (adresse inexistante, boîte pleine…). On suit donc la
 * suite : le reçu « Envoi confirmé » ne part qu'une fois l'e-mail remis, et un
 * rejet prévient l'émetteur par e-mail.
 *
 * Deux sources : le webhook Resend (immédiat) et une vérification planifiée
 * qui relit chez Resend les e-mails restés sans nouvelle (événement non
 * abonné ou perdu).
 */

export const DOCUMENT_MODELS = [
  { model: Invoice, type: "invoice" },
  { model: Quote, type: "quote" },
  { model: PurchaseOrder, type: "purchaseOrder" },
  { model: DeliveryNote, type: "deliveryNote" },
  { model: CreditNote, type: "creditNote" },
];

const DELIVERY_EVENTS = new Set([
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.failed",
  "email.suppressed",
]);

const DEFAULT_REJECTION = "Le serveur du destinataire a refusé l'e-mail";
const SUPPRESSED = "L'adresse a déjà été rejetée lors d'un envoi précédent";
const SEND_FAILURE = "L'envoi a échoué chez notre prestataire d'e-mails";

// Sous-types de rejet Resend (bounce.subType), rédigés pour l'utilisateur
const BOUNCE_REASONS = {
  NoEmail: "L'adresse e-mail n'existe pas",
  Suppressed: SUPPRESSED,
  OnAccountSuppressionList: SUPPRESSED,
  MailboxFull: "La boîte de réception du destinataire est pleine",
  MessageTooLarge: "L'e-mail est trop volumineux (pièces jointes)",
  ContentRejected: "Le serveur du destinataire a refusé le contenu de l'e-mail",
  AttachmentRejected: "Le serveur du destinataire a refusé une pièce jointe",
  MessageRejected: DEFAULT_REJECTION,
};

// Dernier événement connu chez Resend (emails.get) → état de remise
const LAST_EVENT_OUTCOMES = {
  delivered: { status: "DELIVERED" },
  opened: { status: "DELIVERED" },
  clicked: { status: "DELIVERED" },
  complained: { status: "DELIVERED" },
  delivery_delayed: { status: "DELAYED" },
  bounced: { status: "FAILED", reason: DEFAULT_REJECTION },
  failed: { status: "FAILED", reason: SEND_FAILURE },
};

// États depuis lesquels chaque issue s'applique : un rejet l'emporte sur une
// remise (rejet différé du serveur), jamais l'inverse ; null = envoi antérieur
// au suivi de remise
const FROM_STATUSES = {
  DELIVERED: [null, "SENT", "DELAYED"],
  DELAYED: [null, "SENT"],
  FAILED: [null, "SENT", "DELAYED", "DELIVERED"],
};

// Vérification planifiée : premier passage après 3 min, puis toutes les
// 20 min pendant 48 h
const CHECK_MIN_AGE_MS = 3 * 60 * 1000;
const CHECK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 20 * 60 * 1000;

export function isDeliveryEvent(type) {
  return DELIVERY_EVENTS.has(type);
}

/**
 * Cherche un document par son resendMessageId
 */
export async function findDocumentByResendId(resendMessageId) {
  for (const { model: Model, type: documentType } of DOCUMENT_MODELS) {
    const doc = await Model.findOne({
      "emailTracking.resendMessageId": resendMessageId,
    });

    if (doc) {
      return { doc, Model, documentType };
    }
  }
  return null;
}

/**
 * Raison d'un rejet, rédigée pour l'utilisateur
 */
export function describeFailure(type, data = {}) {
  if (type === "email.failed") return SEND_FAILURE;
  if (type === "email.suppressed") return SUPPRESSED;
  const { subType, type: bounceType } = data.bounce || {};
  if (BOUNCE_REASONS[subType]) return BOUNCE_REASONS[subType];
  if (bounceType === "Permanent") {
    return "L'adresse e-mail est invalide ou refuse les e-mails";
  }
  return DEFAULT_REJECTION;
}

function normalizeAddress(address) {
  const value = String(address || "");
  const bracketed = value.match(/<([^>]+)>/);
  return (bracketed ? bracketed[1] : value).trim().toLowerCase();
}

/**
 * Un événement vise-t-il le destinataire principal ? Resend liste dans `to`
 * les adresses concernées : un rejet d'une copie (Cc, Cci) ne doit pas marquer
 * le document comme non remis au client.
 */
function concernsRecipient(tracking, to) {
  const recipient = normalizeAddress(tracking?.recipientEmail);
  if (!recipient || !Array.isArray(to) || to.length === 0) return true;
  return to.some((address) => normalizeAddress(address) === recipient);
}

const toIso = (date) => (date ? new Date(date).toISOString() : null);

function serializeTracking(tracking = {}) {
  return {
    emailSentAt: toIso(tracking.emailSentAt),
    emailOpenedAt: toIso(tracking.emailOpenedAt),
    emailOpenCount: tracking.emailOpenCount || 0,
    emailClickedAt: toIso(tracking.emailClickedAt),
    emailClickCount: tracking.emailClickCount || 0,
    deliveryStatus: tracking.deliveryStatus || null,
    deliveredAt: toIso(tracking.deliveredAt),
    deliveryFailedAt: toIso(tracking.deliveryFailedAt),
    deliveryFailureReason: tracking.deliveryFailureReason || null,
    recipientEmail: tracking.recipientEmail || null,
  };
}

/**
 * Réserve l'envoi d'un e-mail à l'émetteur (une seule fois par envoi, même
 * si le webhook et la vérification planifiée arrivent ensemble)
 */
async function claimSenderNotice(Model, doc, field) {
  const { modifiedCount } = await Model.updateOne(
    {
      _id: doc._id,
      "emailTracking.resendMessageId": doc.emailTracking.resendMessageId,
      "emailTracking.senderEmail": { $nin: [null, ""] },
      [`emailTracking.${field}`]: null,
    },
    { $set: { [`emailTracking.${field}`]: new Date() } },
  );
  return modifiedCount === 1;
}

async function notifySender(Model, documentType, doc) {
  const tracking = doc.emailTracking;
  const failed = tracking.deliveryStatus === "FAILED";
  const field = failed ? "senderFailureNotifiedAt" : "senderNotifiedAt";
  if (!(await claimSenderNotice(Model, doc, field))) return;

  const summary = buildDocumentSummary(doc);
  const notice = {
    senderEmail: tracking.senderEmail,
    documentType,
    documentNumber: summary.documentNumber,
    recipientEmail: tracking.recipientEmail,
    clientName: summary.clientName,
    sentAt: tracking.emailSentAt,
  };
  try {
    if (failed) {
      await sendSenderFailureEmail({
        ...notice,
        reason: tracking.deliveryFailureReason || DEFAULT_REJECTION,
      });
    } else {
      await sendSenderConfirmationEmail({
        ...notice,
        totalAmount: summary.totalAmount,
        deliveredAt: tracking.deliveredAt,
      });
    }
  } catch (error) {
    logger.warn(
      `[DocumentDelivery] e-mail à l'émetteur en échec (${documentType} ${doc._id}): ${error.message}`,
    );
  }
}

/**
 * Applique une issue de remise (DELIVERED, DELAYED, FAILED) au document, puis
 * publie la mise à jour et prévient l'émetteur
 * @returns {Promise<boolean>} true si l'état du document a changé
 */
async function applyDeliveryOutcome({
  Model,
  documentType,
  doc,
  status,
  reason,
  at,
}) {
  const set = { "emailTracking.deliveryStatus": status };
  if (status === "DELIVERED") set["emailTracking.deliveredAt"] = at;
  if (status === "FAILED") {
    set["emailTracking.deliveryFailedAt"] = at;
    set["emailTracking.deliveryFailureReason"] = reason || DEFAULT_REJECTION;
  }

  const updated = await Model.findOneAndUpdate(
    {
      _id: doc._id,
      "emailTracking.resendMessageId": doc.emailTracking.resendMessageId,
      "emailTracking.deliveryStatus": { $in: FROM_STATUSES[status] },
    },
    { $set: set },
    { new: true },
  );
  if (!updated) return false;

  logger.info(
    `[DocumentDelivery] ${Model.modelName} ${doc._id} → ${status}${reason ? ` (${reason})` : ""}`,
  );

  publishEmailTrackingUpdate({
    documentId: updated._id.toString(),
    documentType,
    workspaceId: updated.workspaceId.toString(),
    emailTracking: serializeTracking(updated.emailTracking),
  });

  if (status !== "DELAYED") {
    await notifySender(Model, documentType, updated);
  }
  return true;
}

/**
 * Événement Resend de remise (webhook) : remis, retardé, rejeté
 * @returns {Promise<boolean>} true si l'e-mail est celui d'un document
 */
export async function recordDeliveryEvent(event) {
  const { type, data, created_at: createdAt } = event || {};
  if (!isDeliveryEvent(type) || !data?.email_id) return false;

  const found = await findDocumentByResendId(data.email_id);
  if (!found) return false;
  const { doc, Model, documentType } = found;

  if (!concernsRecipient(doc.emailTracking, data.to)) return true;

  const status =
    type === "email.delivered"
      ? "DELIVERED"
      : type === "email.delivery_delayed"
        ? "DELAYED"
        : "FAILED";

  await applyDeliveryOutcome({
    Model,
    documentType,
    doc,
    status,
    reason: status === "FAILED" ? describeFailure(type, data) : null,
    at: createdAt ? new Date(createdAt) : new Date(),
  });
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Relit chez Resend les e-mails de documents restés sans nouvelle (ni remis
 * ni rejeté) : filet du webhook. Les appels sont espacés pour ne pas
 * consommer la limite de débit de Resend, partagée avec les vrais envois.
 * @returns {Promise<{checked: number, updated: number}>}
 */
export async function checkPendingDeliveries({
  now = new Date(),
  limit = 20,
  pauseMs = 1500,
} = {}) {
  const resend = emailReminderService.useResend && emailReminderService.resend;
  if (!resend) return { checked: 0, updated: 0 };

  const filter = {
    "emailTracking.deliveryStatus": { $exists: true, $in: ["SENT", "DELAYED"] },
    "emailTracking.emailSentAt": {
      $lte: new Date(now.getTime() - CHECK_MIN_AGE_MS),
      $gte: new Date(now.getTime() - CHECK_MAX_AGE_MS),
    },
    "emailTracking.resendMessageId": { $exists: true, $ne: null },
    $or: [
      { "emailTracking.deliveryCheckedAt": null },
      {
        "emailTracking.deliveryCheckedAt": {
          $lte: new Date(now.getTime() - CHECK_INTERVAL_MS),
        },
      },
    ],
  };

  const pending = [];
  for (const { model: Model, type: documentType } of DOCUMENT_MODELS) {
    if (pending.length >= limit) break;
    const docs = await Model.find(filter)
      .sort({ "emailTracking.emailSentAt": 1 })
      .limit(limit - pending.length);
    docs.forEach((doc) => pending.push({ doc, Model, documentType }));
  }

  let updated = 0;
  for (const [index, { doc, Model, documentType }] of pending.entries()) {
    if (index > 0 && pauseMs > 0) await sleep(pauseMs);
    try {
      const { data, error } = await resend.emails.get(
        doc.emailTracking.resendMessageId,
      );
      await Model.updateOne(
        { _id: doc._id },
        { $set: { "emailTracking.deliveryCheckedAt": now } },
      );
      if (error || !data) continue;

      const outcome = LAST_EVENT_OUTCOMES[data.last_event];
      if (!outcome) continue;
      const changed = await applyDeliveryOutcome({
        Model,
        documentType,
        doc,
        status: outcome.status,
        reason: outcome.reason,
        at: now,
      });
      if (changed) updated += 1;
    } catch (error) {
      logger.warn(
        `[DocumentDelivery] vérification en échec (${documentType} ${doc._id}): ${error.message}`,
      );
    }
  }

  return { checked: pending.length, updated };
}
