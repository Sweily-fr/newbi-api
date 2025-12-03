import { Queue, Worker } from 'bullmq';
import Invoice from '../models/Invoice.js';
import InvoiceReminderSettings from '../models/InvoiceReminderSettings.js';
import InvoiceReminderLog from '../models/InvoiceReminderLog.js';
import EmailSettings from '../models/EmailSettings.js';
import emailReminderService from '../services/emailReminderService.js';
import axios from 'axios';

// Configuration Redis
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Créer la queue de relances
const reminderQueue = new Queue('invoice-reminders', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Réessayer 3 fois en cas d'échec
    backoff: {
      type: 'exponential',
      delay: 5000, // 5s, 10s, 20s...
    },
    removeOnComplete: {
      count: 1000, // Garder les 1000 derniers jobs terminés
      age: 24 * 3600, // Supprimer après 24h
    },
    removeOnFail: {
      count: 5000, // Garder les 5000 derniers échecs
      age: 7 * 24 * 3600, // Supprimer après 7 jours
    },
  },
});

// Worker qui traite les jobs de relance
let reminderWorker = null;

/**
 * Démarre le worker de traitement des relances
 */
function startReminderWorker() {
  reminderWorker = new Worker(
    'invoice-reminders',
    async (job) => {
      const { invoiceId, reminderType, workspaceId } = job.data;
      
      console.log(`📧 [Queue] Traitement relance ${reminderType} pour facture ${invoiceId}`);
      
      try {
        // Récupérer la facture
        const invoice = await Invoice.findById(invoiceId).populate('client');
        if (!invoice) {
          throw new Error(`Facture ${invoiceId} non trouvée`);
        }
        
        // Vérifier que la relance n'a pas déjà été envoyée (double check)
        const alreadySent = await InvoiceReminderLog.findOne({
          invoiceId: invoice._id,
          reminderType: reminderType,
          status: 'SENT',
        });
        
        if (alreadySent) {
          console.log(`⏭️ [Queue] Relance ${reminderType} déjà envoyée pour ${invoice.number}`);
          return { skipped: true, reason: 'already_sent' };
        }
        
        // Récupérer les paramètres de relance
        const settings = await InvoiceReminderSettings.findOne({ workspaceId });
        if (!settings) {
          throw new Error(`Paramètres de relance non trouvés pour workspace ${workspaceId}`);
        }
        
        // Envoyer la relance
        await sendReminderEmail(invoice, settings, reminderType);
        
        console.log(`✅ [Queue] Relance ${reminderType} envoyée pour ${invoice.number}`);
        return { success: true, invoiceNumber: invoice.number };
        
      } catch (error) {
        console.error(`❌ [Queue] Erreur relance ${invoiceId}:`, error.message);
        throw error; // BullMQ va réessayer
      }
    },
    {
      connection: redisConnection,
      concurrency: 5, // Traiter 5 jobs en parallèle max
      limiter: {
        max: 10, // Max 10 jobs
        duration: 1000, // par seconde
      },
    }
  );
  
  // Événements du worker
  reminderWorker.on('completed', (job, result) => {
    if (!result?.skipped) {
      console.log(`✅ [Queue] Job ${job.id} terminé:`, result);
    }
  });
  
  reminderWorker.on('failed', (job, error) => {
    console.error(`❌ [Queue] Job ${job.id} échoué après ${job.attemptsMade} tentatives:`, error.message);
  });
  
  reminderWorker.on('error', (error) => {
    console.error('❌ [Queue] Erreur worker:', error);
  });
  
  console.log('🚀 [Queue] Worker de relances démarré (concurrency: 5, rate: 10/s)');
  
  return reminderWorker;
}

/**
 * Ajoute une relance à la queue
 */
async function queueReminder(invoiceId, reminderType, workspaceId, delay = 0) {
  const job = await reminderQueue.add(
    `reminder-${reminderType}`,
    {
      invoiceId: invoiceId.toString(),
      reminderType,
      workspaceId: workspaceId.toString(),
    },
    {
      delay, // Délai avant exécution (en ms)
      jobId: `${invoiceId}-${reminderType}`, // ID unique pour éviter les doublons
    }
  );
  
  console.log(`📥 [Queue] Relance ${reminderType} ajoutée pour ${invoiceId} (job: ${job.id})`);
  return job;
}

