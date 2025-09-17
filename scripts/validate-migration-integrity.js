#!/usr/bin/env node

/**
 * Script de validation de l'intégrité des données après migration
 * 
 * Ce script :
 * 1. Vérifie la cohérence des données utilisateur entre Users et user
 * 2. Valide que tous les documents ont un workspaceId valide
 * 3. Vérifie l'intégrité des organisations et membres
 * 4. Génère un rapport détaillé de validation
 * 
 * Usage: node scripts/validate-migration-integrity.js [--detailed] [--fix-issues]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import path from 'path';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  try {
    await fs.access(ecosystemPath);
    console.log('📄 Chargement des variables depuis ecosystem.config.cjs');
    
    // Importer dynamiquement le fichier ecosystem
    const ecosystemConfig = await import(`file://${ecosystemPath}`);
    const config = ecosystemConfig.default;
    
    if (config && config.apps && config.apps[0] && config.apps[0].env) {
      // Appliquer les variables d'environnement
      Object.assign(process.env, config.apps[0].env);
      
      // Si env_production existe, l'utiliser aussi
      if (config.apps[0].env_production) {
        Object.assign(process.env, config.apps[0].env_production);
      }
      
      console.log('✅ Variables d\'environnement chargées depuis ecosystem.config.cjs');
      return true;
    }
  } catch (error) {
    console.log('⚠️  Impossible de charger ecosystem.config.cjs:', error.message);
  }
  
  return false;
}

// Charger les variables d'environnement
dotenv.config({ path: join(__dirname, '../.env') });
await loadEcosystemConfig();

// Import des modèles
import User from '../src/models/User.js';
import Invoice from '../src/models/Invoice.js';
import Expense from '../src/models/Expense.js';
import Event from '../src/models/Event.js';
import Transaction from '../src/models/Transaction.js';
import Quote from '../src/models/Quote.js';
import Client from '../src/models/Client.js';
import CreditNote from '../src/models/CreditNote.js';

// Configuration du script
const DETAILED = process.argv.includes('--detailed');
const FIX_ISSUES = process.argv.includes('--fix-issues');

// Résultats de validation
const validationResults = {
  users: {
    oldCollection: { count: 0, emails: [] },
    newCollection: { count: 0, emails: [] },
    missing: [],
    duplicates: [],
    issues: []
  },
  organizations: {
    count: 0,
    orphaned: [],
    missingMetadata: [],
    issues: []
  },
  members: {
    count: 0,
    orphaned: [],
    invalidRoles: [],
    issues: []
  },
  workspaces: {
    validMappings: 0,
    invalidMappings: 0,
    orphanedDocuments: [],
    issues: []
  },
  models: {}
};

/**
 * Valide les utilisateurs
 */
async function validateUsers(db) {
  console.log('🔍 Validation des utilisateurs...');
  
  try {
    // Compter les utilisateurs dans l'ancienne collection
    const oldUsersCount = await db.collection('Users').countDocuments().catch(() => 0);
    const oldUsers = oldUsersCount > 0 ? await db.collection('Users').find({}, { projection: { email: 1 } }).toArray() : [];
    
    validationResults.users.oldCollection.count = oldUsersCount;
    validationResults.users.oldCollection.emails = oldUsers.map(u => u.email);
    
    // Compter les utilisateurs dans la nouvelle collection
    const newUsersCount = await db.collection('user').countDocuments();
    const newUsers = await db.collection('user').find({}, { projection: { email: 1 } }).toArray();
    
    validationResults.users.newCollection.count = newUsersCount;
    validationResults.users.newCollection.emails = newUsers.map(u => u.email);
    
    // Vérifier les utilisateurs manquants
    const oldEmails = new Set(validationResults.users.oldCollection.emails);
    const newEmails = new Set(validationResults.users.newCollection.emails);
    
    validationResults.users.missing = [...oldEmails].filter(email => !newEmails.has(email));
    
    // Vérifier les doublons
    const emailCounts = {};
    newUsers.forEach(user => {
      emailCounts[user.email] = (emailCounts[user.email] || 0) + 1;
    });
    
    validationResults.users.duplicates = Object.entries(emailCounts)
      .filter(([email, count]) => count > 1)
      .map(([email, count]) => ({ email, count }));
    
    console.log(`📊 Utilisateurs: ${oldUsersCount} anciens, ${newUsersCount} nouveaux`);
    
    if (validationResults.users.missing.length > 0) {
      console.warn(`⚠️  ${validationResults.users.missing.length} utilisateurs manquants dans la nouvelle collection`);
      validationResults.users.issues.push(`${validationResults.users.missing.length} utilisateurs manquants`);
    }
    
    if (validationResults.users.duplicates.length > 0) {
      console.warn(`⚠️  ${validationResults.users.duplicates.length} emails dupliqués détectés`);
      validationResults.users.issues.push(`${validationResults.users.duplicates.length} emails dupliqués`);
    }
    
  } catch (error) {
    console.error('❌ Erreur validation utilisateurs:', error.message);
    validationResults.users.issues.push(`Erreur validation: ${error.message}`);
  }
}

