import mongoose from "mongoose";
import crypto from "crypto";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import CreditNote from "../models/CreditNote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";
import Client from "../models/Client.js";
import EmailSettings from "../models/EmailSettings.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import emailReminderService from "./emailReminderService.js";
import axios from "axios";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import cloudflareService from "./cloudflareService.js";
import { readArchivedDocumentPdf } from "../utils/archivedDocumentPdf.js";
import { isInvoiceFullyCredited } from "../utils/invoiceCredit.js";
import { APP_URL, escapeHtml, typo } from "../utils/trialEmails.js";
import {
  createEmailLog,
  emailLogPreviewUrl,
  storeEmailLogAttachments,
} from "./documentEmailLogService.js";

/**
 * Service d'envoi de documents (factures, devis, avoirs) par email
 */

const DOCUMENT_TYPES = {
  INVOICE: "invoice",
  QUOTE: "quote",
  CREDIT_NOTE: "creditNote",
  PURCHASE_ORDER: "purchaseOrder",
  DELIVERY_NOTE: "deliveryNote",
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
  deliveryNote: {
    singular: "bon de livraison",
    plural: "bons de livraison",
    article: "le",
  },
};

/**
 * Récupère un document par son ID et type
 */
/** Adresse e-mail : une partie locale, un @, un domaine avec un point. */
const EMAIL_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Le contenu commence par la signature d'un PDF (« %PDF- »). */
const isPdfBuffer = (buffer) =>
  buffer.length > 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";

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
    case DOCUMENT_TYPES.DELIVERY_NOTE:
      document = await DeliveryNote.findOne({ _id: documentId, workspaceId });
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
  // Sous Vitest, les documents vivent dans un MongoMemoryServer : le front ne
  // les connaît pas, l'appel lancerait un vrai Puppeteer pour finir en 404.
  if (process.env.NODE_ENV === "test") {
    throw new Error(
      "generateDocumentPdf désactivé en environnement de test (mocker le service si nécessaire)",
    );
  }
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
    case DOCUMENT_TYPES.DELIVERY_NOTE:
      endpoint = "/api/delivery-notes/generate-pdf";
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
    } else if (documentType === DOCUMENT_TYPES.DELIVERY_NOTE) {
      body.deliveryNoteId = documentId;
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
  paymentUrl = null,
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

  const detailRows = `${detailRow(numberLabel, variables.documentNumber)}${detailRow("Montant total", variables.totalAmount, { strong: true })}${detailRow("Date d'émission", variables.issueDate)}${documentType === DOCUMENT_TYPES.INVOICE || documentType === DOCUMENT_TYPES.QUOTE ? detailRow("Date d'échéance", dueDate) : documentType === DOCUMENT_TYPES.PURCHASE_ORDER ? detailRow("Date de validité", dueDate) : ""}${documentType === DOCUMENT_TYPES.CREDIT_NOTE ? detailRow("Facture associée", variables.invoiceNumber) : ""}`;

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
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">${escapeHtml(emailBody).replace(/\n/g, "<br>")}</div>

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
        paymentUrl
          ? `
      <!-- Bouton Paiement en ligne -->
      <a href="${paymentUrl}" style="display:block;background-color:#16a34a;color:#ffffff;text-decoration:none;padding:16px 24px;border-radius:6px;font-weight:600;font-size:15px;text-align:center;margin-bottom:12px;">Payer en ligne</a>`
          : ""
      }
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
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">${escapeHtml(emailBody).replace(/\n/g, "<br>")}</div>

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

// Liste où retrouver chaque type de document dans l'application
const DOCUMENT_LIST_PATHS = {
  invoice: "factures",
  quote: "devis",
  creditNote: "factures",
  purchaseOrder: "bons-commande",
  deliveryNote: "bons-de-livraison",
};

/**
 * Numéro, client et montant affichés dans les e-mails d'un document
 */
function buildDocumentSummary(document) {
  const total = document.finalTotalTTC ?? document.totalTTC ?? 0;
  return {
    documentNumber: `${document.prefix || ""}-${document.number}`.replace(
      /^-/,
      "",
    ),
    clientName: document.client?.name || "Client",
    totalAmount: new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(total),
  };
}