/**
 * Planifie toutes les relances pour un workspace
 */
async function scheduleWorkspaceReminders(workspaceId, settings) {
  const { firstReminderDays, secondReminderDays } = settings;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Calculer les dates cibles
  const firstReminderDate = new Date(today);
  firstReminderDate.setDate(firstReminderDate.getDate() - firstReminderDays);
  
  const secondReminderDate = new Date(today);
  secondReminderDate.setDate(secondReminderDate.getDate() - secondReminderDays);
  
  // Trouver les factures impayées
  const overdueInvoices = await Invoice.find({
    workspaceId,
    status: { $in: ['PENDING', 'OVERDUE'] },
    dueDate: { $lte: today },
  });
  
  console.log(`📄 [Queue] ${overdueInvoices.length} facture(s) en retard pour workspace ${workspaceId}`);
  
  let scheduledCount = 0;
  let baseDelay = 0;
  const DELAY_BETWEEN_JOBS = 2000; // 2 secondes entre chaque job
  
  for (const invoice of overdueInvoices) {
    const invoiceDueDate = new Date(invoice.dueDate);
    invoiceDueDate.setHours(0, 0, 0, 0);
    
    // Vérifier première relance
    if (invoiceDueDate <= firstReminderDate) {
      const firstSent = await InvoiceReminderLog.findOne({
        invoiceId: invoice._id,
        reminderType: 'FIRST',
        status: 'SENT',
      });
      
      if (!firstSent) {
        await queueReminder(invoice._id, 'FIRST', workspaceId, baseDelay);
        baseDelay += DELAY_BETWEEN_JOBS;
        scheduledCount++;
        continue; // Pas de 2ème relance si 1ère pas encore envoyée
      }
    }
    
    // Vérifier deuxième relance
    if (invoiceDueDate <= secondReminderDate) {
      const secondSent = await InvoiceReminderLog.findOne({
        invoiceId: invoice._id,
        reminderType: 'SECOND',
        status: 'SENT',
      });
      
      if (!secondSent) {
        await queueReminder(invoice._id, 'SECOND', workspaceId, baseDelay);
        baseDelay += DELAY_BETWEEN_JOBS;
        scheduledCount++;
      }
    }
  }
  
  return scheduledCount;
}

/**
 * Envoie l'email de relance (logique extraite du service original)
 */
