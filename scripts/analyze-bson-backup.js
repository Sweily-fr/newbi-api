#!/usr/bin/env node

/**
 * Script d'analyse rapide d'une sauvegarde BSON
 * Usage: node scripts/analyze-bson-backup.js [--backup-date=2025-09-17_06-49-52-607Z]
 */

import { MongoClient } from 'mongodb';
import { existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';
const BACKUP_BASE_PATH = '/home/joaquim/api.newbi.fr/backups';

async function analyzeBsonBackup(backupDate) {
  console.log('🔍 Analyse de la sauvegarde BSON');
  console.log('===============================');
  console.log(`📅 Date de sauvegarde: ${backupDate}`);
  
  const backupPath = join(BACKUP_BASE_PATH, `backup_${backupDate}`);
  const bsonPath = join(backupPath, 'newbi');
  
  console.log(`📁 Chemin: ${bsonPath}`);
  
  if (!existsSync(bsonPath)) {
    console.error(`❌ Dossier BSON non trouvé: ${bsonPath}`);
    return;
  }
  
  // Collections importantes à analyser
  const collectionsToAnalyze = ['invoices', 'quotes', 'clients', 'products', 'expenses'];
  
  console.log('\n📊 ANALYSE DES FICHIERS BSON');
  console.log('============================');
  
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    
    for (const collectionName of collectionsToAnalyze) {
      const bsonFile = join(bsonPath, `${collectionName}.bson`);
      const metadataFile = join(bsonPath, `${collectionName}.metadata.json`);
      
      console.log(`\n📦 Collection: ${collectionName}`);
      
      if (!existsSync(bsonFile)) {
        console.log('   ❌ Fichier BSON non trouvé');
        continue;
      }
      
      // Taille du fichier BSON
      const bsonStats = statSync(bsonFile);
      const sizeKB = Math.round(bsonStats.size / 1024);
      console.log(`   📄 Taille BSON: ${sizeKB} KB`);
      
      // Lire les métadonnées si disponibles
      if (existsSync(metadataFile)) {
        try {
          const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'));
          if (metadata.options) {
            console.log(`   📋 Métadonnées: ${JSON.stringify(metadata.options)}`);
          }
        } catch (error) {
          console.log('   ⚠️  Erreur lecture métadonnées');
        }
      }
      
      // Compter les documents existants en production
      try {
        const collection = db.collection(collectionName);
        const existingCount = await collection.countDocuments({});
        console.log(`   🏭 En production: ${existingCount} documents`);
        
        // Estimer le nombre de documents dans le BSON (approximatif)
        if (sizeKB > 0) {
          const estimatedDocs = Math.round(sizeKB / 2); // Estimation très approximative
          console.log(`   📊 Estimation BSON: ~${estimatedDocs} documents`);
        }
        
      } catch (error) {
        console.log(`   ❌ Erreur vérification production: ${error.message}`);
      }
    }
    
    console.log('\n💡 RECOMMANDATIONS');
    console.log('==================');
    console.log('1. Les fichiers BSON contiennent des données binaires MongoDB');
    console.log('2. Utilisez restore-from-bson-backup.js pour la restauration');
    console.log('3. La restauration nécessite mongorestore installé sur le serveur');
    console.log('4. Testez d\'abord en mode simulation');
    
    console.log('\nCommandes suggérées:');
    console.log(`   node scripts/restore-from-bson-backup.js --backup-date=${backupDate}`);
    console.log(`   node scripts/restore-from-bson-backup.js --backup-date=${backupDate} --apply`);
    
  } catch (error) {
    console.error('❌ Erreur lors de l\'analyse:', error.message);
  } finally {
    await client.close();
  }
}

// Analyser les arguments de ligne de commande
const args = process.argv.slice(2);
const backupDateArg = args.find(arg => arg.startsWith('--backup-date='));
const backupDate = backupDateArg ? backupDateArg.split('=')[1] : '2025-09-17_06-49-52-607Z';

console.log('🔍 Script d\'analyse de sauvegarde BSON');
console.log('=====================================');
console.log('\nOptions disponibles:');
console.log('  --backup-date=YYYY-MM-DD_HH-mm-ss  Date de la sauvegarde à analyser');
console.log('\nExemples:');
console.log('  node scripts/analyze-bson-backup.js');
console.log('  node scripts/analyze-bson-backup.js --backup-date=2025-09-17_06-49-52-607Z');

analyzeBsonBackup(backupDate).catch(console.error);
