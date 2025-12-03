import cron from 'node-cron';
import InvoiceReminderSettings from '../models/InvoiceReminderSettings.js';
import { 
  startReminderWorker, 
  stopReminderWorker,
  scheduleWorkspaceReminders,
  getQueueStats 
} from '../queues/reminderQueue.js';

let workerStarted = false;

/**
 * Cron job pour planifier les relances automatiques via la queue
 * S'exécute toutes les heures pour vérifier les workspaces à traiter
 */
function startInvoiceReminderCron() {
  // Démarrer le worker de traitement
  if (!workerStarted) {
    startReminderWorker();
    workerStarted = true;
  }
  
  // Cron expression: '0 * * * *' = toutes les heures à la minute 0
  const cronExpression = '0 * * * *';
  
  const task = cron.schedule(cronExpression, async () => {
    const currentHour = new Date().getHours();
    console.log(`⏰ [Cron] Vérification des relances pour l'heure ${currentHour}h`);
    
    try {
      await scheduleRemindersForHour(currentHour);
      
      // Afficher les stats de la queue
      const stats = await getQueueStats();
      if (stats.waiting > 0 || stats.delayed > 0) {
        console.log(`📊 [Cron] Queue stats: ${stats.waiting} en attente, ${stats.delayed} différés`);
      }
      
    } catch (error) {
      console.error('❌ [Cron] Erreur lors de la planification:', error);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris',
  });

  console.log(`🕐 [Cron] Job de relance automatique configuré (toutes les heures)`);
  console.log('🚀 [Cron] Worker de traitement des relances actif');
  
  return task;
}

/**
 * Planifie les relances pour les workspaces configurés à cette heure
 */
async function scheduleRemindersForHour(hour) {
  // Trouver les workspaces dont l'heure de relance correspond
  const activeSettings = await InvoiceReminderSettings.find({ 
    enabled: true,
    reminderHour: hour 
  });
  
  if (activeSettings.length === 0) {
    return 0;
  }
  
  console.log(`📊 [Cron] ${activeSettings.length} workspace(s) configuré(s) pour ${hour}h`);
  
  let totalScheduled = 0;
  
  for (const settings of activeSettings) {
    try {
      const count = await scheduleWorkspaceReminders(settings.workspaceId, settings);
      totalScheduled += count;
      if (count > 0) {
        console.log(`✅ [Cron] Workspace ${settings.workspaceId}: ${count} relance(s) planifiée(s)`);
      }
    } catch (error) {
      console.error(`❌ [Cron] Erreur workspace ${settings.workspaceId}:`, error.message);
    }
  }
  
  if (totalScheduled > 0) {
    console.log(`📧 [Cron] Total: ${totalScheduled} relance(s) ajoutée(s) à la queue`);
  }
  
  return totalScheduled;
}

/**
 * Planifie les relances pour tous les workspaces actifs (toutes heures confondues)
 */
async function scheduleAllReminders() {
  const activeSettings = await InvoiceReminderSettings.find({ enabled: true });
  
  console.log(`📊 [Cron] ${activeSettings.length} workspace(s) avec relances activées`);
  
  let totalScheduled = 0;
  
  for (const settings of activeSettings) {
    try {
      const count = await scheduleWorkspaceReminders(settings.workspaceId, settings);
      totalScheduled += count;
      console.log(`✅ [Cron] Workspace ${settings.workspaceId}: ${count} relance(s) planifiée(s)`);
    } catch (error) {
      console.error(`❌ [Cron] Erreur workspace ${settings.workspaceId}:`, error.message);
    }
  }
  
  console.log(`📧 [Cron] Total: ${totalScheduled} relance(s) ajoutée(s) à la queue`);
  
  return totalScheduled;
}

/**
 * Fonction pour exécuter manuellement le processus de relance
 * Utile pour les tests
 */
async function runManualReminder() {
  console.log('🔧 [Manual] Exécution manuelle de la planification des relances');
  
  // S'assurer que le worker est démarré
  if (!workerStarted) {
    startReminderWorker();
    workerStarted = true;
  }
  
  try {
    const count = await scheduleAllReminders();
    const stats = await getQueueStats();
    
    console.log('✅ [Manual] Planification terminée');
    console.log(`📊 [Manual] ${count} relance(s) planifiée(s)`);
    console.log(`📊 [Manual] Queue: ${stats.waiting} en attente, ${stats.active} en cours`);
    
    return { scheduled: count, stats };
  } catch (error) {
    console.error('❌ [Manual] Erreur:', error);
    throw error;
  }
}

/**
 * Arrête proprement le système de queue
 */
async function stopInvoiceReminderCron() {
  await stopReminderWorker();
  workerStarted = false;
}

export {
  startInvoiceReminderCron,
  stopInvoiceReminderCron,
  runManualReminder,
  scheduleAllReminders,
};