async function sendReminderEmail(invoice, settings, reminderType) {
  const clientEmail = invoice.client?.email;
  if (!clientEmail) {
    throw new Error(`Pas d'email pour le client de la facture ${invoice.number}`);
  }
  
  // Utiliser finalTotalTTC (montant final après remises) ou totalTTC en fallback
  const total = invoice.finalTotalTTC ?? invoice.totalTTC ?? invoice.total ?? 0;
  
  const variables = {
    invoiceNumber: `${invoice.prefix || 'F'}-${invoice.number}`,
    clientName: invoice.client?.name || 'Client',
    totalAmount: new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(total),
    dueDate: new Date(invoice.dueDate).toLocaleDateString('fr-FR'),
    companyName: invoice.companyInfo?.name || 'Votre Entreprise',
  };
  
  const emailSubject = replaceVariables(settings.emailSubject, variables);
  const emailBody = replaceVariables(settings.emailBody, variables);
  
  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="padding: 40px 40px 30px 40px;">
          <h1 style="margin: 0 0 30px 0; font-size: 24px; font-weight: 400; text-align: center; color: #1a1a1a;">
            Rappel de paiement
          </h1>
          
          <!-- Corps du message -->
          <div style="font-size: 15px; line-height: 1.6; color: #4a4a4a;">
            ${emailBody.replace(/\n/g, '<br>')}
          </div>
        </div>
        
        <!-- Bloc détails facture -->
        <div style="margin: 0 40px 30px 40px; background-color: #f8f9fa; border-radius: 8px; padding: 20px 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 600; color: #1a1a1a; text-transform: uppercase; letter-spacing: 0.5px;">
            DÉTAILS DE LA FACTURE
          </h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Numéro de facture</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 500;">${variables.invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Montant total</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 600;">${variables.totalAmount}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; font-size: 14px; color: #6b7280;">Date d'échéance</td>
              <td style="padding: 8px 0; font-size: 14px; color: #1a1a1a; text-align: right; font-weight: 500;">${variables.dueDate}</td>
            </tr>
          </table>
        </div>
        
        <!-- Informations complémentaires -->
        <div style="padding: 0 40px 40px 40px; font-size: 14px; line-height: 1.6; color: #4a4a4a;">
          <p style="margin: 0 0 16px 0;">La facture est jointe à cet email au format PDF.</p>
          <p style="margin: 0 0 24px 0;">Pour toute question, n'hésitez pas à nous contacter.</p>
          <p style="margin: 0;">
            Cordialement,<br>
            L'équipe ${variables.companyName}
          </p>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #f8f9fa; padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
            Cet email a été envoyé automatiquement par le système de relance de ${variables.companyName}.<br>
            Merci de ne pas répondre directement à cet email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  // Générer le PDF
  let pdfBuffer = null;
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const response = await axios.post(
      `${frontendUrl}/api/invoices/generate-pdf`,
      { invoiceId: invoice._id.toString() },
      { responseType: 'arraybuffer', timeout: 60000 } // 60s timeout pour PDF
    );
    pdfBuffer = Buffer.from(response.data);
    console.log(`📄 [Queue] PDF généré (${pdfBuffer.length} bytes)`);
  } catch (pdfError) {
    console.warn('⚠️ [Queue] Erreur génération PDF:', pdfError.message);
  }
  
  const attachments = pdfBuffer ? [{
    filename: `${variables.invoiceNumber}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }] : [];
  
  // Récupérer les paramètres email
  const emailSettings = await EmailSettings.findOne({ workspaceId: invoice.workspaceId });
  
  let fromEmail, fromName, replyTo;
  if (emailSettings?.fromEmail) {
    fromEmail = emailSettings.fromEmail;
    fromName = emailSettings.fromName || invoice.companyInfo?.name || '';
    replyTo = emailSettings.replyTo || emailSettings.fromEmail;
  } else {
    fromEmail = invoice.companyInfo?.email || 'noreply@newbi.fr';
    fromName = invoice.companyInfo?.name || '';
  }
  
  const actualSenderEmail = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
  
  const mailOptions = {
    from: actualSenderEmail,
    to: clientEmail,
    subject: emailSubject,
    html: emailHtml,
    attachments,
  };
  
  if (replyTo) {
    mailOptions.replyTo = replyTo;
  }
  
  if (!emailReminderService.transporter) {
    throw new Error('Service SMTP non initialisé');
  }
  
  const mailResult = await emailReminderService.transporter.sendMail(mailOptions);
  
  // Enregistrer le succès
  await InvoiceReminderLog.create({
    invoiceId: invoice._id,
    workspaceId: invoice.workspaceId,
    reminderType,
    recipientEmail: clientEmail,
    emailSubject,
    emailBody,
    status: 'SENT',
  });
  
  return mailResult;
}

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
 * Obtenir les statistiques de la queue
 */
async function getQueueStats() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    reminderQueue.getWaitingCount(),
    reminderQueue.getActiveCount(),
    reminderQueue.getCompletedCount(),
    reminderQueue.getFailedCount(),
    reminderQueue.getDelayedCount(),
  ]);
  
  return { waiting, active, completed, failed, delayed };
}

/**
 * Arrête le worker proprement
 */
async function stopReminderWorker() {
  if (reminderWorker) {
    await reminderWorker.close();
    console.log('🛑 [Queue] Worker de relances arrêté');
  }
  await reminderQueue.close();
  console.log('🛑 [Queue] Queue de relances fermée');
}

export {
  reminderQueue,
  startReminderWorker,
  stopReminderWorker,
  queueReminder,
  scheduleWorkspaceReminders,
  getQueueStats,
};
