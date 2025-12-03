import Invoice from '../models/Invoice.js';
import InvoiceReminderSettings from '../models/InvoiceReminderSettings.js';
import InvoiceReminderLog from '../models/InvoiceReminderLog.js';
import EmailSettings from '../models/EmailSettings.js';
import emailReminderService from './emailReminderService.js';
import axios from 'axios';

/**
 * Vérifie et envoie les relances automatiques pour toutes les factures impayées
 */
async function processAutomaticReminders() {
  console.log('🔔 [InvoiceReminder] Démarrage du processus de relance automatique...');
  
  try {
    // Récupérer tous les workspaces avec les relances activées
    const activeSettings = await InvoiceReminderSettings.find({ enabled: true });
    
    console.log(`📊 [InvoiceReminder] ${activeSettings.length} workspace(s) avec relances activées`);
    
    for (const settings of activeSettings) {
      await processWorkspaceReminders(settings);
    }
    
    console.log('✅ [InvoiceReminder] Processus de relance terminé');
  } catch (error) {
    console.error('❌ [InvoiceReminder] Erreur lors du processus de relance:', error);
    throw error;
  }
}

/**
 * Traite les relances pour un workspace spécifique
 */
async function processWorkspaceReminders(settings) {
  const { workspaceId, firstReminderDays, secondReminderDays, excludedClientIds = [] } = settings;
  
  console.log(`🏢 [InvoiceReminder] Traitement du workspace: ${workspaceId}`);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Calculer les dates cibles pour les relances
  const firstReminderDate = new Date(today);
  firstReminderDate.setDate(firstReminderDate.getDate() - firstReminderDays);
  
  const secondReminderDate = new Date(today);
  secondReminderDate.setDate(secondReminderDate.getDate() - secondReminderDays);
  
  // Construire la requête de base
  const query = {
    workspaceId,
    status: { $in: ['PENDING', 'OVERDUE'] },
    dueDate: { $lte: today },
  };
  
  // Exclure les clients si nécessaire
  if (excludedClientIds && excludedClientIds.length > 0) {
    query.client = { $nin: excludedClientIds };
    console.log(`🚫 [InvoiceReminder] ${excludedClientIds.length} client(s) exclu(s) des relances`);
  }
  
  // Trouver les factures impayées avec date d'échéance dépassée
  const overdueInvoices = await Invoice.find(query).populate('client');
  
  console.log(`📄 [InvoiceReminder] ${overdueInvoices.length} facture(s) en retard trouvée(s)`);
  
  for (const invoice of overdueInvoices) {
    await processInvoiceReminder(invoice, settings, firstReminderDate, secondReminderDate);
  }
}

/**
 * Traite la relance pour une facture spécifique
 */
async function processInvoiceReminder(invoice, settings, firstReminderDate, secondReminderDate) {
  try {
    const invoiceDueDate = new Date(invoice.dueDate);
    invoiceDueDate.setHours(0, 0, 0, 0);
    
    // Vérifier si une première relance doit être envoyée
    if (invoiceDueDate <= firstReminderDate) {
      const firstReminderSent = await InvoiceReminderLog.findOne({
        invoiceId: invoice._id,
        reminderType: 'FIRST',
      });
      
      if (!firstReminderSent) {
        await sendReminder(invoice, settings, 'FIRST');
        return;
      }
    }
    
    // Vérifier si une deuxième relance doit être envoyée
    if (invoiceDueDate <= secondReminderDate) {
      const secondReminderSent = await InvoiceReminderLog.findOne({
        invoiceId: invoice._id,
        reminderType: 'SECOND',
      });
      
      if (!secondReminderSent) {
        await sendReminder(invoice, settings, 'SECOND');
        return;
      }
    }
  } catch (error) {
    console.error(`❌ [InvoiceReminder] Erreur pour la facture ${invoice.number}:`, error);
  }
}

/**
 * Envoie une relance par email
 */
