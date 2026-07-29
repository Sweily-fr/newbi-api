import {
  sendDocumentEmail,
  DOCUMENT_TYPES,
} from "../services/documentEmailService.js";
import { requireWrite, resolveWorkspaceId } from "../middlewares/rbac.js";
import { getActiveOrganization } from "../middlewares/org-resolver.js";
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

const documentEmailResolvers = {
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
    sendInvoiceEmail: requireWrite("invoices")(
      async (_, { workspaceId, input }, context) => {
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
      },
    ),

    sendQuoteEmail: requireWrite("quotes")(
      async (_, { workspaceId, input }, context) => {
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
      },
    ),

    sendCreditNoteEmail: requireWrite("creditNotes")(
      async (_, { workspaceId, input }, context) => {
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
      },
    ),

    sendPurchaseOrderEmail: requireWrite("purchaseOrders")(
      async (_, { workspaceId, input }, context) => {
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
      },
    ),
  },
};

export default documentEmailResolvers;
