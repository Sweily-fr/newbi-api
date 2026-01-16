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
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paiement reçu</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f6f9fc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f6f9fc; padding: 40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 48px; border-bottom: 1px solid #e6ebf1; text-align: center;">
              <h1 style="margin: 0; font-size: 24px; font-weight: bold; color: #1a1a1a;">${companyName}</h1>
            </td>
          </tr>
          
          <!-- Badge -->
          <tr>
            <td style="padding: 24px 0; text-align: center;">
              <span style="display: inline-block; padding: 8px 20px; background-color: #10b981; color: #ffffff; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase;">
                ✓ Paiement reçu
              </span>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 48px 32px;">
              <h2 style="color: #1a1a1a; font-size: 24px; font-weight: bold; margin: 0 0 24px; text-align: center;">
                Bonne nouvelle ! 🎉
              </h2>
              
              <p style="color: #525f7f; font-size: 16px; line-height: 24px; margin: 0 0 16px;">
                Bonjour ${userName},
              </p>
              
              <p style="color: #525f7f; font-size: 16px; line-height: 24px; margin: 0 0 24px;">
                Nous avons le plaisir de vous informer que le paiement de la facture <strong>${invoiceNumber}</strong> a été reçu.
              </p>
              
              <!-- Details Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; margin: 24px 0;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="font-size: 14px; font-weight: bold; color: #1a1a1a; margin: 0 0 16px; text-transform: uppercase; letter-spacing: 0.5px;">
                      Détails du paiement
                    </p>
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="color: #6b7280; font-size: 14px; padding: 8px 0;">Numéro de facture</td>
                        <td style="color: #1a1a1a; font-size: 14px; padding: 8px 0; text-align: right; font-weight: 500;">${invoiceNumber}</td>
                      </tr>
                      <tr>
                        <td style="color: #6b7280; font-size: 14px; padding: 8px 0;">Client</td>
                        <td style="color: #1a1a1a; font-size: 14px; padding: 8px 0; text-align: right; font-weight: 500;">${clientName}</td>
                      </tr>
                      <tr>
                        <td style="color: #6b7280; font-size: 14px; padding: 8px 0;">Montant reçu</td>
                        <td style="color: #10b981; font-size: 16px; padding: 8px 0; text-align: right; font-weight: bold;">${totalAmount}</td>
                      </tr>
                      <tr>
                        <td style="color: #6b7280; font-size: 14px; padding: 8px 0;">Date de paiement</td>
                        <td style="color: #1a1a1a; font-size: 14px; padding: 8px 0; text-align: right; font-weight: 500;">${paymentDate}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <p style="color: #525f7f; font-size: 16px; line-height: 24px; margin: 0 0 16px;">
                La facture a été automatiquement marquée comme payée dans votre espace Newbi.
              </p>
              
              <p style="color: #525f7f; font-size: 16px; line-height: 24px; margin: 32px 0 0;">
                Cordialement,<br>
                L'équipe Newbi
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 48px; border-top: 1px solid #e6ebf1; background-color: #fafafa;">
              <p style="color: #8898aa; font-size: 12px; line-height: 16px; margin: 0; text-align: center;">
                Cet email a été envoyé automatiquement par Newbi.
              </p>
              <p style="color: #8898aa; font-size: 12px; line-height: 16px; margin: 4px 0 0; text-align: center;">
                Vous recevez cet email car vous avez activé les notifications de paiement.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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
