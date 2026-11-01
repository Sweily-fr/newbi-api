import logger from "../utils/logger.js";
import mongoose from "mongoose";
import CrmEmailAutomation from "../models/CrmEmailAutomation.js";
import CrmEmailAutomationLog from "../models/CrmEmailAutomationLog.js";
import ClientCustomField from "../models/ClientCustomField.js";
import Client from "../models/Client.js";
import EmailSettings from "../models/EmailSettings.js";
import emailReminderService from "./emailReminderService.js";
import { escapeHtml } from "../utils/trialEmails.js";
import { assertPlanFeature } from "./planLimits.js";
import { workspaceSenderEmails } from "../utils/crmEmailSender.js";

/** Date du jour en heure de Paris, au format enregistré (AAAA-MM-JJ). */
function parisDateString(date) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Traite les automatisations d'email CRM pour tous les workspaces
 */
async function processCrmEmailAutomations() {
  logger.debug(
    "📧 [CrmEmailAutomation] Démarrage du processus d'envoi automatique...",
  );

  try {
    // Utiliser explicitement le fuseau horaire Europe/Paris pour correspondre au cron
    const currentHour = parseInt(
      new Date().toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        hour: "numeric",
        hour12: false,
      }),
    );

    // Récupérer toutes les automatisations actives pour cette heure
    const activeAutomations = await CrmEmailAutomation.find({
      isActive: true,
      "timing.sendHour": currentHour,
    });

    logger.debug(
      `📊 [CrmEmailAutomation] ${activeAutomations.length} automatisation(s) active(s) pour ${currentHour}h`,
    );

    let totalSent = 0;

    for (const automation of activeAutomations) {
      // Offre qui ne comprend plus les automatisations d'e-mails, ou
      // abonnement terminé : plus aucun envoi
      if (!(await workspaceAllowsCrmEmails(automation.workspaceId))) continue;
      const sent = await processAutomation(automation);
      totalSent += sent;
    }

    logger.debug(
      `✅ [CrmEmailAutomation] Processus terminé - ${totalSent} email(s) envoyé(s)`,
    );

    return totalSent;
  } catch (error) {
    console.error("❌ [CrmEmailAutomation] Erreur lors du processus:", error);
    throw error;
  }
}

/** L'offre active de l'espace comprend les automatisations d'e-mails. */
async function workspaceAllowsCrmEmails(workspaceId) {
  try {
    await assertPlanFeature(
      workspaceId,
      "crmEmailAutomations",
      "les automatisations d'e-mails",
    );
    return true;
  } catch {
    logger.debug(
      `[CrmEmailAutomation] Espace ${workspaceId} : offre sans automatisations d'e-mails, envois ignorés`,
    );
    return false;
  }
}

/**
 * Traite une automatisation spécifique
 */
async function processAutomation(automation) {
  const { workspaceId, customFieldId, timing } = automation;

  logger.debug(
    `🔄 [CrmEmailAutomation] Traitement de "${automation.name}" (workspace: ${workspaceId})`,
  );

  try {
    // Récupérer le champ personnalisé
    const customField = await ClientCustomField.findById(customFieldId);
    if (!customField) {
      console.warn(
        `⚠️ [CrmEmailAutomation] Champ personnalisé ${customFieldId} non trouvé`,
      );
      return 0;
    }

    // Calculer la date cible selon le timing
    const targetDate = calculateTargetDate(timing);

    logger.debug(
      `📅 [CrmEmailAutomation] Date cible: ${targetDate.toLocaleDateString("fr-FR")}`,
    );

    // Trouver les clients avec cette date dans le champ personnalisé
    const clients = await findClientsWithDateField(
      workspaceId,
      customField.id,
      targetDate,
    );

    logger.debug(
      `👥 [CrmEmailAutomation] ${clients.length} client(s) correspondant(s)`,
    );

    let sentCount = 0;

    for (const client of clients) {
      const sent = await sendEmailToClient(
        automation,
        customField,
        client,
        targetDate,
      );
      if (sent) sentCount++;
    }

    // Mettre à jour les stats de l'automatisation
    if (sentCount > 0) {
      automation.stats.totalSent += sentCount;
      automation.stats.lastSentAt = new Date();
      if (clients.length > 0) {
        automation.stats.lastClientId = clients[clients.length - 1]._id;
      }
      await automation.save();
    }

    return sentCount;
  } catch (error) {
    console.error(
      `❌ [CrmEmailAutomation] Erreur pour "${automation.name}":`,
      error,
    );
    return 0;
  }
}

