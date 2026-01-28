import mongoose from 'mongoose';
import CrmEmailAutomation from '../models/CrmEmailAutomation.js';
import CrmEmailAutomationLog from '../models/CrmEmailAutomationLog.js';
import ClientCustomField from '../models/ClientCustomField.js';
import Client from '../models/Client.js';
import EmailSettings from '../models/EmailSettings.js';
import emailReminderService from './emailReminderService.js';

/**
 * Traite les automatisations d'email CRM pour tous les workspaces
 */
async function processCrmEmailAutomations() {
  console.log('📧 [CrmEmailAutomation] Démarrage du processus d\'envoi automatique...');
  
  try {
    const currentHour = new Date().getHours();
    
    // Récupérer toutes les automatisations actives pour cette heure
    const activeAutomations = await CrmEmailAutomation.find({ 
      isActive: true,
      'timing.sendHour': currentHour
    });
    
    console.log(`📊 [CrmEmailAutomation] ${activeAutomations.length} automatisation(s) active(s) pour ${currentHour}h`);
    
    let totalSent = 0;
    
    for (const automation of activeAutomations) {
      const sent = await processAutomation(automation);
      totalSent += sent;
    }
    
    console.log(`✅ [CrmEmailAutomation] Processus terminé - ${totalSent} email(s) envoyé(s)`);
    
    return totalSent;
  } catch (error) {
    console.error('❌ [CrmEmailAutomation] Erreur lors du processus:', error);
    throw error;
  }
}

/**
 * Traite une automatisation spécifique
 */
async function processAutomation(automation) {
  const { workspaceId, customFieldId, timing } = automation;
  
  console.log(`🔄 [CrmEmailAutomation] Traitement de "${automation.name}" (workspace: ${workspaceId})`);
  
  try {
    // Récupérer le champ personnalisé
    const customField = await ClientCustomField.findById(customFieldId);
    if (!customField) {
      console.warn(`⚠️ [CrmEmailAutomation] Champ personnalisé ${customFieldId} non trouvé`);
      return 0;
    }
    
    // Calculer la date cible selon le timing
    const targetDate = calculateTargetDate(timing);
    
    console.log(`📅 [CrmEmailAutomation] Date cible: ${targetDate.toLocaleDateString('fr-FR')}`);
    
    // Trouver les clients avec cette date dans le champ personnalisé
    const clients = await findClientsWithDateField(workspaceId, customField.id, targetDate);
    
    console.log(`👥 [CrmEmailAutomation] ${clients.length} client(s) correspondant(s)`);
    
    let sentCount = 0;
    
    for (const client of clients) {
      const sent = await sendEmailToClient(automation, customField, client, targetDate);
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
    console.error(`❌ [CrmEmailAutomation] Erreur pour "${automation.name}":`, error);
    return 0;
  }
}

/**
 * Calcule la date cible selon la configuration du timing
 */
function calculateTargetDate(timing) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const targetDate = new Date(today);
  
  switch (timing.type) {
    case 'BEFORE_DATE':
      // Si on veut envoyer X jours AVANT la date, on cherche les dates dans X jours
      targetDate.setDate(targetDate.getDate() + timing.daysOffset);
      break;
    case 'AFTER_DATE':
      // Si on veut envoyer X jours APRÈS la date, on cherche les dates d'il y a X jours
      targetDate.setDate(targetDate.getDate() - timing.daysOffset);
      break;
    case 'ON_DATE':
    default:
      // Le jour même, pas de modification
      break;
  }
  
  return targetDate;
}

/**
 * Trouve les clients avec une date spécifique dans un champ personnalisé
 */
async function findClientsWithDateField(workspaceId, customFieldId, targetDate) {
  // Créer les bornes de la journée
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);
  
  // Format de date stocké: YYYY-MM-DD
  const dateString = targetDate.toISOString().split('T')[0];
  
  // Rechercher les clients avec ce champ personnalisé à cette date
  const clients = await Client.find({
    workspaceId,
    [`customFields.${customFieldId}`]: dateString,
    email: { $exists: true, $ne: '' }
  });
  
  return clients;
}

