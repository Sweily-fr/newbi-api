#!/usr/bin/env node

/**
 * Script de validation pour vérifier l'intégrité des données après migration workspace
 * 
 * Ce script :
 * 1. Vérifie que tous les documents ont un workspaceId valide
 * 2. Contrôle la cohérence des données entre utilisateurs et workspaces
 * 3. Détecte les données orphelines ou incohérentes
 * 4. Génère un rapport détaillé
 * 
 * Usage: node scripts/validate-migration.js [--fix-orphans] [--verbose]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

// Import des modèles
import User from '../src/models/User.js';
import Invoice from '../src/models/Invoice.js';
import Expense from '../src/models/Expense.js';
import Event from '../src/models/Event.js';
import Transaction from '../src/models/Transaction.js';
import BridgeAccount from '../src/models/BridgeAccount.js';
import OcrDocument from '../src/models/OcrDocument.js';
import EmailSignature from '../src/models/EmailSignature.js';
import DocumentSettings from '../src/models/DocumentSettings.js';
import Quote from '../src/models/Quote.js';

// Import des modèles Kanban
import kanbanModels from '../src/models/kanban.js';
const { Board, Column, Task } = kanbanModels;

// Configuration du script
const FIX_ORPHANS = process.argv.includes('--fix-orphans');
const VERBOSE = process.argv.includes('--verbose');

// Rapport de validation
const report = {
  summary: {
    totalModels: 0,
    validModels: 0,
    modelsWithIssues: 0,
    totalDocuments: 0,
    validDocuments: 0,
    orphanedDocuments: 0,
    fixedOrphans: 0
  },
  models: {},
  issues: [],
  recommendations: []
};

/**
 * Valide un modèle spécifique
 */
async function validateModel(Model, modelName, userField = 'createdBy') {
  console.log(`\n🔍 Validation du modèle ${modelName}...`);
  
  const modelReport = {
    name: modelName,
    total: 0,
    withWorkspaceId: 0,
    withoutWorkspaceId: 0,
    validWorkspaceId: 0,
    invalidWorkspaceId: 0,
    orphanedDocuments: 0,
    userMismatch: 0,
    issues: []
  };
  
  // Compter tous les documents
  modelReport.total = await Model.countDocuments({});
  report.summary.totalDocuments += modelReport.total;
  
  if (modelReport.total === 0) {
    console.log(`✅ ${modelName}: Aucun document (OK)`);
    report.models[modelName] = modelReport;
    return;
  }
  
  // Compter les documents avec/sans workspaceId
  modelReport.withWorkspaceId = await Model.countDocuments({ workspaceId: { $exists: true, $ne: null } });
  modelReport.withoutWorkspaceId = await Model.countDocuments({ 
    $or: [
      { workspaceId: { $exists: false } },
      { workspaceId: null }
    ]
  });
  
  // Vérifier la validité des workspaceId (format ObjectId)
  const documentsWithInvalidWorkspaceId = await Model.find({
    workspaceId: { $exists: true, $ne: null, $not: { $type: "objectId" } }
  }).lean();
  
  modelReport.invalidWorkspaceId = documentsWithInvalidWorkspaceId.length;
  modelReport.validWorkspaceId = modelReport.withWorkspaceId - modelReport.invalidWorkspaceId;
  
  // Vérifier la cohérence utilisateur <-> workspace
  if (userField) {
    const pipeline = [
      {
        $match: { 
          workspaceId: { $exists: true, $ne: null },
          [userField]: { $exists: true, $ne: null }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: userField,
          foreignField: '_id',
          as: 'user'
        }
      },
      {
        $match: {
          'user': { $size: 0 } // Documents dont l'utilisateur n'existe pas
        }
      }
    ];
    
    const orphanedDocs = await Model.aggregate(pipeline);
    modelReport.orphanedDocuments = orphanedDocs.length;
    
    if (orphanedDocs.length > 0) {
      modelReport.issues.push(`${orphanedDocs.length} documents référencent des utilisateurs inexistants`);
      
      if (VERBOSE) {
        console.log(`⚠️  Documents orphelins trouvés dans ${modelName}:`);
        orphanedDocs.slice(0, 5).forEach(doc => {
          console.log(`   - ${doc._id} (user: ${doc[userField]})`);
        });
        if (orphanedDocs.length > 5) {
          console.log(`   ... et ${orphanedDocs.length - 5} autres`);
        }
      }
    }
  }
  
  // Ajouter les issues au rapport global
  if (modelReport.withoutWorkspaceId > 0) {
    const issue = `${modelName}: ${modelReport.withoutWorkspaceId} documents sans workspaceId`;
    modelReport.issues.push(issue);
    report.issues.push(issue);
  }
  
  if (modelReport.invalidWorkspaceId > 0) {
    const issue = `${modelName}: ${modelReport.invalidWorkspaceId} documents avec workspaceId invalide`;
    modelReport.issues.push(issue);
    report.issues.push(issue);
  }
  
  if (modelReport.orphanedDocuments > 0) {
    const issue = `${modelName}: ${modelReport.orphanedDocuments} documents orphelins`;
    modelReport.issues.push(issue);
    report.issues.push(issue);
  }
  
  // Statistiques
  report.summary.validDocuments += modelReport.validWorkspaceId;
  report.summary.orphanedDocuments += modelReport.orphanedDocuments;
  
  // Affichage des résultats
  const status = modelReport.issues.length === 0 ? '✅' : '⚠️';
  console.log(`${status} ${modelName}: ${modelReport.validWorkspaceId}/${modelReport.total} documents valides`);
  
  if (modelReport.issues.length > 0) {
    modelReport.issues.forEach(issue => console.log(`   - ${issue}`));
  }
  
  report.models[modelName] = modelReport;
}

