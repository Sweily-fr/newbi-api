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

console.log(' DÉMARRAGE DU SCRIPT DE MIGRATION');
console.log('===================================');
console.log(`Fichier: ${__filename}`);
console.log(`Répertoire: ${__dirname}`);
console.log(`Arguments: ${process.argv.join(' ')}`);
console.log(`Node version: ${process.version}`);
console.log('');

// Configuration
const BACKUP_DIR = path.resolve(__dirname, '../backups');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_BACKUP = process.argv.includes('--skip-backup');

console.log(' MIGRATION COMPANY → ORGANIZATION');
console.log('===================================');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (simulation)' : 'EXÉCUTION RÉELLE'}`);
console.log(`Sauvegarde: ${SKIP_BACKUP ? 'DÉSACTIVÉE' : 'ACTIVÉE'}`);
console.log(`Répertoire de sauvegarde: ${BACKUP_DIR}`);
console.log('');

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  console.log(' Chargement de la configuration...');
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
      console.log('  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
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
    console.log('  Sauvegarde ignorée (--skip-backup)');
    return true;
  }

  console.log(' Création de la sauvegarde...');
  
  // Créer le dossier backups s'il n'existe pas
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log(`   Création du dossier backups: ${BACKUP_DIR}`);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`   Dossier backups créé: ${BACKUP_DIR}`);
  } else {
    console.log(`   Dossier backups existe déjà: ${BACKUP_DIR}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `company-migration-backup-${timestamp}`);
  
  console.log(`   Chemin de sauvegarde: ${backupPath}`);

  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie');
    }

    console.log('   URI MongoDB masquée:', mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));

    // Créer la sauvegarde avec mongodump
    const command = `mongodump --uri="${mongoUri}" --out="${backupPath}"`;
    console.log('   Exécution de mongodump...');
    console.log(`   Commande: mongodump --uri="***" --out="${backupPath}"`);
    
    const { stdout, stderr } = await execAsync(command);
    
    console.log('   Sortie mongodump:');
    if (stdout) console.log('     stdout:', stdout);
    if (stderr) console.log('     stderr:', stderr);
    
    if (stderr && !stderr.includes('done dumping')) {
      console.warn('   Avertissements mongodump:', stderr);
    }

    console.log('   Sauvegarde créée avec succès');
    console.log(`   Emplacement: ${backupPath}`);
    
    return true;
  } catch (error) {
    console.error('   Erreur lors de la sauvegarde:', error.message);
    console.error('     Stack:', error.stack);
    return false;
  }
}

// Fonction de mapping des données company vers organization
function mapCompanyToOrganization(company, userId) {
  const orgData = {
    name: `Organisation de ${userId}`, // Nom par défaut
    slug: `org-${userId}-${Date.now()}`, // Slug unique
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Mapping des champs company vers champs directs Better Auth
  if (company) {
    // Informations de base
    if (company.name) {
      orgData.companyName = company.name;
      orgData.name = company.name; // Utiliser le nom de l'entreprise
    }
    if (company.email) orgData.companyEmail = company.email;
    if (company.phone) orgData.companyPhone = company.phone;
    if (company.website) orgData.website = company.website;

    // Informations légales
    if (company.siret) orgData.siret = company.siret;
    if (company.vatNumber) orgData.vatNumber = company.vatNumber;
    if (company.rcs) orgData.rcs = company.rcs;
    if (company.companyStatus) orgData.legalForm = company.companyStatus;
    if (company.capitalSocial) orgData.capitalSocial = company.capitalSocial;
    if (company.transactionCategory) orgData.activityCategory = company.transactionCategory;
    if (company.vatPaymentCondition) orgData.fiscalRegime = company.vatPaymentCondition;

    // Adresse (flattened)
    if (company.address) {
      if (company.address.street) orgData.addressStreet = company.address.street;
      if (company.address.city) orgData.addressCity = company.address.city;
      if (company.address.zipCode) orgData.addressZipCode = company.address.zipCode;
      if (company.address.country) orgData.addressCountry = company.address.country;
    }

    // Coordonnées bancaires (flattened)
    if (company.bankDetails) {
      if (company.bankDetails.bankName) orgData.bankName = company.bankDetails.bankName;
      if (company.bankDetails.iban) orgData.bankIban = company.bankDetails.iban;
      if (company.bankDetails.bic) orgData.bankBic = company.bankDetails.bic;
    }

    // Valeurs par défaut pour les nouveaux champs Better Auth
    orgData.isVatSubject = company.vatNumber ? true : false;
    orgData.hasCommercialActivity = company.transactionCategory === 'GOODS' || company.transactionCategory === 'MIXED';
    orgData.showBankDetails = company.bankDetails && (company.bankDetails.iban || company.bankDetails.bic) ? true : false;

    // Paramètres de document par défaut
    orgData.documentTextColor = '#000000';
    orgData.documentHeaderTextColor = '#FFFFFF';
    orgData.documentHeaderBgColor = '#3B82F6';
    orgData.documentHeaderNotes = '';
    orgData.documentFooterNotes = '';
    orgData.documentTermsAndConditions = '';
    
    // Notes spéciales pour devis
    orgData.quoteHeaderNotes = '';
    orgData.quoteFooterNotes = '';
    orgData.quoteTermsAndConditions = '';
    
    // Notes spéciales pour factures
    orgData.invoiceHeaderNotes = '';
    orgData.invoiceFooterNotes = '';
    orgData.invoiceTermsAndConditions = '';
  } else {
    // Valeurs par défaut si pas de données company
    orgData.companyName = '';
    orgData.companyEmail = '';
    orgData.companyPhone = '';
    orgData.website = '';
    orgData.siret = '';
    orgData.vatNumber = '';
    orgData.rcs = '';
    orgData.legalForm = '';
    orgData.capitalSocial = '';
    orgData.activityCategory = '';
    orgData.fiscalRegime = '';
    orgData.isVatSubject = false;
    orgData.hasCommercialActivity = false;
    orgData.addressStreet = '';
    orgData.addressCity = '';
    orgData.addressZipCode = '';
    orgData.addressCountry = 'France';
    orgData.bankName = '';
    orgData.bankIban = '';
    orgData.bankBic = '';
    orgData.showBankDetails = false;
    orgData.documentTextColor = '#000000';
    orgData.documentHeaderTextColor = '#FFFFFF';
    orgData.documentHeaderBgColor = '#3B82F6';
    orgData.documentHeaderNotes = '';
    orgData.documentFooterNotes = '';
    orgData.documentTermsAndConditions = '';
    orgData.quoteHeaderNotes = '';
    orgData.quoteFooterNotes = '';
    orgData.quoteTermsAndConditions = '';
    orgData.invoiceHeaderNotes = '';
    orgData.invoiceFooterNotes = '';
    orgData.invoiceTermsAndConditions = '';
  }

  return orgData;
}

// Fonction principale de migration
async function runMigration() {
  let client;
  
  try {
    // Charger la configuration
    await loadEcosystemConfig();
    
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie dans les variables d\'environnement');
    }

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

    // Créer la sauvegarde
    if (!await createBackup()) {
      console.log('  Échec de la sauvegarde, arrêt de la migration');
      return;
    }

    console.log('\n  Analyse des données...');
    
    console.log('   Recherche des utilisateurs avec données company...');
    console.log('   Collection utilisée: user');
    console.log('   Critère de recherche: company existe et non null');
    
    const users = await db.collection('user').find({
      'company': { $exists: true, $ne: null }
    }).toArray();

    console.log(`   ${users.length} utilisateurs trouvés avec des données company`);

    // Vérifier aussi les utilisateurs avec des champs company partiels
    const usersWithPartialCompany = await db.collection('user').find({
      $or: [
        { 'company.name': { $exists: true, $ne: null, $ne: '' } },
        { 'company.siret': { $exists: true, $ne: null, $ne: '' } },
        { 'company.email': { $exists: true, $ne: null, $ne: '' } }
      ]
    }).toArray();

    console.log(`   ${usersWithPartialCompany.length} utilisateurs avec des données company partielles`);

    // Afficher quelques statistiques sur les données company
    const companyStats = await db.collection('user').aggregate([
      { $match: { 'company': { $exists: true, $ne: null } } },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          withName: { $sum: { $cond: [{ $ne: ['$company.name', null] }, 1, 0] } },
          withSiret: { $sum: { $cond: [{ $ne: ['$company.siret', null] }, 1, 0] } },
          withEmail: { $sum: { $cond: [{ $ne: ['$company.email', null] }, 1, 0] } },
          withAddress: { $sum: { $cond: [{ $ne: ['$company.address', null] }, 1, 0] } },
          withBankDetails: { $sum: { $cond: [{ $ne: ['$company.bankDetails', null] }, 1, 0] } }
        }
      }
    ]).toArray();

    if (companyStats.length > 0) {
      const stats = companyStats[0];
      console.log('   Statistiques des données company:');
      console.log(`     Total utilisateurs: ${stats.totalUsers}`);
      console.log(`     Avec nom: ${stats.withName}`);
      console.log(`     Avec SIRET: ${stats.withSiret}`);
      console.log(`     Avec email: ${stats.withEmail}`);
      console.log(`     Avec adresse: ${stats.withAddress}`);
      console.log(`     Avec coordonnées bancaires: ${stats.withBankDetails}`);
    }

    if (users.length === 0) {
      console.log('   Aucune donnée à migrer');
      
      // Vérifier s'il y a des utilisateurs dans la collection
      const totalUsers = await db.collection('user').countDocuments();
      console.log(`   Total utilisateurs dans la collection: ${totalUsers}`);
      
      // Vérifier quelques exemples d'utilisateurs
      const sampleUsers = await db.collection('user').find({}).limit(3).toArray();
      console.log('   Exemples d\'utilisateurs:');
      sampleUsers.forEach((user, index) => {
        console.log(`     ${index + 1}. ${user.email} - Company: ${!!user.company}`);
        if (user.company) {
          console.log(`       Company keys: ${Object.keys(user.company)}`);
        }
      });
      
      return;
    }

    // Statistiques
    let migratedCount = 0;
    let errorCount = 0;
    const errors = [];

    console.log('\n  Début de la migration...');

    for (const user of users) {
      try {
        console.log(`\n  Migration utilisateur: ${user.email} (${user._id})`);

        // Vérifier si l'utilisateur a déjà une organisation
        const existingOrg = await db.collection('organization').findOne({
          createdBy: user._id.toString()
        });

        if (existingOrg) {
          console.log('  Organisation existante trouvée, mise à jour...');
          
          // Mapper les données company vers organization
          const orgData = mapCompanyToOrganization(user.company, user._id.toString());
          delete orgData.name; // Ne pas écraser le nom existant
          delete orgData.slug; // Ne pas écraser le slug existant
          delete orgData.createdAt; // Ne pas écraser la date de création
          orgData.updatedAt = new Date();

          if (!DRY_RUN) {
            await db.collection('organization').updateOne(
              { _id: existingOrg._id },
              { $set: orgData }
            );
          }
          
          console.log('  Organisation mise à jour');
        } else {
          console.log('  Création d\'une nouvelle organisation...');
          
          // Créer une nouvelle organisation
          const orgData = mapCompanyToOrganization(user.company, user._id.toString());
          orgData.createdBy = user._id.toString();

          if (!DRY_RUN) {
            const result = await db.collection('organization').insertOne(orgData);
            
            // Créer le membership pour l'utilisateur
            const memberData = {
              organizationId: result.insertedId.toString(),
              userId: user._id.toString(),
              role: 'owner',
              createdAt: new Date(),
              updatedAt: new Date()
            };
            
            await db.collection('member').insertOne(memberData);
          }
          
          console.log('  Organisation créée avec membership');
        }

        // Optionnel: Supprimer les données company de l'utilisateur
        if (!DRY_RUN) {
          await db.collection('user').updateOne(
            { _id: user._id },
            { $unset: { company: "" } }
          );
          console.log('  Données company supprimées de l\'utilisateur');
        }

        migratedCount++;
        
      } catch (error) {
        console.error(`  Erreur pour l'utilisateur ${user.email}:`, error.message);
        errors.push({ userId: user._id, email: user.email, error: error.message });
        errorCount++;
      }
    }

    // Résumé
    console.log('\n  RÉSUMÉ DE LA MIGRATION');
    console.log('========================');
    console.log(`  Utilisateurs migrés: ${migratedCount}`);
    console.log(`  Erreurs: ${errorCount}`);
    
    if (errors.length > 0) {
      console.log('\n  ERREURS DÉTAILLÉES:');
      errors.forEach(err => {
        console.log(`- ${err.email} (${err.userId}): ${err.error}`);
      });
    }

    if (DRY_RUN) {
      console.log('\n  SIMULATION TERMINÉE');
      console.log('Pour exécuter la migration réelle, relancez sans --dry-run');
    } else {
      console.log('\n  MIGRATION TERMINÉE AVEC SUCCÈS');
    }

  } catch (error) {
    console.error('  Erreur fatale:', error.message);
    console.error(error.stack);
  } finally {
    if (client) {
      await client.close();
      console.log('  Connexion MongoDB fermée');
    }
  }
}

// Validation des arguments
if (process.argv.includes('--help')) {
  console.log(`
Usage: node migrate-company-to-organization.js [options]

Options:
  --dry-run      Simulation sans modification des données
  --skip-backup  Ignorer la création de sauvegarde
  --help         Afficher cette aide

Exemples:
  node migrate-company-to-organization.js --dry-run
  node migrate-company-to-organization.js
  node migrate-company-to-organization.js --skip-backup
`);
  process.exit(0);
}

// Exécution
runMigration().catch(console.error);
