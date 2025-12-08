import mongoose from 'mongoose';
import Invoice from '../models/Invoice.js';
import Quote from '../models/Quote.js';
import CreditNote from '../models/CreditNote.js';
import Client from '../models/Client.js';
import EmailSettings from '../models/EmailSettings.js';
import emailReminderService from './emailReminderService.js';
import axios from 'axios';

/**
 * Service d'envoi de documents (factures, devis, avoirs) par email
 */

const DOCUMENT_TYPES = {
  INVOICE: 'invoice',
  QUOTE: 'quote',
  CREDIT_NOTE: 'creditNote',
};

const DOCUMENT_LABELS = {
  invoice: { singular: 'facture', plural: 'factures', article: 'la' },
  quote: { singular: 'devis', plural: 'devis', article: 'le' },
  creditNote: { singular: 'avoir', plural: 'avoirs', article: 'l\'' },
};

/**
 * Récupère un document par son ID et type
 */
async function getDocument(documentId, documentType, workspaceId) {
  let document;
  
  switch (documentType) {
  case DOCUMENT_TYPES.INVOICE:
    document = await Invoice.findOne({ _id: documentId, workspaceId });
    break;
  case DOCUMENT_TYPES.QUOTE:
    document = await Quote.findOne({ _id: documentId, workspaceId });
    break;
  case DOCUMENT_TYPES.CREDIT_NOTE:
    document = await CreditNote.findOne({ _id: documentId, workspaceId });
    break;
  default:
    throw new Error(`Type de document inconnu: ${documentType}`);
  }
  
  if (!document) {
    throw new Error(`Document non trouvé: ${documentId}`);
  }
  
  return document;
}

/**
 * Génère le PDF d'un document via l'API Next.js
 */
async function generateDocumentPdf(documentId, documentType) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  
  let endpoint;
  switch (documentType) {
  case DOCUMENT_TYPES.INVOICE:
    endpoint = '/api/invoices/generate-pdf';
    break;
  case DOCUMENT_TYPES.QUOTE:
    endpoint = '/api/quotes/generate-pdf';
    break;
  case DOCUMENT_TYPES.CREDIT_NOTE:
    endpoint = '/api/credit-notes/generate-pdf';
    break;
  default:
    throw new Error(`Type de document inconnu: ${documentType}`);
  }
  
  try {
    // Construire le body avec le bon paramètre selon le type de document
    const body = {};
    if (documentType === DOCUMENT_TYPES.INVOICE) {
      body.invoiceId = documentId;
    } else if (documentType === DOCUMENT_TYPES.QUOTE) {
      body.quoteId = documentId;
    } else if (documentType === DOCUMENT_TYPES.CREDIT_NOTE) {
      body.creditNoteId = documentId;
    }
    
    const response = await axios.post(
      `${frontendUrl}${endpoint}`,
      body,
      { responseType: 'arraybuffer', timeout: 60000 }
    );
    return Buffer.from(response.data);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('⚠️ [DocumentEmail] Erreur génération PDF:', error.message);
    return null;
  }
}

/**
 * Remplace les variables dans un texte
 */
function replaceVariables(text, variables) {
  if (!text) return '';
  
  let result = text;
  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    result = result.replace(regex, variables[key]);
  });
  
  return result;
}

/**
 * Génère le template HTML de l'email
 */
