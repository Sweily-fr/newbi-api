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

    // Authentification serveur-à-serveur via secret interne : les routes
    // /api/*/generate-pdf l'acceptent en lieu et place d'une session utilisateur.
    const headers = process.env.INTERNAL_API_SECRET
      ? { "x-internal-secret": process.env.INTERNAL_API_SECRET }
      : {};
    if (!process.env.INTERNAL_API_SECRET) {
      console.warn(
        "⚠️ [DocumentEmail] INTERNAL_API_SECRET non défini : l'appel PDF échouera en 401.",
      );
    }

    const response = await axios.post(`${frontendUrl}${endpoint}`, body, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers,
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
  clickTrackingUrl = null,
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

  const badgeLabel =
    documentType === DOCUMENT_TYPES.INVOICE
      ? "FACTURE"
      : documentType === DOCUMENT_TYPES.QUOTE
        ? "DEVIS"
        : documentType === DOCUMENT_TYPES.PURCHASE_ORDER
          ? "BON DE COMMANDE"
          : "AVOIR";

  const notifType =
    documentType === DOCUMENT_TYPES.INVOICE
      ? "ENVOI DE FACTURE"
      : documentType === DOCUMENT_TYPES.QUOTE
        ? "ENVOI DE DEVIS"
        : documentType === DOCUMENT_TYPES.PURCHASE_ORDER
          ? "ENVOI DE BON DE COMMANDE"
          : "ENVOI D'AVOIR";

  const pdfNote = `${labels.article.charAt(0).toUpperCase() + labels.article.slice(1)}${labels.article.endsWith("'") ? "" : " "}${documentLabel} est ${documentType === DOCUMENT_TYPES.INVOICE || documentType === DOCUMENT_TYPES.CREDIT_NOTE ? "jointe" : "joint"} à cet email au format PDF.`;

  const footerText =
    customFooter ||
    `${documentType === DOCUMENT_TYPES.INVOICE ? "Cette facture a été envoyée" : documentType === DOCUMENT_TYPES.QUOTE ? "Ce devis a été envoyé" : documentType === DOCUMENT_TYPES.PURCHASE_ORDER ? "Ce bon de commande a été envoyé" : "Cet avoir a été envoyé"} par ${variables.companyName} depuis Newbi, logiciel de gestion.`;

  const ctaLabel = `Voir ${labels.article}${labels.article.endsWith("'") ? "" : " "}${documentLabel}`;

  const todayFormatted = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const detailRow = (label, value, opts = {}) => {
    if (value === null || value === undefined || value === "") return "";
    const weight = opts.strong ? "600" : "400";
    return `
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#6b7280;">${label}</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a1a1a;text-align:right;font-weight:${weight};word-break:break-word;">${value}</td>
                </tr>`;
  };

  const numberLabel =
    documentType === DOCUMENT_TYPES.INVOICE
      ? "Numéro de la facture"
      : documentType === DOCUMENT_TYPES.QUOTE
        ? "Numéro du devis"
        : documentType === DOCUMENT_TYPES.PURCHASE_ORDER
          ? "Numéro du bon de commande"
          : "Numéro de l'avoir";

  const detailRows = `${detailRow(numberLabel, variables.documentNumber)}${detailRow("Montant total", variables.totalAmount, { strong: true })}${detailRow("Date d'émission", variables.issueDate)}${documentType === DOCUMENT_TYPES.INVOICE ? detailRow("Date d'échéance", dueDate) : ""}${documentType === DOCUMENT_TYPES.CREDIT_NOTE ? detailRow("Facture associée", variables.invoiceNumber) : ""}`;

  // Gabarit aligné sur les autres emails Newbi (cf. notification de mention) :
  // logo centré, carte blanche, badge violet, bouton noir, footer marque.
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titleText}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#fafafa;color:#1a1a1a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#fafafa;font-size:1px;line-height:1px;">${titleText} ${variables.documentNumber} — ${variables.totalAmount}</div>
  <div style="max-width:600px;margin:0 auto;padding:0 20px;background-color:#fafafa;">

    <!-- Logo -->
    <div style="text-align:center;padding:40px 0 24px 0;">
      <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png" alt="Newbi" style="height:32px;width:auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align:center;margin-bottom:8px;">
      <span style="font-size:11px;font-weight:600;color:#1a1a1a;letter-spacing:0.5px;text-transform:uppercase;">${notifType}</span>
    </div>

    <!-- Date -->
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-size:12px;color:#6b7280;">${todayFormatted}</span>
    </div>

    <!-- Carte principale -->
    <div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 24px;margin-bottom:32px;">

      <!-- Badge -->
      <div style="margin-bottom:20px;">
        <div style="display:inline-block;background-color:#ede9fe;border-radius:6px;padding:8px 12px;">
          <span style="font-size:11px;font-weight:500;color:#5a50ff;letter-spacing:0.3px;text-transform:uppercase;">${badgeLabel}</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size:26px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;line-height:1.3;">${titleText}</h1>

      <!-- Message -->
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">${emailBody.replace(/\n/g, "<br>")}</div>

      <!-- Note PDF joint -->
      <div style="background-color:#fafafa;border-left:3px solid #5a50ff;border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px;">
        <p style="font-size:14px;color:#4b5563;margin:0;line-height:1.6;">📎 ${pdfNote}</p>
      </div>

      <!-- Détails -->
      <div style="background-color:#fafafa;border-radius:8px;padding:16px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">${detailRows}
        </table>
      </div>
      ${
        clickTrackingUrl
          ? `
      <!-- Bouton CTA -->
      <a href="${clickTrackingUrl}" style="display:block;background-color:#1a1a1a;color:#ffffff;text-decoration:none;padding:16px 24px;border-radius:6px;font-weight:500;font-size:15px;text-align:center;">${ctaLabel}</a>`
          : ""
      }
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding-top:32px;text-align:center;padding-bottom:40px;">
      <div style="margin-bottom:16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height:28px;width:auto;">
      </div>
      <p style="font-size:13px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;">Votre gestion, simplifiée.</p>
      <p style="font-size:12px;color:#9ca3af;margin:0 0 24px 0;line-height:1.8;">${footerText}</p>
      <div style="font-size:11px;color:#9ca3af;line-height:1.6;">
        <p style="margin:0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin:0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
  ${trackingPixelUrl ? `<img src="${trackingPixelUrl}" width="1" height="1" border="0" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;text-decoration:none;">` : ""}
