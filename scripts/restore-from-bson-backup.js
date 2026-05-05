#!/usr/bin/env node

/**
 * Script de restauration des factures et devis depuis une sauvegarde BSON
 * Utilise mongorestore pour restaurer les fichiers .bson
 * Usage: node scripts/restore-from-bson-backup.js [--backup-date=2025-09-17_06-49-52-607Z] [--apply]
 */

import { MongoClient, ObjectId } from 'mongodb';
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

// Configuration MongoDB pour la production
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}
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

async function analyzeCollection(db, collectionName, backupPath) {
  const bsonFile = join(backupPath, 'newbi', `${collectionName}.bson`);
  const metadataFile = join(backupPath, 'newbi', `${collectionName}.metadata.json`);
  
  if (!existsSync(bsonFile)) {
    console.log(`⚠️  Fichier BSON non trouvé: ${bsonFile}`);
    return null;
  }
  
  // Lire les métadonnées
  let metadata = {};
  if (existsSync(metadataFile)) {
    try {
      metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
    } catch (error) {
      console.log(`⚠️  Erreur lecture métadonnées: ${error.message}`);
    }
  }
  
  // Compter les documents existants en production
  const collection = db.collection(collectionName);
  const existingCount = await collection.countDocuments({});
  
  console.log(`📊 Collection: ${collectionName}`);
  console.log(`   📄 Fichier BSON: ${Math.round(statSync(bsonFile).size / 1024)} KB`);
  console.log(`   📋 En production: ${existingCount} documents`);
  
  return {
    name: collectionName,
    bsonFile,
    metadataFile,
    existingCount,
    metadata
  };
}

async function restoreCollectionFromBson(collectionName, backupPath, isDryRun = true) {
  const bsonFile = join(backupPath, 'newbi', `${collectionName}.bson`);
  const tempCollection = `${collectionName}_temp_restore`;
  
  if (!existsSync(bsonFile)) {
    console.log(`⚠️  Fichier BSON non trouvé: ${bsonFile}`);
    return { restored: 0, errors: 0 };
  }
  
  console.log(`\n📦 Restauration de ${collectionName} depuis BSON`);
  console.log('─'.repeat(50));
  
  if (isDryRun) {
    console.log(`🔍 Mode simulation - analyserait le fichier ${bsonFile}`);
    return { restored: 0, errors: 0 };
  }
  
  try {
    // Extraire les informations de connexion MongoDB
    const mongoUri = MONGODB_URI;
    const [, credentials, hostAndDb] = mongoUri.match(/mongodb:\/\/([^@]+)@(.+)/) || [];
    const [username, password] = credentials ? credentials.split(':') : ['', ''];
    const [hostPort, dbAndParams] = hostAndDb ? hostAndDb.split('/') : ['', ''];
    const [host, port] = hostPort.split(':');
    
    // Commande mongorestore pour restaurer dans une collection temporaire
    const restoreCmd = [
      'mongorestore',
      `--host=${host}:${port || 27017}`,
      `--username=${username}`,
      `--password=${password}`,
      '--authenticationDatabase=admin',
      `--db=${DB_NAME}`,
      `--collection=${tempCollection}`,
      bsonFile
    ].join(' ');
    
    console.log(`🔄 Restauration dans collection temporaire: ${tempCollection}`);
    execSync(restoreCmd, { stdio: 'pipe' });
    
    // Maintenant traiter les documents pour ajouter les workspaceId
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    
    const tempColl = db.collection(tempCollection);
    const targetColl = db.collection(collectionName);
    
    const documents = await tempColl.find({}).toArray();
    console.log(`📄 ${documents.length} documents à traiter`);
    
    let restored = 0;
    let errors = 0;
    
    for (const doc of documents) {
      try {
        // Vérifier si le document existe déjà
        const existing = await targetColl.findOne({ _id: doc._id });
        if (existing) {
          console.log(`⏭️  Document ${doc._id} existe déjà - ignoré`);
          continue;
        }
        
        // Ajouter workspaceId si manquant
        if (!doc.workspaceId && doc.createdBy) {
          const workspaceInfo = findWorkspaceForUser(doc.createdBy);
          if (workspaceInfo) {
            doc.workspaceId = new ObjectId(workspaceInfo.workspaceId);
            console.log(`🔧 WorkspaceId ajouté: ${doc._id} -> ${workspaceInfo.workspaceId} (${workspaceInfo.method})`);
          } else {
            console.log(`⚠️  Impossible de trouver workspaceId pour ${doc._id} (createdBy: ${doc.createdBy})`);
          }
        }
        
        // Insérer le document
        await targetColl.insertOne(doc);
        console.log(`✅ Document restauré: ${doc._id}`);
        restored++;
        
      } catch (error) {
        console.error(`❌ Erreur pour le document ${doc._id}:`, error.message);
        errors++;
      }
    }
    
    // Nettoyer la collection temporaire
    await tempColl.drop();
    console.log(`🗑️  Collection temporaire supprimée: ${tempCollection}`);
    
    await client.close();
    
    return { restored, errors };
    
  } catch (error) {
    console.error(`❌ Erreur lors de la restauration BSON:`, error.message);
    return { restored: 0, errors: 1 };
  }
}

async function restoreFromBsonBackup(backupDate, isDryRun = true, collections = ['invoices', 'quotes']) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('🚀 Restauration depuis sauvegarde BSON');
    console.log('===================================');
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
    
    // Analyser les collections disponibles
    console.log('\n📊 ANALYSE DES COLLECTIONS DISPONIBLES');
    console.log('=====================================');
    
    for (const collectionName of collections) {
      await analyzeCollection(db, collectionName, backupPath);
    }
    
    if (isDryRun) {
      console.log('\n💡 Pour appliquer la restauration, relancez avec --apply');
      console.log('⚠️  La restauration BSON nécessite mongorestore installé sur le serveur');
      return;
    }
    
    // Restaurer les collections
    const totalStats = { restored: 0, errors: 0 };
    
    for (const collectionName of collections) {
      const stats = await restoreCollectionFromBson(collectionName, backupPath, isDryRun);
      totalStats.restored += stats.restored;
      totalStats.errors += stats.errors;
    }
    
    // Résumé final
    console.log('\n📊 RÉSUMÉ DE LA RESTAURATION');
    console.log('============================');
    console.log(`✅ Documents restaurés: ${totalStats.restored}`);
    console.log(`❌ Erreurs rencontrées: ${totalStats.errors}`);
    
    if (totalStats.restored > 0) {
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

console.log('📦 Script de restauration depuis sauvegarde BSON');
console.log('===============================================');

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
console.log('  node scripts/restore-from-bson-backup.js');
console.log('  node scripts/restore-from-bson-backup.js --backup-date=2025-09-17_06-49-52-607Z --apply');
console.log('  node scripts/restore-from-bson-backup.js --collections=invoices --apply');

// Fonction principale async
async function main() {
  // Demander confirmation si ce n'est pas un dry-run
  if (!isDryRun) {
    console.log('\n⚠️  ATTENTION: Vous êtes sur le point de restaurer des données en production !');
    console.log('Appuyez sur Ctrl+C pour annuler, ou attendez 5 secondes pour continuer...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  await restoreFromBsonBackup(backupDate, isDryRun, collections);
}

main().catch(console.error);
