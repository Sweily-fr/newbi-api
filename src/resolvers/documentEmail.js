import {
  sendDocumentEmail,
  DOCUMENT_TYPES,
} from "../services/documentEmailService.js";
import mongoose from "mongoose";
import {
  requireAction,
  requireRead,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import { getActiveOrganization } from "../middlewares/org-resolver.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import DocumentEmailLog from "../models/DocumentEmailLog.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { getPubSub } from "../config/redis.js";

export const EMAIL_TRACKING_UPDATED = "EMAIL_TRACKING_UPDATED";

export function publishEmailTrackingUpdate(payload) {
  try {
    const pubsub = getPubSub();
    pubsub.publish(`${EMAIL_TRACKING_UPDATED}_${payload.workspaceId}`, {
      emailTrackingUpdated: payload,
    });
  } catch (error) {
    console.warn(
      "[EmailTracking] Erreur publication subscription:",
      error.message,
    );
  }
}

// Page de droits de chaque type de document
const DOCUMENT_RESOURCES = {
  invoice: "invoices",
  quote: "quotes",
  creditNote: "creditNotes",
  purchaseOrder: "purchaseOrders",
  deliveryNote: "deliveryNotes",
};

const toIso = (date) => (date ? new Date(date).toISOString() : null);

function serializeEmailLog(log, workspaceName = null) {
  return {
    id: log._id.toString(),
    workspaceId: log.workspaceId.toString(),
    workspaceName,
    documentType: log.documentType,
    documentId: log.documentId.toString(),
    documentNumber: log.documentNumber || null,
    originalInvoiceId: log.originalInvoiceId?.toString() || null,
    sentAt: toIso(log.sentAt),
    senderEmail: log.senderEmail || null,
    from: log.from || null,
    replyTo: log.replyTo || null,
    to: log.to,
    cc: log.cc || [],
    bcc: log.bcc || [],
    subject: log.subject || null,
    html: log.html ?? null,
    attachments: log.attachments || [],
    deliveryStatus: log.deliveryStatus || null,
    deliveredAt: toIso(log.deliveredAt),
    deliveryFailedAt: toIso(log.deliveryFailedAt),
    deliveryFailureReason: log.deliveryFailureReason || null,
    openedAt: toIso(log.openedAt),
  };
}

const documentEmailResolvers = {
  Query: {
    documentEmailLog: isAuthenticated(async (parent, { id }, context, info) => {
      const log = mongoose.isValidObjectId(id)
        ? await DocumentEmailLog.findById(id).lean()
        : null;
      if (!log) {
        throw new AppError("Cet envoi est introuvable.", ERROR_CODES.NOT_FOUND);
      }
      // Droits vérifiés dans l'espace de l'envoi, pas dans l'espace actif :
      // le lien du reçu s'ouvre quel que soit l'espace sélectionné
      return requireRead(DOCUMENT_RESOURCES[log.documentType], {
        preferArgsWorkspace: true,
      })(async (_, __, ctx) =>
        serializeEmailLog(log, ctx.organization?.name || null),
      )(parent, { workspaceId: log.workspaceId.toString() }, context, info);
    }),

    documentEmailLogs: (parent, args, context, info) => {
      const resource = DOCUMENT_RESOURCES[args.documentType];
      if (!resource) {
        throw new AppError(
          "Type de document inconnu.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      return requireRead(resource)(
        async (_, { workspaceId, documentType, documentId }, ctx) => {
          if (!mongoose.isValidObjectId(documentId)) return [];
          const logs = await DocumentEmailLog.find({
            workspaceId: resolveWorkspaceId(workspaceId, ctx.workspaceId),
            documentType,
            documentId,
          })
            .select("-html")
            .sort({ sentAt: -1 })
            .limit(50)
            .lean();
          return logs.map((log) => serializeEmailLog(log));
        },
      )(parent, args, context, info);
    },
  },
  Subscription: {
    emailTrackingUpdated: {
      // 🔐 Authentification + appartenance : sans ce contrôle, un client WebSocket
      // anonyme pouvait souscrire au flux de suivi email de n'importe quelle org.
      subscribe: async (_, { workspaceId }, context) => {
        if (!context?.user) {
          throw new AppError("Non authentifié", ERROR_CODES.UNAUTHENTICATED);
        }
        const org = await getActiveOrganization(
          context.user._id.toString(),
          workspaceId,
        );
        if (!org) {
          throw new AppError(
            "Vous n'êtes pas membre de cette organisation.",
            ERROR_CODES.FORBIDDEN,
          );
        }
        const pubsub = getPubSub();
        return pubsub.asyncIterableIterator([
          `${EMAIL_TRACKING_UPDATED}_${workspaceId}`,
        ]);
      },
    },
  },
  Mutation: {
    sendInvoiceEmail: requireAction(
      "invoices",
      "send",
    )(async (_, { workspaceId, input }, context) => {
      const result = await sendDocumentEmail({
        documentId: input.documentId,
        documentType: DOCUMENT_TYPES.INVOICE,
        workspaceId: resolveWorkspaceId(workspaceId, context.workspaceId),
        emailSubject: input.emailSubject,
        emailBody: input.emailBody,
        recipientEmail: input.recipientEmail,
        ccEmails: input.ccEmails || [],
        bccEmails: input.bccEmails || [],
        pdfBase64: input.pdfBase64 || null,
        senderEmail: context?.user?.email || null,
        extraAttachments: input.attachments || [],
        useCustomFooter: input.useCustomFooter,
        customEmailFooter: input.customEmailFooter,
      });

      return result;
    }),

    sendQuoteEmail: requireAction(
      "quotes",
      "send",
    )(async (_, { workspaceId, input }, context) => {
      const result = await sendDocumentEmail({
        documentId: input.documentId,
        documentType: DOCUMENT_TYPES.QUOTE,
        workspaceId: resolveWorkspaceId(workspaceId, context.workspaceId),
        emailSubject: input.emailSubject,
        emailBody: input.emailBody,
        recipientEmail: input.recipientEmail,
        ccEmails: input.ccEmails || [],
        bccEmails: input.bccEmails || [],
        pdfBase64: input.pdfBase64 || null,
        senderEmail: context?.user?.email || null,
        extraAttachments: input.attachments || [],
        useCustomFooter: input.useCustomFooter,
        customEmailFooter: input.customEmailFooter,
      });

      return result;
    }),

    sendCreditNoteEmail: requireAction(
      "creditNotes",
      "send",
    )(async (_, { workspaceId, input }, context) => {
      const result = await sendDocumentEmail({
        documentId: input.documentId,
        documentType: DOCUMENT_TYPES.CREDIT_NOTE,
        workspaceId: resolveWorkspaceId(workspaceId, context.workspaceId),
        emailSubject: input.emailSubject,
        emailBody: input.emailBody,
        recipientEmail: input.recipientEmail,
        ccEmails: input.ccEmails || [],
        bccEmails: input.bccEmails || [],
        pdfBase64: input.pdfBase64 || null,
        senderEmail: context?.user?.email || null,
        extraAttachments: input.attachments || [],
        useCustomFooter: input.useCustomFooter,
        customEmailFooter: input.customEmailFooter,
      });

      return result;
    }),

    sendPurchaseOrderEmail: requireAction(
      "purchaseOrders",
      "send",
    )(async (_, { workspaceId, input }, context) => {
      const result = await sendDocumentEmail({
        documentId: input.documentId,
        documentType: DOCUMENT_TYPES.PURCHASE_ORDER,
        workspaceId: resolveWorkspaceId(workspaceId, context.workspaceId),
        emailSubject: input.emailSubject,
        emailBody: input.emailBody,
        recipientEmail: input.recipientEmail,
        ccEmails: input.ccEmails || [],
        bccEmails: input.bccEmails || [],
        pdfBase64: input.pdfBase64 || null,
        senderEmail: context?.user?.email || null,
        extraAttachments: input.attachments || [],
        useCustomFooter: input.useCustomFooter,
        customEmailFooter: input.customEmailFooter,
      });

      return result;
    }),

    sendDeliveryNoteEmail: requireAction(
      "deliveryNotes",
      "send",
    )(async (_, { workspaceId, input }, context) => {
      const result = await sendDocumentEmail({
        documentId: input.documentId,
        documentType: DOCUMENT_TYPES.DELIVERY_NOTE,
        workspaceId: resolveWorkspaceId(workspaceId, context.workspaceId),
        emailSubject: input.emailSubject,
        emailBody: input.emailBody,
        recipientEmail: input.recipientEmail,
        ccEmails: input.ccEmails || [],
        bccEmails: input.bccEmails || [],
        pdfBase64: input.pdfBase64 || null,
        senderEmail: context?.user?.email || null,
        extraAttachments: input.attachments || [],
        useCustomFooter: input.useCustomFooter,
        customEmailFooter: input.customEmailFooter,
      });

      return result;
    }),
  },
};

export default documentEmailResolvers;
