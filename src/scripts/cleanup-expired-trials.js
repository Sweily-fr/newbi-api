#!/usr/bin/env node

/**
 * Script pour nettoyer automatiquement les périodes d'essai expirées
 * À exécuter via cron job quotidiennement
 */

import mongoose from 'mongoose';
import TrialService from '../services/trialService.js';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

/**
 * Fonction principale du script
 */
async function main() {
  try {
    logger.info('🚀 Démarrage du nettoyage des périodes d\'essai expirées');

    // Connexion à MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';
    await mongoose.connect(mongoUri);
    logger.info('✅ Connexion à MongoDB établie');

    // Nettoyer les périodes d'essai expirées
    const updatedCount = await TrialService.cleanupExpiredTrials();
    logger.info(`✅ ${updatedCount} périodes d'essai expirées nettoyées`);

    // Obtenir les statistiques après nettoyage
    const stats = await TrialService.getTrialStats();
    logger.info('📊 Statistiques des périodes d\'essai:', {
      activeTrials: stats.activeTrials,
      expiredTrials: stats.expiredTrials,
      totalTrialsUsed: stats.totalTrialsUsed,
      conversionRate: `${stats.conversionRate}%`,
    });

    // Obtenir les utilisateurs dont la période d'essai expire dans 3 jours
    const expiringUsers = await TrialService.getUsersWithExpiringTrial(3);
    logger.info(`⚠️  ${expiringUsers.length} utilisateurs ont une période d'essai qui expire dans 3 jours`);

    // Obtenir les utilisateurs dont la période d'essai expire demain
    const expiringTomorrowUsers = await TrialService.getUsersWithExpiringTrial(1);
    logger.info(`🚨 ${expiringTomorrowUsers.length} utilisateurs ont une période d'essai qui expire demain`);

    logger.info('✅ Nettoyage terminé avec succès');
    
  } catch (error) {
    logger.error('❌ Erreur lors du nettoyage des périodes d\'essai:', error);
    process.exit(1);
  } finally {
    // Fermer la connexion MongoDB
    await mongoose.disconnect();
    logger.info('🔌 Connexion MongoDB fermée');
    process.exit(0);
  }
}

// Exécuter le script si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default main;
