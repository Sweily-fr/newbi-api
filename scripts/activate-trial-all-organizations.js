/**
 * Script de migration : Activer la période d'essai pour toutes les organizations
 * 
 * Ce script met à jour toutes les organizations existantes avec :
 * - hasUsedTrial: true
 * - isTrialActive: true
 * - trialStartDate: Date actuelle
 * - trialEndDate: Date actuelle + 14 jours
 * 
 * Usage:
 *   node scripts/activate-trial-all-organizations.js
 *   node scripts/activate-trial-all-organizations.js --confirm  (pour exécuter)
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Charge la configuration
let MONGODB_URI;
try {
  const ecosystemConfig = require('../ecosystem.config.cjs');
  MONGODB_URI = ecosystemConfig.apps[0].env.MONGODB_URI;
} catch (error) {
  console.log('⚠️  Impossible de charger ecosystem.config.cjs, utilise MONGODB_URI depuis .env');
  require('dotenv').config();
  MONGODB_URI = process.env.MONGODB_URI;
}

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI non trouvé dans ecosystem.config.cjs ou .env');
  process.exit(1);
}

// Schéma simplifié pour la migration
const organizationSchema = new mongoose.Schema({
  name: String,
  hasUsedTrial: Boolean,
  isTrialActive: Boolean,
  trialStartDate: Date,
  trialEndDate: Date,
}, { strict: false });

const Organization = mongoose.model('Organization', organizationSchema);

async function createBackup(organizations) {
  const backupDir = path.join(__dirname, '../backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const backupFile = path.join(backupDir, `trial-activation-backup-${timestamp}.json`);

  const backupData = {
    timestamp: new Date().toISOString(),
    totalOrganizations: organizations.length,
    organizations: organizations.map(org => ({
      _id: org._id,
      name: org.name,
      hasUsedTrial: org.hasUsedTrial,
      isTrialActive: org.isTrialActive,
      trialStartDate: org.trialStartDate,
      trialEndDate: org.trialEndDate,
    })),
  };

  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
  console.log(`✅ Backup créé : ${backupFile}`);
  return backupFile;
}

async function activateTrialForAllOrganizations(dryRun = true) {
  try {
    console.log('🔌 Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB\n');

    // Récupère toutes les organizations
    const organizations = await Organization.find({});
    console.log(`📊 Total organizations trouvées : ${organizations.length}\n`);

    if (organizations.length === 0) {
      console.log('⚠️  Aucune organization trouvée');
      return;
    }

    // Crée un backup
    console.log('💾 Création du backup...');
    await createBackup(organizations);

    // Affiche les organizations qui seront mises à jour
    console.log('\n📋 Organizations qui seront mises à jour :\n');
    organizations.forEach((org, index) => {
      console.log(`${index + 1}. ${org.name || 'Sans nom'} (${org._id})`);
      console.log(`   Avant : hasUsedTrial=${org.hasUsedTrial}, isTrialActive=${org.isTrialActive}`);
    });

    if (dryRun) {
      console.log('\n⚠️  MODE DRY-RUN : Aucune modification effectuée');
      console.log('Pour exécuter réellement, lance : node scripts/activate-trial-all-organizations.js --confirm\n');
      return;
    }

    // Calcule les dates
    const now = new Date();
    const trialEndDate = new Date(now.getTime() + (14 * 24 * 60 * 60 * 1000)); // +14 jours

    console.log('\n🚀 Mise à jour en cours...\n');

    // Met à jour toutes les organizations
    const result = await Organization.updateMany(
      {},
      {
        $set: {
          hasUsedTrial: true,
          isTrialActive: true,
          trialStartDate: now,
          trialEndDate: trialEndDate,
        }
      }
    );

    console.log('✅ Mise à jour terminée !');
    console.log(`   Organizations modifiées : ${result.modifiedCount}`);
    console.log(`   Trial Start Date : ${now.toISOString()}`);
    console.log(`   Trial End Date : ${trialEndDate.toISOString()}`);
    console.log(`   Durée : 14 jours\n`);

    // Vérifie les mises à jour
    console.log('🔍 Vérification des mises à jour...\n');
    const updatedOrgs = await Organization.find({});
    
    let successCount = 0;
    let errorCount = 0;

    updatedOrgs.forEach((org, index) => {
      const isValid = 
        org.hasUsedTrial === true &&
        org.isTrialActive === true &&
        org.trialStartDate &&
        org.trialEndDate;

      if (isValid) {
        successCount++;
        console.log(`✅ ${index + 1}. ${org.name || 'Sans nom'}`);
        console.log(`   hasUsedTrial: ${org.hasUsedTrial}`);
        console.log(`   isTrialActive: ${org.isTrialActive}`);
        console.log(`   trialStartDate: ${org.trialStartDate?.toISOString()}`);
        console.log(`   trialEndDate: ${org.trialEndDate?.toISOString()}\n`);
      } else {
        errorCount++;
        console.log(`❌ ${index + 1}. ${org.name || 'Sans nom'} - Mise à jour incomplète`);
      }
    });

    console.log('\n📊 Résumé :');
    console.log(`   ✅ Succès : ${successCount}`);
    console.log(`   ❌ Erreurs : ${errorCount}`);
    console.log(`   📝 Total : ${updatedOrgs.length}\n`);

  } catch (error) {
    console.error('❌ Erreur lors de la migration :', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécution
const isConfirm = process.argv.includes('--confirm');
const dryRun = !isConfirm;

console.log('🔧 Script d\'activation de trial pour toutes les organizations\n');

if (dryRun) {
  console.log('⚠️  MODE DRY-RUN : Aucune modification ne sera effectuée');
  console.log('Pour exécuter réellement, lance : node scripts/activate-trial-all-organizations.js --confirm\n');
}

activateTrialForAllOrganizations(dryRun)
  .then(() => {
    console.log('✅ Script terminé avec succès');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Erreur fatale :', error);
    process.exit(1);
  });
