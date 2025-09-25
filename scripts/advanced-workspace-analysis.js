#!/usr/bin/env node

/**
 * Script d'analyse avancée pour trouver les workspaceId manquants
 * Utilise toutes les relations possibles : member, organization, user, users (ancienne)
 * Usage: node scripts/advanced-workspace-analysis.js [--apply]
 */

import { MongoClient, ObjectId } from 'mongodb';

// Configuration MongoDB pour la production
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';

// Cache pour optimiser les requêtes
const userCache = new Map();
const memberCache = new Map();
const organizationCache = new Map();

async function buildCaches(db) {
  console.log('🔄 Construction des caches de relations...');
  
  // Cache des utilisateurs (nouvelle collection)
  const users = await db.collection('user').find({}).toArray();
  users.forEach(user => {
    userCache.set(user._id.toString(), {
      workspaceId: user.workspaceId,
      email: user.email,
      name: user.name
    });
  });
  console.log(`📋 Cache user: ${users.length} utilisateurs`);
  
  // Cache des utilisateurs (ancienne collection)
  try {
    const oldUsers = await db.collection('users').find({}).toArray();
    oldUsers.forEach(user => {
      if (!userCache.has(user._id.toString())) {
        userCache.set(user._id.toString(), {
          workspaceId: user.workspaceId,
          email: user.email,
          name: user.name,
          source: 'old_users'
        });
      }
    });
    console.log(`📋 Cache users (ancienne): ${oldUsers.length} utilisateurs`);
  } catch (error) {
    console.log('⚠️  Collection users (ancienne) non trouvée');
  }
  
  // Cache des membres
  const members = await db.collection('member').find({}).toArray();
  members.forEach(member => {
    const userId = member.userId?.toString() || member.user?.toString();
    if (userId) {
      memberCache.set(userId, {
        organizationId: member.organizationId,
        role: member.role,
        status: member.status
      });
    }
  });
  console.log(`📋 Cache member: ${members.length} relations`);
  
  // Cache des organisations
  const organizations = await db.collection('organization').find({}).toArray();
  organizations.forEach(org => {
    organizationCache.set(org._id.toString(), {
      name: org.name,
      slug: org.slug,
      ownerId: org.ownerId
    });
  });
  console.log(`📋 Cache organization: ${organizations.length} organisations`);
}

async function findWorkspaceForUser(userId) {
  const userIdStr = userId.toString();
  
  // 1. Vérifier dans le cache user direct
  const userInfo = userCache.get(userIdStr);
  if (userInfo?.workspaceId) {
    return {
      workspaceId: userInfo.workspaceId,
      method: `user.workspaceId${userInfo.source ? ' (ancienne collection)' : ''}`,
      confidence: 'high'
    };
  }
  
  // 2. Vérifier via member -> organization
  const memberInfo = memberCache.get(userIdStr);
  if (memberInfo?.organizationId) {
    return {
      workspaceId: memberInfo.organizationId,
      method: 'member.organizationId',
      confidence: 'high'
    };
  }
  
  // 3. Chercher par email dans les autres utilisateurs
  if (userInfo?.email) {
    for (const [otherUserId, otherUserInfo] of userCache.entries()) {
      if (otherUserInfo.email === userInfo.email && otherUserInfo.workspaceId && otherUserId !== userIdStr) {
        return {
          workspaceId: otherUserInfo.workspaceId,
          method: 'email_match',
          confidence: 'medium'
        };
      }
    }
  }
  
  // 4. Si c'est un owner d'organisation
  for (const [orgId, orgInfo] of organizationCache.entries()) {
    if (orgInfo.ownerId?.toString() === userIdStr) {
      return {
        workspaceId: new ObjectId(orgId),
        method: 'organization.ownerId',
        confidence: 'high'
      };
    }
  }
  
  return null;
}

async function analyzeCollection(db, collectionName, strategy, isDryRun = true) {
  console.log(`\n🔍 Analyse avancée de la collection: ${collectionName}`);
  
  const collection = db.collection(collectionName);
  
  // Trouver les documents sans workspaceId
  const docsWithoutWorkspace = await collection.find({
    workspaceId: { $exists: false }
  }).toArray();
  
  if (docsWithoutWorkspace.length === 0) {
    console.log('✅ Aucun document à analyser');
    return { analyzed: 0, found: 0, applied: 0 };
  }
  
  console.log(`📄 ${docsWithoutWorkspace.length} documents à analyser`);
  
  let analyzed = 0;
  let found = 0;
  let applied = 0;
  
  for (const doc of docsWithoutWorkspace) {
    analyzed++;
    
    let result = null;
    let userId = null;
    
    // Déterminer l'userId selon la stratégie
    switch (strategy) {
      case 'createdBy':
        userId = doc.createdBy;
        break;
      case 'userId':
        userId = doc.userId;
        break;
      case 'user':
        userId = doc.user;
        break;
    }
    
    if (userId) {
      result = await findWorkspaceForUser(userId);
    }
    
    if (result) {
      found++;
      
      const confidence = result.confidence === 'high' ? '🟢' : '🟡';
      console.log(`${confidence} Document ${doc._id}: workspaceId ${result.workspaceId} (${result.method}) ${isDryRun ? '(simulation)' : '(appliqué)'}`);
      
      if (!isDryRun) {
        try {
          await collection.updateOne(
            { _id: doc._id },
            { $set: { workspaceId: new ObjectId(result.workspaceId) } }
          );
          applied++;
        } catch (error) {
          console.error(`❌ Erreur lors de la mise à jour de ${doc._id}:`, error.message);
        }
      }
    } else {
      console.log(`❌ Document ${doc._id}: aucune relation trouvée (userId: ${userId})`);
    }
  }
  
  return { analyzed, found, applied };
}