/**
 * Valide les organisations
 */
async function validateOrganizations(db) {
  console.log('🔍 Validation des organisations...');
  
  try {
    const organizations = await db.collection('organization').find({}).toArray();
    validationResults.organizations.count = organizations.length;
    
    for (const org of organizations) {
      // Vérifier les métadonnées essentielles
      const requiredFields = ['companyName', 'companyEmail'];
      const missingFields = requiredFields.filter(field => !org.metadata || !org.metadata[field]);
      
      if (missingFields.length > 0) {
        validationResults.organizations.missingMetadata.push({
          id: org._id,
          name: org.name,
          missingFields
        });
      }
      
      // Vérifier si l'organisation a au moins un membre
      const memberCount = await db.collection('member').countDocuments({ organizationId: org._id });
      if (memberCount === 0) {
        validationResults.organizations.orphaned.push({
          id: org._id,
          name: org.name
        });
      }
    }
    
    console.log(`📊 Organisations: ${organizations.length} trouvées`);
    
    if (validationResults.organizations.orphaned.length > 0) {
      console.warn(`⚠️  ${validationResults.organizations.orphaned.length} organisations sans membres`);
      validationResults.organizations.issues.push(`${validationResults.organizations.orphaned.length} organisations orphelines`);
    }
    
    if (validationResults.organizations.missingMetadata.length > 0) {
      console.warn(`⚠️  ${validationResults.organizations.missingMetadata.length} organisations avec métadonnées manquantes`);
      validationResults.organizations.issues.push(`${validationResults.organizations.missingMetadata.length} métadonnées manquantes`);
    }
    
  } catch (error) {
    console.error('❌ Erreur validation organisations:', error.message);
    validationResults.organizations.issues.push(`Erreur validation: ${error.message}`);
  }
}

/**
 * Valide les membres
 */
async function validateMembers(db) {
  console.log('🔍 Validation des membres...');
  
  try {
    const members = await db.collection('member').find({}).toArray();
    validationResults.members.count = members.length;
    
    const validRoles = ['owner', 'admin', 'member'];
    
    for (const member of members) {
      // Vérifier le rôle
      if (!validRoles.includes(member.role)) {
        validationResults.members.invalidRoles.push({
          id: member._id,
          userId: member.userId,
          role: member.role
        });
      }
      
      // Vérifier si l'organisation existe
      const orgExists = await db.collection('organization').countDocuments({ _id: member.organizationId });
      if (orgExists === 0) {
        validationResults.members.orphaned.push({
          id: member._id,
          userId: member.userId,
          organizationId: member.organizationId
        });
      }
      
      // Vérifier si l'utilisateur existe
      const userExists = await db.collection('user').countDocuments({ _id: member.userId });
      if (userExists === 0) {
        validationResults.members.orphaned.push({
          id: member._id,
          userId: member.userId,
          reason: 'user_not_found'
        });
      }
    }
    
    console.log(`📊 Membres: ${members.length} trouvés`);
    
    if (validationResults.members.orphaned.length > 0) {
      console.warn(`⚠️  ${validationResults.members.orphaned.length} membres orphelins`);
      validationResults.members.issues.push(`${validationResults.members.orphaned.length} membres orphelins`);
    }
    
    if (validationResults.members.invalidRoles.length > 0) {
      console.warn(`⚠️  ${validationResults.members.invalidRoles.length} rôles invalides`);
      validationResults.members.issues.push(`${validationResults.members.invalidRoles.length} rôles invalides`);
    }
    
  } catch (error) {
    console.error('❌ Erreur validation membres:', error.message);
    validationResults.members.issues.push(`Erreur validation: ${error.message}`);
  }
}

/**
 * Valide les workspaceId des modèles
 */
