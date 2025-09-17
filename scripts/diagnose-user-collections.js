#!/usr/bin/env node

/**
 * Script de diagnostic des collections utilisateur
 * 
 * Ce script vérifie l'état des collections 'users' et 'user'
 * pour diagnostiquer les problèmes de migration
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

/**
 * Fonction principale de diagnostic
 */
async function main() {
  try {
    console.log('🔍 DIAGNOSTIC DES COLLECTIONS UTILISATEUR');
    console.log('=' .repeat(60));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    const db = mongoose.connection.db;
    
    // Lister toutes les collections
    console.log('\n📋 Collections disponibles:');
    const collections = await db.listCollections().toArray();
    collections.forEach(col => {
      console.log(`  - ${col.name}`);
    });
    
    // Vérifier la collection 'users' (ancienne)
    console.log('\n🔍 Analyse de la collection "users":');
    try {
      const usersCount = await db.collection('users').countDocuments();
      console.log(`  📊 Nombre total d'utilisateurs: ${usersCount}`);
      
      if (usersCount > 0) {
        // Afficher quelques exemples
        const sampleUsers = await db.collection('users').find({}).limit(3).toArray();
        console.log('  📝 Exemples d\'utilisateurs:');
        sampleUsers.forEach((user, index) => {
          console.log(`    ${index + 1}. ID: ${user._id}, Email: ${user.email || 'N/A'}`);
        });
        
        // Vérifier les utilisateurs avec workspaceId
        const usersWithWorkspace = await db.collection('users').countDocuments({
          workspaceId: { $exists: true, $ne: null }
        });
        console.log(`  🏢 Utilisateurs avec workspaceId: ${usersWithWorkspace}`);
      }
    } catch (error) {
      console.log(`  ❌ Erreur lors de l'analyse de 'users': ${error.message}`);
    }
    
    // Vérifier la collection 'user' (nouvelle)
    console.log('\n🔍 Analyse de la collection "user":');
    try {
      const userCount = await db.collection('user').countDocuments();
      console.log(`  📊 Nombre total d'utilisateurs: ${userCount}`);
      
      if (userCount > 0) {
        // Afficher tous les utilisateurs migrés
        const migratedUsers = await db.collection('user').find({}).toArray();
        console.log('  📝 Utilisateurs migrés:');
        migratedUsers.forEach((user, index) => {
          console.log(`    ${index + 1}. ID: ${user._id}, Email: ${user.email || 'N/A'}`);
          if (user.workspaceId) {
            console.log(`       WorkspaceId: ${user.workspaceId}`);
          }
        });
      }
    } catch (error) {
      console.log(`  ❌ Erreur lors de l'analyse de 'user': ${error.message}`);
    }
    
    // Vérifier les organisations
    console.log('\n🔍 Analyse des organisations:');
    try {
      const orgsCount = await db.collection('organization').countDocuments();
      console.log(`  📊 Nombre d'organisations: ${orgsCount}`);
      
      if (orgsCount > 0) {
        const orgs = await db.collection('organization').find({}).toArray();
        orgs.forEach((org, index) => {
          console.log(`    ${index + 1}. ID: ${org._id}, Nom: ${org.companyName || 'N/A'}`);
        });
      }
    } catch (error) {
      console.log(`  ❌ Erreur lors de l'analyse des organisations: ${error.message}`);
    }
    
    // Vérifier les membres
    console.log('\n🔍 Analyse des membres:');
    try {
      const membersCount = await db.collection('member').countDocuments();
      console.log(`  📊 Nombre de membres: ${membersCount}`);
      
      if (membersCount > 0) {
        const members = await db.collection('member').find({}).toArray();
        members.forEach((member, index) => {
          console.log(`    ${index + 1}. UserID: ${member.userId}, OrgID: ${member.organizationId}, Role: ${member.role}`);
        });
      }
    } catch (error) {
      console.log(`  ❌ Erreur lors de l'analyse des membres: ${error.message}`);
    }
    
    console.log('\n🎯 RECOMMANDATIONS:');
    
    const usersCount = await db.collection('users').countDocuments().catch(() => 0);
    const userCount = await db.collection('user').countDocuments().catch(() => 0);
    
    if (usersCount > userCount) {
      console.log(`⚠️  Il y a ${usersCount} utilisateurs dans 'users' mais seulement ${userCount} dans 'user'`);
      console.log('   → La migration n\'est pas complète');
      console.log('   → Exécutez le rollback puis relancez la migration');
    } else if (usersCount === 0 && userCount > 0) {
      console.log('✅ Migration semble complète (collection users vide, user peuplée)');
    } else if (usersCount > 0 && userCount > 0) {
      console.log('⚠️  Les deux collections contiennent des données');
      console.log('   → Migration partiellement exécutée');
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

export { main as diagnoseUserCollections };
