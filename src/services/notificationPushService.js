import User from "../models/User.js";
import { sendPushToUser } from "./pushNotificationService.js";
import logger from "../utils/logger.js";
import { documentNavigationIds } from "../utils/notificationDocumentIds.js";

/**
 * Push mobile adossé à une notification in-app (modèle Notification) : même
 * titre, même message, et des données de navigation communes à tous les
 * types pour que l'app mobile ouvre le bon écran au tap.
 *
 * Format de `data` (toutes les valeurs sont des chaînes, clés absentes quand
 * la notification n'a pas l'information) :
 *  - type, workspaceId, notificationId (toujours)
 *  - boardId, taskId, actorId : tâches kanban (TASK_ASSIGNED, MENTION…)
 *  - purchaseInvoiceId : facture d'achat (PURCHASE_INVOICE_RECEIVED, et
 *    DOCUMENT_IMPORTED quand le document est une facture d'achat)
 *  - documentType, documentId, documentModel, source, event : DOCUMENT_IMPORTED
 *  - invoiceId / importedInvoiceId / quoteId / importedQuoteId : selon le
 *    modèle du document importé (une facture importée n'est pas une facture
 *    Newbi, la fiche mobile factures/[id] ne l'ouvrirait pas)
 *  - url : lien de la notification (absolu ou relatif au front)
 *  - + les clés passées en `extra` (commentId, module, action…)
 * Les clés de document sont aussi stockées dans le `data` de la notification
 * in-app (voir utils/notificationDocumentIds.js) : cloche et push ouvrent le
 * même écran.
 */

const toStringValue = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
};

/**
 * Construit les données embarquées d'un push à partir d'une notification.
 * @param {object} notification - Document Notification (ou objet équivalent)
 * @param {object} [extra] - Clés supplémentaires (prioritaires)
 * @returns {Record<string, string>}
 */
export function buildNotificationPushData(notification, extra = {}) {
  const notifData = notification?.data || {};
  // Une clé `extra` vide n'écrase pas la valeur de la notification
  const definedExtra = Object.fromEntries(
    Object.entries(extra || {}).filter(
      ([, value]) => toStringValue(value) !== undefined,
    ),
  );
  const data = {
    type: notification?.type,
    workspaceId: notification?.workspaceId,
    notificationId: notification?._id,
    boardId: notifData.boardId,
    taskId: notifData.taskId,
    actorId: notifData.actorId,
    purchaseInvoiceId: notifData.purchaseInvoiceId,
    invoiceId: notifData.invoiceId,
    importedInvoiceId: notifData.importedInvoiceId,
    quoteId: notifData.quoteId,
    importedQuoteId: notifData.importedQuoteId,
    documentType: notifData.documentType,
    documentId: notifData.documentId,
    documentModel: notifData.documentModel,
    source: notifData.source,
    event: notifData.event,
    url: notifData.url,
    ...definedExtra,
  };

  // Clé propre au modèle du document (invoiceId, importedInvoiceId…) et
  // purchaseInvoiceId d'une facture d'achat : déjà stockées par les
  // notifications récentes, déduites ici pour les plus anciennes ou quand
  // `extra` précise le modèle
  Object.entries(documentNavigationIds(data)).forEach(([key, value]) => {
    if (toStringValue(data[key]) === undefined) data[key] = value;
  });

  return Object.fromEntries(
    Object.entries(data)
      .map(([key, value]) => [key, toStringValue(value)])
      .filter(([, value]) => value !== undefined),
  );
}

/**
 * Clé de notificationPreferences qui gouverne le push d'une notification,
 * quand il en existe une pertinente. Les notifications kanban (TASK_ASSIGNED,
 * MENTION) sont filtrées en amont avec la notification in-app
 * (kanban_task_assigned / kanban_mention) ; les autres types n'ont pas de clé.
 * @returns {string|null}
 */
export function pushPreferenceKey(notification, extra = {}) {
  if (notification?.type !== "DOCUMENT_IMPORTED") return null;
  const documentType = notification.data?.documentType;
  // Événement stocké dans la notification, sauf précision explicite
  const event = extra?.event || notification.data?.event;
  // Facture client marquée payée dans Qonto / Abby = paiement reçu
  if (event === "PAID" && documentType === "INVOICE") {
    return "payment_received";
  }
  // Devis accepté ou refusé par le client
  if (
    (event === "ACCEPTED" || event === "REFUSED") &&
    documentType === "QUOTE"
  ) {
    return "quote_response";
  }
  return null;
}

// Push désactivé seulement sur refus explicite (défaut des deux clés : true)
async function isPushAllowed(userId, preferenceKey) {
  if (!preferenceKey) return true;
  const user = await User.findById(userId)
    .select("notificationPreferences")
    .lean();
  return user?.notificationPreferences?.[preferenceKey]?.push !== false;
}

/**
 * Envoie le push correspondant à une notification in-app à son destinataire.
 * Ne lève jamais d'erreur : un push raté ne doit pas faire échouer l'action
 * métier qui a créé la notification.
 *
 * @param {object} notification - Document Notification créé
 * @param {object} [options]
 * @param {string} [options.title] - Titre (défaut : celui de la notification)
 * @param {string} [options.body] - Corps (défaut : message de la notification)
 * @param {object} [options.data] - Données supplémentaires (voir plus haut)
 */
export async function sendNotificationPush(
  notification,
  { title, body, data } = {},
) {
  try {
    const recipientId = notification?.userId;
    if (!notification || !recipientId) return;
    const preferenceKey = pushPreferenceKey(notification, data);
    if (!(await isPushAllowed(recipientId, preferenceKey))) {
      logger.info(
        `🔔 [Push] ${notification.type} non envoyé à ${recipientId} : préférence ${preferenceKey}.push désactivée`,
      );
      return;
    }
    await sendPushToUser(String(recipientId), {
      title: title || notification.title,
      body: body || notification.message,
      data: buildNotificationPushData(notification, data),
    });
  } catch (error) {
    logger.error(
      `❌ [Push] Erreur push de la notification ${notification?.type || "?"}:`,
      error,
    );
  }
}

export default {
  buildNotificationPushData,
  pushPreferenceKey,
  sendNotificationPush,
};
