#!/usr/bin/env node

/**
 * Script de vérification des workspaceId en production
 * Vérifie que toutes les collections qui doivent avoir un workspaceId l'ont bien
 * Usage: node scripts/verify-workspace-ids.js [--fix]
 */

import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration MongoDB pour la production
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}
const DB_NAME = 'newbi'; // Base de données de production

// Collections qui doivent avoir un workspaceId
const COLLECTIONS_WITH_WORKSPACE_ID = [
  'invoices',
  'quotes', 
  'clients',
  'expenses',
  'creditnotes',
  'emailsignatures',
  'documentsettings',
  'apimetrics',
  'accountbankings',
  'ocrdocuments',
  'boards',
  'columns',
  'tasks',
  'transactions',
  'products',
  'events',
  'filetransfers',
  'integrations',
  'downloadevents',
  'accessgrants'
];

// Collections qui ne doivent PAS avoir de workspaceId
const COLLECTIONS_WITHOUT_WORKSPACE_ID = [
  'user',
  'users',
  'organization',
  'member',
  'subscription',
  'session',
  'account',
  'verification',
  'jwks',
  'stripeconnectaccounts',
  'referralevents'
];

async function verifyWorkspaceIds(shouldFix = false) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('🚀 Démarrage de la vérification des workspaceId...\n');
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    const results = {
      total: 0,
      verified: 0,
      missing: 0,
      errors: 0,
      collections: {}
    };
    
    // Vérifier chaque collection
    for (const collectionName of COLLECTIONS_WITH_WORKSPACE_ID) {
      console.log(`\n📋 Vérification de la collection: ${collectionName}`);
      
      try {
        const collection = db.collection(collectionName);
        
        // Vérifier si la collection existe
        const collectionExists = await db.listCollections({ name: collectionName }).hasNext();
        if (!collectionExists) {
          console.log(`⚠️  Collection ${collectionName} n'existe pas`);
          results.collections[collectionName] = {
            exists: false,
            total: 0,
            withWorkspaceId: 0,
            withoutWorkspaceId: 0
          };
          continue;
        }
        
        // Compter le total de documents
        const totalDocs = await collection.countDocuments();
        
        // Compter les documents avec workspaceId
        const docsWithWorkspaceId = await collection.countDocuments({
          workspaceId: { $exists: true, $ne: null }
        });
        
        // Compter les documents sans workspaceId
        const docsWithoutWorkspaceId = totalDocs - docsWithWorkspaceId;
        
        results.total += totalDocs;
        results.verified += docsWithWorkspaceId;
        results.missing += docsWithoutWorkspaceId;
        
        results.collections[collectionName] = {
          exists: true,
          total: totalDocs,
          withWorkspaceId: docsWithWorkspaceId,
          withoutWorkspaceId: docsWithoutWorkspaceId
        };
        
        if (docsWithoutWorkspaceId > 0) {
          console.log(`❌ ${docsWithoutWorkspaceId}/${totalDocs} documents sans workspaceId`);
          
          // Afficher quelques exemples de documents sans workspaceId
          const sampleDocs = await collection.find(
            { workspaceId: { $exists: false } },
            { projection: { _id: 1, createdAt: 1, createdBy: 1 } }
          ).limit(3).toArray();
          
          console.log('   Exemples de documents sans workspaceId:');
          sampleDocs.forEach(doc => {
            console.log(`   - ID: ${doc._id}, createdAt: ${doc.createdAt || 'N/A'}, createdBy: ${doc.createdBy || 'N/A'}`);
          });
          
          if (shouldFix) {
            console.log('🔧 Mode correction activé - tentative de correction...');
            // TODO: Implémenter la logique de correction si nécessaire
            console.log('⚠️  Correction non implémentée - nécessite une logique spécifique par collection');
          }
        } else {
          console.log(`✅ ${totalDocs} documents avec workspaceId`);
        }
        
      } catch (error) {
        console.error(`❌ Erreur lors de la vérification de ${collectionName}:`, error.message);
        results.errors++;
      }
    }
    
    // Vérifier les collections qui ne doivent PAS avoir de workspaceId
    console.log('\n\n🔍 Vérification des collections sans workspaceId...');
    for (const collectionName of COLLECTIONS_WITHOUT_WORKSPACE_ID) {
      try {
        const collection = db.collection(collectionName);
        
        const collectionExists = await db.listCollections({ name: collectionName }).hasNext();
        if (!collectionExists) {
          continue;
        }
        
        const docsWithWorkspaceId = await collection.countDocuments({
          workspaceId: { $exists: true, $ne: null }
        });
        
        if (docsWithWorkspaceId > 0) {
          console.log(`⚠️  ${collectionName}: ${docsWithWorkspaceId} documents ont un workspaceId (ne devrait pas)`);
        } else {
          console.log(`✅ ${collectionName}: Aucun workspaceId (correct)`);
        }
        
      } catch (error) {
        console.error(`❌ Erreur lors de la vérification de ${collectionName}:`, error.message);
      }
    }
    
    // Résumé final
    console.log('\n\n📊 RÉSUMÉ DE LA VÉRIFICATION');
    console.log('=====================================');
    console.log(`📄 Total documents vérifiés: ${results.total}`);
    console.log(`✅ Documents avec workspaceId: ${results.verified}`);
    console.log(`❌ Documents sans workspaceId: ${results.missing}`);
    console.log(`⚠️  Erreurs rencontrées: ${results.errors}`);
    
    if (results.missing > 0) {
      console.log(`\n🚨 ATTENTION: ${results.missing} documents n'ont pas de workspaceId !`);
      console.log('Ces documents ne seront pas accessibles dans l\'application.');
      console.log('Utilisez --fix pour tenter une correction automatique (si disponible).');
    } else {
      console.log('\n🎉 Toutes les collections ont des workspaceId corrects !');
    }
    
    // Détail par collection
    console.log('\n📋 DÉTAIL PAR COLLECTION');
    console.log('========================');
    Object.entries(results.collections).forEach(([name, data]) => {
      if (!data.exists) {
        console.log(`${name}: Collection n'existe pas`);
      } else if (data.withoutWorkspaceId > 0) {
        console.log(`${name}: ${data.withoutWorkspaceId}/${data.total} documents sans workspaceId ❌`);
      } else {
        console.log(`${name}: ${data.total} documents OK ✅`);
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur générale:', error);
  } finally {
    await client.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

// Récupérer les arguments de ligne de commande
const shouldFix = process.argv.includes('--fix');

if (shouldFix) {
  console.log('⚠️  Mode correction activé');
} else {
  console.log('ℹ️  Mode vérification uniquement (utilisez --fix pour corriger)');
}

verifyWorkspaceIds(shouldFix);
