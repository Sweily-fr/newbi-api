#!/usr/bin/env node

/**
 * Script de migration de production vers la nouvelle structure
 * 
 * Ce script :
 * 1. Migre la collection "Users" vers "user"
 * 2. Crée des organisations Better Auth pour chaque utilisateur
 * 3. Ajoute les workspaceId à tous les documents existants
 * 4. Valide l'intégrité des données migrées
 * 
 * Usage: node scripts/migrate-production-to-new-structure.js [--dry-run] [--batch-size=100]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';
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
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// Statistiques de migration
const stats = {
  users: { total: 0, migrated: 0, errors: 0, skipped: 0 },
  organizations: { created: 0, errors: 0 },
  invoices: { total: 0, migrated: 0, errors: 0 },
  expenses: { total: 0, migrated: 0, errors: 0 },
  events: { total: 0, migrated: 0, errors: 0 },
  transactions: { total: 0, migrated: 0, errors: 0 },
  quotes: { total: 0, migrated: 0, errors: 0 },
  clients: { total: 0, migrated: 0, errors: 0 },
  creditNotes: { total: 0, migrated: 0, errors: 0 }
};

/**
 * Génère un ID d'organisation unique
 */
function generateOrganizationId() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Crée une organisation Better Auth pour un utilisateur
 */
async function createOrganizationForUser(user, db) {
  try {
    const organizationId = generateOrganizationId();
    const now = new Date();
    
    // Créer l'organisation
    const organization = {
      _id: new mongoose.Types.ObjectId(organizationId),
      name: user.company?.name || `Organisation de ${user.profile?.firstName || user.email}`,
      slug: `org-${user._id.toString().slice(-8)}`,
      logo: user.company?.logo || null,
      createdAt: now,
      updatedAt: now,
      metadata: {
        // Copier les données de l'entreprise existante
        companyName: user.company?.name || null,
        companyEmail: user.company?.email || null,
        companyPhone: user.company?.phone || null,
        companyWebsite: user.company?.website || null,
        siret: user.company?.siret || null,
        vatNumber: user.company?.vatNumber || null,
        companyStatus: user.company?.companyStatus || null,
        capitalSocial: user.company?.capitalSocial || null,
        rcs: user.company?.rcs || null,
        transactionCategory: user.company?.transactionCategory || 'SERVICES',
        vatPaymentCondition: user.company?.vatPaymentCondition || 'NONE',
        
        // Adresse
        addressStreet: user.company?.address?.street || null,
        addressCity: user.company?.address?.city || null,
        addressZipCode: user.company?.address?.zipCode || null,
        addressCountry: user.company?.address?.country || null,
        
        // Coordonnées bancaires
        bankIban: user.company?.bankDetails?.iban || null,
        bankBic: user.company?.bankDetails?.bic || null,
        bankName: user.company?.bankDetails?.bankName || null,
        
        // Paramètres de document par défaut
        documentTextColor: '#000000',
        documentHeaderTextColor: '#FFFFFF',
        documentHeaderBgColor: '#3B82F6',
        documentHeaderNotes: '',
        documentFooterNotes: '',
        documentTermsAndConditions: '',
        showBankDetails: false
      }
    };
    
    if (!DRY_RUN) {
      await db.collection('organization').insertOne(organization);
    }
    
    // Créer le membre de l'organisation
    const member = {
      _id: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(organizationId),
      userId: user._id,
      role: 'owner',
      createdAt: now,
      updatedAt: now
    };
    
    if (!DRY_RUN) {
      await db.collection('member').insertOne(member);
    }
    
    stats.organizations.created++;
    
    if (VERBOSE) {
      console.log(`✅ Organisation créée pour ${user.email}: ${organizationId}`);
    }
    
    return organizationId;
    
  } catch (error) {
    console.error(`❌ Erreur création organisation pour ${user.email}:`, error.message);
    stats.organizations.errors++;
    return null;
  }
}

/**
 * Migre les utilisateurs - ajoute les workspaceId et crée les organisations
 */