function generateEmailHtml(emailBody, variables, documentType, dueDate = null) {
  const labels = DOCUMENT_LABELS[documentType];
  const documentLabel = labels.singular;
  
  const titleText = documentType === DOCUMENT_TYPES.INVOICE 
    ? 'Votre facture' 
    : documentType === DOCUMENT_TYPES.QUOTE 
      ? 'Votre devis' 
      : 'Votre avoir';
  
  const detailsTitle = documentType === DOCUMENT_TYPES.INVOICE 
    ? 'DE LA FACTURE' 
    : documentType === DOCUMENT_TYPES.QUOTE 
      ? 'DU DEVIS' 
      : 'DE L\'AVOIR';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        @media only screen and (max-width: 480px) {
          .email-header { padding: 24px 16px 20px 16px !important; }
          .email-details { margin: 0 16px 20px 16px !important; padding: 16px !important; }
          .email-content { padding: 0 16px 24px 16px !important; }
          .email-footer { padding: 16px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div class="email-header" style="padding: 40px 40px 30px 40px;">
          <h1 style="margin: 0 0 30px 0; font-size: 24px; font-weight: 400; text-align: center; color: #1a1a1a;">
            ${titleText}
          </h1>
          
          <!-- Corps du message -->
          <div style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
            ${emailBody.replace(/\n/g, '<br>')}
          </div>
        </div>
        
        <!-- Bloc détails document -->
        <div class="email-details" style="margin: 0 40px 30px 40px; background-color: #f8f9fa; border-radius: 8px; padding: 20px 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; color: #1a1a1a; text-transform: uppercase; letter-spacing: 0.5px;">
            DÉTAILS ${detailsTitle}
          </h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Numéro</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 500;">${variables.documentNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Montant total</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 600;">${variables.totalAmount}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Date</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 500;">${variables.issueDate}</td>
            </tr>
            ${documentType === DOCUMENT_TYPES.INVOICE && dueDate ? `
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Date d'échéance</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 500;">${dueDate}</td>
            </tr>
            ` : ''}
            ${documentType === DOCUMENT_TYPES.CREDIT_NOTE && variables.invoiceNumber ? `
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Facture associée</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 500;">${variables.invoiceNumber}</td>
            </tr>
            ` : ''}
          </table>
        </div>
        
        <!-- Informations complémentaires -->
        <div class="email-content" style="padding: 0 40px 40px 40px; font-size: 14px; line-height: 1.6; color: #4a4a4a;">
          <p style="margin: 0 0 16px 0;">${labels.article.charAt(0).toUpperCase() + labels.article.slice(1)}${documentLabel} est jointe à cet email au format PDF.</p>
          <p style="margin: 0 0 24px 0;">Pour toute question, n'hésitez pas à nous contacter.</p>
          <p style="margin: 0;">
            Cordialement,<br>
            L'équipe ${variables.companyName}
          </p>
        </div>
        
        <!-- Footer -->
        <div class="email-footer" style="background-color: #f8f9fa; padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
            ${documentType === DOCUMENT_TYPES.INVOICE ? 'Cette facture a été envoyée' : documentType === DOCUMENT_TYPES.QUOTE ? 'Ce devis a été envoyé' : 'Cet avoir a été envoyé'} par ${variables.companyName} depuis la plateforme Newbi Logiciel de gestion.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Envoie un document par email
 */
async function sendDocumentEmail({
  documentId,
  documentType,
  workspaceId,
  emailSubject,
  emailBody,
  recipientEmail,
  ccEmails = [],
  pdfBase64 = null,
}) {
  // Récupérer le document
  const document = await getDocument(documentId, documentType, workspaceId);
  
  // Vérifier l'email du destinataire
  if (!recipientEmail) {
    throw new Error('Email du destinataire requis');
  }
  
  // Préparer les variables
  const total = document.finalTotalTTC ?? document.totalTTC ?? 0;
  const documentNumber = `${document.prefix || ''}-${document.number}`.replace(/^-/, '');
  
  const variables = {
    documentNumber,
    clientName: document.client?.name || 'Client',
    totalAmount: new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(total),
    issueDate: new Date(document.issueDate).toLocaleDateString('fr-FR'),
    companyName: document.companyInfo?.name || 'Votre Entreprise',
  };
  
  // Ajouter le numéro de facture associée pour les avoirs (avec préfixe)
  if (documentType === DOCUMENT_TYPES.CREDIT_NOTE) {
    // Essayer de récupérer la facture originale pour obtenir le préfixe
    if (document.originalInvoice) {
      const originalInvoice = await Invoice.findById(document.originalInvoice);
      if (originalInvoice) {
        variables.invoiceNumber = `${originalInvoice.prefix || 'F'}-${originalInvoice.number}`;
      } else if (document.originalInvoiceNumber) {
        variables.invoiceNumber = document.originalInvoiceNumber;
      }
    } else if (document.originalInvoiceNumber) {
      variables.invoiceNumber = document.originalInvoiceNumber;
    }
  }
  
  // Remplacer les variables dans le sujet et le corps
  const finalSubject = replaceVariables(emailSubject, variables);
  const finalBody = replaceVariables(emailBody, variables);
  
  // Récupérer la date d'échéance pour les factures
  const dueDate = documentType === DOCUMENT_TYPES.INVOICE && document.dueDate 
    ? new Date(document.dueDate).toLocaleDateString('fr-FR') 
    : null;
  
  // Générer le HTML
  const emailHtml = generateEmailHtml(finalBody, variables, documentType, dueDate);
  
  // Utiliser le PDF envoyé depuis le client, sinon essayer de le générer côté serveur
  let pdfBuffer = null;
  if (pdfBase64) {
    // Décoder le PDF base64 envoyé depuis le client
    pdfBuffer = Buffer.from(pdfBase64, 'base64');
  } else {
    // Fallback: essayer de générer le PDF côté serveur (peut échouer sur Vercel)
    pdfBuffer = await generateDocumentPdf(documentId, documentType);
  }
  
  const attachments = pdfBuffer ? [{
    filename: `${documentNumber}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }] : [];
  
  // Récupérer les paramètres email du workspace
  const emailSettings = await EmailSettings.findOne({ workspaceId });
  
  let fromEmail, fromName, replyTo;
  if (emailSettings?.fromEmail) {
    fromEmail = emailSettings.fromEmail;
    fromName = emailSettings.fromName || document.companyInfo?.name || '';
    replyTo = emailSettings.replyTo || emailSettings.fromEmail;
  } else {
    fromEmail = document.companyInfo?.email || 'noreply@newbi.fr';
    fromName = document.companyInfo?.name || '';
    replyTo = fromEmail;
  }
  
  const actualSenderEmail = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  
  // Préparer les options d'envoi
  const mailOptions = {
    from: actualSenderEmail,
    to: recipientEmail,
    subject: finalSubject,
    html: emailHtml,
    attachments,
  };
  
  if (replyTo) {
    mailOptions.replyTo = replyTo;
  }
  
  if (ccEmails && ccEmails.length > 0) {
    mailOptions.cc = ccEmails.filter(email => email && email.trim());
  }
  
  // Vérifier que le transporter est initialisé
  if (!emailReminderService.transporter) {
    throw new Error('Service SMTP non initialisé');
  }
  
  // Envoyer l'email
  const mailResult = await emailReminderService.transporter.sendMail(mailOptions);
  
  // Ajouter l'activité au client
  try {
    if (document.client?.id || document.client?._id) {
      const clientId = document.client.id || document.client._id;
      const client = await Client.findById(clientId);
      
      if (client) {
        const documentLabel = documentType === DOCUMENT_TYPES.INVOICE 
          ? 'facture' 
          : documentType === DOCUMENT_TYPES.QUOTE 
            ? 'devis' 
            : 'avoir';
        
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: 'document_email_sent',
          description: `a envoyé ${documentLabel === 'avoir' ? 'l\'' : 'le '}${documentLabel} ${documentNumber} par email`,
          userId: document.createdBy || document.userId,
          userName: variables.companyName,
          metadata: {
            documentType: documentType,
            documentId: documentId,
            documentNumber: documentNumber,
            recipientEmail: recipientEmail,
          },
          createdAt: new Date(),
        });
        
        await client.save();
      }
    }
  } catch (activityError) {
    // Ne pas bloquer l'envoi si l'ajout d'activité échoue
    console.warn('⚠️ [DocumentEmail] Erreur ajout activité client:', activityError.message);
  }
  
  return {
    success: true,
    messageId: mailResult.messageId,
    recipientEmail,
  };
}

/**
 * Obtient les valeurs par défaut pour l'envoi d'un document
 */
function getDefaultEmailContent(documentType, documentNumber) {
  const labels = DOCUMENT_LABELS[documentType];
  
  let subject;
  if (documentType === DOCUMENT_TYPES.INVOICE) {
    subject = `Facture ${documentNumber}`;
  } else if (documentType === DOCUMENT_TYPES.QUOTE) {
    subject = `Devis ${documentNumber}`;
  } else {
    subject = `Avoir ${documentNumber}`;
  }
  
  let instruction;
  if (documentType === DOCUMENT_TYPES.QUOTE) {
    instruction = 'N\'hésitez pas à nous contacter pour toute question concernant ce devis.';
  } else if (documentType === DOCUMENT_TYPES.INVOICE) {
    instruction = 'Nous vous remercions de bien vouloir procéder au règlement selon les conditions indiquées.';
  } else {
    instruction = 'Cet avoir a été établi suite à votre demande.';
  }
  
  const body = `Bonjour {clientName},

Veuillez trouver ci-joint ${labels.article}${labels.singular} ${documentNumber}.

${instruction}

Cordialement,
{companyName}`;

  return { subject, body };
}

export {
  DOCUMENT_TYPES,
  DOCUMENT_LABELS,
  sendDocumentEmail,
  getDefaultEmailContent,
  getDocument,
  generateDocumentPdf,
};
