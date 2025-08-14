#!/usr/bin/env node

/**
 * Script de migration pour backfill les workspaceId dans les modèles existants
 * 
 * Ce script :
 * 1. Récupère tous les utilisateurs et leurs organisations Better Auth
 * 2. Met à jour tous les documents existants avec le bon workspaceId
 * 3. Valide l'intégrité des données après migration
 * 
 * Usage: node scripts/migrate-workspace-ids.js [--dry-run] [--batch-size=1000]
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
const BATCH_SIZE = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 1000;
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Statistiques de migration
const stats = {
  users: { total: 0, migrated: 0, errors: 0 },
  invoices: { total: 0, migrated: 0, errors: 0 },
  expenses: { total: 0, migrated: 0, errors: 0 },
  events: { total: 0, migrated: 0, errors: 0 },
  transactions: { total: 0, migrated: 0, errors: 0 },
  bridgeAccounts: { total: 0, migrated: 0, errors: 0 },
  ocrDocuments: { total: 0, migrated: 0, errors: 0 },
  emailSignatures: { total: 0, migrated: 0, errors: 0 },
  documentSettings: { total: 0, migrated: 0, errors: 0 },
  quotes: { total: 0, migrated: 0, errors: 0 },
  boards: { total: 0, migrated: 0, errors: 0 },
  columns: { total: 0, migrated: 0, errors: 0 },
  tasks: { total: 0, migrated: 0, errors: 0 }
};

/**
 * Récupère les organisations d'un utilisateur via Better Auth API
 */
async function getUserOrganizations(userEmail) {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    // Simuler une session pour récupérer les organisations
    // En production, vous devrez adapter cette logique selon votre API Better Auth
    const response = await fetch(`${frontendUrl}/api/auth/admin/user-organizations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ADMIN_API_KEY}` // Clé API admin
      },
      body: JSON.stringify({ email: userEmail })
    });
    
    if (!response.ok) {
      console.warn(`Impossible de récupérer les organisations pour ${userEmail}`);
      return null;
    }
    
    const organizations = await response.json();
    
    // Retourner la première organisation (organisation principale de l'utilisateur)
    return organizations && organizations.length > 0 ? organizations[0].id : null;
    
  } catch (error) {
    console.warn(`Erreur lors de la récupération des organisations pour ${userEmail}:`, error.message);
    return null;
  }
}

/**
 * Crée un mapping utilisateur -> workspaceId
 */
async function createUserWorkspaceMapping() {
  console.log('📋 Création du mapping utilisateur -> workspace...');
  
  const users = await User.find({ isDisabled: { $ne: true } }).lean();
  const userWorkspaceMap = new Map();
  
  stats.users.total = users.length;
  
  for (const user of users) {
    try {
      // Récupérer l'organisation principale de l'utilisateur
      const workspaceId = await getUserOrganizations(user.email);
      
      if (workspaceId) {
        userWorkspaceMap.set(user._id.toString(), workspaceId);
        stats.users.migrated++;
        
        if (VERBOSE) {
          console.log(`✅ ${user.email} -> workspace ${workspaceId}`);
        }
      } else {
        console.warn(`⚠️  Aucun workspace trouvé pour ${user.email}`);
        stats.users.errors++;
      }
      
    } catch (error) {
      console.error(`❌ Erreur pour ${user.email}:`, error.message);
      stats.users.errors++;
    }
  }
  
  console.log(`📊 Mapping créé: ${userWorkspaceMap.size} utilisateurs mappés sur ${users.length}`);
  return userWorkspaceMap;
}

/**
 * Migre un modèle spécifique
 */
async function migrateModel(Model, modelName, userField, userWorkspaceMap) {
  console.log(`\n🔄 Migration du modèle ${modelName}...`);
  
  // Compter les documents sans workspaceId
  const totalCount = await Model.countDocuments({ workspaceId: { $exists: false } });
  stats[modelName].total = totalCount;
  
  if (totalCount === 0) {
    console.log(`✅ Aucun document à migrer pour ${modelName}`);
    return;
  }
  
  console.log(`📊 ${totalCount} documents à migrer pour ${modelName}`);
  
  let processed = 0;
  let migrated = 0;
  let errors = 0;
  
  // Traitement par batch
  while (processed < totalCount) {
    const documents = await Model.find({ workspaceId: { $exists: false } })
      .limit(BATCH_SIZE)
      .lean();
    
    if (documents.length === 0) break;
    
    const bulkOps = [];
    
    for (const doc of documents) {
      const userId = doc[userField]?.toString();
      const workspaceId = userWorkspaceMap.get(userId);
      
      if (workspaceId) {
        if (!DRY_RUN) {
          bulkOps.push({
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { workspaceId: new mongoose.Types.ObjectId(workspaceId) } }
            }
          });
        }
        migrated++;
      } else {
        console.warn(`⚠️  Workspace non trouvé pour ${modelName} ${doc._id} (user: ${userId})`);
        errors++;
      }
    }
    
    // Exécuter les mises à jour en batch
    if (bulkOps.length > 0 && !DRY_RUN) {
      try {
        await Model.bulkWrite(bulkOps);
      } catch (error) {
        console.error(`❌ Erreur lors de la mise à jour batch pour ${modelName}:`, error.message);
        errors += bulkOps.length;
        migrated -= bulkOps.length;
      }
    }
    
    processed += documents.length;
    
    if (VERBOSE || processed % (BATCH_SIZE * 5) === 0) {
      console.log(`📈 ${modelName}: ${processed}/${totalCount} traités (${migrated} migrés, ${errors} erreurs)`);
    }
  }
  
  stats[modelName].migrated = migrated;
  stats[modelName].errors = errors;
  
  console.log(`✅ ${modelName} terminé: ${migrated} migrés, ${errors} erreurs`);
}

