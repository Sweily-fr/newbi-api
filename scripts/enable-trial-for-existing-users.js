#!/usr/bin/env node

/**
 * Script pour activer la période d'essai pour les utilisateurs existants
 * qui n'ont pas d'abonnement actif
 * 
 * Ce script :
 * 1. Identifie les organisations sans abonnement actif
 * 2. Active la période d'essai de 14 jours pour ces organisations
 * 3. Met à jour les champs trial nécessaires
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
      console.log('✅ Configuration chargée depuis ecosystem.config.cjs');
    }
  } catch (error) {
    console.log('⚠️  Impossible de charger ecosystem.config.cjs, utilisation des variables d\'environnement');
  }

  // Fallback vers les variables d'environnement
  if (!MONGODB_URI) {
    MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:Sweily2024!@localhost:27017/newbi?authSource=admin';
    MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'newbi';
  }

  console.log(`🔗 URI MongoDB: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
  console.log(`📊 Base de données: ${MONGODB_DB_NAME}`);
}

class TrialActivationService {
  constructor() {
    this.client = null;
    this.db = null;
    this.stats = {
      totalOrganizations: 0,
      organizationsWithSubscription: 0,
      organizationsWithoutSubscription: 0,
      organizationsAlreadyWithTrial: 0,
      organizationsTrialActivated: 0,
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

  async analyzeOrganizations() {
    console.log('\n📊 Analyse des organisations...');
    
    try {
      // Récupérer toutes les organisations
      const organizations = await this.db.collection('organization').find({}).toArray();
      this.stats.totalOrganizations = organizations.length;
      
      console.log(`📋 Total des organisations: ${this.stats.totalOrganizations}`);
      
      // Récupérer tous les abonnements actifs
      const activeSubscriptions = await this.db.collection('subscription').find({
        status: { $in: ['active', 'trialing'] },
        licence: true
      }).toArray();
      
      const organizationsWithSubscription = new Set(
        activeSubscriptions.map(sub => sub.organizationId?.toString())
      );
      
      this.stats.organizationsWithSubscription = organizationsWithSubscription.size;
      this.stats.organizationsWithoutSubscription = this.stats.totalOrganizations - this.stats.organizationsWithSubscription;
      
      console.log(`💳 Organisations avec abonnement actif: ${this.stats.organizationsWithSubscription}`);
      console.log(`🆓 Organisations sans abonnement: ${this.stats.organizationsWithoutSubscription}`);
      
      // Analyser les organisations sans abonnement
      const organizationsNeedingTrial = [];
      
      for (const org of organizations) {
        const orgId = org._id.toString();
        
        // Vérifier si l'organisation a un abonnement actif
        if (organizationsWithSubscription.has(orgId)) {
          continue;
        }
        
        // Vérifier si l'organisation a déjà un trial actif
        if (org.isTrialActive) {
          this.stats.organizationsAlreadyWithTrial++;
          console.log(`🔄 Organisation ${org.companyName || orgId} a déjà un trial actif`);
          continue;
        }
        
        // Vérifier si l'organisation a déjà utilisé son trial
        if (org.hasUsedTrial) {
          console.log(`⏰ Organisation ${org.companyName || orgId} a déjà utilisé son trial`);
          continue;
        }
        
        organizationsNeedingTrial.push(org);
      }
      
      console.log(`🎯 Organisations éligibles pour activation du trial: ${organizationsNeedingTrial.length}`);
      
      return organizationsNeedingTrial;
      
    } catch (error) {
      console.error('❌ Erreur lors de l\'analyse:', error.message);
      this.stats.errors.push(`Analyse: ${error.message}`);
      throw error;
    }
  }

  async activateTrialForOrganization(organization, dryRun = true) {
    const orgId = organization._id;
    const orgName = organization.companyName || orgId.toString();
    
    try {
      // Calculer les dates de trial (180 jours - 6 mois)
      const now = new Date();
      const trialEndDate = new Date(now.getTime() + (180 * 24 * 60 * 60 * 1000));
      
      const trialData = {
        trialStartDate: now,
        trialEndDate: trialEndDate,
        isTrialActive: true,
        hasUsedTrial: true // Marquer comme utilisé pour éviter les abus
      };
      
      if (dryRun) {
        console.log(`🔍 [DRY-RUN] Activation trial pour ${orgName}:`, {
          trialStartDate: trialData.trialStartDate.toISOString(),
          trialEndDate: trialData.trialEndDate.toISOString(),
          duration: '14 jours'
        });
        return true;
      }
      
      // Mettre à jour l'organisation
      const result = await this.db.collection('organization').updateOne(
        { _id: orgId },
        { $set: trialData }
      );
      
      if (result.modifiedCount === 1) {
        console.log(`✅ Trial activé pour ${orgName} (180 jours - 6 mois)`);
        this.stats.organizationsTrialActivated++;
        return true;
      } else {
        throw new Error('Aucune modification effectuée');
      }
      
    } catch (error) {
      console.error(`❌ Erreur activation trial pour ${orgName}:`, error.message);
      this.stats.errors.push(`${orgName}: ${error.message}`);
      return false;
    }
  }

  async activateTrialsForEligibleOrganizations(dryRun = true) {
    console.log(`\n🚀 ${dryRun ? '[DRY-RUN] ' : ''}Activation des trials...`);
    
    const eligibleOrganizations = await this.analyzeOrganizations();
    
    if (eligibleOrganizations.length === 0) {
      console.log('✅ Aucune organisation éligible trouvée');
      return;
    }
    
    console.log(`\n📝 ${dryRun ? 'Simulation d\'activation' : 'Activation'} pour ${eligibleOrganizations.length} organisations:`);
    
    for (const org of eligibleOrganizations) {
      await this.activateTrialForOrganization(org, dryRun);
    }
  }

  async createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(__dirname, '..', 'backups');
    
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const backupFile = path.join(backupDir, `trial-activation-backup-${timestamp}.json`);
    
    try {
      // Sauvegarder les organisations
      const organizations = await this.db.collection('organization').find({}).toArray();
      
      const backup = {
        timestamp: new Date().toISOString(),
        collections: {
          organizations: organizations
        },
        stats: {
          totalOrganizations: organizations.length
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
    console.log('\n📊 STATISTIQUES FINALES:');
    console.log('========================');
    console.log(`Total organisations: ${this.stats.totalOrganizations}`);
    console.log(`Avec abonnement actif: ${this.stats.organizationsWithSubscription}`);
    console.log(`Sans abonnement: ${this.stats.organizationsWithoutSubscription}`);
    console.log(`Déjà avec trial actif: ${this.stats.organizationsAlreadyWithTrial}`);
    console.log(`Trials activés: ${this.stats.organizationsTrialActivated}`);
    
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
  
  console.log('🎯 ACTIVATION TRIAL POUR UTILISATEURS EXISTANTS');
  console.log('===============================================');
  
  if (dryRun) {
    console.log('🔍 MODE DRY-RUN: Aucune modification ne sera effectuée');
    console.log('   Utilisez --confirm pour appliquer les changements');
  } else {
    console.log('⚠️  MODE PRODUCTION: Les modifications seront appliquées');
  }
  
  const service = new TrialActivationService();
  
  try {
    await service.connect();
    
    // Créer une sauvegarde si pas en dry-run
    if (!dryRun && !skipBackup) {
      await service.createBackup();
    }
    
    // Activer les trials
    await service.activateTrialsForEligibleOrganizations(dryRun);
    
    // Afficher les statistiques
    service.printStats();
    
    if (dryRun) {
      console.log('\n💡 Pour appliquer ces changements, exécutez:');
      console.log('   node enable-trial-for-existing-users.js --confirm');
    } else {
      console.log('\n✅ Activation des trials terminée avec succès!');
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

// Vérifier si le script est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { TrialActivationService };
