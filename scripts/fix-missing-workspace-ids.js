#!/usr/bin/env node

/**
 * Script de correction des workspaceId manquants
 * Utilise les relations existantes (createdBy, userId) pour assigner les workspaceId corrects
 * Usage: node scripts/fix-missing-workspace-ids.js [--dry-run] [--collection=collectionName]
 */

import { MongoClient, ObjectId } from 'mongodb';

// Configuration MongoDB pour la production
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:newbi2024@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';

// Mapping des stratégies de correction par collection
const CORRECTION_STRATEGIES = {
  invoices: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  quotes: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  clients: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  expenses: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  creditnotes: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  emailsignatures: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  documentsettings: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  ocrdocuments: {
    strategy: 'userId_to_workspace',
    description: 'Utilise userId pour trouver le workspace de l\'utilisateur'
  },
  boards: {
    strategy: 'userId_to_workspace',
    description: 'Utilise userId pour trouver le workspace de l\'utilisateur'
  },
  columns: {
    strategy: 'boardId_to_workspace',
    description: 'Utilise boardId pour trouver le workspace du board parent'
  },
  tasks: {
    strategy: 'boardId_to_workspace',
    description: 'Utilise boardId pour trouver le workspace du board parent'
  },
  products: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  },
  events: {
    strategy: 'createdBy_to_workspace',
    description: 'Utilise createdBy pour trouver le workspace de l\'utilisateur'
  }
};

async function getUserWorkspace(db, userId) {
  try {
    // Chercher dans la collection user
    const user = await db.collection('user').findOne({ _id: new ObjectId(userId) });
    if (user && user.workspaceId) {
      return user.workspaceId;
    }
    
    // Chercher dans la collection member pour trouver l'organisation
    const member = await db.collection('member').findOne({ userId: userId.toString() });
    if (member && member.organizationId) {
      return member.organizationId;
    }
    
    return null;
  } catch (error) {
    console.error(`Erreur lors de la recherche du workspace pour l'utilisateur ${userId}:`, error.message);
    return null;
  }
}

async function getBoardWorkspace(db, boardId) {
  try {
    const board = await db.collection('boards').findOne({ _id: new ObjectId(boardId) });
    return board ? board.workspaceId : null;
  } catch (error) {
    console.error(`Erreur lors de la recherche du workspace pour le board ${boardId}:`, error.message);
    return null;
  }
}

async function fixCollection(db, collectionName, strategy, isDryRun = true) {
  console.log(`\n🔧 Correction de la collection: ${collectionName}`);
  console.log(`📋 Stratégie: ${strategy.description}`);
  
  const collection = db.collection(collectionName);
  
  // Trouver les documents sans workspaceId
  const docsWithoutWorkspace = await collection.find({
    workspaceId: { $exists: false }
  }).toArray();
  
  if (docsWithoutWorkspace.length === 0) {
    console.log('✅ Aucun document à corriger');
    return { fixed: 0, errors: 0 };
  }
  
  console.log(`📄 ${docsWithoutWorkspace.length} documents à corriger`);
  
  let fixed = 0;
  let errors = 0;
  
  for (const doc of docsWithoutWorkspace) {
    try {
      let workspaceId = null;
      
      switch (strategy.strategy) {
        case 'createdBy_to_workspace':
          if (doc.createdBy) {
            workspaceId = await getUserWorkspace(db, doc.createdBy);
          }
          break;
          
        case 'userId_to_workspace':
          if (doc.userId) {
            workspaceId = await getUserWorkspace(db, doc.userId);
          }
          break;
          
        case 'boardId_to_workspace':
          if (doc.boardId) {
            workspaceId = await getBoardWorkspace(db, doc.boardId);
          }
          break;
      }
      
      if (workspaceId) {
        if (!isDryRun) {
          await collection.updateOne(
            { _id: doc._id },
            { $set: { workspaceId: new ObjectId(workspaceId) } }
          );
        }
        
        console.log(`${isDryRun ? '🔍' : '✅'} Document ${doc._id}: workspaceId ${workspaceId} ${isDryRun ? '(simulation)' : '(appliqué)'}`);
        fixed++;
      } else {
        console.log(`❌ Document ${doc._id}: impossible de déterminer le workspaceId`);
        errors++;
      }
      
    } catch (error) {
      console.error(`❌ Erreur pour le document ${doc._id}:`, error.message);
      errors++;
    }
  }
  
  return { fixed, errors };
}