/**
 * Valide l'intégrité des données après migration
 */
async function validateMigration() {
  console.log('\n🔍 Validation de l\'intégrité des données...');
  
  const models = [
    { Model: Invoice, name: 'invoices' },
    { Model: Expense, name: 'expenses' },
    { Model: Event, name: 'events' },
    { Model: Transaction, name: 'transactions' },
    { Model: BridgeAccount, name: 'bridgeAccounts' },
    { Model: OcrDocument, name: 'ocrDocuments' },
    { Model: EmailSignature, name: 'emailSignatures' },
    { Model: DocumentSettings, name: 'documentSettings' },
    { Model: Quote, name: 'quotes' },
    { Model: Board, name: 'boards' },
    { Model: Column, name: 'columns' },
    { Model: Task, name: 'tasks' }
  ];
  
  for (const { Model, name } of models) {
    const withoutWorkspace = await Model.countDocuments({ workspaceId: { $exists: false } });
    const withWorkspace = await Model.countDocuments({ workspaceId: { $exists: true } });
    
    console.log(`📊 ${name}: ${withWorkspace} avec workspaceId, ${withoutWorkspace} sans workspaceId`);
    
    if (withoutWorkspace > 0) {
      console.warn(`⚠️  ${withoutWorkspace} documents ${name} n'ont pas de workspaceId`);
    }
  }
}

/**
 * Affiche les statistiques finales
 */
function displayStats() {
  console.log('\n📈 STATISTIQUES DE MIGRATION');
  console.log('=' .repeat(50));
  
  let totalMigrated = 0;
  let totalErrors = 0;
  
  for (const [modelName, modelStats] of Object.entries(stats)) {
    if (modelStats.total > 0) {
      console.log(`${modelName.padEnd(20)}: ${modelStats.migrated}/${modelStats.total} migrés (${modelStats.errors} erreurs)`);
      totalMigrated += modelStats.migrated;
      totalErrors += modelStats.errors;
    }
  }
  
  console.log('=' .repeat(50));
  console.log(`TOTAL: ${totalMigrated} documents migrés, ${totalErrors} erreurs`);
  
  if (DRY_RUN) {
    console.log('\n🔍 MODE DRY-RUN: Aucune modification n\'a été effectuée');
  }
}

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🚀 DÉMARRAGE DE LA MIGRATION WORKSPACE');
    console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'PRODUCTION'}`);
    console.log(`Batch size: ${BATCH_SIZE}`);
    console.log('=' .repeat(50));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    // Étape 1: Créer le mapping utilisateur -> workspace
    const userWorkspaceMap = await createUserWorkspaceMapping();
    
    if (userWorkspaceMap.size === 0) {
      console.error('❌ Aucun mapping utilisateur -> workspace créé. Arrêt de la migration.');
      process.exit(1);
    }
    
    // Étape 2: Migrer chaque modèle
    await migrateModel(Invoice, 'invoices', 'createdBy', userWorkspaceMap);
    await migrateModel(Expense, 'expenses', 'createdBy', userWorkspaceMap);
    await migrateModel(Event, 'events', 'userId', userWorkspaceMap);
    await migrateModel(Transaction, 'transactions', 'userId', userWorkspaceMap);
    await migrateModel(BridgeAccount, 'bridgeAccounts', 'userId', userWorkspaceMap);
    await migrateModel(OcrDocument, 'ocrDocuments', 'userId', userWorkspaceMap);
    await migrateModel(EmailSignature, 'emailSignatures', 'createdBy', userWorkspaceMap);
    await migrateModel(DocumentSettings, 'documentSettings', 'createdBy', userWorkspaceMap);
    await migrateModel(Quote, 'quotes', 'createdBy', userWorkspaceMap);
    await migrateModel(Board, 'boards', 'userId', userWorkspaceMap);
    await migrateModel(Column, 'columns', 'userId', userWorkspaceMap);
    await migrateModel(Task, 'tasks', 'userId', userWorkspaceMap);
    
    // Étape 3: Validation
    if (!DRY_RUN) {
      await validateMigration();
    }
    
    // Étape 4: Statistiques
    displayStats();
    
    console.log('\n🎉 MIGRATION TERMINÉE AVEC SUCCÈS');
    
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

export { main as migrateworkspaceIds };
