import cron from 'node-cron';
import documentAutomationService from '../services/documentAutomationService.js';

/**
 * Cron job quotidien qui vérifie les factures en retard
 * et déclenche les automatisations OVERDUE correspondantes.
 * S'exécute tous les jours à 8h00 (heure de Paris).
 */
function startOverdueAutomationCron() {
  const task = cron.schedule('0 8 * * *', async () => {
    console.log('⏰ [OverdueCron] Lancement de la vérification des documents en retard...');

    try {
      const result = await documentAutomationService.checkOverdueAutomations();
      if (result.processed > 0) {
        console.log(`✅ [OverdueCron] ${result.processed} document(s) en retard traité(s)`);
      }
    } catch (error) {
      console.error('❌ [OverdueCron] Erreur:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris',
  });

  console.log('🕐 [OverdueCron] Cron de vérification des documents en retard configuré (tous les jours à 8h)');

  return task;
}

export { startOverdueAutomationCron };