/**
 * Vérifie la cohérence des index
 */
async function validateIndexes() {
  console.log('\n🔍 Validation des index...');
  
  const models = [
    { Model: Invoice, name: 'Invoice' },
    { Model: Expense, name: 'Expense' },
    { Model: Event, name: 'Event' },
    { Model: Transaction, name: 'Transaction' },
    { Model: BridgeAccount, name: 'BridgeAccount' },
    { Model: OcrDocument, name: 'OcrDocument' },
    { Model: EmailSignature, name: 'EmailSignature' },
    { Model: DocumentSettings, name: 'DocumentSettings' },
    { Model: Quote, name: 'Quote' },
    { Model: Board, name: 'Board' },
    { Model: Column, name: 'Column' },
    { Model: Task, name: 'Task' }
  ];
  
  for (const { Model, name } of models) {
    try {
      const indexes = await Model.collection.getIndexes();
      const hasWorkspaceIndex = Object.keys(indexes).some(indexName => 
        indexName.includes('workspaceId') || 
        JSON.stringify(indexes[indexName]).includes('workspaceId')
      );
      
      if (hasWorkspaceIndex) {
        console.log(`✅ ${name}: Index workspaceId présent`);
      } else {
        console.log(`⚠️  ${name}: Aucun index workspaceId trouvé`);
        report.issues.push(`${name}: Aucun index workspaceId trouvé`);
      }
      
    } catch (error) {
      console.log(`❌ ${name}: Erreur lors de la vérification des index - ${error.message}`);
      report.issues.push(`${name}: Erreur index - ${error.message}`);
    }
  }
}

/**
 * Vérifie les contraintes d'unicité
 */
