import { MongoClient, ObjectId } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔗 MISE À JOUR DES RELATIONS MEMBER ↔ ORGANIZATION');
console.log('==================================================');
console.log(`Fichier: ${__filename}`);
console.log(`Répertoire: ${__dirname}`);
console.log('');

// Configuration
const BACKUP_DIR = path.resolve(__dirname, '../backups');

// Traitement des arguments de ligne de commande
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_BACKUP = process.argv.includes('--skip-backup');

console.log('📋 CONFIGURATION');
console.log('================');
console.log(`Mode: ${DRY_RUN ? '🧪 DRY RUN (simulation)' : '⚡ EXÉCUTION RÉELLE'}`);
console.log(`Sauvegarde: ${SKIP_BACKUP ? '❌ DÉSACTIVÉE' : '✅ ACTIVÉE'}`);
console.log(`Répertoire de sauvegarde: ${BACKUP_DIR}`);
console.log('');

// Fonction pour charger la configuration depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  console.log('🔧 Chargement de la configuration...');
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  console.log(`   Chemin ecosystem: ${ecosystemPath}`);
  
  if (fs.existsSync(ecosystemPath)) {
    console.log('   Fichier ecosystem.config.cjs trouvé');
    
    try {
      // Utiliser import dynamique pour les fichiers .cjs
      const ecosystem = await import(`file://${ecosystemPath}`);
      
      if (ecosystem.default && ecosystem.default.apps && ecosystem.default.apps[0] && ecosystem.default.apps[0].env) {
        console.log('   Configuration trouvée dans ecosystem.config.cjs');
        
        // Charger les variables d'environnement
        const envVars = ecosystem.default.apps[0].env;
        Object.keys(envVars).forEach(key => {
          if (!process.env[key]) {
            process.env[key] = envVars[key];
            console.log(`   Variable chargée: ${key}`);
          } else {
            console.log(`   Variable déjà définie: ${key}`);
          }
        });
        
        console.log('✅ Variables d\'environnement chargées depuis ecosystem.config.cjs');
        return true;
      } else {
        console.log('⚠️  Structure ecosystem.config.cjs inattendue');
        console.log('   Structure trouvée:', Object.keys(ecosystem.default || {}));
        return false;
      }
    } catch (error) {
      console.log('⚠️  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
      console.log('   Stack:', error.stack);
    }
  }
  
  console.log('⚠️  ecosystem.config.cjs non trouvé ou inaccessible');
  console.log('   Vérification des variables d\'environnement existantes...');
  
  const requiredVars = ['MONGODB_URI'];
  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.log(`❌ Variables manquantes: ${missingVars.join(', ')}`);
    return false;
  }
  
  console.log('✅ Variables d\'environnement déjà disponibles');
  return true;
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
  const backupPath = path.join(BACKUP_DIR, `member-organization-relations-backup-${timestamp}`);
  
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

