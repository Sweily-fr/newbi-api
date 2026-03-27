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
        `Utilisateur ${userId} non trouvé pour vérification des préférences`,
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
      "Erreur lors de la vérification des préférences de notification:",
      error,
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
 * Génère le HTML pour l'email "Paiement reçu" - Style Qonto
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
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paiement confirmé</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #fafafa; color: #1a1a1a;">
  <div style="max-width: 600px; margin: 0 auto; padding: 0 20px; background-color: #fafafa;">

    <!-- Logo -->
    <div style="text-align: center; padding: 40px 0 24px 0;">
      <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png" alt="Newbi" style="height: 32px; width: auto;">
    </div>

    <!-- Type de notification -->
    <div style="text-align: center; margin-bottom: 8px;">
      <span style="font-size: 11px; font-weight: 600; color: #1a1a1a; letter-spacing: 0.5px; text-transform: uppercase;">
        CONFIRMATION DE PAIEMENT
      </span>
    </div>

    <!-- Date -->
    <div style="text-align: center; margin-bottom: 32px;">
      <span style="font-size: 12px; color: #6b7280;">
        ${paymentDate}
      </span>
    </div>

    <!-- Carte principale -->
    <div style="background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 24px; margin-bottom: 32px;">

      <!-- Icône -->
      <div style="margin-bottom: 20px;">
        <div style="display: inline-flex; align-items: center; background-color: #f3f4f6; border-radius: 6px; padding: 8px 12px;">
          <img src="https://pub-f5ac1d55852142ab931dc75bdc939d68.r2.dev/mail.png" alt="Mail" style="height: 16px; width: 16px; margin-right: 8px;">
          <span style="font-size: 11px; font-weight: 500; color: #374151; letter-spacing: 0.3px; text-transform: uppercase;">PAIEMENT</span>
        </div>
      </div>

      <!-- Titre -->
      <h1 style="font-size: 26px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0; line-height: 1.3;">
        Votre facture a été réglée
      </h1>

      <!-- Salutation -->
      <p style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;">
        Bonjour${userName ? ` ${userName}` : ""},
      </p>

      <!-- Message -->
      <p style="font-size: 15px; color: #4b5563; margin: 0 0 24px 0; line-height: 1.6;">
        La facture <strong style="color: #1a1a1a;">${invoiceNumber}</strong> a été automatiquement marquée comme payée.
      </p>

      <!-- Détails -->
      <div style="background-color: #fafafa; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">N° de facture</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; text-align: right; word-break: break-word;">${invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Client</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; text-align: right; word-break: break-word;">${clientName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #6b7280;">Date de paiement</td>
            <td style="padding: 6px 0; font-size: 14px; color: #1a1a1a; text-align: right;">${paymentDate}</td>
          </tr>
          <tr style="border-top: 1px solid #e5e7eb;">
            <td style="padding: 12px 0 6px 0; font-size: 14px; color: #6b7280; font-weight: 500;">Montant payé</td>
            <td style="padding: 12px 0 6px 0; font-size: 16px; color: #10b981; font-weight: 600; text-align: right;">${totalAmount}</td>
          </tr>
        </table>
      </div>

      <!-- Bouton CTA -->
      <a href="${process.env.FRONTEND_URL}/dashboard/factures" style="display: block; background-color: #1a1a1a; color: #ffffff; text-decoration: none; padding: 16px 24px; border-radius: 6px; font-weight: 500; font-size: 15px; text-align: center;">
        Accéder à mon espace
      </a>
    </div>

    <!-- Footer -->
    <div style="border-top: 1px solid #e5e7eb; padding-top: 32px; text-align: center; padding-bottom: 40px;">
      <div style="margin-bottom: 16px;">
        <img src="https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png" alt="Newbi" style="height: 28px; width: auto;">
      </div>
      <p style="font-size: 13px; font-weight: 500; color: #1a1a1a; margin: 0 0 24px 0;">
        Votre gestion, simplifiée.
      </p>
      <p style="font-size: 12px; color: #9ca3af; margin: 0 0 24px 0; line-height: 1.8;">
        Vous recevez cet email suite à un règlement sur Newbi. • <a href="https://newbi.fr/aide" style="color: #9ca3af; text-decoration: underline;">FAQ</a>
      </p>
      <div style="font-size: 11px; color: #9ca3af; line-height: 1.6;">
        <p style="margin: 0 0 4px 0;">SWEILY (SAS),</p>
        <p style="margin: 0;">229 rue Saint-Honoré, 75001 Paris, FRANCE</p>
      </div>
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
      "email",
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'payment_received' désactivée pour l'utilisateur ${userId}`,
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
      invoice.finalTotalTTC || invoice.totalTTC || 0,
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
      `✅ Email 'payment_received' envoyé à ${user.email} pour la facture ${invoiceNumber}`,
    );

    return { success: true, sent: true };
  } catch (error) {
    logger.error(
      "❌ Erreur lors de l'envoi de la notification 'payment_received':",
      error,
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
      "email",
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'invoice_overdue' désactivée pour l'utilisateur ${userId}`,
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // TODO: Implémenter le template et l'envoi
    logger.info("📧 Notification 'invoice_overdue' à implémenter");
    return { success: true, skipped: true, reason: "not_implemented" };
  } catch (error) {
    logger.error(
      "❌ Erreur lors de l'envoi de la notification 'invoice_overdue':",
      error,
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
      "email",
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'trial_ending' désactivée pour l'utilisateur ${userId}`,
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // TODO: Implémenter le template et l'envoi
    logger.info("📧 Notification 'trial_ending' à implémenter");
    return { success: true, skipped: true, reason: "not_implemented" };
  } catch (error) {
    logger.error(
      "❌ Erreur lors de l'envoi de la notification 'trial_ending':",
      error,
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
      "email",
    );

    if (!emailEnabled) {
      logger.info(
        `📧 Notification 'payment_failed' désactivée pour l'utilisateur ${userId}`,
      );
      return { success: true, skipped: true, reason: "notification_disabled" };
    }

    // TODO: Implémenter le template et l'envoi
    logger.info("📧 Notification 'payment_failed' à implémenter");
    return { success: true, skipped: true, reason: "not_implemented" };
  } catch (error) {
    logger.error(
      "❌ Erreur lors de l'envoi de la notification 'payment_failed':",
      error,
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
