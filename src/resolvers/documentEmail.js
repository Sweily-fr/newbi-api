import {
  sendDocumentEmail,
  DOCUMENT_TYPES,
} from "../services/documentEmailService.js";
import { requireWrite } from "../middlewares/rbac.js";
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
      subscribe: (_, { workspaceId }) => {
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
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
          bccEmails: input.bccEmails || [],
          pdfBase64: input.pdfBase64 || null,
          senderEmail: context?.user?.email || null,
          extraAttachments: input.attachments || [],
        });

        return result;
      },
    ),

    sendQuoteEmail: requireWrite("quotes")(
      async (_, { workspaceId, input }, context) => {
        const result = await sendDocumentEmail({
          documentId: input.documentId,
          documentType: DOCUMENT_TYPES.QUOTE,
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
          bccEmails: input.bccEmails || [],
          pdfBase64: input.pdfBase64 || null,
          senderEmail: context?.user?.email || null,
          extraAttachments: input.attachments || [],
        });

        return result;
      },
    ),

    sendCreditNoteEmail: requireWrite("creditNotes")(
      async (_, { workspaceId, input }, context) => {
        const result = await sendDocumentEmail({
          documentId: input.documentId,
          documentType: DOCUMENT_TYPES.CREDIT_NOTE,
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
          bccEmails: input.bccEmails || [],
          pdfBase64: input.pdfBase64 || null,
          senderEmail: context?.user?.email || null,
          extraAttachments: input.attachments || [],
        });

        return result;
      },
    ),

    sendPurchaseOrderEmail: requireWrite("purchaseOrders")(
      async (_, { workspaceId, input }, context) => {
        const result = await sendDocumentEmail({
          documentId: input.documentId,
          documentType: DOCUMENT_TYPES.PURCHASE_ORDER,
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
          bccEmails: input.bccEmails || [],
          pdfBase64: input.pdfBase64 || null,
          senderEmail: context?.user?.email || null,
          extraAttachments: input.attachments || [],
        });

        return result;
      },
    ),
  },
};

export default documentEmailResolvers;
