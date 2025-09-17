#!/usr/bin/env node

/**
 * Script de rollback de la migration vers la nouvelle structure
 * 
 * Ce script :
 * 1. Supprime les workspaceId ajoutés aux documents
 * 2. Supprime les organisations et membres créés
 * 3. Supprime la collection "user" si elle a été créée
 * 4. Restaure l'état antérieur à la migration
 * 
 * Usage: node scripts/rollback-migration.js [--confirm] [--batch-size=100]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';
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
const BATCH_SIZE = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 100;
const CONFIRM = process.argv.includes('--confirm');

// Statistiques de rollback
const stats = {
  invoices: { total: 0, rolled: 0, errors: 0 },
  expenses: { total: 0, rolled: 0, errors: 0 },
  events: { total: 0, rolled: 0, errors: 0 },
  transactions: { total: 0, rolled: 0, errors: 0 },
  quotes: { total: 0, rolled: 0, errors: 0 },
  clients: { total: 0, rolled: 0, errors: 0 },
  creditNotes: { total: 0, rolled: 0, errors: 0 },
  organizations: { deleted: 0, errors: 0 },
  members: { deleted: 0, errors: 0 },
  users: { deleted: 0, errors: 0 }
};

/**
 * Demande confirmation à l'utilisateur
 */
async function askConfirmation() {
  if (CONFIRM) {
    return true;
  }
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question('⚠️  ATTENTION: Cette opération va annuler la migration et supprimer les données créées.\nÊtes-vous sûr de vouloir continuer? (tapez "CONFIRMER" pour continuer): ', (answer) => {
      rl.close();
      resolve(answer === 'CONFIRMER');
    });
  });
}

/**
 * Supprime les workspaceId d'un modèle
 */
async function removeWorkspaceIds(Model, modelName) {
  console.log(`\n🔄 Suppression des workspaceId pour ${modelName}...`);
  
  // Compter les documents avec workspaceId
  const totalCount = await Model.countDocuments({ 
    workspaceId: { $exists: true, $ne: null } 
  });
  
  stats[modelName].total = totalCount;
  
  if (totalCount === 0) {
    console.log(`✅ Aucun workspaceId à supprimer pour ${modelName}`);
    return;
  }
  
  console.log(`📊 ${totalCount} documents à traiter pour ${modelName}`);
  
  let processed = 0;
  let rolled = 0;
  let errors = 0;
  
  // Traitement par batch
  while (processed < totalCount) {
    try {
      const result = await Model.updateMany(
        { workspaceId: { $exists: true, $ne: null } },
        { $unset: { workspaceId: "" } }
      );
      
      rolled += result.modifiedCount;
      processed = totalCount; // Tout est traité en une fois avec updateMany
      
    } catch (error) {
      console.error(`❌ Erreur lors de la suppression des workspaceId pour ${modelName}:`, error.message);
      errors++;
      break;
    }
  }
  
  stats[modelName].rolled = rolled;
  stats[modelName].errors = errors;
  
  console.log(`✅ ${modelName} terminé: ${rolled} workspaceId supprimés, ${errors} erreurs`);
}

/**
 * Supprime les organisations et membres créés
 */