async function advancedWorkspaceAnalysis(isDryRun = true, targetCollection = null) {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('🚀 Analyse avancée des workspaceId manquants...');
    console.log(`📋 Mode: ${isDryRun ? 'SIMULATION (dry-run)' : 'CORRECTION RÉELLE'}`);
    if (targetCollection) {
      console.log(`🎯 Collection ciblée: ${targetCollection}`);
    }
    console.log('');
    
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    
    // Construire les caches de relations
    await buildCaches(db);
    
    // Collections à analyser avec leurs stratégies
    const collectionsToAnalyze = {
      clients: 'createdBy',
      expenses: 'createdBy', // Essayer createdBy d'abord
      emailsignatures: 'createdBy',
      documentsettings: 'createdBy',
      products: 'createdBy',
      filetransfers: 'userId', // Pas de createdBy, essayer userId
      // Ajouter d'autres collections si nécessaire
    };
    
    const totalResults = { analyzed: 0, found: 0, applied: 0 };
    
    // Déterminer les collections à traiter
    const collectionsToProcess = targetCollection 
      ? { [targetCollection]: collectionsToAnalyze[targetCollection] || 'createdBy' }
      : collectionsToAnalyze;
    
    for (const [collectionName, strategy] of Object.entries(collectionsToProcess)) {
      // Vérifier si la collection existe
      const collectionExists = await db.listCollections({ name: collectionName }).hasNext();
      if (!collectionExists) {
        console.log(`⚠️  Collection ${collectionName} n'existe pas`);
        continue;
      }
      
      const result = await analyzeCollection(db, collectionName, strategy, isDryRun);
      totalResults.analyzed += result.analyzed;
      totalResults.found += result.found;
      totalResults.applied += result.applied;
    }
    
    // Résumé final
    console.log('\n📊 RÉSUMÉ DE L\'ANALYSE AVANCÉE');
    console.log('===============================');
    console.log(`📄 Documents analysés: ${totalResults.analyzed}`);
    console.log(`✅ Relations trouvées: ${totalResults.found}`);
    if (!isDryRun) {
      console.log(`🔧 Corrections appliquées: ${totalResults.applied}`);
    }
    console.log(`📈 Taux de réussite: ${totalResults.analyzed > 0 ? Math.round((totalResults.found / totalResults.analyzed) * 100) : 0}%`);
    
    if (isDryRun && totalResults.found > 0) {
      console.log('\n💡 Pour appliquer les corrections, relancez avec --apply');
    } else if (!isDryRun && totalResults.applied > 0) {
      console.log('\n🎉 Corrections appliquées avec succès !');
      console.log('💡 Relancez verify-workspace-ids.js pour vérifier les résultats');
    }
    
    // Afficher les statistiques des caches
    console.log('\n📋 STATISTIQUES DES RELATIONS');
    console.log('=============================');
    console.log(`👥 Utilisateurs dans le cache: ${userCache.size}`);
    console.log(`🔗 Relations member trouvées: ${memberCache.size}`);
    console.log(`🏢 Organisations trouvées: ${organizationCache.size}`);
    
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

console.log('🔍 Script d\'analyse avancée des workspaceId manquants');
console.log('===================================================');

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
  console.log('🌍 Toutes les collections problématiques seront analysées');
}

console.log('\nCe script utilise une analyse multi-relations :');
console.log('  📋 Collection user (nouvelle)');
console.log('  📋 Collection users (ancienne)');
console.log('  🔗 Collection member');
console.log('  🏢 Collection organization');
console.log('  📧 Correspondance par email');
console.log('  👑 Propriétaires d\'organisation');

// Fonction principale async
async function main() {
  // Demander confirmation si ce n'est pas un dry-run
  if (!isDryRun) {
    console.log('\n⚠️  ATTENTION: Vous êtes sur le point de modifier la base de données de production !');
    console.log('Appuyez sur Ctrl+C pour annuler, ou attendez 5 secondes pour continuer...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  await advancedWorkspaceAnalysis(isDryRun, targetCollection);
}

main().catch(console.error);
