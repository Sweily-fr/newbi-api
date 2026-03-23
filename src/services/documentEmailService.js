import mongoose from "mongoose";
import crypto from "crypto";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import CreditNote from "../models/CreditNote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Client from "../models/Client.js";
import EmailSettings from "../models/EmailSettings.js";
import emailReminderService from "./emailReminderService.js";
import axios from "axios";
import cloudflareService from "./cloudflareService.js";

/**
 * Service d'envoi de documents (factures, devis, avoirs) par email
 */

const DOCUMENT_TYPES = {
  INVOICE: "invoice",
  QUOTE: "quote",
  CREDIT_NOTE: "creditNote",
  PURCHASE_ORDER: "purchaseOrder",
};

const DOCUMENT_LABELS = {
  invoice: { singular: "facture", plural: "factures", article: "la" },
  quote: { singular: "devis", plural: "devis", article: "le" },
  creditNote: { singular: "avoir", plural: "avoirs", article: "l'" },
  purchaseOrder: {
    singular: "bon de commande",
    plural: "bons de commande",
    article: "le",
  },
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
    case DOCUMENT_TYPES.PURCHASE_ORDER:
      document = await PurchaseOrder.findOne({ _id: documentId, workspaceId });
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
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

  let endpoint;
  switch (documentType) {
    case DOCUMENT_TYPES.INVOICE:
      endpoint = "/api/invoices/generate-pdf";
      break;
    case DOCUMENT_TYPES.QUOTE:
      endpoint = "/api/quotes/generate-pdf";
      break;
    case DOCUMENT_TYPES.CREDIT_NOTE:
      endpoint = "/api/credit-notes/generate-pdf";
      break;
    case DOCUMENT_TYPES.PURCHASE_ORDER:
      endpoint = "/api/purchase-orders/generate-pdf";
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
    } else if (documentType === DOCUMENT_TYPES.PURCHASE_ORDER) {
      body.purchaseOrderId = documentId;
    }

    const response = await axios.post(`${frontendUrl}${endpoint}`, body, {
      responseType: "arraybuffer",
      timeout: 60000,
    });
    return Buffer.from(response.data);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("⚠️ [DocumentEmail] Erreur génération PDF:", error.message);
    return null;
  }
}

/**
 * Remplace les variables dans un texte
 */
function replaceVariables(text, variables) {
  if (!text) return "";

  let result = text;
  Object.keys(variables).forEach((key) => {
    const regex = new RegExp(`\\{${key}\\}`, "g");
    result = result.replace(regex, variables[key]);
  });

  return result;
}

/**
 * Génère le template HTML de l'email
 */