// Le VPS est en UTC : les heures affichées sont celles de Paris
function formatParisDateTime(date) {
  return new Date(date).toLocaleString("fr-FR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Paris",
  });
}

/**
 * Article + nom du document en début de phrase (« La facture », « L'avoir »)
 */
function capitalizedDocumentLabel(documentType) {
  const { singular, article } = DOCUMENT_LABELS[documentType];
  const capitalizedArticle =
    article.charAt(0).toUpperCase() +
    article.slice(1) +
    (article.endsWith("'") ? "" : " ");
  return `${capitalizedArticle}${singular}`;
}

/**
 * Gabarit commun des e-mails adressés à l'émetteur (reçu de remise, alerte
 * de rejet) : même habillage que l'e-mail d'envoi de document.
 */
function renderSenderNoticeHtml({
  title,
  preheader,
  notifType,
  badge,
  heading,
  messageHtml,
  rows,
  afterRowsHtml = "",
  footerText,
}) {
  const todayFormatted = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  });

  const confRows = rows
    .filter(
      ({ value }) => value !== null && value !== undefined && value !== "",
    )
    .map(({ label, value, strong }) => {
      const weight = strong ? "600" : "400";
      return `
                <tr>
                  <td style="padding:6px 0;font-size:14px;color:#6b7280;">${label}</td>
                  <td style="padding:6px 0;font-size:14px;color:#1a1a1a;text-align:right;font-weight:${weight};word-break:break-word;">${typo(escapeHtml(value))}</td>
                </tr>`;
    })
    .join("");

  // Même gabarit que l'email d'envoi de document (cf. notification de mention).
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#fafafa;color:#1a1a1a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#fafafa;font-size:1px;line-height:1px;">${escapeHtml(preheader)}</div>
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
        <div style="display:inline-block;background-color:${badge.background};border-radius:6px;padding:8px 12px;">
          <span style="font-size:11px;font-weight:500;color:${badge.color};letter-spacing:0.3px;text-transform:uppercase;">${badge.label}</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size:26px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;line-height:1.3;">${escapeHtml(heading)}</h1>

      <!-- Message -->
      <div style="font-size:15px;color:#4b5563;margin:0 0 24px 0;line-height:1.6;">
        ${typo(messageHtml)}
      </div>

      <!-- Récapitulatif -->
      <div style="background-color:#fafafa;border-radius:8px;padding:16px;">
        <table style="width:100%;border-collapse:collapse;">${confRows}
        </table>
      </div>${afterRowsHtml}
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #e5e7eb;padding-top:32px;text-align:center;padding-bottom:40px;">
      <div style="margin-bottom:16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height:28px;width:auto;">
      </div>
      <p style="font-size:13px;font-weight:500;color:#1a1a1a;margin:0 0 24px 0;">Votre gestion, simplifiée.</p>
      <p style="font-size:12px;color:#9ca3af;margin:0 0 24px 0;line-height:1.8;">${typo(footerText)}</p>
      <div style="font-size:11px;color:#9ca3af;line-height:1.6;">
        <p style="margin:0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin:0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
    </div>

  </div>
