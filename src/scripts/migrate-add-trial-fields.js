#!/usr/bin/env node

/**
 * Script de migration pour ajouter les champs de période d'essai aux utilisateurs existants
 */

import mongoose from 'mongoose';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

/**
 * Fonction principale de migration
 */
async function migrateTrialFields() {
  try {
    logger.info('🚀 Démarrage de la migration des champs de période d\'essai');

    // Connexion à MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';
    await mongoose.connect(mongoUri);
    logger.info('✅ Connexion à MongoDB établie');

    // Trouver tous les utilisateurs qui n'ont pas encore les nouveaux champs
    const usersToMigrate = await User.find({
      $or: [
        { 'subscription.trialStartDate': { $exists: false } },
        { 'subscription.trialEndDate': { $exists: false } },
        { 'subscription.isTrialActive': { $exists: false } },
        { 'subscription.hasUsedTrial': { $exists: false } },
      ]
    });

    logger.info(`📊 ${usersToMigrate.length} utilisateurs à migrer`);

    if (usersToMigrate.length === 0) {
      logger.info('✅ Aucune migration nécessaire, tous les utilisateurs ont déjà les champs requis');
      return;
    }

    let migratedCount = 0;
    let trialStartedCount = 0;

    for (const user of usersToMigrate) {
      try {
        // Déterminer si l'utilisateur doit avoir une période d'essai active
        const shouldStartTrial = !user.subscription.stripeCustomerId && 
                                user.subscription.licence === true;

        if (shouldStartTrial && !user.subscription.hasUsedTrial) {
          // Démarrer la période d'essai pour les nouveaux utilisateurs
          const now = new Date();
          const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 jours

          await User.updateOne(
            { _id: user._id },
            {
              $set: {
                'subscription.trialStartDate': now,
                'subscription.trialEndDate': trialEnd,
                'subscription.isTrialActive': true,
                'subscription.hasUsedTrial': true,
              }
            }
          );

          trialStartedCount++;
          logger.info(`✅ Période d'essai démarrée pour l'utilisateur ${user.email}`);
        } else {
          // Ajouter les champs avec des valeurs par défaut
          await User.updateOne(
            { _id: user._id },
            {
              $set: {
                'subscription.trialStartDate': null,
                'subscription.trialEndDate': null,
                'subscription.isTrialActive': false,
                'subscription.hasUsedTrial': user.subscription.stripeCustomerId ? true : false,
              }
            }
          );
        }

        migratedCount++;

        // Log de progression tous les 10 utilisateurs
        if (migratedCount % 10 === 0) {
          logger.info(`📈 Progression: ${migratedCount}/${usersToMigrate.length} utilisateurs migrés`);
        }

      } catch (error) {
        logger.error(`❌ Erreur lors de la migration de l'utilisateur ${user.email}:`, error);
      }
    }

    logger.info('✅ Migration terminée avec succès');
    logger.info(`📊 Résumé:`);
    logger.info(`   - Utilisateurs migrés: ${migratedCount}`);
    logger.info(`   - Périodes d'essai démarrées: ${trialStartedCount}`);
    logger.info(`   - Utilisateurs avec abonnement existant: ${migratedCount - trialStartedCount}`);

  } catch (error) {
    logger.error('❌ Erreur lors de la migration:', error);
    process.exit(1);
  } finally {
    // Fermer la connexion MongoDB
    await mongoose.disconnect();
    logger.info('🔌 Connexion MongoDB fermée');
    process.exit(0);
  }
}

/**
 * Fonction pour vérifier l'état de la migration
 */
async function checkMigrationStatus() {
  try {
    logger.info('🔍 Vérification de l\'état de la migration');

    // Connexion à MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';
    await mongoose.connect(mongoUri);

    // Compter les utilisateurs avec et sans les nouveaux champs
    const totalUsers = await User.countDocuments();
    const usersWithTrialFields = await User.countDocuments({
      'subscription.trialStartDate': { $exists: true },
      'subscription.trialEndDate': { $exists: true },
      'subscription.isTrialActive': { $exists: true },
      'subscription.hasUsedTrial': { $exists: true },
    });

    const activeTrials = await User.countDocuments({
      'subscription.isTrialActive': true
    });

    logger.info(`📊 État de la migration:`);
    logger.info(`   - Total utilisateurs: ${totalUsers}`);
    logger.info(`   - Utilisateurs avec champs d'essai: ${usersWithTrialFields}`);
    logger.info(`   - Utilisateurs sans champs d'essai: ${totalUsers - usersWithTrialFields}`);
    logger.info(`   - Périodes d'essai actives: ${activeTrials}`);

    if (totalUsers === usersWithTrialFields) {
      logger.info('✅ Migration complète - tous les utilisateurs ont les champs requis');
    } else {
      logger.info('⚠️  Migration incomplète - certains utilisateurs n\'ont pas les champs requis');
    }

  } catch (error) {
    logger.error('❌ Erreur lors de la vérification:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// Gestion des arguments de ligne de commande
const args = process.argv.slice(2);
const command = args[0];

if (command === 'check') {
  checkMigrationStatus();
} else if (command === 'migrate' || !command) {
  migrateTrialFields();
} else {
  logger.info('Usage: node migrate-add-trial-fields.js [migrate|check]');
  logger.info('  migrate: Effectuer la migration (par défaut)');
  logger.info('  check: Vérifier l\'état de la migration');
  process.exit(1);
}

export default migrateTrialFields;