async function validateUniqueConstraints() {
  console.log('\n🔍 Validation des contraintes d\'unicité...');
  
  // Vérifier les doublons de numéros de factures par workspace
  const invoiceDuplicates = await Invoice.aggregate([
    { $match: { workspaceId: { $exists: true } } },
    { $group: { _id: { workspaceId: '$workspaceId', number: '$number' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  
  if (invoiceDuplicates.length > 0) {
    console.log(`⚠️  ${invoiceDuplicates.length} doublons de numéros de factures détectés`);
    report.issues.push(`${invoiceDuplicates.length} doublons de numéros de factures par workspace`);
  } else {
    console.log('✅ Aucun doublon de numéros de factures');
  }
  
  // Vérifier les doublons de numéros de devis par workspace
  const quoteDuplicates = await Quote.aggregate([
    { $match: { workspaceId: { $exists: true } } },
    { $group: { _id: { workspaceId: '$workspaceId', number: '$number' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  
  if (quoteDuplicates.length > 0) {
    console.log(`⚠️  ${quoteDuplicates.length} doublons de numéros de devis détectés`);
    report.issues.push(`${quoteDuplicates.length} doublons de numéros de devis par workspace`);
  } else {
    console.log('✅ Aucun doublon de numéros de devis');
  }
}

/**
 * Génère des recommandations
 */
function generateRecommendations() {
  console.log('\n💡 Génération des recommandations...');
  
  if (report.summary.orphanedDocuments > 0) {
    report.recommendations.push(
      `Nettoyer ${report.summary.orphanedDocuments} documents orphelins avec --fix-orphans`
    );
  }
  
  if (report.issues.some(issue => issue.includes('sans workspaceId'))) {
    report.recommendations.push(
      'Relancer le script de migration pour les documents sans workspaceId'
    );
  }
  
  if (report.issues.some(issue => issue.includes('index'))) {
    report.recommendations.push(
      'Recréer les index manquants avec db.collection.createIndex()'
    );
  }
  
  if (report.issues.some(issue => issue.includes('doublon'))) {
    report.recommendations.push(
      'Résoudre les doublons avant d\'activer les contraintes d\'unicité'
    );
  }
  
  if (report.recommendations.length === 0) {
    report.recommendations.push('Aucune action requise - Migration réussie ! 🎉');
  }
}

/**
 * Affiche le rapport final
 */
function displayReport() {
  console.log('\n📊 RAPPORT DE VALIDATION');
  console.log('=' .repeat(60));
  
  // Résumé
  console.log('📈 RÉSUMÉ:');
  console.log(`   Documents totaux: ${report.summary.totalDocuments}`);
  console.log(`   Documents valides: ${report.summary.validDocuments}`);
  console.log(`   Documents orphelins: ${report.summary.orphanedDocuments}`);
  console.log(`   Issues détectées: ${report.issues.length}`);
  
  // Issues
  if (report.issues.length > 0) {
    console.log('\n⚠️  ISSUES DÉTECTÉES:');
    report.issues.forEach((issue, index) => {
      console.log(`   ${index + 1}. ${issue}`);
    });
  }
  
  // Recommandations
  console.log('\n💡 RECOMMANDATIONS:');
  report.recommendations.forEach((rec, index) => {
    console.log(`   ${index + 1}. ${rec}`);
  });
  
  // Statut global
  const isValid = report.issues.length === 0;
  console.log('\n' + '=' .repeat(60));
  console.log(isValid ? '✅ VALIDATION RÉUSSIE' : '⚠️  VALIDATION AVEC ISSUES');
  console.log('=' .repeat(60));
}

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🔍 DÉMARRAGE DE LA VALIDATION MIGRATION');
    console.log(`Mode: ${FIX_ORPHANS ? 'CORRECTION' : 'LECTURE SEULE'}`);
    console.log('=' .repeat(50));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    // Validation de chaque modèle
    await validateModel(Invoice, 'invoices', 'createdBy');
    await validateModel(Expense, 'expenses', 'createdBy');
    await validateModel(Event, 'events', 'userId');
    await validateModel(Transaction, 'transactions', 'userId');
    await validateModel(BridgeAccount, 'bridgeAccounts', 'userId');
    await validateModel(OcrDocument, 'ocrDocuments', 'userId');
    await validateModel(EmailSignature, 'emailSignatures', 'createdBy');
    await validateModel(DocumentSettings, 'documentSettings', 'createdBy');
    await validateModel(Quote, 'quotes', 'createdBy');
    await validateModel(Board, 'boards', 'userId');
    await validateModel(Column, 'columns', 'userId');
    await validateModel(Task, 'tasks', 'userId');
    
    // Validation des index
    await validateIndexes();
    
    // Validation des contraintes d'unicité
    await validateUniqueConstraints();
    
    // Génération des recommandations
    generateRecommendations();
    
    // Affichage du rapport
    displayReport();
    
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

export { main as validateMigration };
