#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🚀 MIGRATION DONNÉES COMPANY: USERS → USER.COMPANY');
console.log('==================================================');
console.log(`Fichier: ${__filename}`);
console.log(`Répertoire: ${__dirname}`);
console.log(`Arguments: ${process.argv.join(' ')}`);
console.log(`Node version: ${process.version}`);
console.log('');

// Configuration
const BACKUP_DIR = path.resolve(__dirname, '../backups');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_BACKUP = process.argv.includes('--skip-backup');

console.log('📋 CONFIGURATION');
console.log('================');
console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN (simulation)' : '⚡ EXÉCUTION RÉELLE'}`);
console.log(`Sauvegarde: ${SKIP_BACKUP ? '❌ DÉSACTIVÉE' : '✅ ACTIVÉE'}`);
console.log(`Répertoire de sauvegarde: ${BACKUP_DIR}`);
console.log('');

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  console.log('🔧 Chargement de la configuration...');
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  console.log(`   Chemin ecosystem: ${ecosystemPath}`);
  console.log(`   Fichier existe: ${fs.existsSync(ecosystemPath)}`);
  
  if (fs.existsSync(ecosystemPath)) {
    try {
      console.log('   Tentative de chargement ecosystem.config.cjs...');
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const config = require(ecosystemPath);
      
      console.log('   Config chargée:', !!config);
      console.log('   Apps disponibles:', config.apps ? config.apps.length : 0);
      
      if (config && config.apps && config.apps[0] && config.apps[0].env) {
        console.log('   Variables env trouvées:', Object.keys(config.apps[0].env));
        Object.assign(process.env, config.apps[0].env);
        
        if (config.apps[0].env_production) {
          console.log('   Variables env_production trouvées:', Object.keys(config.apps[0].env_production));
          Object.assign(process.env, config.apps[0].env_production);
        }
        
        console.log('   Variables d\'environnement assignées');
        console.log(`   MONGODB_URI définie: ${!!process.env.MONGODB_URI}`);
        if (process.env.MONGODB_URI) {
          console.log(`   MONGODB_URI masquée: ${process.env.MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
        }
        return true;
      }
    } catch (error) {
      console.log('⚠️  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
      console.log('   Stack:', error.stack);
    }
  }
  
  console.log('   Fallback vers variables d\'environnement système');
  console.log(`   MONGODB_URI système: ${!!process.env.MONGODB_URI}`);
  if (process.env.MONGODB_URI) {
    console.log(`   MONGODB_URI système masquée: ${process.env.MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
  }
  return false;
}

// Fonction de sauvegarde
async function createBackup() {
  if (SKIP_BACKUP) {
    console.log('⏭️  Sauvegarde ignorée (--skip-backup)');
    return true;
  }

  console.log('💾 Création de la sauvegarde...');
  
  // Créer le dossier backups s'il n'existe pas
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log(`📁 Création du dossier backups: ${BACKUP_DIR}`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`📁 Dossier backups créé: ${BACKUP_DIR}`);
  } else {
    console.log(`📁 Dossier backups existe déjà: ${BACKUP_DIR}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `users-to-user-company-backup-${timestamp}`);
  
  console.log(`📍 Chemin de sauvegarde: ${backupPath}`);

  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie');
    }

    console.log('   URI MongoDB masquée:', mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));

    // Créer la sauvegarde avec mongodump
    const command = `mongodump --uri="${mongoUri}" --out="${backupPath}"`;
    console.log('🔧 Exécution de mongodump...');
    console.log(`   Commande: mongodump --uri="***" --out="${backupPath}"`);
    
    const { stdout, stderr } = await execAsync(command);
    
    console.log('📤 Sortie mongodump:');
    if (stdout) console.log('   stdout:', stdout);
    if (stderr) console.log('   stderr:', stderr);
    
    if (stderr && !stderr.includes('done dumping')) {
      console.warn('⚠️  Avertissements mongodump:', stderr);
    }

    console.log('✅ Sauvegarde créée avec succès');
    console.log(`📍 Emplacement: ${backupPath}`);
    
    return true;
  } catch (error) {
    console.error('❌ Erreur lors de la sauvegarde:', error.message);
    console.error('   Stack:', error.stack);
    return false;
  }
}

// Fonction pour mapper les données de users vers user.company
function mapUsersCompanyToUserCompany(usersCompanyData) {
  const companyData = {};

  // Mapping des champs selon la structure attendue dans User.js
  if (usersCompanyData.name) companyData.name = usersCompanyData.name;
  if (usersCompanyData.email) companyData.email = usersCompanyData.email;
  if (usersCompanyData.phone) companyData.phone = usersCompanyData.phone;
  if (usersCompanyData.website) companyData.website = usersCompanyData.website;
  if (usersCompanyData.siret) companyData.siret = usersCompanyData.siret;
  if (usersCompanyData.vatNumber) companyData.vatNumber = usersCompanyData.vatNumber;
  if (usersCompanyData.rcs) companyData.rcs = usersCompanyData.rcs;
  if (usersCompanyData.companyStatus) companyData.companyStatus = usersCompanyData.companyStatus;
  if (usersCompanyData.capitalSocial) companyData.capitalSocial = usersCompanyData.capitalSocial;
  if (usersCompanyData.transactionCategory) companyData.transactionCategory = usersCompanyData.transactionCategory;
  if (usersCompanyData.vatPaymentCondition) companyData.vatPaymentCondition = usersCompanyData.vatPaymentCondition;

  // Mapper l'adresse si elle existe
  if (usersCompanyData.address) {
    companyData.address = {};
    if (usersCompanyData.address.street) companyData.address.street = usersCompanyData.address.street;
    if (usersCompanyData.address.city) companyData.address.city = usersCompanyData.address.city;
    if (usersCompanyData.address.zipCode) companyData.address.zipCode = usersCompanyData.address.zipCode;
    if (usersCompanyData.address.country) companyData.address.country = usersCompanyData.address.country;
  }

  // Mapper les coordonnées bancaires si elles existent
  if (usersCompanyData.bankDetails) {
    companyData.bankDetails = {};
    if (usersCompanyData.bankDetails.bankName) companyData.bankDetails.bankName = usersCompanyData.bankDetails.bankName;
    if (usersCompanyData.bankDetails.iban) companyData.bankDetails.iban = usersCompanyData.bankDetails.iban;
    if (usersCompanyData.bankDetails.bic) companyData.bankDetails.bic = usersCompanyData.bankDetails.bic;
  }

  return companyData;
}

// Fonction principale de migration
async function runMigration() {
  console.log('🚀 DÉBUT DE LA FONCTION PRINCIPALE');
  let client;
  
  try {
    console.log('📋 Étape 1: Chargement de la configuration...');
    const configLoaded = await loadEcosystemConfig();
    console.log(`   Configuration chargée: ${configLoaded}`);
    
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie dans les variables d\'environnement');
    }
    console.log('✅ MONGODB_URI trouvée');

    console.log('📋 Étape 2: Connexion à MongoDB...');
    console.log('   Création du client MongoDB...');
    client = new MongoClient(mongoUri);
    console.log('   Tentative de connexion...');
    await client.connect();
    console.log('   Test de la connexion...');
    
    const db = client.db();
    console.log('   Récupération de la base de données...');
    
    // Test simple de la connexion sans droits admin
    try {
      await db.collection('user').countDocuments({}, { limit: 1 });
      console.log('✅ Connexion réussie - Base de données accessible');
    } catch (testError) {
      console.log('⚠️  Test de connexion avec une requête simple...');
      // Essayer une autre méthode de test
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      console.log(`✅ Connexion réussie - ${collections.length} collections disponibles`);
    }

    console.log('📋 Étape 3: Création de la sauvegarde...');
    if (!await createBackup()) {
      console.log('❌ Échec de la sauvegarde, arrêt de la migration');
      return;
    }
    console.log('✅ Sauvegarde terminée');

    console.log('\n📋 Étape 4: Analyse des collections...');
    
    // Vérifier l'existence des collections
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    console.log('   Collections disponibles:', collectionNames);
    
    const hasUsersCollection = collectionNames.includes('users');
    const hasUserCollection = collectionNames.includes('user');
    
    console.log(`   Collection 'users' existe: ${hasUsersCollection}`);
    console.log(`   Collection 'user' existe: ${hasUserCollection}`);

    if (!hasUsersCollection) {
      console.log('❌ Collection "users" non trouvée');
      
      // Afficher quelques collections pour diagnostic
      console.log('📋 Collections disponibles:');
      collectionNames.forEach(name => console.log(`   - ${name}`));
      return;
    }

    if (!hasUserCollection) {
      console.log('❌ Collection "user" non trouvée');
      return;
    }

    console.log('📋 Étape 5: Analyse des données users...');
    
    // Récupérer les données de la collection users
    const usersData = await db.collection('users').find({}).toArray();
    console.log(`✅ ${usersData.length} documents trouvés dans la collection users`);

    if (usersData.length === 0) {
      console.log('ℹ️  Aucune donnée dans la collection users');
      return;
    }

    // Afficher quelques exemples
    console.log('\n📋 Aperçu des données users:');
    usersData.slice(0, 3).forEach((userData, index) => {
      console.log(`   ${index + 1}. ID: ${userData._id}`);
      console.log(`      Champs: ${Object.keys(userData).join(', ')}`);
      if (userData.name) console.log(`      Nom: ${userData.name}`);
      if (userData.email) console.log(`      Email: ${userData.email}`);
      if (userData.siret) console.log(`      SIRET: ${userData.siret}`);
    });
    if (usersData.length > 3) {
      console.log(`   ... et ${usersData.length - 3} autres documents`);
    }

    console.log('\n📋 Étape 6: Analyse des utilisateurs user...');
    
    // Récupérer les utilisateurs de la collection user
    const userUsers = await db.collection('user').find({}).toArray();
    console.log(`✅ ${userUsers.length} utilisateurs trouvés dans la collection user`);

    // Statistiques
    let migratedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const errors = [];

    console.log('\n📋 Étape 7: Début de la migration...');
    console.log(`Mode: ${DRY_RUN ? '🧪 SIMULATION' : '⚡ EXÉCUTION RÉELLE'}`);

    for (const userData of usersData) {
      try {
        console.log(`\n👤 Traitement document users: ${userData._id}`);
        
        // Vérifier si ce document users a des données company
        if (!userData.company || Object.keys(userData.company).length === 0) {
          console.log('⚠️  Aucune donnée company dans ce document users, ignoré');
          skippedCount++;
          continue;
        }
        
        console.log(`📋 Données company trouvées: ${Object.keys(userData.company).join(', ')}`);
        
        // Chercher un utilisateur correspondant dans la collection user
        // On peut essayer de matcher par email si disponible, sinon par ID
        let matchingUser = null;
        
        if (userData.email) {
          matchingUser = await db.collection('user').findOne({ email: userData.email });
          console.log(`   Recherche par email (${userData.email}): ${matchingUser ? 'TROUVÉ' : 'NON TROUVÉ'}`);
        }
        
        if (!matchingUser && userData._id) {
          // Essayer de matcher par ID si c'est un ObjectId
          try {
            matchingUser = await db.collection('user').findOne({ _id: userData._id });
            console.log(`   Recherche par ID (${userData._id}): ${matchingUser ? 'TROUVÉ' : 'NON TROUVÉ'}`);
          } catch (e) {
            console.log(`   Recherche par ID échouée: ${e.message}`);
          }
        }

        if (!matchingUser) {
          console.log('⚠️  Aucun utilisateur correspondant trouvé dans la collection user');
          skippedCount++;
          continue;
        }

        console.log(`✅ Utilisateur correspondant trouvé: ${matchingUser.email} (${matchingUser._id})`);

        // Vérifier si l'utilisateur a déjà des données company
        if (matchingUser.company && Object.keys(matchingUser.company).length > 0) {
          console.log('ℹ️  L\'utilisateur a déjà des données company, mise à jour...');
        } else {
          console.log('🆕 L\'utilisateur n\'a pas de données company, création...');
        }

        // Mapper les données users.company vers user.company
        const companyData = mapUsersCompanyToUserCompany(userData.company);
        console.log(`📋 Données company mappées: ${Object.keys(companyData).length} champs`);
        
        // Afficher les principales données mappées
        if (companyData.name) console.log(`   Nom: ${companyData.name}`);
        if (companyData.siret) console.log(`   SIRET: ${companyData.siret}`);
        if (companyData.email) console.log(`   Email: ${companyData.email}`);

        if (!DRY_RUN) {
          console.log('   Mise à jour de l\'utilisateur...');
          const updateResult = await db.collection('user').updateOne(
            { _id: matchingUser._id },
            { $set: { company: companyData } }
          );
          console.log(`   Documents modifiés: ${updateResult.modifiedCount}`);
        } else {
          console.log('   🧪 SIMULATION - Mise à jour non exécutée');
        }

        migratedCount++;
        console.log(`✅ Migration réussie pour ${matchingUser.email}`);
        
      } catch (error) {
        console.error(`❌ Erreur pour le document ${userData._id}:`, error.message);
        console.error('   Stack:', error.stack);
        errors.push({ 
          usersId: userData._id, 
          email: userData.email || 'N/A', 
          error: error.message 
        });
        errorCount++;
      }
    }

    // Résumé
    console.log('\n📊 RÉSUMÉ DE LA MIGRATION');
    console.log('========================');
    console.log(`✅ Documents migrés: ${migratedCount}`);
    console.log(`⚠️  Documents ignorés: ${skippedCount}`);
    console.log(`❌ Erreurs: ${errorCount}`);
    
    if (errors.length > 0) {
      console.log('\n🚨 ERREURS DÉTAILLÉES:');
      errors.forEach(err => {
        console.log(`- ${err.email} (${err.usersId}): ${err.error}`);
      });
    }

    if (DRY_RUN) {
      console.log('\n🧪 SIMULATION TERMINÉE');
      console.log('Pour exécuter la migration réelle, relancez sans --dry-run');
    } else {
      console.log('\n🎉 MIGRATION TERMINÉE AVEC SUCCÈS');
      console.log('Les données company sont maintenant dans la collection user');
      console.log('Vous pouvez maintenant exécuter le script de migration vers Better Auth');
    }

  } catch (error) {
    console.error('💥 Erreur fatale:', error.message);
    console.error('Stack complet:', error.stack);
    
    // Informations de débogage supplémentaires
    console.error('\n🔍 Informations de débogage:');
    console.error(`   Node version: ${process.version}`);
    console.error(`   Répertoire de travail: ${process.cwd()}`);
    console.error(`   Variables d'environnement MongoDB: ${!!process.env.MONGODB_URI}`);
    
  } finally {
    if (client) {
      console.log('🔌 Fermeture de la connexion MongoDB...');
      await client.close();
      console.log('✅ Connexion MongoDB fermée');
    }
  }
}

// Validation des arguments
if (process.argv.includes('--help')) {
  console.log(`
Usage: node migrate-users-to-user-company.js [options]

Description:
  Migre les données company de la collection 'users' vers le champ 'company' 
  de la collection 'user'. Cette migration est nécessaire avant la migration 
  vers Better Auth.

Options:
  --dry-run      Simulation sans modification des données
  --skip-backup  Ignorer la création de sauvegarde
  --help         Afficher cette aide

Exemples:
  node migrate-users-to-user-company.js --dry-run
  node migrate-users-to-user-company.js
  node migrate-users-to-user-company.js --skip-backup

Étapes recommandées:
  1. node migrate-users-to-user-company.js --dry-run
  2. node migrate-users-to-user-company.js
  3. node migrate-company-to-organization.js --dry-run
  4. node migrate-company-to-organization.js
`);
  process.exit(0);
}

// Exécution
runMigration().catch(console.error);