// Fonction principale de mise à jour des relations
async function runUpdate() {
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
      console.log('❌ Échec de la sauvegarde, arrêt de la mise à jour');
      return;
    }
    console.log('✅ Sauvegarde terminée');

    console.log('\n📋 Étape 4: Analyse des données existantes...');
    
    // Analyser les collections
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    const hasMemberCollection = collectionNames.includes('member');
    const hasUserCollection = collectionNames.includes('user');
    const hasOrganizationCollection = collectionNames.includes('organization');
    
    console.log(`   Collection 'member': ${hasMemberCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);
    console.log(`   Collection 'user': ${hasUserCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);
    console.log(`   Collection 'organization': ${hasOrganizationCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);

    if (!hasMemberCollection || !hasUserCollection || !hasOrganizationCollection) {
      console.log('❌ Collections manquantes pour effectuer la mise à jour');
      return;
    }

    // Compter les données
    const memberCount = await db.collection('member').countDocuments();
    const userCount = await db.collection('user').countDocuments();
    const orgCount = await db.collection('organization').countDocuments();
    
    console.log(`📊 Statistiques:`);
    console.log(`   Membres: ${memberCount}`);
    console.log(`   Utilisateurs: ${userCount}`);
    console.log(`   Organisations: ${orgCount}`);

    console.log('\n📋 Étape 5: Analyse des relations existantes...');
    
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

    console.log(`   Relations member->organization valides: ${validOrgRelations}/${memberCount}`);
    console.log(`   Relations member->user valides: ${validUserRelations}/${memberCount}`);

    console.log('\n📋 Étape 6: Stratégie de mise à jour...');
    
    if (validOrgRelations === memberCount && validUserRelations === memberCount) {
      console.log('✅ Toutes les relations sont déjà valides, aucune mise à jour nécessaire');
      return;
    }

    // Stratégie 1: Créer des memberships pour chaque organisation avec son créateur
    console.log('🔄 Stratégie: Créer des memberships pour chaque organisation');
    
    const organizations = await db.collection('organization').find({}).toArray();
    console.log(`   ${organizations.length} organisations trouvées`);

    let createdCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    const errors = [];

    console.log('\n📋 Étape 7: Mise à jour des relations...');
    console.log(`Mode: ${DRY_RUN ? '🧪 SIMULATION' : '⚡ EXÉCUTION RÉELLE'}`);

    for (const org of organizations) {
      try {
        console.log(`\n🏢 Traitement organisation: ${org.name || org._id}`);
        console.log(`   ID: ${org._id}`);
        console.log(`   CreatedBy: ${org.createdBy || 'N/A'}`);

        if (!org.createdBy) {
          console.log('⚠️  Pas de createdBy, impossible de créer le membership');
          errorCount++;
          continue;
        }

        // Vérifier si l'utilisateur existe
        const user = await db.collection('user').findOne({ _id: new ObjectId(org.createdBy) });
        if (!user) {
          console.log(`⚠️  Utilisateur ${org.createdBy} non trouvé`);
          errorCount++;
          continue;
        }

        console.log(`✅ Utilisateur trouvé: ${user.email}`);

        // Vérifier si un membership existe déjà
        const existingMember = await db.collection('member').findOne({
          organizationId: new ObjectId(org._id),
          userId: new ObjectId(org.createdBy)
        });

        if (existingMember) {
          console.log('ℹ️  Membership existant trouvé, mise à jour...');
          
          if (!DRY_RUN) {
            const updateResult = await db.collection('member').updateOne(
              { _id: existingMember._id },
              {
                $set: {
                  organizationId: new ObjectId(org._id),
                  userId: new ObjectId(org.createdBy),
                  role: 'owner',
                  updatedAt: new Date()
                }
              }
            );
            console.log(`   Documents modifiés: ${updateResult.modifiedCount}`);
          } else {
            console.log('   🧪 SIMULATION - Mise à jour non exécutée');
          }
          
          updatedCount++;
        } else {
          console.log('🆕 Création d\'un nouveau membership...');
          
          const memberData = {
            organizationId: new ObjectId(org._id),
            userId: new ObjectId(org.createdBy),
            role: 'owner',
            createdAt: new Date(),
            updatedAt: new Date()
          };

          if (!DRY_RUN) {
            const insertResult = await db.collection('member').insertOne(memberData);
            console.log(`   Membership créé avec ID: ${insertResult.insertedId}`);
          } else {
            console.log('   🧪 SIMULATION - Création non exécutée');
          }
          
          createdCount++;
        }

        console.log(`✅ Traitement réussi pour ${org.name || org._id}`);
        
      } catch (error) {
        console.error(`❌ Erreur pour l'organisation ${org._id}:`, error.message);
        console.error('   Stack:', error.stack);
        errors.push({ 
          orgId: org._id, 
          orgName: org.name || 'N/A', 
          error: error.message 
        });
        errorCount++;
      }
    }

    // Résumé
    console.log('\n📊 RÉSUMÉ DE LA MISE À JOUR');
    console.log('==========================');
    console.log(`✅ Memberships créés: ${createdCount}`);
    console.log(`🔄 Memberships mis à jour: ${updatedCount}`);
    console.log(`❌ Erreurs: ${errorCount}`);
    
    if (errors.length > 0) {
      console.log('\n🚨 ERREURS DÉTAILLÉES:');
      errors.forEach(err => {
        console.log(`- ${err.orgName} (${err.orgId}): ${err.error}`);
      });
    }

    if (DRY_RUN) {
      console.log('\n🧪 SIMULATION TERMINÉE');
      console.log('Pour exécuter la mise à jour réelle, relancez sans --dry-run');
    } else {
      console.log('\n🎉 MISE À JOUR TERMINÉE AVEC SUCCÈS');
      console.log('Les relations member ↔ organization sont maintenant à jour');
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
Usage: node update-member-organization-relations.js [options]

Description:
  Met à jour les relations entre la collection 'member' et 'organization' 
  en créant des memberships pour chaque organisation avec son créateur.

Options:
  --dry-run      Simulation sans modification des données
  --skip-backup  Ignorer la création de sauvegarde
  --help         Afficher cette aide

Exemples:
  node update-member-organization-relations.js --dry-run
  node update-member-organization-relations.js
  node update-member-organization-relations.js --skip-backup

Étapes recommandées:
  1. node diagnose-member-collection.js (analyser l'état actuel)
  2. node update-member-organization-relations.js --dry-run
  3. node update-member-organization-relations.js
`);
  process.exit(0);
}

// Exécution
runUpdate().catch(console.error);
