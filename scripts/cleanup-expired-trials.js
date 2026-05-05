#!/usr/bin/env node

/**
 * Script de nettoyage des trials expirés
 * Met à jour isTrialActive=false pour les trials expirés
 */

import { MongoClient, ObjectId } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration MongoDB
let MONGODB_URI;
let MONGODB_DB_NAME = 'newbi';

// Fonction pour charger la configuration
async function loadConfig() {
  try {
    const ecosystemPath = path.join(__dirname, '..', 'ecosystem.config.cjs');
    if (fs.existsSync(ecosystemPath)) {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const ecosystem = require(ecosystemPath);
      const env = ecosystem.apps[0].env;
      MONGODB_URI = env.MONGODB_URI;
      MONGODB_DB_NAME = env.MONGODB_DB_NAME || 'newbi';
    }
  } catch (error) {
    console.log('⚠️  Impossible de charger ecosystem.config.cjs, utilisation des variables d\'environnement');
  }

  // Fallback vers les variables d'environnement
  if (!MONGODB_URI) {
    MONGODB_URI = process.env.MONGODB_URI;
    MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'newbi';
  }
  if (!MONGODB_URI) {
    console.error("MONGODB_URI environment variable is required (none found in ecosystem.config.cjs nor env)");
    process.exit(1);
  }
}

class TrialCleanupService {
  constructor() {
    this.client = null;
    this.db = null;
    this.stats = {
      totalOrganizations: 0,
      expiredTrialsFound: 0,
      expiredTrialsCleaned: 0,
      errors: []
    };
  }

  async connect() {
    try {
      this.client = new MongoClient(MONGODB_URI);
      await this.client.connect();
      this.db = this.client.db(MONGODB_DB_NAME);
      console.log('✅ Connexion MongoDB établie');
    } catch (error) {
      console.error('❌ Erreur de connexion MongoDB:', error.message);
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      console.log('✅ Connexion MongoDB fermée');
    }
  }

  async findExpiredTrials() {
    console.log('\n🔍 Recherche des trials expirés...');
    
    try {
      const now = new Date();
      
      // Trouver les organisations avec trial expiré mais encore actif
      const expiredTrials = await this.db.collection('organization').find({
        isTrialActive: true,
        trialEndDate: { $lt: now }
      }).toArray();
      
      this.stats.expiredTrialsFound = expiredTrials.length;
      
      console.log(`⏰ Trials expirés trouvés: ${this.stats.expiredTrialsFound}`);
      
      if (expiredTrials.length > 0) {
        console.log('\n📋 Détails des trials expirés:');
        expiredTrials.forEach(org => {
          const daysExpired = Math.ceil((now - new Date(org.trialEndDate)) / (24 * 60 * 60 * 1000));
          console.log(`  - ${org.companyName || org._id}: expiré depuis ${daysExpired} jour(s)`);
        });
      }
      
      return expiredTrials;
      
    } catch (error) {
      console.error('❌ Erreur lors de la recherche:', error.message);
      this.stats.errors.push(`Recherche: ${error.message}`);
      throw error;
    }
  }

  async cleanupExpiredTrial(organization, dryRun = true) {
    const orgId = organization._id;
    const orgName = organization.companyName || orgId.toString();
    
    try {
      const now = new Date();
      const daysExpired = Math.ceil((now - new Date(organization.trialEndDate)) / (24 * 60 * 60 * 1000));
      
      if (dryRun) {
        console.log(`🔍 [DRY-RUN] Nettoyage trial pour ${orgName} (expiré depuis ${daysExpired} jour(s))`);
        return true;
      }
      
      // Mettre à jour l'organisation pour désactiver le trial
      const result = await this.db.collection('organization').updateOne(
        { _id: orgId },
        { 
          $set: { 
            isTrialActive: false 
          }
          // Note: On garde trialEndDate et hasUsedTrial pour l'historique
        }
      );
      
      if (result.modifiedCount === 1) {
        console.log(`✅ Trial nettoyé pour ${orgName}`);
        this.stats.expiredTrialsCleaned++;
        return true;
      } else {
        throw new Error('Aucune modification effectuée');
      }
      
    } catch (error) {
      console.error(`❌ Erreur nettoyage trial pour ${orgName}:`, error.message);
      this.stats.errors.push(`${orgName}: ${error.message}`);
      return false;
    }
  }

