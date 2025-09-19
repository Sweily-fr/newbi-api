#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 DIAGNOSTIC DE LA COLLECTION MEMBER');
console.log('====================================');
console.log(`Fichier: ${__filename}`);
console.log(`Node version: ${process.version}`);
console.log('');

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  console.log('🔧 Chargement de la configuration...');
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  if (fs.existsSync(ecosystemPath)) {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const config = require(ecosystemPath);
      
      if (config && config.apps && config.apps[0] && config.apps[0].env) {
        Object.assign(process.env, config.apps[0].env);
        
        if (config.apps[0].env_production) {
          Object.assign(process.env, config.apps[0].env_production);
        }
        
        console.log('✅ Configuration chargée');
        return true;
      }
    } catch (error) {
      console.log('⚠️  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
    }
  }
  
  return false;
}

// Fonction principale de diagnostic
async function runDiagnostic() {
  console.log('🚀 DÉBUT DU DIAGNOSTIC');
  let client;
  
  try {
    await loadEcosystemConfig();
    
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie');
    }

    console.log('📋 Connexion à MongoDB...');
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db();
    
    // Test de connexion simple
    try {
      await db.collection('user').countDocuments({}, { limit: 1 });
      console.log('✅ Connexion réussie');
    } catch (testError) {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      console.log(`✅ Connexion réussie - ${collections.length} collections`);
    }

    console.log('\n📋 Analyse des collections...');
    
    // Lister toutes les collections
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    const hasMemberCollection = collectionNames.includes('member');
    const hasUserCollection = collectionNames.includes('user');
    const hasOrganizationCollection = collectionNames.includes('organization');
    
    console.log(`📊 État des collections:`);
    console.log(`   Collection 'member': ${hasMemberCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);
    console.log(`   Collection 'user': ${hasUserCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);
    console.log(`   Collection 'organization': ${hasOrganizationCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);

    // Analyser la collection member
    if (hasMemberCollection) {
      console.log('\n📋 Analyse de la collection member...');
      
      const memberCount = await db.collection('member').countDocuments();
      console.log(`📊 Nombre total de membres: ${memberCount}`);

      if (memberCount > 0) {
        const sampleMembers = await db.collection('member').find({}).limit(5).toArray();
        
        console.log('\n📋 STRUCTURE DES DOCUMENTS MEMBER:');
        console.log('=================================');
        
        sampleMembers.forEach((member, index) => {
          console.log(`\n👤 Membre ${index + 1}:`);
          console.log(`   ID: ${member._id}`);
          console.log(`   Champs: ${Object.keys(member).join(', ')}`);
          
          Object.entries(member).forEach(([key, value]) => {
            if (key === '_id') return;
            
            if (typeof value === 'object' && value !== null) {
              console.log(`   ${key}: [objet avec ${Object.keys(value).length} propriétés]`);
            } else {
              console.log(`   ${key}: ${value} (${typeof value})`);
            }
          });
        });
      }
    }

    // Analyser la collection user pour les champs organizationId et workspaceId
    if (hasUserCollection) {
      console.log('\n📋 Analyse des champs organizationId/workspaceId dans user...');
      
      const userCount = await db.collection('user').countDocuments();
      console.log(`📊 Nombre total d'utilisateurs: ${userCount}`);

      // Compter les utilisateurs avec organizationId
      const usersWithOrgId = await db.collection('user').countDocuments({
        organizationId: { $exists: true, $ne: null }
      });
      
      // Compter les utilisateurs avec workspaceId
      const usersWithWorkspaceId = await db.collection('user').countDocuments({
        workspaceId: { $exists: true, $ne: null }
      });

      console.log(`📊 Utilisateurs avec organizationId: ${usersWithOrgId}`);
      console.log(`📊 Utilisateurs avec workspaceId: ${usersWithWorkspaceId}`);

      // Afficher quelques exemples
      if (usersWithOrgId > 0 || usersWithWorkspaceId > 0) {
        const usersWithIds = await db.collection('user').find({
          $or: [
            { organizationId: { $exists: true, $ne: null } },
            { workspaceId: { $exists: true, $ne: null } }
          ]
        }).limit(3).toArray();

        console.log('\n📋 EXEMPLES D\'UTILISATEURS AVEC IDS:');
        console.log('===================================');
        
        usersWithIds.forEach((user, index) => {
          console.log(`\n👤 Utilisateur ${index + 1}:`);
          console.log(`   Email: ${user.email}`);
          console.log(`   ID: ${user._id}`);
          if (user.organizationId) console.log(`   OrganizationId: ${user.organizationId}`);
          if (user.workspaceId) console.log(`   WorkspaceId: ${user.workspaceId}`);
        });
      }
    }

    // Analyser la collection organization
    if (hasOrganizationCollection) {
      console.log('\n📋 Analyse de la collection organization...');
      
      const orgCount = await db.collection('organization').countDocuments();
      console.log(`📊 Nombre total d'organisations: ${orgCount}`);

      if (orgCount > 0) {
        const sampleOrgs = await db.collection('organization').find({}).limit(3).toArray();
        
        console.log('\n📋 EXEMPLES D\'ORGANISATIONS:');
        console.log('===========================');
        
        sampleOrgs.forEach((org, index) => {
          console.log(`\n🏢 Organisation ${index + 1}:`);
          console.log(`   ID: ${org._id}`);
          console.log(`   Nom: ${org.name || 'N/A'}`);
          console.log(`   CreatedBy: ${org.createdBy || 'N/A'}`);
          console.log(`   Champs: ${Object.keys(org).join(', ')}`);
        });
      }
    }

    // Analyser les relations existantes
    console.log('\n📋 ANALYSE DES RELATIONS:');
    console.log('========================');
    
    if (hasMemberCollection && hasUserCollection && hasOrganizationCollection) {
      // Vérifier les relations member -> user
      const membersWithValidUsers = await db.collection('member').aggregate([
        {
          $lookup: {
            from: 'user',
            localField: 'userId',
            foreignField: '_id',
            as: 'userMatch'
          }
        },
        {
          $match: {
            userMatch: { $size: 1 }
          }
        },
        { $count: 'count' }
      ]).toArray();

      const validUserRelations = membersWithValidUsers.length > 0 ? membersWithValidUsers[0].count : 0;
      
      // Vérifier les relations member -> organization
      const membersWithValidOrgs = await db.collection('member').aggregate([
        {
          $lookup: {
            from: 'organization',
            localField: 'organizationId',
            foreignField: '_id',
            as: 'orgMatch'
          }
        },
        {
          $match: {
            orgMatch: { $size: 1 }
          }
        },
        { $count: 'count' }
      ]).toArray();

      const validOrgRelations = membersWithValidOrgs.length > 0 ? membersWithValidOrgs[0].count : 0;

      console.log(`✅ Relations member->user valides: ${validUserRelations}`);
      console.log(`✅ Relations member->organization valides: ${validOrgRelations}`);
      
      // Suggestions de migration
      console.log('\n📋 SUGGESTIONS DE MIGRATION:');
      console.log('============================');
      
      if (usersWithOrgId > 0) {
        console.log(`🔄 ${usersWithOrgId} utilisateurs ont organizationId - peuvent être migrés vers member`);
      }
      
      if (usersWithWorkspaceId > 0) {
        console.log(`🔄 ${usersWithWorkspaceId} utilisateurs ont workspaceId - à analyser`);
      }
      
      if (validUserRelations === 0 && validOrgRelations === 0) {
        console.log('⚠️  Aucune relation valide dans member - migration nécessaire');
      }
    }

  } catch (error) {
    console.error('💥 Erreur:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    if (client) {
      await client.close();
      console.log('\n✅ Connexion fermée');
    }
  }
}

// Validation des arguments
if (process.argv.includes('--help')) {
  console.log(`
Usage: node diagnose-member-collection.js

Description:
  Analyse la structure de la collection 'member' et les relations avec 
  'user' et 'organization' pour préparer la migration Better Auth.

Exemples:
  node diagnose-member-collection.js
`);
  process.exit(0);
}

// Exécution
runDiagnostic().catch(console.error);
