import { sendDocumentEmail, DOCUMENT_TYPES } from '../services/documentEmailService.js';
import { requireWrite } from '../middlewares/rbac.js';

const documentEmailResolvers = {
  Mutation: {
    sendInvoiceEmail: requireWrite('invoices')(
      async (_, { workspaceId, input }) => {
        const result = await sendDocumentEmail({
          documentId: input.documentId,
          documentType: DOCUMENT_TYPES.INVOICE,
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
        });
        
        return result;
      }
    ),
    
    sendQuoteEmail: requireWrite('quotes')(
      async (_, { workspaceId, input }) => {
        const result = await sendDocumentEmail({
          documentId: input.documentId,
          documentType: DOCUMENT_TYPES.QUOTE,
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
        });
        
        return result;
      }
    ),
    
    sendCreditNoteEmail: requireWrite('creditNotes')(
      async (_, { workspaceId, input }) => {
        const result = await sendDocumentEmail({
          documentId: input.documentId,
          documentType: DOCUMENT_TYPES.CREDIT_NOTE,
          workspaceId,
          emailSubject: input.emailSubject,
          emailBody: input.emailBody,
          recipientEmail: input.recipientEmail,
          ccEmails: input.ccEmails || [],
        });
        
        return result;
      }
    ),
  },
};

export default documentEmailResolvers;