async function validateWorkspaceIds(db) {
  console.log('🔍 Validation des workspaceId...');
  
  const models = [
    { Model: Invoice, name: 'invoices', userField: 'createdBy' },
    { Model: Expense, name: 'expenses', userField: 'createdBy' },
    { Model: Event, name: 'events', userField: 'userId' },
    { Model: Transaction, name: 'transactions', userField: 'userId' },
    { Model: Quote, name: 'quotes', userField: 'createdBy' },
    { Model: Client, name: 'clients', userField: 'createdBy' },
    { Model: CreditNote, name: 'creditNotes', userField: 'createdBy' }
  ];
  
  // Créer un mapping userId -> organizationId
  const members = await db.collection('member').find({}).toArray();
  const userOrgMap = new Map();
  members.forEach(member => {
    userOrgMap.set(member.userId.toString(), member.organizationId.toString());
  });
  
  for (const { Model, name, userField } of models) {
    try {
      console.log(`  🔍 Validation ${name}...`);
      
      const totalDocs = await Model.countDocuments();
      const docsWithWorkspace = await Model.countDocuments({ 
        workspaceId: { $exists: true, $ne: null } 
      });
      const docsWithoutWorkspace = totalDocs - docsWithWorkspace;
      
      validationResults.models[name] = {
        total: totalDocs,
        withWorkspace: docsWithWorkspace,
        withoutWorkspace: docsWithoutWorkspace,
        invalidWorkspaces: 0,
        orphanedDocuments: [],
        issues: []
      };
      
      // Vérifier les documents sans workspaceId
      if (docsWithoutWorkspace > 0) {
        const orphanedDocs = await Model.find({ 
          $or: [
            { workspaceId: { $exists: false } },
            { workspaceId: null }
          ]
        }, { _id: 1, [userField]: 1 }).lean();
        
        validationResults.models[name].orphanedDocuments = orphanedDocs.map(doc => ({
          id: doc._id,
          userId: doc[userField]
        }));
        
        validationResults.models[name].issues.push(`${docsWithoutWorkspace} documents sans workspaceId`);
      }
      
      // Vérifier la cohérence des workspaceId
      const docsWithWorkspaceIds = await Model.find({ 
        workspaceId: { $exists: true, $ne: null } 
      }, { _id: 1, workspaceId: 1, [userField]: 1 }).lean();
      
      let invalidWorkspaces = 0;
      
      for (const doc of docsWithWorkspaceIds) {
        const userId = doc[userField]?.toString();
        const expectedOrgId = userOrgMap.get(userId);
        const actualOrgId = doc.workspaceId?.toString();
        
        if (expectedOrgId && actualOrgId !== expectedOrgId) {
          invalidWorkspaces++;
        }
      }
      
      validationResults.models[name].invalidWorkspaces = invalidWorkspaces;
      
      if (invalidWorkspaces > 0) {
        validationResults.models[name].issues.push(`${invalidWorkspaces} workspaceId incohérents`);
      }
      
      console.log(`    📊 ${name}: ${docsWithWorkspace}/${totalDocs} avec workspaceId, ${invalidWorkspaces} incohérents`);
      
    } catch (error) {
      console.error(`❌ Erreur validation ${name}:`, error.message);
      validationResults.models[name] = {
        total: 0,
        withWorkspace: 0,
        withoutWorkspace: 0,
        invalidWorkspaces: 0,
        orphanedDocuments: [],
        issues: [`Erreur validation: ${error.message}`]
      };
    }
  }
  
  // Calculer les totaux
  const totalValid = Object.values(validationResults.models).reduce((sum, model) => sum + model.withWorkspace - model.invalidWorkspaces, 0);
  const totalInvalid = Object.values(validationResults.models).reduce((sum, model) => sum + model.withoutWorkspace + model.invalidWorkspaces, 0);
  
  validationResults.workspaces.validMappings = totalValid;
  validationResults.workspaces.invalidMappings = totalInvalid;
  
  if (totalInvalid > 0) {
    validationResults.workspaces.issues.push(`${totalInvalid} documents avec workspaceId invalide ou manquant`);
  }
}

/**
 * Génère un rapport de validation
 */
async function generateValidationReport() {
  console.log('📊 Génération du rapport de validation...');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(__dirname, `../validation_report_${timestamp}.json`);
  
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalIssues: 0,
      criticalIssues: 0,
      warnings: 0
    },
    details: validationResults
  };
  
  // Calculer les statistiques du résumé
  Object.values(validationResults).forEach(section => {
    if (section.issues) {
      report.summary.totalIssues += section.issues.length;
    }
    if (section.models) {
      Object.values(section.models).forEach(model => {
        if (model.issues) {
          report.summary.totalIssues += model.issues.length;
        }
      });
    }
  });
  
  // Déterminer la criticité
  if (validationResults.users.missing.length > 0 || validationResults.workspaces.invalidMappings > 0) {
    report.summary.criticalIssues = 1;
  }
  
  report.summary.warnings = report.summary.totalIssues - report.summary.criticalIssues;
  
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  
  console.log(`📄 Rapport sauvegardé: ${reportPath}`);
  return report;
}