function generateEmailHtml(
  emailBody,
  variables,
  documentType,
  dueDate = null,
  customFooter = null,
  trackingPixelUrl = null,
) {
  const labels = DOCUMENT_LABELS[documentType];
  const documentLabel = labels.singular;

  const titleText =
    documentType === DOCUMENT_TYPES.INVOICE
      ? "Votre facture"
      : documentType === DOCUMENT_TYPES.QUOTE
        ? "Votre devis"
        : documentType === DOCUMENT_TYPES.PURCHASE_ORDER
          ? "Votre bon de commande"
          : "Votre avoir";

  const detailsTitle =
    documentType === DOCUMENT_TYPES.INVOICE
      ? "DE LA FACTURE"
      : documentType === DOCUMENT_TYPES.QUOTE
        ? "DU DEVIS"
        : documentType === DOCUMENT_TYPES.PURCHASE_ORDER
          ? "DU BON DE COMMANDE"
          : "DE L'AVOIR";

  const pdfNote = `${labels.article.charAt(0).toUpperCase() + labels.article.slice(1)}${labels.article.endsWith("'") ? "" : " "}${documentLabel} est ${documentType === DOCUMENT_TYPES.INVOICE || documentType === DOCUMENT_TYPES.CREDIT_NOTE ? "jointe" : "joint"} à cet email au format PDF.`;

  const footerText =
    customFooter ||
    `${documentType === DOCUMENT_TYPES.INVOICE ? "Cette facture a été envoyée" : documentType === DOCUMENT_TYPES.QUOTE ? "Ce devis a été envoyé" : documentType === DOCUMENT_TYPES.PURCHASE_ORDER ? "Ce bon de commande a été envoyé" : "Cet avoir a été envoyé"} par ${variables.companyName} depuis la plateforme Newbi Logiciel de gestion.`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${titleText}</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          line-height: 1.6;
          color: #333;
          margin: 0;
          padding: 0;
          background-color: #f0eeff;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          padding: 20px;
          background-color: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .header {
          text-align: center;
          padding: 20px 0;
          border-bottom: 1px solid #e5e7eb;
        }
        .logo {
          display: inline-block;
          margin-bottom: 20px;
        }
        .logo-text {
          font-size: 34px;
          font-weight: 800;
          color: #1f2937;
          letter-spacing: -0.025em;
        }
        .logo-dot {
          color: #3b82f6;
        }
        .logo-subtitle {
          font-size: 14px;
          color: #6b7280;
          margin-top: -5px;
        }
        .content {
          padding: 30px 20px;
        }
        h1 {
          color: #1f2937;
          font-size: 24px;
          font-weight: 700;
          margin-bottom: 20px;
        }
        p {
          margin-bottom: 16px;
          color: #4b5563;
        }
        .btn {
          display: inline-block;
          background-color: #5b50ff;
          color: white;
          font-weight: 600;
          text-decoration: none;
          padding: 12px 24px;
          border-radius: 6px;
          margin: 20px 0;
          text-align: center;
        }
        .btn:hover {
          background-color: #4a41e0;
        }
        .link-fallback {
          word-break: break-all;
          color: #6b7280;
          font-size: 14px;
        }
        .footer {
          text-align: center;
          padding: 20px;
          color: #6b7280;
          font-size: 14px;
          border-top: 1px solid #e5e7eb;
        }
        .security-notice {
          background-color: #e6e1ff;
          padding: 15px;
          border-radius: 6px;
          margin-top: 30px;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #1f2937;">${titleText}</h1>
        </div>
        <div class="content">
          <div style="font-size: 15px; line-height: 1.6; color: #4b5563;">
            ${emailBody.replace(/\n/g, "<br>")}
          </div>

          <div class="security-notice">
            <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; color: #1f2937; text-transform: uppercase; letter-spacing: 0.5px;">
              DÉTAILS ${detailsTitle}
            </h2>
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Numéro</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${variables.documentNumber}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Montant total</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 600;">${variables.totalAmount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Date</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${variables.issueDate}</td>
              </tr>
              ${
                documentType === DOCUMENT_TYPES.INVOICE && dueDate
                  ? `
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Date d'échéance</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${dueDate}</td>
              </tr>
              `
                  : ""
              }
              ${
                documentType === DOCUMENT_TYPES.CREDIT_NOTE &&
                variables.invoiceNumber
                  ? `
              <tr>
                <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Facture associée</td>
                <td style="padding: 8px 0; font-size: 14px; color: #1f2937; text-align: right; font-weight: 500;">${variables.invoiceNumber}</td>
              </tr>
              `
                  : ""
              }
            </table>
          </div>

          <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">${pdfNote}</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} ${variables.companyName}. Tous droits réservés.</p>
          <p style="margin: 0; font-size: 12px; color: #9ca3af;">${footerText}</p>
        </div>
      </div>
      ${trackingPixelUrl ? `<img src="${trackingPixelUrl}" width="1" height="1" style="display:none" alt="" />` : ""}
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
  bccEmails = [],
  pdfBase64 = null,
}) {
  // Récupérer le document
  const document = await getDocument(documentId, documentType, workspaceId);

  // Vérifier l'email du destinataire
  if (!recipientEmail) {
    throw new Error("Email du destinataire requis");
  }

  // Préparer les variables
  const total = document.finalTotalTTC ?? document.totalTTC ?? 0;
  const documentNumber = `${document.prefix || ""}-${document.number}`.replace(
    /^-/,
    "",
  );

  // Récupérer le nom d'entreprise actuel depuis l'organisation (pas le snapshot du document)
  let currentCompanyName = document.companyInfo?.name || "Votre Entreprise";
  try {
    const db = mongoose.connection.db;
    const organizationCollection = db.collection("organization");
    const organization = await organizationCollection.findOne({
      _id: new mongoose.Types.ObjectId(workspaceId),
    });
    if (organization?.companyName) {
      currentCompanyName = organization.companyName;
    }
  } catch {
    // Fallback sur le snapshot du document
  }

  const variables = {
    documentNumber,
    clientName: document.client?.name || "Client",
    totalAmount: new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(total),
    issueDate: new Date(document.issueDate).toLocaleDateString("fr-FR"),
    companyName: currentCompanyName,
  };

  // Ajouter le numéro de facture associée pour les avoirs (avec préfixe)
  if (documentType === DOCUMENT_TYPES.CREDIT_NOTE) {
    // Essayer de récupérer la facture originale pour obtenir le préfixe
    if (document.originalInvoice) {
      const originalInvoice = await Invoice.findById(document.originalInvoice);
      if (originalInvoice) {
        variables.invoiceNumber = `${originalInvoice.prefix || "F"}-${originalInvoice.number}`;
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
  const dueDate =
    documentType === DOCUMENT_TYPES.INVOICE && document.dueDate
      ? new Date(document.dueDate).toLocaleDateString("fr-FR")
      : null;

  // Récupérer les paramètres email du workspace (avancé pour le footer)
  const emailSettings = await EmailSettings.findOne({ workspaceId });

  // Déterminer le footer personnalisé
  const customFooter =
    emailSettings?.useCustomFooter && emailSettings?.customEmailFooter
      ? replaceVariables(emailSettings.customEmailFooter, variables)
      : null;

  // Générer le token de tracking et l'URL du pixel
  const trackingToken = crypto.randomBytes(32).toString("hex");
  const apiBaseUrl =
    process.env.API_URL || process.env.BACKEND_URL || "http://localhost:4000";
  const trackingPixelUrl = `${apiBaseUrl}/tracking/open/${trackingToken}`;

  // Sauvegarder le token de tracking sur le document
  const ModelMap = {
    invoice: Invoice,
    quote: Quote,
    creditNote: CreditNote,
    purchaseOrder: PurchaseOrder,
  };
  const TrackingModel = ModelMap[documentType];
  if (TrackingModel) {
    await TrackingModel.updateOne(
      { _id: documentId },
      {
        $set: {
          "emailTracking.trackingToken": trackingToken,
          "emailTracking.emailSentAt": new Date(),
          "emailTracking.emailOpenedAt": null,
          "emailTracking.emailOpenCount": 0,
        },
      },
    );
  }

  // Générer le HTML avec le pixel de tracking
  const emailHtml = generateEmailHtml(
    finalBody,
    variables,
    documentType,
    dueDate,
    customFooter,
    trackingPixelUrl,
  );

  // Utiliser le PDF envoyé depuis le client, sinon essayer de le générer côté serveur
  let pdfBuffer = null;
  if (pdfBase64) {
    // Décoder le PDF base64 envoyé depuis le client
    pdfBuffer = Buffer.from(pdfBase64, "base64");
  } else {
    // Fallback: essayer de générer le PDF côté serveur (peut échouer sur Vercel)
    pdfBuffer = await generateDocumentPdf(documentId, documentType);
  }

  // Cache le PDF dans R2 pour les automatisations futures (fire-and-forget)
  if (
    pdfBuffer &&
    (documentType === DOCUMENT_TYPES.INVOICE ||
      documentType === DOCUMENT_TYPES.QUOTE ||
      documentType === DOCUMENT_TYPES.CREDIT_NOTE ||
      documentType === DOCUMENT_TYPES.PURCHASE_ORDER)
  ) {
    const ModelMap = {
      invoice: Invoice,
      quote: Quote,
      creditNote: CreditNote,
      purchaseOrder: PurchaseOrder,
    };
    const Model = ModelMap[documentType];
    if (Model) {
      (async () => {
        try {
          const uploadResult = await cloudflareService.uploadImage(
            pdfBuffer,
            `${documentId}.pdf`,
            "system",
            "sharedDocuments",
            workspaceId,
          );
          await Model.updateOne(
            { _id: documentId },
            {
              $set: {
                cachedPdf: {
                  key: uploadResult.key,
                  url: uploadResult.url,
                  generatedAt: new Date(),
                },
              },
            },
          );
        } catch (err) {
          console.warn("⚠️ [DocumentEmail] Erreur cache PDF:", err.message);
        }
      })();
    }
  }

  const attachments = pdfBuffer
    ? [
        {
          filename: `${documentNumber}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ]
    : [];

  let fromEmail, fromName, replyTo;
  if (emailSettings?.fromEmail) {
    fromEmail = emailSettings.fromEmail;
    fromName = emailSettings.fromName || currentCompanyName || "";
    replyTo = emailSettings.replyTo || emailSettings.fromEmail;
  } else {
    fromEmail = document.companyInfo?.email || "noreply@newbi.fr";
    fromName = currentCompanyName || "";
    replyTo = fromEmail;
  }

  const actualSenderEmail = fromName
    ? `"${fromName}" <${fromEmail}>`
    : fromEmail;

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
    mailOptions.cc = ccEmails.filter((email) => email && email.trim());
  }

  if (bccEmails && bccEmails.length > 0) {
    mailOptions.bcc = bccEmails.filter((email) => email && email.trim());
  }

  // Vérifier que le transporter est initialisé
  if (!emailReminderService.transporter) {
    throw new Error("Service SMTP non initialisé");
  }

  // Envoyer l'email
  const mailResult =
    await emailReminderService.transporter.sendMail(mailOptions);

  // Ajouter l'activité au client
  try {
    if (document.client?.id || document.client?._id) {
      const clientId = document.client.id || document.client._id;
      const client = await Client.findById(clientId);

      if (client) {
        const documentLabel =
          documentType === DOCUMENT_TYPES.INVOICE
            ? "facture"
            : documentType === DOCUMENT_TYPES.QUOTE
              ? "devis"
              : documentType === DOCUMENT_TYPES.PURCHASE_ORDER
                ? "bon de commande"
                : "avoir";

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "document_email_sent",
          description: `a envoyé ${documentLabel === "avoir" ? "l'" : "le "}${documentLabel} ${documentNumber} par email`,
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
    console.warn(
      "⚠️ [DocumentEmail] Erreur ajout activité client:",
      activityError.message,
    );
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
  } else if (documentType === DOCUMENT_TYPES.PURCHASE_ORDER) {
    subject = `Bon de commande ${documentNumber}`;
  } else {
    subject = `Avoir ${documentNumber}`;
  }

  let instruction;
  if (documentType === DOCUMENT_TYPES.QUOTE) {
    instruction =
      "N'hésitez pas à nous contacter pour toute question concernant ce devis.";
  } else if (documentType === DOCUMENT_TYPES.INVOICE) {
    instruction =
      "Nous vous remercions de bien vouloir procéder au règlement selon les conditions indiquées.";
  } else if (documentType === DOCUMENT_TYPES.PURCHASE_ORDER) {
    instruction =
      "N'hésitez pas à nous contacter pour toute question concernant ce bon de commande.";
  } else {
    instruction = "Cet avoir a été établi suite à votre demande.";
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