  async cleanupAllExpiredTrials(dryRun = true) {
    console.log(`\n🧹 ${dryRun ? '[DRY-RUN] ' : ''}Nettoyage des trials expirés...`);
    
    const expiredTrials = await this.findExpiredTrials();
    
    if (expiredTrials.length === 0) {
      console.log('✅ Aucun trial expiré à nettoyer');
      return;
    }
    
    console.log(`\n📝 ${dryRun ? 'Simulation de nettoyage' : 'Nettoyage'} pour ${expiredTrials.length} organisations:`);
    
    for (const org of expiredTrials) {
      await this.cleanupExpiredTrial(org, dryRun);
    }
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '..', 'backups');
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const backupFile = path.join(backupDir, `trial-cleanup-backup-${timestamp}.json`);
    
    try {
      // Sauvegarder les organisations avec trial actif
      const organizationsWithTrial = await this.db.collection('organization').find({
        $or: [
          { isTrialActive: true },
          { trialEndDate: { $exists: true } }
        ]
      }).toArray();
      
      const backup = {
        timestamp: new Date().toISOString(),
        collections: {
          organizationsWithTrial: organizationsWithTrial
        },
        stats: {
          totalOrganizationsWithTrial: organizationsWithTrial.length
        }
      };
      
      fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
      console.log(`💾 Sauvegarde créée: ${backupFile}`);
      
      return backupFile;
    } catch (error) {
      console.error('❌ Erreur création sauvegarde:', error.message);
      throw error;
    }
  }

  printStats() {
    console.log('\n📊 STATISTIQUES DE NETTOYAGE:');
    console.log('=============================');
    console.log(`Trials expirés trouvés: ${this.stats.expiredTrialsFound}`);
    console.log(`Trials nettoyés: ${this.stats.expiredTrialsCleaned}`);
    
    if (this.stats.errors.length > 0) {
      console.log(`\n❌ Erreurs (${this.stats.errors.length}):`);
      this.stats.errors.forEach(error => console.log(`  - ${error}`));
    }
  }
}

async function main() {
  // Charger la configuration en premier
  await loadConfig();
  
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--confirm');
  const skipBackup = args.includes('--skip-backup');
  
  console.log('🧹 NETTOYAGE DES TRIALS EXPIRÉS');
  console.log('===============================');
  
  if (dryRun) {
    console.log('🔍 MODE DRY-RUN: Aucune modification ne sera effectuée');
    console.log('   Utilisez --confirm pour appliquer les changements');
  } else {
    console.log('⚠️  MODE PRODUCTION: Les modifications seront appliquées');
  }
  
  const service = new TrialCleanupService();
  
  try {
    await service.connect();
    
    // Créer une sauvegarde si pas en dry-run
    if (!dryRun && !skipBackup) {
      await service.createBackup();
    }
    
    // Nettoyer les trials expirés
    await service.cleanupAllExpiredTrials(dryRun);
    
    // Afficher les statistiques
    service.printStats();
    
    if (dryRun) {
      console.log('\n💡 Pour appliquer ces changements, exécutez:');
      console.log('   node cleanup-expired-trials.js --confirm');
    } else {
      console.log('\n✅ Nettoyage des trials expirés terminé avec succès!');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur fatale:', error.message);
    process.exit(1);
  } finally {
    await service.disconnect();
  }
}

// Gestion des signaux pour fermeture propre
process.on('SIGINT', async () => {
  console.log('\n⚠️  Interruption détectée, fermeture...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Arrêt demandé, fermeture...');
  process.exit(0);
});

// Exécution
// Vérifier si le script est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { TrialCleanupService };