</body>
</html>`;
}

// Bouton des e-mails à l'émetteur (même style que les e-mails d'essai)
function senderNoticeButton(url, label) {
  return `
      <a href="${escapeHtml(url)}" style="display:block;background-color:#1a1a1a;color:#ffffff;text-decoration:none;padding:16px 24px;border-radius:6px;font-weight:500;font-size:15px;text-align:center;margin-top:24px;">${label}</a>`;
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
  deliveredAt,
  previewUrl,
}) {
  const label = capitalizedDocumentLabel(documentType);
  const verbAccord =
    documentType === DOCUMENT_TYPES.INVOICE ||
    documentType === DOCUMENT_TYPES.CREDIT_NOTE
      ? "envoyée"
      : "envoyé";

  return renderSenderNoticeHtml({
    title: "Confirmation d'envoi",
    preheader: `${label} ${documentNumber} a bien été ${verbAccord} à ${clientName}.`,
    notifType: "CONFIRMATION D'ENVOI",
    badge: { label: "Envoi confirmé", background: "#ede9fe", color: "#5a50ff" },
    heading: `${label} ${documentNumber}`,
    messageHtml: `${escapeHtml(label)} <strong style="color:#1a1a1a;">${escapeHtml(documentNumber)}</strong> a bien été ${verbAccord} à <strong style="color:#1a1a1a;">${escapeHtml(clientName)}</strong> (${escapeHtml(recipientEmail)}).`,
    rows: [
      { label: "Numéro", value: documentNumber },
      { label: "Destinataire", value: recipientEmail },
      { label: "Montant", value: totalAmount, strong: true },
      { label: "Envoyé le", value: sentAt },
      { label: "Remis le", value: deliveredAt },
    ],
    afterRowsHtml: previewUrl
      ? senderNoticeButton(previewUrl, "Voir l'e-mail envoyé")
      : "",
    footerText:
      "Email automatique envoyé par Newbi pour confirmer l'envoi de votre document.",
  });
}

/**
 * Génère le HTML de l'alerte envoyée à l'émetteur quand l'e-mail du document
 * n'a pas pu être remis au destinataire
 */
function generateSenderFailureHtml({
  documentType,
  documentNumber,
  recipientEmail,
  clientName,
  reason,
  sentAt,
  previewUrl,
}) {
  const { singular } = DOCUMENT_LABELS[documentType];
  const remis = documentType === DOCUMENT_TYPES.INVOICE ? "remise" : "remis";
  // L'aperçu montre l'adresse utilisée ; sans lui, la liste des documents
  const button = previewUrl
    ? senderNoticeButton(previewUrl, "Voir l'e-mail envoyé")
    : senderNoticeButton(
        `${APP_URL}/dashboard/outils/${DOCUMENT_LIST_PATHS[documentType]}`,
        "Ouvrir Newbi",
      );

  return renderSenderNoticeHtml({
    title: "Envoi non remis",
    preheader: `Votre ${singular} ${documentNumber} n'a pas pu être ${remis} à ${clientName}.`,
    notifType: "ENVOI NON REMIS",
    badge: { label: "Non remis", background: "#fee2e2", color: "#dc2626" },
    heading: `${capitalizedDocumentLabel(documentType)} ${documentNumber}`,
    messageHtml: `Votre ${singular} <strong style="color:#1a1a1a;">${escapeHtml(documentNumber)}</strong> n'a pas pu être ${remis} à <strong style="color:#1a1a1a;">${escapeHtml(clientName)}</strong> (${escapeHtml(recipientEmail)}). Votre client ne l'a pas reçu.`,
    rows: [
      { label: "Numéro", value: documentNumber },
      { label: "Destinataire", value: recipientEmail },
      { label: "Raison", value: reason, strong: true },
      { label: "Envoyé le", value: sentAt },
    ],
    afterRowsHtml: `

      <!-- Que faire -->
      <div style="font-size:15px;color:#4b5563;margin:24px 0 0 0;line-height:1.6;">
        ${typo("Vérifiez l'adresse e-mail de votre client, puis renvoyez le document depuis Newbi.")}
      </div>${button}`,
    footerText:
      "Email automatique envoyé par Newbi pour vous signaler un envoi non remis.",
  });
}

/**
 * Envoie un email de confirmation à l'émetteur une fois l'e-mail du document
 * remis au serveur du destinataire
 */
