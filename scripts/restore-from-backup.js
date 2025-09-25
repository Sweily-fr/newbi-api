#!/usr/bin/env node

/**
 * Script de restauration des factures et devis depuis une sauvegarde
 * Ajoute automatiquement les workspaceId manquants
 * Usage: node scripts/restore-from-backup.js [--backup-date=2025-09-17_06-49-52-607Z] [--apply]
 */

import { MongoClient, ObjectId } from 'mongodb';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Configuration MongoDB pour la production
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';
const BACKUP_BASE_PATH = '/home/joaquim/api.newbi.fr/backups';

// Cache pour les relations utilisateur -> workspace
const userWorkspaceCache = new Map();
const memberCache = new Map();

async function buildUserWorkspaceCache(db) {
  console.log('🔄 Construction du cache utilisateur -> workspace...');
  
  // Cache des utilisateurs avec workspaceId
  const users = await db.collection('user').find({ workspaceId: { $exists: true } }).toArray();
  users.forEach(user => {
    userWorkspaceCache.set(user._id.toString(), user.workspaceId);
  });
  console.log(`📋 Cache user: ${users.length} utilisateurs avec workspaceId`);
  
  // Cache des relations member
  const members = await db.collection('member').find({}).toArray();
  members.forEach(member => {
    const userId = member.userId?.toString() || member.user?.toString();
    if (userId && member.organizationId) {
      memberCache.set(userId, member.organizationId);
    }
  });
  console.log(`🔗 Cache member: ${members.length} relations`);
}

function findWorkspaceForUser(userId) {
  const userIdStr = userId.toString();
  
  // 1. Vérifier dans le cache user direct
  if (userWorkspaceCache.has(userIdStr)) {
    return {
      workspaceId: userWorkspaceCache.get(userIdStr),
      method: 'user.workspaceId'
    };
  }
  
  // 2. Vérifier via member -> organization
  if (memberCache.has(userIdStr)) {
    return {
      workspaceId: memberCache.get(userIdStr),
      method: 'member.organizationId'
    };
  }
  
  return null;
}

async function loadBackupData(backupPath, collection) {
  const filePath = join(backupPath, `${collection}.json`);
  
  if (!existsSync(filePath)) {
    console.log(`⚠️  Fichier de sauvegarde non trouvé: ${filePath}`);
    return [];
  }
  
  try {
    const data = readFileSync(filePath, 'utf8');
    const documents = JSON.parse(data);
    console.log(`📄 Chargé ${documents.length} documents depuis ${collection}.json`);
    return documents;
  } catch (error) {
    console.error(`❌ Erreur lors du chargement de ${filePath}:`, error.message);
    return [];
  }
}

function convertBackupDocument(doc) {
  // Convertir les ObjectId depuis le format de sauvegarde
  const converted = { ...doc };
  
  // Convertir _id
  if (converted._id && converted._id.$oid) {
    converted._id = new ObjectId(converted._id.$oid);
  }
  
  // Convertir createdBy
  if (converted.createdBy && converted.createdBy.$oid) {
    converted.createdBy = new ObjectId(converted.createdBy.$oid);
  }
  
  // Convertir les dates
  if (converted.createdAt && converted.createdAt.$date) {
    converted.createdAt = new Date(converted.createdAt.$date);
  }
  
  if (converted.updatedAt && converted.updatedAt.$date) {
    converted.updatedAt = new Date(converted.updatedAt.$date);
  }
  
  // Convertir d'autres champs ObjectId courants
  ['clientId', 'userId', 'organizationId'].forEach(field => {
    if (converted[field] && converted[field].$oid) {
      converted[field] = new ObjectId(converted[field].$oid);
    }
  });
  
  return converted;
}

async function restoreCollection(db, collectionName, backupPath, isDryRun = true) {
  console.log(`\n📦 Restauration de la collection: ${collectionName}`);
  console.log('─'.repeat(50));
  
  // Charger les données de sauvegarde
  const backupData = await loadBackupData(backupPath, collectionName);
  if (backupData.length === 0) {
    return { processed: 0, restored: 0, skipped: 0, errors: 0 };
  }
  
  const collection = db.collection(collectionName);
  const stats = { processed: 0, restored: 0, skipped: 0, errors: 0 };
  
  for (const backupDoc of backupData) {
    stats.processed++;
    
    try {
      // Convertir le document
      const doc = convertBackupDocument(backupDoc);
      
      // Vérifier si le document existe déjà
      const existing = await collection.findOne({ _id: doc._id });
      if (existing) {
        console.log(`⏭️  Document ${doc._id} existe déjà - ignoré`);
        stats.skipped++;
        continue;
      }
      
      // Trouver le workspaceId si manquant
      if (!doc.workspaceId && doc.createdBy) {
        const workspaceInfo = findWorkspaceForUser(doc.createdBy);
        if (workspaceInfo) {
          doc.workspaceId = new ObjectId(workspaceInfo.workspaceId);
          console.log(`🔧 WorkspaceId ajouté: ${doc._id} -> ${workspaceInfo.workspaceId} (${workspaceInfo.method})`);
        } else {
          console.log(`⚠️  Impossible de trouver workspaceId pour ${doc._id} (createdBy: ${doc.createdBy})`);
        }
      }
      
      // Restaurer le document
      if (!isDryRun) {
        await collection.insertOne(doc);
        console.log(`✅ Document restauré: ${doc._id}`);
      } else {
        console.log(`🔍 Document à restaurer: ${doc._id} ${doc.workspaceId ? '(avec workspaceId)' : '(sans workspaceId)'}`);
      }
      
      stats.restored++;
      
    } catch (error) {
      console.error(`❌ Erreur pour le document ${backupDoc._id?.$oid || 'unknown'}:`, error.message);
      stats.errors++;
    }
  }
  
  return stats;
}