async function migrateUsers(db) {
  console.log('\n🔄 Migration des utilisateurs...');
  
  // Lister toutes les collections pour diagnostic
  console.log('\n📋 Collections disponibles:');
  const allCollections = await db.listCollections().toArray();
  for (const collection of allCollections) {
    const count = await db.collection(collection.name).countDocuments();
    console.log(`   - ${collection.name}: ${count} documents`);
  }
  
  // Chercher les collections d'utilisateurs possibles avec diagnostic détaillé
  const possibleUserCollections = ['Users', 'user', 'users', 'User'];
  let bestCollection = null;
  let maxCount = 0;
  let bestCollectionName = '';
  
  console.log('\n🔍 Recherche des collections d\'utilisateurs:');
  
  for (const name of possibleUserCollections) {
    const collections = await db.listCollections({ name }).toArray();
    if (collections.length > 0) {
      const count = await db.collection(name).countDocuments();
      console.log(`   - Collection "${name}" existe avec ${count} documents`);
      
      if (count > maxCount) {
        bestCollection = db.collection(name);
        bestCollectionName = name;
        maxCount = count;
        console.log(`📄 ✅ Collection "${name}" sélectionnée (${count} documents - la plus grande)`);
      }
    } else {
      console.log(`   - Collection "${name}" n'existe pas`);
    }
  }
  
  if (!bestCollection) {
    console.log('\n❌ PROBLÈME: Aucune collection d\'utilisateurs avec des données trouvée');
    console.log('📋 Collections vérifiées:', possibleUserCollections.join(', '));
    console.log('\n💡 Vérifiez manuellement avec:');
    console.log('   mongosh "mongodb://..." --eval "db.getCollectionNames().forEach(c => print(c + \': \' + db[c].countDocuments()))"');
    return new Map();
  }
  
  const userCollection = db.collection('user'); // Collection de destination avec u minuscule
  
  const totalUsers = await bestCollection.countDocuments();
  stats.users.total = totalUsers;
  
  console.log(`\n📊 Migration: ${totalUsers} utilisateurs depuis "${bestCollectionName}" vers "user"`);
  
  const userWorkspaceMap = new Map();
  let processed = 0;
  
  // Traitement par batch
  while (processed < totalUsers) {
    const users = await bestCollection.find({})
      .skip(processed)
      .limit(BATCH_SIZE)
      .toArray();
    
    if (users.length === 0) break;
    
    for (const user of users) {
      try {
        let finalUser = user;
        
        const existingUser = await userCollection.findOne({ email: user.email });
        
        if (existingUser) {
          console.log(`⚠️  Utilisateur ${user.email} existe déjà dans la collection "user"`);
          finalUser = existingUser;
        } else {
          // Migrer l'utilisateur vers la collection "user"
          const newUser = {
            ...user,
            _id: user._id,
            referralCode: user.referralCode || null,
            referredBy: user.referredBy || null,
            referralEarnings: user.referralEarnings || 0
          };
          
          if (!DRY_RUN) {
            await userCollection.insertOne(newUser);
            console.log(`✅ Utilisateur ${user.email} migré vers la collection "user"`);
          } else {
            console.log(`🔍 [DRY-RUN] Migrerait l'utilisateur ${user.email}`);
          }
          
          finalUser = newUser;
          stats.users.migrated++;
        }
        
        // Créer l'organisation pour l'utilisateur
        const organizationId = await createOrganizationForUser(finalUser, db);
        
        if (organizationId) {
          userWorkspaceMap.set(finalUser._id.toString(), organizationId);
          
          // Mettre à jour l'utilisateur avec son workspaceId si pas encore fait
          const hasWorkspace = finalUser.workspaceId || finalUser.organizationId;
          if (!hasWorkspace && !DRY_RUN) {
            await userCollection.updateOne(
              { _id: finalUser._id },
              { 
                $set: { 
                  workspaceId: organizationId,
                  organizationId: organizationId,
                  updatedAt: new Date()
                }
              }
            );
            console.log(`✅ WorkspaceId ajouté à l'utilisateur ${finalUser.email}`);
          }
          
          if (bestCollectionName === 'user') {
            stats.users.migrated++; // Compter comme migré si on ajoute juste le workspace
          }
        } else {
          stats.users.errors++;
        }
        
      } catch (error) {
        console.error(`❌ Erreur lors de la migration de l'utilisateur:`, error.message);
        stats.users.errors++;
      }
    }
    
    processed += users.length;
    console.log(`📈 Progression: ${processed}/${totalUsers} utilisateurs traités`);
  }
  
  console.log(`✅ Migration des utilisateurs terminée:`);
  console.log(`   - Total: ${stats.users.total}`);
  console.log(`   - Migrés: ${stats.users.migrated}`);
  console.log(`   - Erreurs: ${stats.users.errors}`);
  console.log(`   - Organisations créées: ${stats.organizations.created}`);
  
  return userWorkspaceMap;
}

/**
 * Migre un modèle spécifique en ajoutant les workspaceId
 */