async function fixMissingWorkspaceIds(isDryRun = true, targetCollection = null) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('🚀 Démarrage de la correction des workspaceId...');
    console.log(`📋 Mode: ${isDryRun ? 'SIMULATION (dry-run)' : 'CORRECTION RÉELLE'}`);
    if (targetCollection) {
      console.log(`🎯 Collection ciblée: ${targetCollection}`);
    }
    console.log('');
    
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    const totalResults = { fixed: 0, errors: 0 };
    
    // Déterminer les collections à traiter
    const collectionsToProcess = targetCollection 
      ? [targetCollection]
      : Object.keys(CORRECTION_STRATEGIES);
    
    for (const collectionName of collectionsToProcess) {
      const strategy = CORRECTION_STRATEGIES[collectionName];
      
      if (!strategy) {
        console.log(`⚠️  Aucune stratégie définie pour ${collectionName}`);
        continue;
      }
      
      // Vérifier si la collection existe
      const collectionExists = await db.listCollections({ name: collectionName }).hasNext();
      if (!collectionExists) {
        console.log(`⚠️  Collection ${collectionName} n'existe pas`);
        continue;
      }
      
      const result = await fixCollection(db, collectionName, strategy, isDryRun);
      totalResults.fixed += result.fixed;
      totalResults.errors += result.errors;
    }
    
    // Résumé final
    console.log('\n📊 RÉSUMÉ DE LA CORRECTION');
    console.log('===========================');
    console.log(`✅ Documents ${isDryRun ? 'identifiés pour correction' : 'corrigés'}: ${totalResults.fixed}`);
    console.log(`❌ Erreurs rencontrées: ${totalResults.errors}`);
    
    if (isDryRun && totalResults.fixed > 0) {
      console.log('\n💡 Pour appliquer les corrections, relancez sans --dry-run');
    } else if (!isDryRun && totalResults.fixed > 0) {
      console.log('\n🎉 Corrections appliquées avec succès !');
      console.log('💡 Relancez le script verify-workspace-ids.js pour vérifier');
    }
    
  } catch (error) {
    console.error('❌ Erreur générale:', error);
  } finally {
    await client.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

// Analyser les arguments de ligne de commande
const args = process.argv.slice(2);
const isDryRun = !args.includes('--apply');
const collectionArg = args.find(arg => arg.startsWith('--collection='));
const targetCollection = collectionArg ? collectionArg.split('=')[1] : null;

console.log('🔧 Script de correction des workspaceId manquants');
console.log('================================================');

if (isDryRun) {
  console.log('ℹ️  Mode SIMULATION activé (aucune modification ne sera appliquée)');
  console.log('💡 Utilisez --apply pour appliquer les corrections');
} else {
  console.log('⚠️  Mode CORRECTION RÉELLE activé');
  console.log('🚨 Les modifications seront appliquées en base de données !');
}

if (targetCollection) {
  console.log(`🎯 Collection ciblée: ${targetCollection}`);
} else {
  console.log('🌍 Toutes les collections seront traitées');
}

console.log('\nOptions disponibles:');
console.log('  --apply                    Appliquer les corrections (sinon simulation)');
console.log('  --collection=nom           Traiter uniquement cette collection');
console.log('\nExemples:');
console.log('  node scripts/fix-missing-workspace-ids.js');
console.log('  node scripts/fix-missing-workspace-ids.js --apply');
console.log('  node scripts/fix-missing-workspace-ids.js --collection=invoices --apply');

// Fonction principale async
async function main() {
  // Demander confirmation si ce n'est pas un dry-run
  if (!isDryRun) {
    console.log('\n⚠️  ATTENTION: Vous êtes sur le point de modifier la base de données de production !');
    console.log('Appuyez sur Ctrl+C pour annuler, ou attendez 5 secondes pour continuer...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  await fixMissingWorkspaceIds(isDryRun, targetCollection);
}

main().catch(console.error);
