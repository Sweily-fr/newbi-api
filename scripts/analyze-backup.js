#!/usr/bin/env node

/**
 * Script d'analyse du contenu d'une sauvegarde
 * Permet de voir ce qui sera restauré avant de lancer la restauration
 * Usage: node scripts/analyze-backup.js [--backup-date=2025-09-17_06-49-52-607Z]
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';
const BACKUP_BASE_PATH = '/home/joaquim/api.newbi.fr/backup';

async function loadBackupFile(filePath, collectionName) {
  // Essayer plusieurs emplacements possibles
  const possiblePaths = [
    filePath, // Chemin direct
    join(filePath.replace(`${collectionName}.json`, ''), 'json_exports', `${collectionName}.json`), // Dans json_exports
    join(filePath.replace(`${collectionName}.json`, ''), 'newbi', `${collectionName}.json`) // Dans newbi
  ];
  
  let actualPath = null;
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      actualPath = path;
      break;
    
    const analysis = {
      name: collectionName,
      totalDocuments: documents.length,
      withWorkspaceId: 0,
      withoutWorkspaceId: 0,
      creators: new Set(),
      dateRange: { oldest: null, newest: null },
      sampleDocuments: documents.slice(0, 3).map(doc => ({
        id: doc._id?.$oid || 'unknown',
        createdBy: doc.createdBy?.$oid || 'unknown',
        createdAt: doc.createdAt?.$date || 'unknown',
        hasWorkspaceId: !!doc.workspaceId
      }))
    };
    
    documents.forEach(doc => {
      // Compter workspaceId
      if (doc.workspaceId) {
        analysis.withWorkspaceId++;
      } else {
        analysis.withoutWorkspaceId++;
      }
      
      // Collecter les créateurs
      if (doc.createdBy?.$oid) {
        analysis.creators.add(doc.createdBy.$oid);
      }
      
      // Analyser les dates
      if (doc.createdAt?.$date) {
        const date = new Date(doc.createdAt.$date);
        if (!analysis.dateRange.oldest || date < analysis.dateRange.oldest) {
          analysis.dateRange.oldest = date;
        }
        if (!analysis.dateRange.newest || date > analysis.dateRange.newest) {
          analysis.dateRange.newest = date;
        }
      }
    });
    
    analysis.uniqueCreators = analysis.creators.size;
    
    return analysis;
    
  } catch (error) {
    console.error(`❌ Erreur lors de l'analyse de ${filePath}:`, error.message);
    return null;
  }
}

async function checkExistingDocuments(db, backupAnalysis) {
  console.log('\n🔍 Vérification des documents existants en production...');
  
  for (const analysis of backupAnalysis) {
    if (!analysis) continue;
    
    try {
      const collection = db.collection(analysis.name);
      const existingCount = await collection.countDocuments({});
      
      console.log(`📊 ${analysis.name}:`);
      console.log(`   - En production: ${existingCount} documents`);
      console.log(`   - Dans la sauvegarde: ${analysis.totalDocuments} documents`);
      
      // Vérifier quelques documents spécifiques
      let duplicates = 0;
      for (const sample of analysis.sampleDocuments) {
        if (sample.id !== 'unknown') {
          const exists = await collection.findOne({ _id: new ObjectId(sample.id) });
          if (exists) duplicates++;
        }
      }
      
      if (duplicates > 0) {
        console.log(`   ⚠️  ${duplicates}/${analysis.sampleDocuments.length} documents échantillons existent déjà`);
      }
      
    } catch (error) {
      console.error(`❌ Erreur lors de la vérification de ${analysis.name}:`, error.message);
    }
  }
}

async function analyzeBackup(backupDate) {
  console.log('🔍 Analyse du contenu de la sauvegarde');
  console.log('=====================================');
  console.log(`📅 Date de sauvegarde: ${backupDate}`);
  
  const backupPath = join(BACKUP_BASE_PATH, `backup_${backupDate}`);
  console.log(`📁 Chemin: ${backupPath}`);
  
  if (!existsSync(backupPath)) {
    console.error(`❌ Dossier de sauvegarde non trouvé: ${backupPath}`);
    return;
  }
  
  // Lister tous les fichiers de sauvegarde
  console.log('\n📋 Fichiers disponibles dans la sauvegarde:');
  const files = readdirSync(backupPath).filter(f => f.endsWith('.json'));
  files.forEach(file => {
    console.log(`   - ${file}`);
  });
  
  // Analyser les collections principales
  const collectionsToAnalyze = ['invoices', 'quotes', 'clients', 'products', 'expenses'];
  const backupAnalysis = [];
  
  console.log('\n📊 ANALYSE DÉTAILLÉE');
  console.log('===================');
  
  for (const collectionName of collectionsToAnalyze) {
    const filePath = join(backupPath, `${collectionName}.json`);
    const analysis = analyzeBackupFile(filePath, collectionName);
    
    if (analysis) {
      backupAnalysis.push(analysis);
      
      console.log(`\n📦 Collection: ${analysis.name}`);
      console.log(`   📄 Total documents: ${analysis.totalDocuments}`);
      console.log(`   ✅ Avec workspaceId: ${analysis.withWorkspaceId}`);
      console.log(`   ❌ Sans workspaceId: ${analysis.withoutWorkspaceId}`);
      console.log(`   👥 Créateurs uniques: ${analysis.uniqueCreators}`);
      
      if (analysis.dateRange.oldest && analysis.dateRange.newest) {
        console.log(`   📅 Période: ${analysis.dateRange.oldest.toLocaleDateString()} - ${analysis.dateRange.newest.toLocaleDateString()}`);
      }
      
      if (analysis.sampleDocuments.length > 0) {
        console.log(`   📋 Échantillons:`);
        analysis.sampleDocuments.forEach(sample => {
          console.log(`      - ID: ${sample.id.substring(0, 8)}... | Créé par: ${sample.createdBy.substring(0, 8)}... | WorkspaceId: ${sample.hasWorkspaceId ? '✅' : '❌'}`);
        });
      }
    } else {
      console.log(`\n📦 Collection: ${collectionName}`);
      console.log(`   ❌ Fichier non trouvé ou erreur`);
    }
  }
  
  // Résumé global
  const totalDocuments = backupAnalysis.reduce((sum, a) => sum + (a?.totalDocuments || 0), 0);
  const totalWithWorkspace = backupAnalysis.reduce((sum, a) => sum + (a?.withWorkspaceId || 0), 0);
  const totalWithoutWorkspace = backupAnalysis.reduce((sum, a) => sum + (a?.withoutWorkspaceId || 0), 0);
  
  console.log('\n📈 RÉSUMÉ GLOBAL');
  console.log('===============');
  console.log(`📄 Total documents dans la sauvegarde: ${totalDocuments}`);
  console.log(`✅ Documents avec workspaceId: ${totalWithWorkspace} (${Math.round((totalWithWorkspace/totalDocuments)*100)}%)`);
  console.log(`❌ Documents sans workspaceId: ${totalWithoutWorkspace} (${Math.round((totalWithoutWorkspace/totalDocuments)*100)}%)`);
  
  // Vérifier les documents existants en production
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    await checkExistingDocuments(db, backupAnalysis);
  } catch (error) {
    console.error('❌ Erreur lors de la vérification en production:', error.message);
  } finally {
    await client.close();
  }
  
  console.log('\n💡 RECOMMANDATIONS');
  console.log('==================');
  console.log('1. Vérifiez que les documents sans workspaceId peuvent être corrigés');
  console.log('2. Utilisez restore-from-backup.js en mode simulation d\'abord');
  console.log('3. Les documents existants seront automatiquement ignorés');
  console.log('\nCommandes suggérées:');
  console.log(`   node scripts/restore-from-backup.js --backup-date=${backupDate}`);
  console.log(`   node scripts/restore-from-backup.js --backup-date=${backupDate} --apply`);
}

// Analyser les arguments de ligne de commande
const args = process.argv.slice(2);
const backupDateArg = args.find(arg => arg.startsWith('--backup-date='));
const backupDate = backupDateArg ? backupDateArg.split('=')[1] : '2025-09-17_06-49-52-607Z';

console.log('🔍 Script d\'analyse de sauvegarde');
console.log('=================================');
console.log('\nOptions disponibles:');
console.log('  --backup-date=YYYY-MM-DD_HH-mm-ss  Date de la sauvegarde à analyser');
console.log('\nExemples:');
console.log('  node scripts/analyze-backup.js');
console.log('  node scripts/analyze-backup.js --backup-date=2025-09-17_06-49-52-607Z');

analyzeBackup(backupDate).catch(console.error);
