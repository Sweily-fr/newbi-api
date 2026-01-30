import cron from 'node-cron';
import { processCrmEmailAutomations } from '../services/crmEmailAutomationService.js';

let cronTask = null;

/**
 * Démarre le cron job pour les automatisations d'email CRM
 * S'exécute toutes les heures à la minute 5 (décalé de 5 min par rapport aux relances factures)
 */
function startCrmEmailAutomationCron() {
  // Cron expression: '5 * * * *' = toutes les heures à la minute 5
  const cronExpression = '5 * * * *';
  
  cronTask = cron.schedule(cronExpression, async () => {
    const currentHour = new Date().getHours();
    console.log(`⏰ [CrmEmailCron] Vérification des automatisations email CRM pour ${currentHour}h`);
    
    try {
      const sentCount = await processCrmEmailAutomations();
      if (sentCount > 0) {
        console.log(`✅ [CrmEmailCron] ${sentCount} email(s) envoyé(s)`);
      }
    } catch (error) {
      console.error('❌ [CrmEmailCron] Erreur lors du traitement:', error);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris',
  });

  console.log('🕐 [CrmEmailCron] Job d\'automatisation email CRM configuré (toutes les heures à :05)');
  
  return cronTask;
}

/**
 * Arrête le cron job
 */
function stopCrmEmailAutomationCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    console.log('🛑 [CrmEmailCron] Job d\'automatisation email CRM arrêté');
  }
}

/**
 * Exécution manuelle pour les tests
 */
async function runManualCrmEmailAutomation() {
  console.log('🔧 [CrmEmailCron] Exécution manuelle des automatisations email CRM');
  
  try {
    const sentCount = await processCrmEmailAutomations();
    console.log(`✅ [CrmEmailCron] Exécution manuelle terminée - ${sentCount} email(s) envoyé(s)`);
    return sentCount;
  } catch (error) {
    console.error('❌ [CrmEmailCron] Erreur lors de l\'exécution manuelle:', error);
    throw error;
  }
}

export {
  startCrmEmailAutomationCron,
  stopCrmEmailAutomationCron,
  runManualCrmEmailAutomation,
};
