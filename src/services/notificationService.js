import nodemailer from "nodemailer";
import User from "../models/User.js";
import logger from "../utils/logger.js";

// Créer le transporteur SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// Valeurs par défaut pour les préférences de notifications
const defaultNotificationPreferences = {
  invoice_overdue: { email: true, push: true },
  payment_received: { email: true, push: true },
  quote_response: { email: true, push: true },
  invoice_due_soon: { email: false, push: true },
  payment_failed: { email: true, push: true },
  trial_ending: { email: true, push: true },
  subscription_renewed: { email: true, push: false },
  invitation_received: { email: true, push: true },
  member_joined: { email: false, push: true },
  document_shared: { email: false, push: true },
};

/**
 * Vérifie si une notification est activée pour un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @param {string} notificationType - Type de notification (ex: 'payment_received')
 * @param {string} channel - Canal de notification ('email' ou 'push')
 * @returns {Promise<boolean>}
 */
async function isNotificationEnabled(userId, notificationType, channel) {
  try {
    const user = await User.findById(userId)
      .select("notificationPreferences")
      .lean();

    if (!user) {
      logger.warn(
        `Utilisateur ${userId} non trouvé pour vérification des préférences`
      );
      return false;
    }

    const userPrefs = user.notificationPreferences || {};
    const pref = userPrefs[notificationType];

    // Si la préférence existe, l'utiliser, sinon utiliser la valeur par défaut
    if (pref && pref[channel] !== undefined) {
      return pref[channel];
    }

    // Valeur par défaut
    return defaultNotificationPreferences[notificationType]?.[channel] ?? false;
  } catch (error) {
    logger.error(
      `Erreur lors de la vérification des préférences de notification:`,
      error
    );
    return false;
  }
}

/**
 * Formate un montant en euros
 * @param {number} amount - Montant à formater
 * @returns {string}
 */
function formatAmount(amount) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(amount || 0);
}

/**
 * Formate une date en français
 * @param {Date} date - Date à formater
 * @returns {string}
 */
function formatDate(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(date));
}

/**
 * Génère le HTML pour l'email "Paiement reçu"
 */
