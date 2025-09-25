#!/usr/bin/env node

/**
 * Script d'analyse des utilisateurs orphelins
 * Analyse spécifiquement l'utilisateur 68123a82e90c4f5d520a4222 et autres utilisateurs problématiques
 */

import { MongoClient, ObjectId } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';

async function analyzeOrphanUsers() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    
    // Utilisateurs problématiques identifiés
    const problematicUsers = [
      '68123a82e90c4f5d520a4222', // Utilisateur principal orphelin
      '68cd422bae6d99144724d8b6'  // Autre utilisateur orphelin
    ];
    
    console.log('🔍 ANALYSE DES UTILISATEURS ORPHELINS');
    console.log('====================================\n');
    
    for (const userId of problematicUsers) {
      console.log(`👤 Analyse de l'utilisateur: ${userId}`);
      console.log('─'.repeat(50));
      
      // 1. Vérifier dans la collection user
      const user = await db.collection('user').findOne({ _id: new ObjectId(userId) });
      if (user) {
        console.log('📋 Trouvé dans collection "user":');
        console.log(`   - Email: ${user.email}`);
        console.log(`   - Nom: ${user.name}`);
        console.log(`   - WorkspaceId: ${user.workspaceId || 'MANQUANT ❌'}`);
        console.log(`   - Créé le: ${user.createdAt}`);
      } else {
        console.log('❌ Non trouvé dans collection "user"');
      }
      
      // 2. Vérifier dans l'ancienne collection users
      try {
        const oldUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        if (oldUser) {
          console.log('📋 Trouvé dans ancienne collection "users":');
          console.log(`   - Email: ${oldUser.email}`);
          console.log(`   - Nom: ${oldUser.name}`);
          console.log(`   - WorkspaceId: ${oldUser.workspaceId || 'MANQUANT ❌'}`);
        } else {
          console.log('❌ Non trouvé dans ancienne collection "users"');
        }
      } catch (error) {
        console.log('⚠️  Ancienne collection "users" non accessible');
      }
      
      // 3. Vérifier dans member
      const member = await db.collection('member').findOne({ 
        $or: [
          { userId: userId },
          { userId: new ObjectId(userId) },
          { user: userId },
          { user: new ObjectId(userId) }
        ]
      });
      
      if (member) {
        console.log('🔗 Trouvé dans collection "member":');
        console.log(`   - OrganizationId: ${member.organizationId}`);
        console.log(`   - Rôle: ${member.role}`);
        console.log(`   - Statut: ${member.status}`);
        
        // Vérifier l'organisation correspondante
        const org = await db.collection('organization').findOne({ _id: new ObjectId(member.organizationId) });
        if (org) {
          console.log('🏢 Organisation correspondante:');
          console.log(`   - Nom: ${org.name}`);
          console.log(`   - Slug: ${org.slug}`);
          console.log(`   - Owner: ${org.ownerId}`);
          console.log(`   ✅ SOLUTION: Utiliser organizationId ${member.organizationId} comme workspaceId`);
        }
      } else {
        console.log('❌ Non trouvé dans collection "member"');
      }
      
      // 4. Vérifier si c'est un owner d'organisation
      const ownedOrg = await db.collection('organization').findOne({ ownerId: new ObjectId(userId) });
      if (ownedOrg) {
        console.log('👑 Propriétaire d\'organisation:');
        console.log(`   - Organisation: ${ownedOrg.name} (${ownedOrg._id})`);
        console.log(`   ✅ SOLUTION: Utiliser son propre organizationId ${ownedOrg._id} comme workspaceId`);
      }
      
      // 5. Compter les documents affectés
      const collections = ['clients', 'expenses', 'emailsignatures', 'documentsettings', 'products'];
      let totalAffected = 0;
      
      console.log('📊 Documents affectés par cet utilisateur:');
      for (const collName of collections) {
        try {
          const count = await db.collection(collName).countDocuments({ 
            createdBy: new ObjectId(userId),
            workspaceId: { $exists: false }
          });
          if (count > 0) {
            console.log(`   - ${collName}: ${count} documents`);
            totalAffected += count;
          }
        } catch (error) {
          // Collection n'existe pas
        }
      }
      console.log(`   📈 Total: ${totalAffected} documents sans workspaceId`);
      
      console.log('\n');
    }
    
    // Analyse globale des utilisateurs sans workspace
    console.log('🌍 ANALYSE GLOBALE DES UTILISATEURS SANS WORKSPACE');
    console.log('=================================================');
    
    const usersWithoutWorkspace = await db.collection('user').find({ 
      workspaceId: { $exists: false } 
    }).toArray();
    
    console.log(`👥 Utilisateurs sans workspaceId: ${usersWithoutWorkspace.length}`);
    
    for (const user of usersWithoutWorkspace) {
      console.log(`\n👤 ${user.email} (${user._id})`);
      
      // Chercher dans member
      const member = await db.collection('member').findOne({ 
        $or: [
          { userId: user._id.toString() },
          { userId: user._id },
          { user: user._id.toString() },
          { user: user._id }
        ]
      });
      
      if (member) {
        console.log(`   🔗 Member trouvé: organizationId ${member.organizationId}`);
      }
      
      // Chercher si owner
      const ownedOrg = await db.collection('organization').findOne({ ownerId: user._id });
      if (ownedOrg) {
        console.log(`   👑 Owner de: ${ownedOrg.name} (${ownedOrg._id})`);
      }
      
      if (!member && !ownedOrg) {
        console.log(`   ❌ Aucune relation trouvée - utilisateur vraiment orphelin`);
      }
    }
    
    // Suggestions de correction
    console.log('\n💡 SUGGESTIONS DE CORRECTION');
    console.log('============================');
    console.log('1. Exécuter le script advanced-workspace-analysis.js pour correction automatique');
    console.log('2. Pour les utilisateurs vraiment orphelins :');
    console.log('   - Les assigner à une organisation par défaut');
    console.log('   - Ou supprimer leurs documents s\'ils ne sont plus utiles');
    console.log('3. Mettre à jour manuellement les utilisateurs sans workspaceId avec leur organizationId');
    
  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await client.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

console.log('🔍 Analyse des utilisateurs orphelins');
console.log('====================================');

analyzeOrphanUsers().catch(console.error);