async function removeOrganizations(db) {
  console.log('\n🔄 Suppression des organisations et membres...');
  
  try {
    // Compter les organisations
    const orgsCount = await db.collection('organization').countDocuments();
    const membersCount = await db.collection('member').countDocuments();
    
    console.log(`📊 ${orgsCount} organisations et ${membersCount} membres à supprimer`);
    
    // Supprimer les membres d'abord (contraintes de clés étrangères)
    const membersResult = await db.collection('member').deleteMany({});
    stats.members.deleted = membersResult.deletedCount;
    
    // Supprimer les organisations
    const orgsResult = await db.collection('organization').deleteMany({});
    stats.organizations.deleted = orgsResult.deletedCount;
    
    console.log(`✅ Suppression terminée: ${stats.organizations.deleted} organisations, ${stats.members.deleted} membres`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la suppression des organisations:', error.message);
    stats.organizations.errors++;
    stats.members.errors++;
  }
}

/**
 * Supprime la collection "user" si elle existe
 */
async function removeUserCollection(db) {
  console.log('\n🔄 Vérification de la collection "user"...');
  
  try {
    // Vérifier si la collection "user" existe
    const collections = await db.listCollections({ name: 'user' }).toArray();
    
    if (collections.length === 0) {
      console.log('✅ Collection "user" non trouvée, rien à supprimer');
      return;
    }
    
    // Compter les documents
    const userCount = await db.collection('user').countDocuments();
    console.log(`📊 ${userCount} utilisateurs dans la collection "user"`);
    
    // Vérifier si la collection "users" existe encore
    const oldCollections = await db.listCollections({ name: 'users' }).toArray();
    
    if (oldCollections.length === 0) {
      console.warn('⚠️  Collection "users" non trouvée. Les données utilisateur originales pourraient être perdues!');
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const shouldContinue = await new Promise((resolve) => {
        rl.question('Voulez-vous quand même supprimer la collection "user"? (tapez "OUI" pour continuer): ', (answer) => {
          rl.close();
          resolve(answer === 'OUI');
        });
      });
      
      if (!shouldContinue) {
        console.log('❌ Suppression de la collection "user" annulée');
        return;
      }
    }
    
    // Supprimer la collection "user"
    await db.collection('user').drop();
    stats.users.deleted = userCount;
    
    console.log(`✅ Collection "user" supprimée: ${userCount} utilisateurs`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la suppression de la collection "user":', error.message);
    stats.users.errors++;
  }
}

/**
 * Valide l'état après rollback
 */
async function validateRollback(db) {
  console.log('\n🔍 Validation de l\'état après rollback...');
  
  // Vérifier les collections utilisateur
  const userCount = await db.collection('user').countDocuments().catch(() => 0);
  const oldUsersCount = await db.collection('users').countDocuments().catch(() => 0);
  console.log(`📊 Utilisateurs: ${userCount} dans 'user', ${oldUsersCount} dans 'users'`);
  
  // Vérifier les organisations
  const orgsCount = await db.collection('organization').countDocuments().catch(() => 0);
  const membersCount = await db.collection('member').countDocuments().catch(() => 0);
  console.log(`📊 Organisations: ${orgsCount} restantes, ${membersCount} membres restants`);
  
  // Vérifier les modèles sans workspaceId
  const models = [
    { Model: Invoice, name: 'invoices' },
    { Model: Expense, name: 'expenses' },
    { Model: Event, name: 'events' },
    { Model: Transaction, name: 'transactions' },
    { Model: Quote, name: 'quotes' },
    { Model: Client, name: 'clients' },
    { Model: CreditNote, name: 'creditNotes' }
  ];
  
  for (const { Model, name } of models) {
    const withWorkspace = await Model.countDocuments({ 
      workspaceId: { $exists: true, $ne: null } 
    });
    const withoutWorkspace = await Model.countDocuments({ 
      $or: [
        { workspaceId: { $exists: false } },
        { workspaceId: null }
      ]
    });
    
    console.log(`📊 ${name}: ${withoutWorkspace} sans workspaceId, ${withWorkspace} avec workspaceId`);
    
    if (withWorkspace > 0) {
      console.warn(`⚠️  ${withWorkspace} documents ${name} ont encore un workspaceId`);
    }
  }
}

/**
 * Affiche les statistiques finales
 */
function displayStats() {
  console.log('\n📈 STATISTIQUES DE ROLLBACK');
  console.log('=' .repeat(60));
  
  let totalRolled = 0;
  let totalErrors = 0;
  
  for (const [modelName, modelStats] of Object.entries(stats)) {
    if (modelStats.total > 0 || modelStats.deleted > 0) {
      if (modelName === 'organizations' || modelName === 'members' || modelName === 'users') {
        console.log(`${modelName.padEnd(20)}: ${modelStats.deleted} supprimés (${modelStats.errors} erreurs)`);
      } else {
        console.log(`${modelName.padEnd(20)}: ${modelStats.rolled}/${modelStats.total} workspaceId supprimés (${modelStats.errors} erreurs)`);
        totalRolled += modelStats.rolled;
        totalErrors += modelStats.errors;
      }
    }
  }
  
  console.log('=' .repeat(60));
  console.log(`TOTAL: ${totalRolled} workspaceId supprimés, ${totalErrors} erreurs`);
  console.log(`ORGANISATIONS: ${stats.organizations.deleted} supprimées`);
  console.log(`MEMBRES: ${stats.members.deleted} supprimés`);
  console.log(`UTILISATEURS: ${stats.users.deleted} supprimés`);
}

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🚀 DÉMARRAGE DU ROLLBACK DE MIGRATION');
    console.log(`Batch size: ${BATCH_SIZE}`);
    console.log('=' .repeat(60));
    
    // Demander confirmation
    const confirmed = await askConfirmation();
    if (!confirmed) {
      console.log('❌ Rollback annulé par l\'utilisateur');
      process.exit(0);
    }
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    const db = mongoose.connection.db;
    
    // Étape 1: Supprimer les workspaceId des modèles
    await removeWorkspaceIds(Invoice, 'invoices');
    await removeWorkspaceIds(Expense, 'expenses');
    await removeWorkspaceIds(Event, 'events');
    await removeWorkspaceIds(Transaction, 'transactions');
    await removeWorkspaceIds(Quote, 'quotes');
    await removeWorkspaceIds(Client, 'clients');
    await removeWorkspaceIds(CreditNote, 'creditNotes');
    
    // Étape 2: Supprimer les organisations et membres
    await removeOrganizations(db);
    
    // Étape 3: Supprimer la collection "user"
    await removeUserCollection(db);
    
    // Étape 4: Validation
    await validateRollback(db);
    
    // Étape 5: Statistiques
    displayStats();
    
    console.log('\n🎉 ROLLBACK TERMINÉ AVEC SUCCÈS');
    console.log('\n⚠️  ÉTAPES POST-ROLLBACK:');
    console.log('1. Vérifiez que l\'application fonctionne avec l\'ancienne structure');
    console.log('2. Restaurez une sauvegarde si nécessaire');
    console.log('3. Analysez les causes de l\'échec de la migration');
    console.log('4. Corrigez les problèmes avant de relancer la migration');
    
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

export { main as rollbackMigration };