async function sendSenderConfirmationEmail({
  senderEmail,
  documentType,
  documentNumber,
  recipientEmail,
  clientName,
  totalAmount,
  sentAt = new Date(),
  deliveredAt = null,
  previewUrl = null,
}) {
  if (!senderEmail) return;

  const labels = DOCUMENT_LABELS[documentType];
  const subject = `${labels.singular.charAt(0).toUpperCase() + labels.singular.slice(1)} ${documentNumber} envoyé${
    documentType === DOCUMENT_TYPES.INVOICE ||
    documentType === DOCUMENT_TYPES.CREDIT_NOTE
      ? "e"
      : ""
  } à ${clientName}`;

  const html = generateSenderConfirmationHtml({
    documentType,
    documentNumber,
    recipientEmail,
    clientName,
    totalAmount,
    sentAt: formatParisDateTime(sentAt),
    deliveredAt: deliveredAt ? formatParisDateTime(deliveredAt) : null,
    previewUrl,
  });

  await emailReminderService.sendEmail({
    to: senderEmail,
    subject,
    html,
  });
}

/**
 * Prévient l'émetteur que l'e-mail du document a été rejeté
 */
async function sendSenderFailureEmail({
  senderEmail,
  documentType,
  documentNumber,
  recipientEmail,
  clientName,
  reason,
  sentAt = new Date(),
  previewUrl = null,
}) {
  if (!senderEmail) return;

  const labels = DOCUMENT_LABELS[documentType];
  const subject = `${labels.singular.charAt(0).toUpperCase() + labels.singular.slice(1)} ${documentNumber} non remis${
    documentType === DOCUMENT_TYPES.INVOICE ? "e" : ""
  } à ${clientName}`;

  const html = generateSenderFailureHtml({
    documentType,
    documentNumber,
    recipientEmail,
    clientName,
    reason,
    sentAt: formatParisDateTime(sentAt),
    previewUrl,
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
  // Adresses : une adresse e-mail valide chacune (destinataire, copies)
  for (const address of [
    recipientEmail,
    ...(ccEmails || []),
    ...(bccEmails || []),
  ].filter((email) => email && String(email).trim())) {
    if (!EMAIL_ADDRESS.test(String(address).trim())) {
      throw new AppError(
        `Adresse e-mail invalide : ${String(address).slice(0, 100)}`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
  }
  // L'objet tient sur une ligne : un retour à la ligne ajouterait un
  // en-tête à l'e-mail
  emailSubject = String(emailSubject ?? "").replace(/[\r\n]+/g, " ");
  // PDF joint par l'éditeur : un vrai PDF seulement
  if (pdfBase64 && !isPdfBuffer(Buffer.from(pdfBase64, "base64"))) {
    throw new AppError(
      "Le document joint n'est pas un PDF valide. L'e-mail n'a pas été envoyé.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  // Préparer les variables
  const summary = buildDocumentSummary(document);
  const { documentNumber } = summary;

  // Récupérer le nom et l'email d'entreprise actuels depuis l'organisation (pas le snapshot du document)
  let currentCompanyName = document.companyInfo?.name || "Votre Entreprise";
  let currentCompanyEmail = document.companyInfo?.email || "";
  try {
    const db = mongoose.connection.db;
    const organizationCollection = db.collection("organization");
    const organization = await organizationCollection.findOne({
      _id: new mongoose.Types.ObjectId(workspaceId),
    });
    if (organization?.companyName) {
      currentCompanyName = organization.companyName;
    }
    if (organization?.companyEmail) {
      currentCompanyEmail = organization.companyEmail;
    }
  } catch {
    // Fallback sur le snapshot du document
  }

  const variables = {
    documentNumber,
    clientName: summary.clientName,
    totalAmount: summary.totalAmount,
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

  // Récupérer la date d'échéance (factures) ou de validité (devis, bons de commande)
  const dueDate =
    documentType === DOCUMENT_TYPES.INVOICE && document.dueDate
      ? new Date(document.dueDate).toLocaleDateString("fr-FR")
      : (documentType === DOCUMENT_TYPES.QUOTE ||
            documentType === DOCUMENT_TYPES.PURCHASE_ORDER) &&
          document.validUntil
        ? new Date(document.validUntil).toLocaleDateString("fr-FR")
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

  // Le suivi n'est enregistré qu'une fois l'e-mail accepté (après l'envoi) :
  // un envoi refusé ne doit pas marquer le document « Envoyé »
  const ModelMap = {
    invoice: Invoice,
    quote: Quote,
    creditNote: CreditNote,
    purchaseOrder: PurchaseOrder,
    deliveryNote: DeliveryNote,
  };
  const TrackingModel = ModelMap[documentType];

  // Lien de paiement en ligne : uniquement pour une facture non encore payée,
  // et si l'organisation a un compte Stripe Connect opérationnel (chargesEnabled).
  // Lien stable vers l'endpoint de redirection du backend (crée une session Checkout fraîche).
  let paymentUrl = null;
  if (
    documentType === DOCUMENT_TYPES.INVOICE &&
    document.status !== "COMPLETED" &&
    document.status !== "CANCELED" &&
    document.status !== "DRAFT"
  ) {
    try {
      const stripeAccount = await StripeConnectAccount.findOne({
        organizationId: workspaceId.toString(),
      });
      // Facture soldée par avoir : plus de bouton de paiement
      if (
        stripeAccount &&
        stripeAccount.chargesEnabled &&
        !(await isInvoiceFullyCredited(document))
      ) {
        const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
        paymentUrl = `${backendUrl}/pay/invoice/${documentId}`;
      }
    } catch (stripeLinkError) {
      console.error(
        "Erreur résolution lien de paiement Stripe:",
        stripeLinkError,
      );
    }
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
    paymentUrl,
  );

  // Résolution du PDF — R2 binaire prioritaire, base64 = transport optionnel.
  // Le base64 (généré côté éditeur) n'est jamais stocké : il est décodé puis jeté.
  // La source durable est le binaire mis en cache dans R2 (cachedPdf).
  let pdfBuffer = null;
  let pdfFromCache = false;

  // 1) Fast-path : PDF généré côté client et transmis dans la requête
  // (transitoire : jamais mis en cache, la copie durable vient du serveur)
  let pdfFromClient = false;
  if (pdfBase64) {
    pdfBuffer = Buffer.from(pdfBase64, "base64");
    pdfFromClient = true;
  }

  // 2) Document finalisé : PDF archivé sur R2 (archivedPdfKey), la version
  // légale du document, prioritaire sur la copie en cache. Le desktop passe
  // toujours pdfBase64 (étape 1) : ce chemin concerne les clients qui n'en
  // envoient pas (mobile, automatisations).
  if (!pdfBuffer && document.archivedPdfKey && document.status !== "DRAFT") {
    try {
      pdfBuffer = await readArchivedDocumentPdf(documentType, document);
      if (pdfBuffer) pdfFromCache = true; // déjà durable sur R2
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "⚠️ [DocumentEmail] Échec lecture du PDF archivé R2:",
        err.message,
      );
    }
  }

  // 2 bis) Sinon, réutiliser le PDF binaire déjà mis en cache dans R2
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
    !pdfFromClient &&
    pdfBuffer &&
    (documentType === DOCUMENT_TYPES.INVOICE ||
      documentType === DOCUMENT_TYPES.QUOTE ||
      documentType === DOCUMENT_TYPES.CREDIT_NOTE ||
      documentType === DOCUMENT_TYPES.PURCHASE_ORDER ||
      documentType === DOCUMENT_TYPES.DELIVERY_NOTE)
  ) {
    const ModelMap = {
      invoice: Invoice,
      quote: Quote,
      creditNote: CreditNote,
      purchaseOrder: PurchaseOrder,
      deliveryNote: DeliveryNote,
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

  // L'email de l'organisation est l'identité d'expéditeur (cohérent avec le "De" affiché
  // dans le modal d'envoi) ; les paramètres email servent de repli, replyTo reste un override
  const fromEmail =
    currentCompanyEmail || emailSettings?.fromEmail || "noreply@newbi.fr";
  const fromName = currentCompanyName || emailSettings?.fromName || "";
  const replyTo = emailSettings?.replyTo || fromEmail;

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
  // Expéditeur tel que le client le voit (journal de l'envoi)
  let sentFrom = actualSenderEmail;

  if (emailReminderService.useResend && emailReminderService.resend) {
    // Envoi via Resend API
    // Resend exige un domaine vérifié pour le "from" — on utilise le domaine vérifié
    // et on met l'email réel de l'expéditeur en replyTo
    const resendFromEmail = emailReminderService.resendFromEmail;
    const resendFrom = fromName
      ? `${fromName} <${resendFromEmail}>`
      : `Newbi <${resendFromEmail}>`;
    sentFrom = resendFrom;

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

  // Via Resend, le reçu attend la remise de l'e-mail au serveur du
  // destinataire (documentDeliveryService) ; via SMTP, aucun suivi possible,
  // il part tout de suite comme avant
  const sentAt = new Date();
  const confirmNow = Boolean(senderEmail) && !resendMessageId;
  if (TrackingModel) {
    // $set de l'objet entier (pas de chemins pointés) : un document dont
    // emailTracking vaut null ferait échouer la création de sous-champs.
    await TrackingModel.updateOne(
      { _id: documentId },
      {
        $set: {
          emailTracking: {
            trackingToken,
            emailSentAt: sentAt,
            emailOpenedAt: null,
            emailOpenCount: 0,
            emailClickedAt: null,
            emailClickCount: 0,
            resendMessageId,
            deliveryStatus: "SENT",
            recipientEmail,
            senderEmail: senderEmail || null,
            senderNotifiedAt: confirmNow ? sentAt : null,
          },
        },
      },
    );
  }

  // Journal de l'envoi : aperçu de l'e-mail reçu par le client et historique
  // du document. Sans pixel ni liens de suivi (boutons inertes) : consulter
  // l'aperçu ne doit pas marquer le document « Ouvert ».
  const cleanAddresses = (emails) =>
    (emails || []).filter((email) => email && email.trim());
  const emailLog = await createEmailLog({
    workspaceId: document.workspaceId,
    documentType,
    documentId: document._id,
    documentNumber,
    originalInvoiceId:
      documentType === DOCUMENT_TYPES.CREDIT_NOTE
        ? document.originalInvoice || null
        : null,
    sentAt,
    senderEmail: senderEmail || null,
    from: sentFrom,
    replyTo,
    to: recipientEmail,
    cc: cleanAddresses(ccEmails),
    bcc: cleanAddresses(bccEmails),
    subject: finalSubject,
    html: generateEmailHtml(
      finalBody,
      variables,
      documentType,
      dueDate,
      customFooter,
      null,
      "#",
      paymentUrl ? "#" : null,
    ),
    attachments: [
      {
        filename: `${documentNumber}.pdf`,
        size: pdfBuffer.length,
        isDocument: true,
      },
      ...normalizedExtraAttachments.map((att) => ({
        filename: att.filename,
        size: att.content.length,
      })),
    ],
    resendMessageId,
    trackingToken,
    deliveryStatus: "SENT",
  });

  // Fichiers ajoutés à la main : conservés pour être rouverts depuis la page
  // de l'e-mail envoyé, en arrière-plan (l'envoi est déjà parti)
  if (emailLog && normalizedExtraAttachments.length > 0) {
    storeEmailLogAttachments(emailLog, normalizedExtraAttachments).catch(
      (error) => {
        console.warn(
          "⚠️ [DocumentEmail] Pièces jointes non conservées:",
          error.message,
        );
      },
    );
  }

  // Ajouter l'activité au client
  try {
    if (document.client?.id || document.client?._id) {
      const clientId = document.client.id || document.client._id;
      // client.id vient du client : seule une fiche de l'espace du document
      // reçoit l'activité.
      const client = await Client.findOne({
        _id: clientId,
        workspaceId: document.workspaceId,
      });

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
  if (confirmNow) {
    (async () => {
      try {
        await sendSenderConfirmationEmail({
          senderEmail,
          documentType,
          documentNumber,
          recipientEmail,
          clientName: variables.clientName,
          totalAmount: variables.totalAmount,
          sentAt,
          previewUrl: emailLogPreviewUrl(emailLog?._id),
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
  buildDocumentSummary,
  sendSenderConfirmationEmail,
  sendSenderFailureEmail,
};