/**
 * Calcule la date cible selon la configuration du timing. Le jour est celui
 * de Paris (heure d'envoi choisie en heure de Paris), quel que soit le fuseau
 * du serveur : la date cible est minuit UTC de ce jour.
 */
function calculateTargetDate(timing, now = new Date()) {
  const [year, month, day] = parisDateString(now).split("-").map(Number);
  const offset = timing.daysOffset || 0;
  let delta = 0;

  switch (timing.type) {
    case "BEFORE_DATE":
      // Si on veut envoyer X jours AVANT la date, on cherche les dates dans X jours
      delta = offset;
      break;
    case "AFTER_DATE":
      // Si on veut envoyer X jours APRÈS la date, on cherche les dates d'il y a X jours
      delta = -offset;
      break;
    case "ON_DATE":
    default:
      // Le jour même, pas de modification
      break;
  }

  return new Date(Date.UTC(year, month - 1, day + delta));
}

/**
 * Trouve les clients avec une date spécifique dans un champ personnalisé
 */
async function findClientsWithDateField(
  workspaceId,
  customFieldId,
  targetDate,
) {
  // Format de date stocké: YYYY-MM-DD (targetDate : minuit UTC du jour)
  const dateString = targetDate.toISOString().split("T")[0];

  // Rechercher les clients avec ce champ personnalisé à cette date
  // customFields est un tableau de {fieldId, value} — utiliser $elemMatch
  const clients = await Client.find({
    workspaceId,
    customFields: {
      $elemMatch: {
        fieldId: customFieldId,
        value: dateString,
      },
    },
    email: { $exists: true, $ne: "" },
    // Contact bloqué : exclu des communications
    isBlocked: { $ne: true },
  });

  return clients;
}

/**
 * Envoie un email à un client
 */