/**
 * Envoie un email à un client
 */
async function sendEmailToClient(automation, customField, client, triggerDate) {
  try {
    // Vérifier si un email a déjà été envoyé pour cette combinaison
    const existingLog = await CrmEmailAutomationLog.findOne({
      automationId: automation._id,
      clientId: client._id,
      triggerDate: {
        $gte: new Date(triggerDate.setHours(0, 0, 0, 0)),
        $lte: new Date(triggerDate.setHours(23, 59, 59, 999))
      }
    });
    
    if (existingLog) {
      console.log(`⏭️ [CrmEmailAutomation] Email déjà envoyé à ${client.email} pour cette date`);
      return false;
    }
    
    const clientEmail = client.email;
    if (!clientEmail) {
      console.warn(`⚠️ [CrmEmailAutomation] Pas d'email pour le client ${client._id}`);
      return false;
    }
    
    // Récupérer la valeur du champ personnalisé
    const customFieldValue = client.customFields?.get(customField.id.toString()) || 
                            client.customFields?.[customField.id.toString()] || '';
    
    // Préparer les variables
    const variables = {
      clientName: `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Client',
      clientFirstName: client.firstName || '',
      clientLastName: client.lastName || '',
      clientEmail: client.email || '',
      customFieldName: customField.name,
      customFieldValue: customFieldValue ? new Date(customFieldValue).toLocaleDateString('fr-FR') : '',
      companyName: automation.email.fromName || 'Votre Entreprise',
    };
    
    // Remplacer les variables
    const emailSubject = replaceVariables(automation.email.subject, variables);
    const emailBody = replaceVariables(automation.email.body, variables);
    
    // Générer le HTML de l'email
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        ${emailBody.replace(/\n/g, '<br>')}
      </div>
    `;
    
    // Récupérer les paramètres email du workspace
    const emailSettings = await EmailSettings.findOne({ 
      workspaceId: automation.workspaceId
    });
    
    // Déterminer l'email expéditeur
    let fromEmail = automation.email.fromEmail;
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
      fromEmail = 'noreply@newbi.fr';
    }
    
    const actualSenderEmail = fromName 
      ? `"${fromName}" <${fromEmail}>`
      : fromEmail;
    
    console.log(`📤 [CrmEmailAutomation] Envoi email de ${actualSenderEmail} vers ${clientEmail}`);
    
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
      throw new Error('Service SMTP non initialisé');
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
      status: 'SENT',
    });
    
    // Ajouter l'activité au client
    try {
      client.activity.push({
        id: new mongoose.Types.ObjectId().toString(),
        type: 'crm_email_sent',
        description: `a reçu un email automatique "${automation.name}"`,
        userId: automation.createdBy,
        userName: fromName || 'Système',
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
      console.warn('⚠️ [CrmEmailAutomation] Erreur ajout activité client:', activityError.message);
    }
    
    console.log(`✅ [CrmEmailAutomation] Email envoyé à ${clientEmail}`);
    return true;
    
  } catch (error) {
    console.error(`❌ [CrmEmailAutomation] Erreur envoi email à ${client.email}:`, error);
    
    // Enregistrer l'échec
    await CrmEmailAutomationLog.create({
      automationId: automation._id,
      clientId: client._id,
      workspaceId: automation.workspaceId,
      triggerDate: triggerDate,
      recipientEmail: client.email || 'unknown',
      emailSubject: automation.email.subject,
      emailBody: automation.email.body,
      status: 'FAILED',
      error: error.message,
    });
    
    return false;
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
    result = result.replace(regex, variables[key] || '');
  });
  
  return result;
}

/**
 * Exécution manuelle pour un workspace spécifique
 */
async function processWorkspaceCrmEmails(workspaceId) {
  console.log(`🔧 [CrmEmailAutomation] Exécution manuelle pour workspace ${workspaceId}`);
  
  const automations = await CrmEmailAutomation.find({ 
    workspaceId,
    isActive: true
  });
  
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
};