async function restoreFromBackup(backupDate, isDryRun = true, collections = ['invoices', 'quotes']) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('🚀 Restauration depuis sauvegarde');
    console.log('================================');
    console.log(`📅 Date de sauvegarde: ${backupDate}`);
    console.log(`📋 Mode: ${isDryRun ? 'SIMULATION (dry-run)' : 'RESTAURATION RÉELLE'}`);
    console.log(`📦 Collections: ${collections.join(', ')}`);
    console.log('');
    
    const backupPath = join(BACKUP_BASE_PATH, `backup_${backupDate}`);
    console.log(`📁 Chemin de sauvegarde: ${backupPath}`);
    
    if (!existsSync(backupPath)) {
      throw new Error(`Dossier de sauvegarde non trouvé: ${backupPath}`);
    }
    
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    
    // Construire le cache des relations
    await buildUserWorkspaceCache(db);
    
    const totalStats = { processed: 0, restored: 0, skipped: 0, errors: 0 };
    
    // Restaurer chaque collection
    for (const collectionName of collections) {
      const stats = await restoreCollection(db, collectionName, backupPath, isDryRun);
      
      totalStats.processed += stats.processed;
      totalStats.restored += stats.restored;
      totalStats.skipped += stats.skipped;
      totalStats.errors += stats.errors;
    }
    
    // Résumé final
    console.log('\n📊 RÉSUMÉ DE LA RESTAURATION');
    console.log('============================');
    console.log(`📄 Documents traités: ${totalStats.processed}`);
    console.log(`✅ Documents ${isDryRun ? 'à restaurer' : 'restaurés'}: ${totalStats.restored}`);
    console.log(`⏭️  Documents ignorés (déjà existants): ${totalStats.skipped}`);
    console.log(`❌ Erreurs rencontrées: ${totalStats.errors}`);
    
    if (isDryRun && totalStats.restored > 0) {
      console.log('\n💡 Pour appliquer la restauration, relancez avec --apply');
    } else if (!isDryRun && totalStats.restored > 0) {
      console.log('\n🎉 Restauration terminée avec succès !');
      console.log('💡 Relancez verify-workspace-ids.js pour vérifier l\'intégrité');
    }
    
  } catch (error) {
    console.error('❌ Erreur générale:', error.message);
  } finally {
    await client.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

// Analyser les arguments de ligne de commande
const args = process.argv.slice(2);
const isDryRun = !args.includes('--apply');
const backupDateArg = args.find(arg => arg.startsWith('--backup-date='));
const backupDate = backupDateArg ? backupDateArg.split('=')[1] : '2025-09-17_06-49-52-607Z';
const collectionsArg = args.find(arg => arg.startsWith('--collections='));
const collections = collectionsArg ? collectionsArg.split('=')[1].split(',') : ['invoices', 'quotes'];

console.log('📦 Script de restauration depuis sauvegarde');
console.log('===========================================');

if (isDryRun) {
  console.log('ℹ️  Mode SIMULATION activé (aucune modification ne sera appliquée)');
  console.log('💡 Utilisez --apply pour appliquer la restauration');
} else {
  console.log('⚠️  Mode RESTAURATION RÉELLE activé');
  console.log('🚨 Les documents seront ajoutés à la base de données !');
}

console.log('\nOptions disponibles:');
console.log('  --apply                           Appliquer la restauration (sinon simulation)');
console.log('  --backup-date=YYYY-MM-DD_HH-mm-ss Date de la sauvegarde');
console.log('  --collections=invoices,quotes     Collections à restaurer');
console.log('\nExemples:');
console.log('  node scripts/restore-from-backup.js');
console.log('  node scripts/restore-from-backup.js --backup-date=2025-09-17_06-49-52-607Z --apply');
console.log('  node scripts/restore-from-backup.js --collections=invoices --apply');

// Fonction principale async
async function main() {
  // Demander confirmation si ce n'est pas un dry-run
  if (!isDryRun) {
    console.log('\n⚠️  ATTENTION: Vous êtes sur le point de restaurer des données en production !');
    console.log('Appuyez sur Ctrl+C pour annuler, ou attendez 5 secondes pour continuer...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  await restoreFromBackup(backupDate, isDryRun, collections);
}

main().catch(console.error);