function generatePaymentReceivedHtml({
  invoiceNumber,
  clientName,
  totalAmount,
  paymentDate,
  companyName,
  userName,
}) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmation de paiement</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      margin: 0;
      padding: 0;
      background-color: #f3f4f6;
    }
    .email-wrapper {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }
    .header {
      text-align: center;
      padding: 40px 20px 20px;
      background-color: #ffffff;
    }
    .logo {
      font-size: 32px;
      font-weight: 700;
      color: #000000;
      letter-spacing: -1px;
    }
    .header-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #1f2937;
      margin: 30px 0 10px;
    }
    .header-date {
      font-size: 16px;
      color: #9ca3af;
      margin: 0;
    }
    .content {
      background-color: #ffffff;
      padding: 40px 20px;
    }
    .card {
      background-color: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 30px;
      margin: 0 auto;
      max-width: 500px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background-color: #f3f4f6;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      color: #1f2937;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 24px;
    }
    .title {
      font-size: 28px;
      font-weight: 700;
      color: #1f2937;
      margin: 0 0 24px 0;
      line-height: 1.3;
    }
    .greeting {
      font-size: 16px;
      color: #1f2937;
      margin: 0 0 16px 0;
    }
    .message {
      font-size: 16px;
      color: #6b7280;
      margin: 0 0 32px 0;
      line-height: 1.5;
    }
    .details-table {
      width: 100%;
      background-color: #f9fafb;
      border-radius: 8px;
      padding: 20px;
      margin: 24px 0;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      padding: 12px 0;
      border-bottom: 1px solid #e5e7eb;
    }
    .detail-row:last-child {
      border-bottom: none;
    }
    .detail-label {
      color: #6b7280;
      font-size: 14px;
    }
    .detail-value {
      color: #1f2937;
      font-size: 14px;
      font-weight: 600;
      text-align: right;
    }
    .amount-value {
      color: #10b981;
      font-size: 18px;
      font-weight: 700;
    }
    .btn {
      display: block;
      width: 100%;
      background-color: #1f2937;
      color: #ffffff;
      text-align: center;
      text-decoration: none;
      padding: 16px 24px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      margin: 32px 0 0 0;
    }
    .footer {
      text-align: center;
      padding: 40px 20px;
      background-color: #ffffff;
    }
    .footer-logo {
      font-size: 48px;
      color: #5b50ff;
      margin-bottom: 16px;
    }
    .footer-tagline {
      font-size: 20px;
      font-weight: 600;
      color: #1f2937;
      margin: 0 0 24px 0;
    }
    .footer-text {
      font-size: 14px;
      color: #9ca3af;
      margin: 0 0 8px 0;
    }
    .footer-link {
      color: #9ca3af;
      text-decoration: underline;
    }
    .footer-company {
      font-size: 14px;
      color: #9ca3af;
      margin: 24px 0 8px 0;
    }
    .footer-address {
      font-size: 14px;
      color: #5b50ff;
      text-decoration: none;
    }

    @media (max-width: 600px) {
      .header {
        padding: 30px 15px 15px;
      }
      .content {
        padding: 30px 15px;
      }
      .card {
        padding: 20px;
      }
      .title {
        font-size: 24px;
      }
      .detail-row {
        flex-direction: column;
        gap: 4px;
        padding: 10px 0;
      }
      .detail-value {
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="email-wrapper">
    <!-- Header -->
    <div class="header">
      <div class="logo">newbi.</div>
      <p class="header-title">Confirmation de paiement</p>
      <p class="header-date">${paymentDate}</p>
    </div>

    <!-- Content -->
    <div class="content">
      <div class="card">
        <div class="badge">
          <span>📧</span>
          <span>PAIEMENT</span>
        </div>

        <h1 class="title">Votre paiement a été confirmé</h1>

        <p class="greeting">Bonjour ${userName},</p>

        <p class="message">Merci pour votre paiement ! La facture <strong>${invoiceNumber}</strong> a été automatiquement marquée comme payée.</p>

        <div class="details-table">
          <div class="detail-row">
            <span class="detail-label">N° de facture</span>
            <span class="detail-value">${invoiceNumber}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Client</span>
            <span class="detail-value">${clientName}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Date de paiement</span>
            <span class="detail-value">${paymentDate}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Montant payé</span>
            <span class="amount-value">${totalAmount}</span>
          </div>
        </div>

        <a href="${process.env.FRONTEND_URL}/dashboard/factures" class="btn">Accéder à mon espace</a>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-logo">ni</div>
      <p class="footer-tagline">Votre gestion, simplifiée.</p>
      <p class="footer-text">
        Vous recevez cet email suite à votre paiement sur Newbi. •
        <a href="${process.env.FRONTEND_URL}/faq" class="footer-link">FAQ</a>
      </p>
      <p class="footer-company">SWEILY (SAS),</p>
      <a href="https://www.google.com/maps/place/229+Rue+Saint-Honor%C3%A9,+75001+Paris" class="footer-address">
        229 rue Saint-Honoré, 75001 Paris, FRANCE
      </a>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Envoie une notification "Paiement reçu"
 * @param {Object} params - Paramètres de la notification
 * @param {string} params.userId - ID de l'utilisateur à notifier
 * @param {Object} params.invoice - Données de la facture
 * @param {Date} params.paymentDate - Date du paiement
 */
async function sendPaymentReceivedNotification({
  userId,
  invoice,
  paymentDate,
}) {
  try {
    // Vérifier si la notification email est activée
    const emailEnabled = await isNotificationEnabled(
      userId,
      "payment_received",
      "email"
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'payment_received' désactivée pour l'utilisateur ${userId}`
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // Récupérer les informations de l'utilisateur
    const user = await User.findById(userId)
      .select("email profile company")
      .lean();

    if (!user || !user.email) {
      logger.warn(`Utilisateur ${userId} non trouvé ou sans email`);
      return { success: false, reason: "user_not_found" };
    }

    // Préparer les données pour le template
    const invoiceNumber = `${invoice.prefix || ""}${invoice.number || ""}`;
    const clientName =
      invoice.client?.name || invoice.client?.company || "Client";
    const totalAmount = formatAmount(
      invoice.finalTotalTTC || invoice.totalTTC || 0
    );
    const formattedPaymentDate = formatDate(paymentDate);
    const companyName =
      invoice.companyInfo?.name || user.company?.name || "Votre Entreprise";
    const userName = user.profile?.firstName || user.email.split("@")[0];

    // Générer le HTML de l'email
    const emailHtml = generatePaymentReceivedHtml({
      invoiceNumber,
      clientName,
      totalAmount,
      paymentDate: formattedPaymentDate,
      companyName,
      userName,
    });

    // Envoyer l'email
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: `💰 Paiement reçu - Facture ${invoiceNumber}`,
      html: emailHtml,
    });

    logger.info(
      `✅ Email 'payment_received' envoyé à ${user.email} pour la facture ${invoiceNumber}`
    );

    return { success: true, sent: true };
  } catch (error) {
    logger.error(
      `❌ Erreur lors de l'envoi de la notification 'payment_received':`,
      error
    );
    return { success: false, error: error.message };
  }
}

/**
 * Envoie une notification "Facture en retard"
 * @param {Object} params - Paramètres de la notification
 * @param {string} params.userId - ID de l'utilisateur à notifier
 * @param {Object} params.invoice - Données de la facture
 */
async function sendInvoiceOverdueNotification({ userId, invoice }) {
  try {
    const emailEnabled = await isNotificationEnabled(
      userId,
      "invoice_overdue",
      "email"
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'invoice_overdue' désactivée pour l'utilisateur ${userId}`
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // TODO: Implémenter le template et l'envoi
    logger.info(`📧 Notification 'invoice_overdue' à implémenter`);
    return { success: true, skipped: true, reason: "not_implemented" };
  } catch (error) {
    logger.error(
      `❌ Erreur lors de l'envoi de la notification 'invoice_overdue':`,
      error
    );
    return { success: false, error: error.message };
  }
}

/**
 * Envoie une notification "Fin de période d'essai"
 * @param {Object} params - Paramètres de la notification
 * @param {string} params.userId - ID de l'utilisateur à notifier
 * @param {number} params.daysRemaining - Jours restants avant la fin
 */
async function sendTrialEndingNotification({ userId, daysRemaining }) {
  try {
    const emailEnabled = await isNotificationEnabled(
      userId,
      "trial_ending",
      "email"
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'trial_ending' désactivée pour l'utilisateur ${userId}`
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // TODO: Implémenter le template et l'envoi
    logger.info(`📧 Notification 'trial_ending' à implémenter`);
    return { success: true, skipped: true, reason: "not_implemented" };
  } catch (error) {
    logger.error(
      `❌ Erreur lors de l'envoi de la notification 'trial_ending':`,
      error
    );
    return { success: false, error: error.message };
  }
}

/**
 * Envoie une notification "Échec de paiement abonnement"
 * @param {Object} params - Paramètres de la notification
 * @param {string} params.userId - ID de l'utilisateur à notifier
 * @param {string} params.reason - Raison de l'échec
 */
async function sendPaymentFailedNotification({ userId, reason }) {
  try {
    const emailEnabled = await isNotificationEnabled(
      userId,
      "payment_failed",
      "email"
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'payment_failed' désactivée pour l'utilisateur ${userId}`
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // TODO: Implémenter le template et l'envoi
    logger.info(`📧 Notification 'payment_failed' à implémenter`);
    return { success: true, skipped: true, reason: "not_implemented" };
  } catch (error) {
    logger.error(
      `❌ Erreur lors de l'envoi de la notification 'payment_failed':`,
      error
    );
    return { success: false, error: error.message };
  }
}

export default {
  isNotificationEnabled,
  sendPaymentReceivedNotification,
  sendInvoiceOverdueNotification,
  sendTrialEndingNotification,
  sendPaymentFailedNotification,
};
