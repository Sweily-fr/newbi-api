import { MongoClient, ObjectId } from 'mongodb';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script de migration des données trial de la collection user vers organization
 */

// Configuration MongoDB
let MONGODB_URI;
let MONGODB_DB_NAME = 'newbi';

// Essayer de charger la configuration depuis ecosystem.config.cjs
try {
  const configPath = join(__dirname, '..', 'ecosystem.config.cjs');
  if (fs.existsSync(configPath)) {
    // Utilisation synchrone pour éviter les problèmes avec await au niveau module
    console.log('⚠️ Configuration ecosystem.config.cjs trouvée mais non chargée (utilisation des variables d\'environnement)');
  }
} catch (error) {
  console.log('⚠️ Impossible de charger ecosystem.config.cjs, utilisation des variables d\'environnement');
}

// Fallback vers les variables d'environnement
if (!MONGODB_URI) {
  MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';
}

console.log('🚀 Démarrage de la migration trial user → organization');
console.log('📋 Configuration:');
console.log(`   - MongoDB URI: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
console.log(`   - Database: ${MONGODB_DB_NAME}`);

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) {
  console.log('🧪 MODE SIMULATION - Aucune modification ne sera effectuée');
}

async function migrateTrialToOrganization() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('\n📡 Connexion à MongoDB...');
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(MONGODB_DB_NAME);
    const userCollection = db.collection('user');
    const organizationCollection = db.collection('organization');
    const memberCollection = db.collection('member');
    
    // Étape 1: Créer une sauvegarde
    if (!isDryRun) {
      console.log('\n💾 Création de la sauvegarde...');
      const backupDir = join(__dirname, '..', 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = join(backupDir, `trial-migration-backup-${timestamp}.json`);
      
      // Sauvegarder les utilisateurs avec trial
      const usersWithTrial = await userCollection.find({
        $or: [
          { 'subscription.isTrialActive': true },
          { 'subscription.hasUsedTrial': true },
          { 'subscription.trialStartDate': { $exists: true } },
          { 'subscription.trialEndDate': { $exists: true } }
        ]
      }).toArray();
      
      fs.writeFileSync(backupFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        usersWithTrial: usersWithTrial,
        totalUsers: usersWithTrial.length
      }, null, 2));
      
      console.log(`✅ Sauvegarde créée: ${backupFile}`);
      console.log(`📊 ${usersWithTrial.length} utilisateurs avec données trial sauvegardés`);
    }
    
    // Étape 2: Analyser les données existantes
    console.log('\n🔍 Analyse des données existantes...');
    
    const usersWithTrialData = await userCollection.find({
      $or: [
        { 'subscription.isTrialActive': true },
        { 'subscription.hasUsedTrial': true },
        { 'subscription.trialStartDate': { $exists: true } },
        { 'subscription.trialEndDate': { $exists: true } }
      ]
    }).toArray();
    
    console.log(`📊 Utilisateurs avec données trial trouvés: ${usersWithTrialData.length}`);
    
    let migratedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    // Étape 3: Migrer chaque utilisateur
    console.log('\n🔄 Migration des données trial...');
    
    for (const user of usersWithTrialData) {
      try {
        console.log(`\n👤 Migration utilisateur: ${user.email} (${user._id})`);
        
        // Trouver l'organisation de l'utilisateur via member
        const membership = await memberCollection.findOne({
          userId: user._id.toString()
        });
        
        if (!membership) {
          console.log(`⚠️ Aucune organisation trouvée pour l'utilisateur ${user.email}`);
          skippedCount++;
          continue;
        }
        
        const organizationId = membership.organizationId;
        console.log(`🏢 Organisation trouvée: ${organizationId}`);
        
        // Vérifier si l'organisation existe
        const organization = await organizationCollection.findOne({
          id: organizationId
        });
        
        if (!organization) {
          console.log(`❌ Organisation ${organizationId} non trouvée en base`);
          errorCount++;
          continue;
        }
        
        // Préparer les données trial à migrer
        const trialData = {
          trialStartDate: user.subscription?.trialStartDate || null,
          trialEndDate: user.subscription?.trialEndDate || null,
          isTrialActive: user.subscription?.isTrialActive || false,
          hasUsedTrial: user.subscription?.hasUsedTrial || false
        };
        
        console.log(`📋 Données trial à migrer:`, trialData);
        
        if (!isDryRun) {
          // Mettre à jour l'organisation avec les données trial
          const updateResult = await organizationCollection.updateOne(
            { id: organizationId },
            { 
              $set: trialData,
              $setOnInsert: { updatedAt: new Date() }
            },
            { upsert: false }
          );
          
          if (updateResult.modifiedCount > 0) {
            console.log(`✅ Organisation ${organizationId} mise à jour avec succès`);
            migratedCount++;
          } else {
            console.log(`⚠️ Aucune modification pour l'organisation ${organizationId}`);
          }
        } else {
          console.log(`🧪 [SIMULATION] Organisation ${organizationId} serait mise à jour`);
          migratedCount++;
        }
        
      } catch (error) {
        console.error(`❌ Erreur lors de la migration de l'utilisateur ${user.email}:`, error.message);
        errorCount++;
      }
    }
    
    // Étape 4: Résumé de la migration
    console.log('\n📊 RÉSUMÉ DE LA MIGRATION:');
    console.log(`✅ Utilisateurs migrés avec succès: ${migratedCount}`);
    console.log(`⚠️ Utilisateurs ignorés (pas d'organisation): ${skippedCount}`);
    console.log(`❌ Erreurs rencontrées: ${errorCount}`);
    console.log(`📋 Total traité: ${usersWithTrialData.length}`);
    
    if (isDryRun) {
      console.log('\n🧪 SIMULATION TERMINÉE - Aucune modification effectuée');
      console.log('💡 Exécutez sans --dry-run pour appliquer les changements');
    } else {
      console.log('\n✅ MIGRATION TERMINÉE');
      
      if (migratedCount > 0) {
        console.log('\n⚠️ PROCHAINES ÉTAPES:');
        console.log('1. Vérifiez que les données ont été correctement migrées');
        console.log('2. Testez le système trial avec les nouvelles données');
        console.log('3. Une fois validé, nettoyez les champs subscription des utilisateurs');
        console.log('4. Mettez à jour le code pour utiliser les données d\'organisation');
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n📡 Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateTrialToOrganization()
    .then(() => {
      console.log('\n🎉 Script terminé avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Erreur fatale:', error);
      process.exit(1);
    });
}

export default migrateTrialToOrganization;