async function migrateModelWithWorkspace(Model, modelName, userField, userWorkspaceMap) {
  console.log(`\n🔄 Migration du modèle ${modelName}...`);
  
  // Compter les documents sans workspaceId
  const totalCount = await Model.countDocuments({ 
    $or: [
      { workspaceId: { $exists: false } },
      { workspaceId: null }
    ]
  });
  
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
    const documents = await Model.find({ 
      $or: [
        { workspaceId: { $exists: false } },
        { workspaceId: null }
      ]
    })
      .limit(BATCH_SIZE)
      .lean();
    
    if (documents.length === 0) break;
    
    const bulkOps = [];
    
    for (const doc of documents) {
      let userId;
      
      // Gérer différents champs utilisateur selon le modèle
      if (userField === 'createdBy' || userField === 'userId') {
        userId = doc[userField]?.toString();
      } else if (userField === 'user') {
        userId = doc.user?.toString();
      }
      
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
        if (VERBOSE) {
          console.warn(`⚠️  Workspace non trouvé pour ${modelName} ${doc._id} (user: ${userId})`);
        }
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
async function validateMigration(db) {
  console.log('\n🔍 Validation de l\'intégrité des données...');
  
  // Vérifier les utilisateurs
  const usersCount = await db.collection('user').countDocuments();
  const oldUsersCount = await db.collection('Users').countDocuments().catch(() => 0);
  console.log(`📊 Utilisateurs: ${usersCount} dans 'user', ${oldUsersCount} dans 'Users'`);
  
  // Vérifier les organisations
  const orgsCount = await db.collection('organization').countDocuments();
  const membersCount = await db.collection('member').countDocuments();
  console.log(`📊 Organisations: ${orgsCount} créées, ${membersCount} membres`);
  
  // Vérifier les modèles avec workspaceId
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
    const withoutWorkspace = await Model.countDocuments({ 
      $or: [
        { workspaceId: { $exists: false } },
        { workspaceId: null }
      ]
    });
    const withWorkspace = await Model.countDocuments({ 
      workspaceId: { $exists: true, $ne: null } 
    });
    
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
  console.log('=' .repeat(60));
  
  let totalMigrated = 0;
  let totalErrors = 0;
  
  for (const [modelName, modelStats] of Object.entries(stats)) {
    if (modelStats.total > 0 || modelStats.created > 0) {
      if (modelName === 'organizations') {
        console.log(`${modelName.padEnd(20)}: ${modelStats.created} créées (${modelStats.errors} erreurs)`);
      } else {
        const skippedText = modelStats.skipped ? `, ${modelStats.skipped} ignorés` : '';
        console.log(`${modelName.padEnd(20)}: ${modelStats.migrated}/${modelStats.total} migrés (${modelStats.errors} erreurs${skippedText})`);
        totalMigrated += modelStats.migrated;
        totalErrors += modelStats.errors;
      }
    }
  }
  
  console.log('=' .repeat(60));
  console.log(`TOTAL: ${totalMigrated} documents migrés, ${totalErrors} erreurs`);
  console.log(`ORGANISATIONS: ${stats.organizations.created} créées`);
  
  if (DRY_RUN) {
    console.log('\n🔍 MODE DRY-RUN: Aucune modification n\'a été effectuée');
  }
}

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🚀 DÉMARRAGE DE LA MIGRATION VERS LA NOUVELLE STRUCTURE');
    console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'PRODUCTION'}`);
    console.log(`Batch size: ${BATCH_SIZE}`);
    console.log('=' .repeat(60));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    const db = mongoose.connection.db;
    
    // Étape 1: Migrer les utilisateurs et créer les organisations
    const userWorkspaceMap = await migrateUsers(db);
    
    if (userWorkspaceMap.size === 0) {
      console.error('❌ Aucun mapping utilisateur -> workspace créé. Arrêt de la migration.');
      process.exit(1);
    }
    
    console.log(`📋 Mapping créé: ${userWorkspaceMap.size} utilisateurs -> workspaces`);
    
    // Étape 2: Migrer chaque modèle avec workspaceId
    await migrateModelWithWorkspace(Invoice, 'invoices', 'createdBy', userWorkspaceMap);
    await migrateModelWithWorkspace(Expense, 'expenses', 'createdBy', userWorkspaceMap);
    await migrateModelWithWorkspace(Event, 'events', 'userId', userWorkspaceMap);
    await migrateModelWithWorkspace(Transaction, 'transactions', 'userId', userWorkspaceMap);
    await migrateModelWithWorkspace(Quote, 'quotes', 'createdBy', userWorkspaceMap);
    await migrateModelWithWorkspace(Client, 'clients', 'createdBy', userWorkspaceMap);
    await migrateModelWithWorkspace(CreditNote, 'creditNotes', 'createdBy', userWorkspaceMap);
    
    // Étape 3: Validation
    if (!DRY_RUN) {
      await validateMigration(db);
    }
    
    // Étape 4: Statistiques
    displayStats();
    
    console.log('\n🎉 MIGRATION TERMINÉE AVEC SUCCÈS');
    
    if (!DRY_RUN) {
      console.log('\n⚠️  ÉTAPES POST-MIGRATION:');
      console.log('1. Vérifiez que l\'application fonctionne correctement');
      console.log('2. Testez la création de nouveaux documents');
      console.log('3. Une fois validé, vous pouvez supprimer la collection "Users"');
      console.log('4. Mettez à jour vos sauvegardes régulières');
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

export { main as migrateProductionToNewStructure };