</body>
</html>`;
}

/**
 * Génère le HTML de l'email de relance de facture, sur le même gabarit
 * que les autres emails Newbi (logo centré, carte blanche, badge violet,
 * footer marque). Utilisé par la queue de relances automatiques.
 */
function generateReminderEmailHtml(emailBody, variables, reminderType) {
  const isSecond = reminderType === "SECOND";
  const titleText = isSecond
    ? "Dernier rappel de paiement"
    : "Rappel de paiement";
  const badgeLabel = isSecond ? "2ÈME RELANCE" : "1ÈRE RELANCE";
  const notifType = "RELANCE DE FACTURE";

  const todayFormatted = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const detailRow = (label, value, opts = {}) => {
    if (value === null || value === undefined || value === "") return "";
    const weight = opts.strong ? "600" : "400";
    return `
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#6b7280;">${label}</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a1a1a;text-align:right;font-weight:${weight};word-break:break-word;">${value}</td>
                </tr>`;
  };

  const detailRows = `${detailRow("Numéro de la facture", variables.invoiceNumber)}${detailRow("Montant total", variables.totalAmount, { strong: true })}${detailRow("Date d'échéance", variables.dueDate)}`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${titleText}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#fafafa;color:#1a1a1a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#fafafa;font-size:1px;line-height:1px;">${titleText} ${variables.invoiceNumber} — ${variables.totalAmount}</div>
  <div style="max-width:600px;margin:0 auto;padding:0 20px;background-color:#fafafa;">

    <!-- Logo -->
    <div style="text-align:center;padding:40px 0 24px 0;">
      <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png" alt="Newbi" style="height:32px;width:auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align:center;margin-bottom:8px;">
      <span style="font-size:11px;font-weight:600;color:#1a1a1a;letter-spacing:0.5px;text-transform:uppercase;">${notifType}</span>
    </div>

    <!-- Date -->
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-size:12px;color:#6b7280;">${todayFormatted}</span>
    </div>

    <!-- Carte principale -->
    <div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 24px;margin-bottom:32px;">

      <!-- Badge -->
      <div style="margin-bottom:20px;">
        <div style="display:inline-block;background-color:#ede9fe;border-radius:6px;padding:8px 12px;">
          <span style="font-size:11px;font-weight:500;color:#5a50ff;letter-spacing:0.3px;text-transform:uppercase;">${badgeLabel}</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size:26px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;line-height:1.3;">${titleText}</h1>

      <!-- Message -->
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">${emailBody.replace(/\n/g, "<br>")}</div>

      ${
        isSecond
          ? `
      <!-- Avertissement dernier rappel -->
      <div style="background-color:#fef3c7;border-left:3px solid #f59e0b;border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px;">
        <p style="font-size:14px;color:#92400e;margin:0;line-height:1.6;">⚠️ Il s'agit de notre dernier rappel concernant cette facture. Merci de régulariser votre situation dans les plus brefs délais.</p>
      </div>`
          : ""
      }

      <!-- Note PDF joint -->
      <div style="background-color:#fafafa;border-left:3px solid #5a50ff;border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px;">
        <p style="font-size:14px;color:#4b5563;margin:0;line-height:1.6;">📎 La facture est jointe à cet email au format PDF.</p>
      </div>

      <!-- Détails -->
      <div style="background-color:#fafafa;border-radius:8px;padding:16px;">
        <table style="width:100%;border-collapse:collapse;">${detailRows}
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding-top:32px;text-align:center;padding-bottom:40px;">
      <div style="margin-bottom:16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height:28px;width:auto;">
      </div>
      <p style="font-size:13px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;">Votre gestion, simplifiée.</p>
      <p style="font-size:12px;color:#9ca3af;margin:0 0 24px 0;line-height:1.8;">Cette relance a été envoyée par ${variables.companyName} depuis Newbi, logiciel de gestion.</p>
      <div style="font-size:11px;color:#9ca3af;line-height:1.6;">
        <p style="margin:0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin:0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
</body>
</html>`;
}