async function sendReminder(invoice, settings, reminderType) {
  try {
    console.log(`📧 [InvoiceReminder] Envoi ${reminderType} relance pour facture ${invoice.number}`);
    
    // Récupérer les informations du client
    const clientEmail = invoice.client?.email;
    if (!clientEmail) {
      console.warn(`⚠️ [InvoiceReminder] Pas d'email pour le client de la facture ${invoice.number}`);
      return;
    }
    
    // Calculer le total si nécessaire
    const total = invoice.total || invoice.totalAmount || 0;
    
    // Préparer les variables pour le template
    const variables = {
      invoiceNumber: `${invoice.prefix}-${invoice.number}`,
      clientName: invoice.client?.name || 'Client',
      totalAmount: `${total.toFixed(2).replace('.', ',')} €`,
      dueDate: new Date(invoice.dueDate).toLocaleDateString('fr-FR'),
      companyName: invoice.companyInfo?.name || 'Votre Entreprise',
    };
    
    // Remplacer les variables dans l'objet et le corps de l'email
    const emailSubject = replaceVariables(settings.emailSubject, variables);
    const emailBody = replaceVariables(settings.emailBody, variables);
    
    // Générer le HTML de l'email (simplifié pour l'instant)
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Rappel de paiement</h2>
        <p>${emailBody.replace(/\n/g, '<br>')}</p>
        <hr>
        <p><strong>Facture:</strong> ${variables.invoiceNumber}</p>
        <p><strong>Montant:</strong> ${variables.totalAmount}</p>
        <p><strong>Date d'échéance:</strong> ${variables.dueDate}</p>
      </div>
    `;
    
    // Générer le PDF de la facture via l'API Next.js
    let pdfBuffer = null;
    try {
      console.log(`📄 [InvoiceReminder] Génération du PDF pour facture ${invoice.number}`);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const response = await axios.post(
        `${frontendUrl}/api/invoices/generate-pdf`,
        { invoiceId: invoice._id.toString() },
        { responseType: 'arraybuffer', timeout: 30000 }
      );
      pdfBuffer = Buffer.from(response.data);
      console.log(`✅ [InvoiceReminder] PDF généré (${pdfBuffer.length} bytes)`);
    } catch (pdfError) {
      console.warn('⚠️ [InvoiceReminder] Erreur génération PDF:', pdfError.message);
      // On continue sans PDF si la génération échoue
    }
    
    // Préparer les pièces jointes
    const attachments = pdfBuffer ? [{
      filename: `${variables.invoiceNumber}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }] : [];
    
    // Récupérer les paramètres email du workspace
    const emailSettings = await EmailSettings.findOne({ 
      workspaceId: invoice.workspaceId
    });
    
    // Déterminer l'email expéditeur (priorité aux EmailSettings)
    let fromEmail;
    let fromName;
    let replyTo = null;
    
    if (emailSettings && emailSettings.fromEmail) {
      // Utiliser les paramètres EmailSettings (configurés dans le modal de relance)
      fromEmail = emailSettings.fromEmail;
      fromName = emailSettings.fromName || invoice.companyInfo?.name || '';
      replyTo = emailSettings.replyTo || emailSettings.fromEmail;
      console.log(`📧 [InvoiceReminder] Utilisation de l'email personnalisé: ${fromEmail}`);
    } else {
      // Fallback sur les informations de la facture
      fromEmail = invoice.companyInfo?.email || 'noreply@newbi.fr';
      fromName = invoice.companyInfo?.name || '';
      console.log(`⚠️ [InvoiceReminder] Aucun email configuré, utilisation de l'email de la facture: ${fromEmail}`);
    }
    
    // Formater l'expéditeur
    const actualSenderEmail = fromName 
      ? `"${fromName}" <${fromEmail}>`
      : fromEmail;
    
    // Envoyer l'email avec le SMTP centralisé
    console.log(`📤 [InvoiceReminder] Envoi email de ${actualSenderEmail} vers ${clientEmail}`);
    console.log(`📋 [InvoiceReminder] Sujet: ${emailSubject}`);
    
    const mailOptions = {
      from: actualSenderEmail,
      to: clientEmail,
      subject: emailSubject,
      html: emailHtml,
      attachments: attachments,
    };
    
    // Ajouter replyTo si configuré
    if (replyTo) {
      mailOptions.replyTo = replyTo;
    }
    
    // Vérifier que le transporter est initialisé
    if (!emailReminderService.transporter) {
      throw new Error('Service SMTP non initialisé. Vérifiez la configuration SMTP dans .env');
    }
    
    const mailResult = await emailReminderService.transporter.sendMail(mailOptions);
    
    console.log(`✅ [InvoiceReminder] Email envoyé, messageId: ${mailResult.messageId}`);
    
    // Enregistrer la relance dans les logs
    await InvoiceReminderLog.create({
      invoiceId: invoice._id,
      workspaceId: invoice.workspaceId,
      reminderType: reminderType,
      recipientEmail: clientEmail,
      emailSubject: emailSubject,
      emailBody: emailBody,
      status: 'SENT',
    });
    
    console.log(`✅ [InvoiceReminder] Relance ${reminderType} envoyée pour ${invoice.number}`);
  } catch (error) {
    console.error(`❌ [InvoiceReminder] Erreur envoi relance:`, error);
    
    // Enregistrer l'échec dans les logs
    await InvoiceReminderLog.create({
      invoiceId: invoice._id,
      workspaceId: invoice.workspaceId,
      reminderType: reminderType,
      recipientEmail: invoice.client?.email || 'unknown',
      emailSubject: settings.emailSubject,
      emailBody: settings.emailBody,
      status: 'FAILED',
      error: error.message,
    });
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

export {
  processAutomaticReminders,
  processWorkspaceReminders,
  sendReminder,
};
