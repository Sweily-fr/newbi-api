import nodemailer from 'nodemailer';
import { render } from '@react-email/render';
import PartnerWithdrawalConfirmation from '../../emails/partner-withdrawal-confirmation.jsx';
import AdminWithdrawalNotification from '../../emails/admin-withdrawal-notification.jsx';
import logger from '../utils/logger.js';

// Créer le transporteur SMTP
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

/**
 * Envoie les emails de notification de retrait (partenaire + admin)
 */
export async function sendWithdrawalEmails({ partnerEmail, partnerName, amount, withdrawalId }) {
  try {
    // Email admin
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@newbi.fr';
    
    logger.info(`📧 Envoi email admin à ${adminEmail}...`);
    
    const adminHtml = await render(AdminWithdrawalNotification({
      partnerName,
      partnerEmail,
      amount,
      withdrawalId,
    }));

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: adminEmail,
      subject: `🔔 Nouvelle demande de retrait - ${partnerName}`,
      html: adminHtml,
    });

    logger.info(`✅ Email admin envoyé`);

    // Email partenaire
    logger.info(`📧 Envoi email partenaire à ${partnerEmail}...`);
    
    const partnerHtml = await render(PartnerWithdrawalConfirmation({
      partnerName,
      amount,
      withdrawalId,
    }));

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: partnerEmail,
      subject: '✅ Demande de retrait confirmée',
      html: partnerHtml,
    });

    logger.info(`✅ Email partenaire envoyé`);

    return { success: true };
  } catch (error) {
    logger.error('❌ Erreur lors de l\'envoi des emails de retrait:', error);
    throw error;
  }
}