/**
 * Génère le HTML de l'email de confirmation d'envoi destiné à l'émetteur
 */
function generateSenderConfirmationHtml({
  documentType,
  documentNumber,
  recipientEmail,
  clientName,
  totalAmount,
  sentAt,
  companyName,
}) {
  const labels = DOCUMENT_LABELS[documentType];
  const docLabel = labels.singular;
  const article = labels.article;
  const capitalizedArticle =
    article.charAt(0).toUpperCase() +
    article.slice(1) +
    (article.endsWith("'") ? "" : " ");
  const verbAccord =
    documentType === DOCUMENT_TYPES.INVOICE ||
    documentType === DOCUMENT_TYPES.CREDIT_NOTE
      ? "envoyée"
      : "envoyé";

  const todayFormatted = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const confRow = (label, value, opts = {}) => {
    if (value === null || value === undefined || value === "") return "";
    const weight = opts.strong ? "600" : "400";
    return `
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#6b7280;">${label}</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a1a1a;text-align:right;font-weight:${weight};word-break:break-word;">${value}</td>
                </tr>`;
  };

  const confRows = `${confRow("Numéro", documentNumber)}${confRow("Destinataire", recipientEmail)}${confRow("Montant", totalAmount, { strong: true })}${confRow("Envoyé le", sentAt)}`;

  // Même gabarit que l'email d'envoi de document (cf. notification de mention).
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmation d'envoi</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#fafafa;color:#1a1a1a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#fafafa;font-size:1px;line-height:1px;">${capitalizedArticle}${docLabel} ${documentNumber} a bien été ${verbAccord} à ${clientName}.</div>
  <div style="max-width:600px;margin:0 auto;padding:0 20px;background-color:#fafafa;">

    <!-- Logo -->
    <div style="text-align:center;padding:40px 0 24px 0;">
      <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png" alt="Newbi" style="height:32px;width:auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align:center;margin-bottom:8px;">
      <span style="font-size:11px;font-weight:600;color:#1a1a1a;letter-spacing:0.5px;text-transform:uppercase;">CONFIRMATION D'ENVOI</span>
    </div>

    <!-- Date -->
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-size:12px;color:#6b7280;">${todayFormatted}</span>
    </div>

    <!-- Carte principale -->
    <div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px 24px;margin-bottom:32px;">

      <!-- Badge -->
      <div style="margin-bottom:20px;">
        <div style="display:inline-block;background-color:#ede9fe;border-radius:6px;padding:8px 12px;">
          <span style="font-size:11px;font-weight:500;color:#5a50ff;letter-spacing:0.3px;text-transform:uppercase;">Envoi confirmé</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size:26px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;line-height:1.3;">${capitalizedArticle}${docLabel} ${documentNumber}</h1>

      <!-- Message -->
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">
        ${capitalizedArticle}${docLabel} <strong style="color:#1a1a1a;">${documentNumber}</strong> a bien été ${verbAccord} à <strong style="color:#1a1a1a;">${clientName}</strong> (${recipientEmail}).
      </div>

      <!-- Récapitulatif -->
      <div style="background-color:#fafafa;border-radius:8px;padding:16px;">
        <table style="width:100%;border-collapse:collapse;">${confRows}
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding-top:32px;text-align:center;padding-bottom:40px;">
      <div style="margin-bottom:16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height:28px;width:auto;">
      </div>
      <p style="font-size:13px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;">Votre gestion, simplifiée.</p>
      <p style="font-size:12px;color:#9ca3af;margin:0 0 24px 0;line-height:1.8;">Email automatique envoyé par Newbi pour confirmer l'envoi de votre document.</p>
      <div style="font-size:11px;color:#9ca3af;line-height:1.6;">
        <p style="margin:0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin:0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
</body>
</html>`;
}

/**
 * Envoie un email de confirmation à l'émetteur après un envoi réussi
 */
async function sendSenderConfirmationEmail({
  senderEmail,
  documentType,
  documentNumber,
  recipientEmail,
  clientName,
  totalAmount,
  companyName,
}) {
  if (!senderEmail) return;

  const labels = DOCUMENT_LABELS[documentType];
  const subject = `${labels.singular.charAt(0).toUpperCase() + labels.singular.slice(1)} ${documentNumber} envoyé${
    documentType === DOCUMENT_TYPES.INVOICE ||
    documentType === DOCUMENT_TYPES.CREDIT_NOTE
      ? "e"
      : ""
  } à ${clientName}`;

  const sentAt = new Date().toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
  });

  const html = generateSenderConfirmationHtml({
    documentType,
    documentNumber,
    recipientEmail,
    clientName,
    totalAmount,
    sentAt,
    companyName,
  });

  await emailReminderService.sendEmail({
    to: senderEmail,
    subject,
    html,
  });
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
  senderEmail = null,
  extraAttachments = [],
  useCustomFooter,
  customEmailFooter,
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

  // Récupérer les paramètres email du workspace (fallback pour le footer)
  const emailSettings = await EmailSettings.findOne({ workspaceId });

  // Déterminer le footer personnalisé : la valeur envoyée depuis le modal
  // d'envoi a la priorité sur les paramètres sauvegardés en base.
  const requestProvidedFooter =
    useCustomFooter !== undefined || customEmailFooter !== undefined;
  const effectiveUseCustomFooter = requestProvidedFooter
    ? Boolean(useCustomFooter)
    : Boolean(emailSettings?.useCustomFooter);
  const effectiveCustomFooter = requestProvidedFooter
    ? customEmailFooter || ""
    : emailSettings?.customEmailFooter || "";

  const customFooter =
    effectiveUseCustomFooter && effectiveCustomFooter
      ? replaceVariables(effectiveCustomFooter, variables)
      : null;

  // Générer le token de tracking et l'URL du pixel
  const trackingToken = crypto.randomBytes(32).toString("hex");
  const apiBaseUrl =
    process.env.API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.BACKEND_URL ||
    "http://localhost:4000";
  const trackingPixelUrl = `${apiBaseUrl}/tracking/open/${trackingToken}`;
  const clickTrackingUrl = `${apiBaseUrl}/tracking/click/${trackingToken}`;

  // Sauvegarder le token de tracking sur le document
  const ModelMap = {
    invoice: Invoice,
    quote: Quote,
    creditNote: CreditNote,
    purchaseOrder: PurchaseOrder,
  };
  const TrackingModel = ModelMap[documentType];
  if (TrackingModel) {
    // $set de l'objet entier (pas de chemins pointés) : un document dont
    // emailTracking vaut null ferait échouer la création de sous-champs.
    await TrackingModel.updateOne(
      { _id: documentId },
      {
        $set: {
          emailTracking: {
            trackingToken,
            emailSentAt: new Date(),
            emailOpenedAt: null,
            emailOpenCount: 0,
            emailClickedAt: null,
            emailClickCount: 0,
          },
        },
      },
    );
  }

  // Générer le HTML avec le pixel de tracking et le bouton cliquable
  const emailHtml = generateEmailHtml(
    finalBody,
    variables,
    documentType,
    dueDate,
    customFooter,
    trackingPixelUrl,
    clickTrackingUrl,
  );

  // Résolution du PDF — R2 binaire prioritaire, base64 = transport optionnel.
  // Le base64 (généré côté éditeur) n'est jamais stocké : il est décodé puis jeté.
  // La source durable est le binaire mis en cache dans R2 (cachedPdf).
  let pdfBuffer = null;
  let pdfFromCache = false;

  // 1) Fast-path : PDF généré côté client et transmis dans la requête (transitoire)
  if (pdfBase64) {
    pdfBuffer = Buffer.from(pdfBase64, "base64");
  }

  // 2) Sinon, réutiliser le PDF binaire déjà mis en cache dans R2 (aucun base64)
  if (!pdfBuffer && document.cachedPdf?.url) {
    try {
      const cachedResponse = await axios.get(document.cachedPdf.url, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      pdfBuffer = Buffer.from(cachedResponse.data);
      pdfFromCache = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "⚠️ [DocumentEmail] Échec lecture du PDF en cache R2:",
        err.message,
      );
    }
  }

  // 3) En dernier recours : génération côté serveur via Puppeteer (Next.js)
  if (!pdfBuffer) {
    pdfBuffer = await generateDocumentPdf(documentId, documentType);
  }

  // Garde-fou : ne jamais envoyer un document sans sa pièce jointe.
  // On bloque l'envoi avec une erreur explicite plutôt que de partir sans PDF.
  if (!pdfBuffer) {
    throw new Error(
      "Impossible de générer le PDF du document. L'email n'a pas été envoyé. Veuillez réessayer.",
    );
  }

  // Cache le PDF binaire dans R2 pour les prochains envois/automatisations
  // (inutile s'il en provient déjà). Fire-and-forget.
  if (
    !pdfFromCache &&
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

  // Ajouter les pièces jointes supplémentaires fournies par l'utilisateur
  const normalizedExtraAttachments = (extraAttachments || [])
    .filter((att) => att && att.filename && att.content)
    .map((att) => ({
      filename: att.filename,
      content: Buffer.from(att.content, "base64"),
      contentType: att.contentType || "application/octet-stream",
    }));

  attachments.push(...normalizedExtraAttachments);

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

  // Envoyer l'email via Resend API (prioritaire) ou SMTP (fallback)
  let mailResult;
  let resendMessageId = null;

  if (emailReminderService.useResend && emailReminderService.resend) {
    // Envoi via Resend API
    // Resend exige un domaine vérifié pour le "from" — on utilise le domaine vérifié
    // et on met l'email réel de l'expéditeur en replyTo
    const resendFromEmail = emailReminderService.resendFromEmail;
    const resendFrom = fromName
      ? `${fromName} <${resendFromEmail}>`
      : `Newbi <${resendFromEmail}>`;

    const resendPayload = {
      from: resendFrom,
      to: [recipientEmail],
      subject: finalSubject,
      html: emailHtml,
      replyTo: replyTo || fromEmail,
      headers: {
        "X-Document-Tracking-Token": trackingToken,
      },
    };

    if (ccEmails && ccEmails.length > 0) {
      resendPayload.cc = ccEmails.filter((email) => email && email.trim());
    }

    if (bccEmails && bccEmails.length > 0) {
      resendPayload.bcc = bccEmails.filter((email) => email && email.trim());
    }

    const resendAttachments = [];
    if (pdfBuffer) {
      resendAttachments.push({
        filename: `${documentNumber}.pdf`,
        content: pdfBuffer,
      });
    }
    for (const att of normalizedExtraAttachments) {
      resendAttachments.push({
        filename: att.filename,
        content: att.content,
      });
    }
    if (resendAttachments.length > 0) {
      resendPayload.attachments = resendAttachments;
    }

    const { data, error } =
      await emailReminderService.resend.emails.send(resendPayload);

    if (error) {
      throw new Error(`Erreur Resend: ${error.message}`);
    }

    resendMessageId = data?.id || null;
    mailResult = { messageId: resendMessageId };

    console.info(
      `📧 [DocumentEmail] Email envoyé via Resend (id: ${resendMessageId})`,
    );
  } else {
    // Fallback SMTP
    if (!emailReminderService.transporter) {
      throw new Error("Service SMTP non initialisé");
    }

    mailResult = await emailReminderService.transporter.sendMail(mailOptions);
  }

  // Sauvegarder le resendMessageId sur le document pour le webhook tracking
  if (resendMessageId && TrackingModel) {
    await TrackingModel.updateOne(
      { _id: documentId },
      { $set: { "emailTracking.resendMessageId": resendMessageId } },
    );
  }

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

  // Envoi de la confirmation à l'émetteur (fire-and-forget)
  if (senderEmail) {
    (async () => {
      try {
        await sendSenderConfirmationEmail({
          senderEmail,
          documentType,
          documentNumber,
          recipientEmail,
          clientName: variables.clientName,
          totalAmount: variables.totalAmount,
          companyName: variables.companyName,
        });
      } catch (confirmationError) {
        console.warn(
          "⚠️ [DocumentEmail] Erreur envoi confirmation émetteur:",
          confirmationError.message,
        );
      }
    })();
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
  generateReminderEmailHtml,
};
