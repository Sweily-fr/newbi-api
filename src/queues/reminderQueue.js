import { Queue, Worker } from "bullmq";
import Invoice from "../models/Invoice.js";
import InvoiceReminderSettings from "../models/InvoiceReminderSettings.js";
import InvoiceReminderLog from "../models/InvoiceReminderLog.js";
import EmailSettings from "../models/EmailSettings.js";
import emailReminderService from "../services/emailReminderService.js";
import { generateReminderEmailHtml } from "../services/documentEmailService.js";
import axios from "axios";

// Configuration Redis
const redisConnection = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
};

// Créer la queue de relances
const reminderQueue = new Queue("invoice-reminders", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3, // Réessayer 3 fois en cas d'échec
    backoff: {
      type: "exponential",
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
    "invoice-reminders",
    async (job) => {
      const { invoiceId, reminderType, workspaceId } = job.data;

      console.log(
        `📧 [Queue] Traitement relance ${reminderType} pour facture ${invoiceId}`,
      );

      try {
        // Récupérer la facture
        const invoice = await Invoice.findById(invoiceId).populate("client");
        if (!invoice) {
          throw new Error(`Facture ${invoiceId} non trouvée`);
        }

        // Vérifier que la relance n'a pas déjà été envoyée (double check)
        const alreadySent = await InvoiceReminderLog.findOne({
          invoiceId: invoice._id,
          reminderType: reminderType,
          status: "SENT",
        });

        if (alreadySent) {
          console.log(
            `⏭️ [Queue] Relance ${reminderType} déjà envoyée pour ${invoice.number}`,
          );
          return { skipped: true, reason: "already_sent" };
        }

        // Récupérer les paramètres de relance
        const settings = await InvoiceReminderSettings.findOne({ workspaceId });
        if (!settings) {
          throw new Error(
            `Paramètres de relance non trouvés pour workspace ${workspaceId}`,
          );
        }

        // Envoyer la relance
        await sendReminderEmail(invoice, settings, reminderType);

        console.log(
          `✅ [Queue] Relance ${reminderType} envoyée pour ${invoice.number}`,
        );
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
    },
  );

  // Événements du worker
  reminderWorker.on("completed", (job, result) => {
    if (!result?.skipped) {
      console.log(`✅ [Queue] Job ${job.id} terminé:`, result);
    }
  });

  reminderWorker.on("failed", (job, error) => {
    console.error(
      `❌ [Queue] Job ${job.id} échoué après ${job.attemptsMade} tentatives:`,
      error.message,
    );
  });

  reminderWorker.on("error", (error) => {
    console.error("❌ [Queue] Erreur worker:", error);
  });

  console.log(
    "🚀 [Queue] Worker de relances démarré (concurrency: 5, rate: 10/s)",
  );

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
    },
  );

  console.log(
    `📥 [Queue] Relance ${reminderType} ajoutée pour ${invoiceId} (job: ${job.id})`,
  );
  return job;
}

/**
 * Planifie toutes les relances pour un workspace
 */