/**
 * Affiche le résumé de validation
 */
function displayValidationSummary(report) {
  console.log('\n📈 RÉSUMÉ DE VALIDATION');
  console.log('=' .repeat(60));
  
  // Statut général
  const isValid = report.summary.criticalIssues === 0;
  console.log(`Statut: ${isValid ? '✅ VALIDE' : '❌ PROBLÈMES CRITIQUES DÉTECTÉS'}`);
  console.log(`Issues totales: ${report.summary.totalIssues}`);
  console.log(`Issues critiques: ${report.summary.criticalIssues}`);
  console.log(`Avertissements: ${report.summary.warnings}`);
  
  console.log('\n📊 DÉTAILS PAR SECTION:');
  
  // Utilisateurs
  console.log(`\nUtilisateurs:`);
  console.log(`  - Anciens: ${validationResults.users.oldCollection.count}`);
  console.log(`  - Nouveaux: ${validationResults.users.newCollection.count}`);
  console.log(`  - Manquants: ${validationResults.users.missing.length}`);
  console.log(`  - Doublons: ${validationResults.users.duplicates.length}`);
  
  // Organisations
  console.log(`\nOrganisations:`);
  console.log(`  - Total: ${validationResults.organizations.count}`);
  console.log(`  - Orphelines: ${validationResults.organizations.orphaned.length}`);
  console.log(`  - Métadonnées manquantes: ${validationResults.organizations.missingMetadata.length}`);
  
  // Membres
  console.log(`\nMembres:`);
  console.log(`  - Total: ${validationResults.members.count}`);
  console.log(`  - Orphelins: ${validationResults.members.orphaned.length}`);
  console.log(`  - Rôles invalides: ${validationResults.members.invalidRoles.length}`);
  
  // WorkspaceId
  console.log(`\nWorkspaceId:`);
  console.log(`  - Mappings valides: ${validationResults.workspaces.validMappings}`);
  console.log(`  - Mappings invalides: ${validationResults.workspaces.invalidMappings}`);
  
  // Modèles
  console.log(`\nModèles:`);
  Object.entries(validationResults.models).forEach(([name, stats]) => {
    console.log(`  - ${name}: ${stats.withWorkspace}/${stats.total} avec workspaceId (${stats.withoutWorkspace} manquants, ${stats.invalidWorkspaces} invalides)`);
  });
  
  if (DETAILED && report.summary.totalIssues > 0) {
    console.log('\n⚠️  ISSUES DÉTAILLÉES:');
    
    if (validationResults.users.missing.length > 0) {
      console.log(`\nUtilisateurs manquants: ${validationResults.users.missing.join(', ')}`);
    }
    
    if (validationResults.users.duplicates.length > 0) {
      console.log(`\nEmails dupliqués:`);
      validationResults.users.duplicates.forEach(dup => {
        console.log(`  - ${dup.email}: ${dup.count} occurrences`);
      });
    }
  }
}

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🚀 DÉMARRAGE DE LA VALIDATION DE MIGRATION');
    console.log(`Mode détaillé: ${DETAILED ? 'OUI' : 'NON'}`);
    console.log(`Correction automatique: ${FIX_ISSUES ? 'OUI' : 'NON'}`);
    console.log('=' .repeat(60));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    const db = mongoose.connection.db;
    
    // Étapes de validation
    await validateUsers(db);
    await validateOrganizations(db);
    await validateMembers(db);
    await validateWorkspaceIds(db);
    
    // Génération du rapport
    const report = await generateValidationReport();
    
    // Affichage du résumé
    displayValidationSummary(report);
    
    const isValid = report.summary.criticalIssues === 0;
    
    if (isValid) {
      console.log('\n🎉 VALIDATION RÉUSSIE - MIGRATION INTÈGRE');
    } else {
      console.log('\n❌ VALIDATION ÉCHOUÉE - PROBLÈMES CRITIQUES DÉTECTÉS');
      console.log('\nActions recommandées:');
      console.log('1. Examinez le rapport détaillé généré');
      console.log('2. Corrigez les problèmes critiques');
      console.log('3. Relancez la validation');
      console.log('4. Considérez un rollback si nécessaire');
    }
    
  } catch (error) {
    console.error('❌ ERREUR FATALE:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('✅ Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as validateMigrationIntegrity };