async function sendEmailToClient(automation, customField, client, triggerDate) {
  try {
    // Vérifier si un email a déjà été envoyé pour cette combinaison
    // Ne pas muter triggerDate — créer des copies pour les bornes de la journée
    const dayStart = new Date(triggerDate);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(triggerDate);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const existingLog = await CrmEmailAutomationLog.findOne({
      automationId: automation._id,
      clientId: client._id,
      triggerDate: {
        $gte: dayStart,
        $lte: dayEnd,
      },
    });

    if (existingLog) {
      logger.debug(
        `⏭️ [CrmEmailAutomation] Email déjà envoyé à ${client.email} pour cette date`,
      );
      return false;
    }

    const clientEmail = client.email;
    if (!clientEmail) {
      console.warn(
        `⚠️ [CrmEmailAutomation] Pas d'email pour le client ${client._id}`,
      );
      return false;
    }

    // Récupérer la valeur du champ personnalisé (customFields est un tableau de {fieldId, value})
    const customFieldEntry = client.customFields?.find(
      (cf) => cf.fieldId?.toString() === customField.id.toString(),
    );
    const customFieldValue = customFieldEntry?.value || "";

    // Préparer les variables
    const variables = {
      clientName:
        `${client.firstName || ""} ${client.lastName || ""}`.trim() || "Client",
      clientFirstName: client.firstName || "",
      clientLastName: client.lastName || "",
      clientEmail: client.email || "",
      customFieldName: customField.name,
      customFieldValue: customFieldValue
        ? new Date(customFieldValue).toLocaleDateString("fr-FR")
        : "",
      companyName: automation.email.fromName || "Votre Entreprise",
    };

    // Remplacer les variables
    const emailSubject = replaceVariables(automation.email.subject, variables);
    const emailBody = replaceVariables(automation.email.body, variables);

    // Générer le HTML de l'email
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${escapeHtml(emailBody).replace(/\n/g, "<br>")}
      </div>
    `;

    // Récupérer les paramètres email du workspace
    const emailSettings = await EmailSettings.findOne({
      workspaceId: automation.workspaceId,
    });

    // Déterminer l'email expéditeur : une adresse de l'espace seulement
    // (paramètres d'e-mail, e-mail de l'entreprise), jamais une adresse libre
    const senderEmails = await workspaceSenderEmails(automation.workspaceId);
    let fromEmail = senderEmails.includes(
      (automation.email.fromEmail || "").toLowerCase(),
    )
      ? automation.email.fromEmail
      : "";
    let fromName = automation.email.fromName;
    let replyTo = automation.email.replyTo;

    // Fallback sur les paramètres du workspace
    if (!fromEmail && emailSettings?.fromEmail) {
      fromEmail = emailSettings.fromEmail;
      fromName = fromName || emailSettings.fromName;
      replyTo = replyTo || emailSettings.replyTo;
    }

    // Fallback final
    if (!fromEmail) {
      fromEmail = "noreply@newbi.fr";
    }

    const actualSenderEmail = fromName
      ? `"${fromName}" <${fromEmail}>`
      : fromEmail;

    logger.debug(
      `📤 [CrmEmailAutomation] Envoi email de ${actualSenderEmail} vers ${clientEmail}`,
    );

    const mailOptions = {
      from: actualSenderEmail,
      to: clientEmail,
      subject: emailSubject,
      html: emailHtml,
    };

    if (replyTo) {
      mailOptions.replyTo = replyTo;
    }

    // Vérifier que le transporter est initialisé
    if (!emailReminderService.transporter) {
      throw new Error("Service SMTP non initialisé");
    }

    await emailReminderService.transporter.sendMail(mailOptions);

    // Enregistrer le log
    await CrmEmailAutomationLog.create({
      automationId: automation._id,
      clientId: client._id,
      workspaceId: automation.workspaceId,
      triggerDate: triggerDate,
      recipientEmail: clientEmail,
      emailSubject: emailSubject,
      emailBody: emailBody,
      status: "SENT",
    });

    // Ajouter l'activité au client
    try {
      client.activity.push({
        id: new mongoose.Types.ObjectId().toString(),
        type: "crm_email_sent",
        description: `a reçu un email automatique "${automation.name}"`,
        userId: automation.createdBy,
        userName: fromName || "Système",
        metadata: {
          automationId: automation._id.toString(),
          automationName: automation.name,
          customFieldName: customField.name,
          customFieldValue: customFieldValue,
        },
        createdAt: new Date(),
      });

      await client.save();
    } catch (activityError) {
      console.warn(
        "⚠️ [CrmEmailAutomation] Erreur ajout activité client:",
        activityError.message,
      );
    }

    logger.debug(`✅ [CrmEmailAutomation] Email envoyé à ${clientEmail}`);
    return true;
  } catch (error) {
    console.error(
      `❌ [CrmEmailAutomation] Erreur envoi email à ${client.email}:`,
      error,
    );

    // Enregistrer l'échec
    await CrmEmailAutomationLog.create({
      automationId: automation._id,
      clientId: client._id,
      workspaceId: automation.workspaceId,
      triggerDate: triggerDate,
      recipientEmail: client.email || "unknown",
      emailSubject: automation.email.subject,
      emailBody: automation.email.body,
      status: "FAILED",
      error: error.message,
    });

    return false;
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
    result = result.replace(regex, variables[key] || "");
  });

  return result;
}

/**
 * Exécution manuelle pour un workspace spécifique
 */
async function processWorkspaceCrmEmails(workspaceId) {
  logger.debug(
    `🔧 [CrmEmailAutomation] Exécution manuelle pour workspace ${workspaceId}`,
  );

  const automations = await CrmEmailAutomation.find({
    workspaceId,
    isActive: true,
  });

  if (!(await workspaceAllowsCrmEmails(workspaceId))) return 0;

  let totalSent = 0;

  for (const automation of automations) {
    const sent = await processAutomation(automation);
    totalSent += sent;
  }

  return totalSent;
}

export {
  processCrmEmailAutomations,
  processAutomation,
  processWorkspaceCrmEmails,
  calculateTargetDate,
};