async function scheduleWorkspaceReminders(workspaceId, settings) {
  const {
    firstReminderDays,
    secondReminderDays,
    excludedClientIds = [],
  } = settings;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Calculer les dates cibles
  const firstReminderDate = new Date(today);
  firstReminderDate.setDate(firstReminderDate.getDate() - firstReminderDays);

  const secondReminderDate = new Date(today);
  secondReminderDate.setDate(secondReminderDate.getDate() - secondReminderDays);

  // Borne en fin de journée : les dueDate sont stockées à minuit UTC
  // (= 01h/02h heure de Paris), donc une comparaison avec minuit local
  // exclurait à tort les factures échéant aujourd'hui — or les réglages
  // promettent « 0 = le jour de l'échéance ».
  const endOfToday = new Date(today);
  endOfToday.setHours(23, 59, 59, 999);

  // Trouver les factures impayées
  const query = {
    workspaceId,
    status: { $in: ["PENDING", "OVERDUE"] },
    dueDate: { $lte: endOfToday },
  };

  // Exclure les clients désélectionnés dans les réglages. Le client est un
  // sous-document embarqué dont `id` est un String référençant la collection
  // Client, alors que excludedClientIds contient des ObjectIds → conversion.
  if (excludedClientIds.length > 0) {
    query["client.id"] = { $nin: excludedClientIds.map(String) };
    console.log(
      `🚫 [Queue] ${excludedClientIds.length} client(s) exclu(s) des relances`,
    );
  }

  const overdueInvoices = await Invoice.find(query);

  console.log(
    `📄 [Queue] ${overdueInvoices.length} facture(s) en retard pour workspace ${workspaceId}`,
  );

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
        reminderType: "FIRST",
        status: "SENT",
      });

      if (!firstSent) {
        await queueReminder(invoice._id, "FIRST", workspaceId, baseDelay);
        baseDelay += DELAY_BETWEEN_JOBS;
        scheduledCount++;
        continue; // Pas de 2ème relance si 1ère pas encore envoyée
      }
    }

    // Vérifier deuxième relance
    if (invoiceDueDate <= secondReminderDate) {
      const secondSent = await InvoiceReminderLog.findOne({
        invoiceId: invoice._id,
        reminderType: "SECOND",
        status: "SENT",
      });

      if (!secondSent) {
        await queueReminder(invoice._id, "SECOND", workspaceId, baseDelay);
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
    throw new Error(
      `Pas d'email pour le client de la facture ${invoice.number}`,
    );
  }

  // Utiliser finalTotalTTC (montant final après remises) ou totalTTC en fallback
  const total = invoice.finalTotalTTC ?? invoice.totalTTC ?? invoice.total ?? 0;

  const variables = {
    invoiceNumber: `${invoice.prefix || "F"}-${invoice.number}`,
    clientName: invoice.client?.name || "Client",
    totalAmount: new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
    }).format(total),
    dueDate: new Date(invoice.dueDate).toLocaleDateString("fr-FR"),
    companyName: invoice.companyInfo?.name || "Votre Entreprise",
  };

  const emailSubject = replaceVariables(settings.emailSubject, variables);
  const emailBody = replaceVariables(settings.emailBody, variables);

  // Gabarit commun Newbi (logo, carte blanche, badge violet, footer marque)
  const emailHtml = generateReminderEmailHtml(
    emailBody,
    variables,
    reminderType,
  );

  // Générer le PDF
  let pdfBuffer = null;
  try {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    // Authentification serveur-à-serveur via secret interne : la route
    // /api/invoices/generate-pdf l'accepte en lieu et place d'une session
    // utilisateur. Sans ce header, l'appel échoue en 401 et la relance
    // part sans facture jointe (cf. documentEmailService).
    const headers = process.env.INTERNAL_API_SECRET
      ? { "x-internal-secret": process.env.INTERNAL_API_SECRET }
      : {};
    if (!process.env.INTERNAL_API_SECRET) {
      console.warn(
        "⚠️ [Queue] INTERNAL_API_SECRET non défini : l'appel PDF échouera en 401.",
      );
    }
    const pdfTimeout = Number(process.env.PDF_GENERATION_TIMEOUT_MS) || 120000;
    const response = await axios.post(
      `${frontendUrl}/api/invoices/generate-pdf`,
      { invoiceId: invoice._id.toString() },
      { responseType: "arraybuffer", timeout: pdfTimeout, headers },
    );
    pdfBuffer = Buffer.from(response.data);
    console.log(`📄 [Queue] PDF généré (${pdfBuffer.length} bytes)`);
  } catch (pdfError) {
    console.warn("⚠️ [Queue] Erreur génération PDF:", pdfError.message);
  }

  const attachments = pdfBuffer
    ? [
        {
          filename: `${variables.invoiceNumber}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ]
    : [];

  // Récupérer les paramètres email
  const emailSettings = await EmailSettings.findOne({
    workspaceId: invoice.workspaceId,
  });

  let fromEmail, fromName, replyTo;
  if (emailSettings?.fromEmail) {
    fromEmail = emailSettings.fromEmail;
    fromName = emailSettings.fromName || invoice.companyInfo?.name || "";
    replyTo = emailSettings.replyTo || emailSettings.fromEmail;
  } else {
    fromEmail = invoice.companyInfo?.email || "noreply@newbi.fr";
    fromName = invoice.companyInfo?.name || "";
  }

  let mailResult;
  if (emailReminderService.useResend && emailReminderService.resend) {
    // Resend en priorité (même logique que emailReminderService.sendEmail).
    // Resend n'accepte comme From qu'un domaine vérifié : on envoie depuis
    // RESEND_FROM_EMAIL avec le nom de l'expéditeur, et l'adresse configurée
    // par l'utilisateur passe en reply-to pour recevoir les réponses.
    const resendFrom = fromName
      ? `${fromName} <${emailReminderService.resendFromEmail}>`
      : emailReminderService.resendFromEmail;
    const { data, error } = await emailReminderService.resend.emails.send({
      from: resendFrom,
      to: [clientEmail],
      subject: emailSubject,
      html: emailHtml,
      replyTo: replyTo || fromEmail,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    if (error) {
      throw new Error(`Resend: ${error.message}`);
    }
    console.log(
      `📧 [Queue] Relance envoyée via Resend (id: ${data?.id}) à ${clientEmail}`,
    );
    mailResult = data;
  } else {
    const actualSenderEmail = fromName
      ? `"${fromName}" <${fromEmail}>`
      : fromEmail;

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
      throw new Error("Service SMTP non initialisé");
    }

    mailResult = await emailReminderService.transporter.sendMail(mailOptions);
  }

  // Enregistrer le succès
  await InvoiceReminderLog.create({
    invoiceId: invoice._id,
    workspaceId: invoice.workspaceId,
    reminderType,
    recipientEmail: clientEmail,
    emailSubject,
    emailBody,
    status: "SENT",
  });

  return mailResult;
}

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
    console.log("🛑 [Queue] Worker de relances arrêté");
  }
  await reminderQueue.close();
  console.log("🛑 [Queue] Queue de relances fermée");
}

export {
  reminderQueue,
  startReminderWorker,
  stopReminderWorker,
  queueReminder,
  scheduleWorkspaceReminders,
  getQueueStats,
};
