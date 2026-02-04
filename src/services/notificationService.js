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
  <title>Paiement reçu - Newbi</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      margin: 0;
      padding: 20px;
      background-color: #f8f9fa;
    }
    .container {
      max-width: 500px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    .header {
      text-align: center;
      padding: 30px 20px;
      border-bottom: 1px solid #e5e7eb;
    }
    .logo {
      width: 120px;
      height: auto;
    }
    .content {
      padding: 30px 20px;
      text-align: center;
    }
    .amount {
      font-size: 32px;
      font-weight: 800;
      color: #10b981;
      margin: 20px 0;
    }
    .message {
      font-size: 18px;
      color: #4b5563;
      margin-bottom: 30px;
    }
    .details {
      background-color: #f8fafc;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      text-align: left;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid #e5e7eb;
    }
    .detail-row:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }
    .detail-label {
      color: #6b7280;
      font-size: 14px;
    }
    .detail-value {
      font-weight: 600;
      color: #1f2937;
      font-size: 14px;
    }
    .btn {
      display: inline-block;
      background-color: #1f2937;
      color: white;
      font-weight: 600;
      text-decoration: none;
      padding: 12px 24px;
      border-radius: 8px;
      margin: 20px 0;
    }
    .footer {
      text-align: center;
      padding: 20px;
      color: #6b7280;
      font-size: 12px;
      background-color: #f8f9fa;
    }

    /* Mobile responsive */
    @media (max-width: 600px) {
      body {
        padding: 10px;
      }
      .container {
        margin: 0;
      }
      .content {
        padding: 20px 15px;
      }
      .amount {
        font-size: 28px;
      }
      .message {
        font-size: 16px;
      }
      .details {
        padding: 15px;
      }
      .detail-row {
        flex-direction: column;
        gap: 5px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img src="${process.env.AWS_S3_API_URL || "https://via.placeholder.com/120x40/000000/FFFFFF?text=NEWBI"}/logobewbi/Logo_Texte_Black.png" alt="Newbi" class="logo">
    </div>

    <div class="content">
      <div class="amount">+${totalAmount}</div>

      <p class="message">Le paiement de votre facture a été reçu !</p>

      <div class="details">
        <div class="detail-row">
          <span class="detail-label">Numéro de facture</span>
          <span class="detail-value">${invoiceNumber}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Client</span>
          <span class="detail-value">${clientName}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Date</span>
          <span class="detail-value">${paymentDate}</span>
        </div>
      </div>

      <a href="${process.env.FRONTEND_URL}/dashboard/factures" class="btn">Voir mes factures</a>
    </div>

    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} Newbi. Tous droits réservés.</p>
      <p>Questions ? <a href="mailto:contact@newbi.fr" style="color: #5b50ff;">contact@newbi.fr</a></p>
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
