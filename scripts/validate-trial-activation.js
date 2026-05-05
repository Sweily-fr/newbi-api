#!/usr/bin/env node

/**
 * Script de validation post-activation des trials
 * Vérifie que les trials ont été correctement activés
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

class TrialValidationService {
  constructor() {
    this.client = null;
    this.db = null;
    this.report = {
      timestamp: new Date().toISOString(),
      validation: {
        totalOrganizations: 0,
        organizationsWithActiveSubscription: 0,
        organizationsWithActiveTrial: 0,
        organizationsWithExpiredTrial: 0,
        organizationsWithoutTrialOrSubscription: 0,
        trialExpiringIn3Days: 0,
        trialExpiringIn7Days: 0
      },
      details: {
        activeTrials: [],
        expiredTrials: [],
        expiringTrials: [],
        noTrialOrSubscription: []
      },
      issues: []
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

  async validateTrialActivation() {
    console.log('\n🔍 VALIDATION DE L\'ACTIVATION DES TRIALS');
    console.log('========================================');
    
    try {
      // Récupérer toutes les organisations
      const organizations = await this.db.collection('organization').find({}).toArray();
      this.report.validation.totalOrganizations = organizations.length;
      
      // Récupérer tous les abonnements actifs
      const activeSubscriptions = await this.db.collection('subscription').find({
        status: { $in: ['active', 'trialing'] },
        licence: true
      }).toArray();
      
      const organizationsWithSubscription = new Set(
        activeSubscriptions.map(sub => sub.organizationId?.toString())
      );
      
      this.report.validation.organizationsWithActiveSubscription = organizationsWithSubscription.size;
      
      const now = new Date();
      const in3Days = new Date(now.getTime() + (3 * 24 * 60 * 60 * 1000));
      const in7Days = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
      
      // Analyser chaque organisation
      for (const org of organizations) {
        const orgId = org._id.toString();
        const orgName = org.companyName || `Organisation ${orgId}`;
        
        // Vérifier si l'organisation a un abonnement actif
        if (organizationsWithSubscription.has(orgId)) {
          continue; // Skip, elle a déjà un abonnement
        }
        
        // Analyser le statut du trial
        if (org.isTrialActive && org.trialEndDate) {
          const trialEndDate = new Date(org.trialEndDate);
          
          if (trialEndDate > now) {
            // Trial actif
            this.report.validation.organizationsWithActiveTrial++;
            
            const daysRemaining = Math.ceil((trialEndDate - now) / (24 * 60 * 60 * 1000));
            
            this.report.details.activeTrials.push({
              organizationId: orgId,
              name: orgName,
              trialStartDate: org.trialStartDate,
              trialEndDate: org.trialEndDate,
              daysRemaining: daysRemaining
            });
            
            // Vérifier si expire bientôt
            if (trialEndDate <= in3Days) {
              this.report.validation.trialExpiringIn3Days++;
              this.report.details.expiringTrials.push({
                organizationId: orgId,
                name: orgName,
                trialEndDate: org.trialEndDate,
                daysRemaining: daysRemaining,
                urgency: 'high'
              });
            } else if (trialEndDate <= in7Days) {
              this.report.validation.trialExpiringIn7Days++;
              this.report.details.expiringTrials.push({
                organizationId: orgId,
                name: orgName,
                trialEndDate: org.trialEndDate,
                daysRemaining: daysRemaining,
                urgency: 'medium'
              });
            }
            
          } else {
            // Trial expiré
            this.report.validation.organizationsWithExpiredTrial++;
            this.report.details.expiredTrials.push({
              organizationId: orgId,
              name: orgName,
              trialStartDate: org.trialStartDate,
              trialEndDate: org.trialEndDate,
              daysExpired: Math.ceil((now - trialEndDate) / (24 * 60 * 60 * 1000))
            });
          }
          
        } else {
          // Pas de trial actif et pas d'abonnement
          this.report.validation.organizationsWithoutTrialOrSubscription++;
          this.report.details.noTrialOrSubscription.push({
            organizationId: orgId,
            name: orgName,
            hasUsedTrial: org.hasUsedTrial || false,
            reason: org.hasUsedTrial ? 'Trial déjà utilisé' : 'Aucun trial configuré'
          });
        }
      }
      
      // Détecter les problèmes potentiels
      await this.detectIssues();
      
    } catch (error) {
      console.error('❌ Erreur lors de la validation:', error.message);
      throw error;
    }
  }

  async detectIssues() {
    // Vérifier les incohérences
    
    // 1. Organisations avec isTrialActive=true mais sans trialEndDate
    const inconsistentTrials = await this.db.collection('organization').find({
      isTrialActive: true,
      trialEndDate: { $exists: false }
    }).toArray();
    
    if (inconsistentTrials.length > 0) {
      this.report.issues.push({
        type: 'inconsistent_trial_data',
        severity: 'high',
        count: inconsistentTrials.length,
        description: 'Organisations avec isTrialActive=true mais sans trialEndDate',
        organizations: inconsistentTrials.map(org => ({
          id: org._id.toString(),
          name: org.companyName
        }))
      });
    }
    
    // 2. Organisations avec trialEndDate dans le passé mais isTrialActive=true
    const expiredButActive = await this.db.collection('organization').find({
      isTrialActive: true,
      trialEndDate: { $lt: new Date() }
    }).toArray();
    
    if (expiredButActive.length > 0) {
      this.report.issues.push({
        type: 'expired_but_active',
        severity: 'medium',
        count: expiredButActive.length,
        description: 'Organisations avec trial expiré mais encore marqué comme actif',
        organizations: expiredButActive.map(org => ({
          id: org._id.toString(),
          name: org.companyName,
          trialEndDate: org.trialEndDate
        }))
      });
    }
    
    // 3. Organisations sans abonnement et sans trial
    if (this.report.validation.organizationsWithoutTrialOrSubscription > 0) {
      this.report.issues.push({
        type: 'no_access',
        severity: 'low',
        count: this.report.validation.organizationsWithoutTrialOrSubscription,
        description: 'Organisations sans abonnement ni trial actif'
      });
    }
  }

  printReport() {
    console.log('\n📊 RAPPORT DE VALIDATION');
    console.log('========================');
    
    const v = this.report.validation;
    
    console.log(`📋 Total organisations: ${v.totalOrganizations}`);
    console.log(`💳 Avec abonnement actif: ${v.organizationsWithActiveSubscription}`);
    console.log(`🎯 Avec trial actif: ${v.organizationsWithActiveTrial}`);
    console.log(`⏰ Avec trial expiré: ${v.organizationsWithExpiredTrial}`);
    console.log(`❌ Sans trial ni abonnement: ${v.organizationsWithoutTrialOrSubscription}`);
    
    if (v.trialExpiringIn3Days > 0) {
      console.log(`🚨 Trials expirant dans 3 jours: ${v.trialExpiringIn3Days}`);
    }
    
    if (v.trialExpiringIn7Days > 0) {
      console.log(`⚠️  Trials expirant dans 7 jours: ${v.trialExpiringIn7Days}`);
    }
    
    // Afficher les trials actifs
    if (this.report.details.activeTrials.length > 0) {
      console.log('\n✅ TRIALS ACTIFS:');
      this.report.details.activeTrials.forEach(trial => {
        console.log(`  - ${trial.name}: ${trial.daysRemaining} jours restants`);
      });
    }
    
    // Afficher les trials expirant bientôt
    if (this.report.details.expiringTrials.length > 0) {
      console.log('\n⚠️  TRIALS EXPIRANT BIENTÔT:');
      this.report.details.expiringTrials.forEach(trial => {
        const urgencyIcon = trial.urgency === 'high' ? '🚨' : '⚠️';
        console.log(`  ${urgencyIcon} ${trial.name}: ${trial.daysRemaining} jours restants`);
      });
    }
    
    // Afficher les problèmes détectés
    if (this.report.issues.length > 0) {
      console.log('\n🔍 PROBLÈMES DÉTECTÉS:');
      this.report.issues.forEach(issue => {
        const severityIcon = issue.severity === 'high' ? '🚨' : issue.severity === 'medium' ? '⚠️' : 'ℹ️';
        console.log(`  ${severityIcon} ${issue.description} (${issue.count})`);
      });
    } else {
      console.log('\n✅ Aucun problème détecté');
    }
  }

  async saveReport() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportsDir = path.join(__dirname, '..', 'reports');
    
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const reportFile = path.join(reportsDir, `trial-validation-${timestamp}.json`);
    
    try {
      fs.writeFileSync(reportFile, JSON.stringify(this.report, null, 2));
      console.log(`\n💾 Rapport sauvegardé: ${reportFile}`);
      return reportFile;
    } catch (error) {
      console.error('❌ Erreur sauvegarde rapport:', error.message);
      throw error;
    }
  }
}

async function main() {
  // Charger la configuration en premier
  await loadConfig();
  
  const service = new TrialValidationService();
  
  try {
    await service.connect();
    await service.validateTrialActivation();
    service.printReport();
    await service.saveReport();
    
    console.log('\n✅ Validation terminée avec succès!');
    
  } catch (error) {
    console.error('\n❌ Erreur fatale:', error.message);
    process.exit(1);
  } finally {
    await service.disconnect();
  }
}

// Vérifier si le script est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { TrialValidationService };
