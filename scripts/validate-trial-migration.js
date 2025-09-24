import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script de validation de la migration trial user → organization
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

console.log('🔍 Validation de la migration trial user → organization');
console.log('📋 Configuration:');
console.log(`   - MongoDB URI: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
console.log(`   - Database: ${MONGODB_DB_NAME}`);

async function validateTrialMigration() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('\n📡 Connexion à MongoDB...');
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(MONGODB_DB_NAME);
    const userCollection = db.collection('user');
    const organizationCollection = db.collection('organization');
    const memberCollection = db.collection('member');
    
    console.log('\n🔍 ANALYSE DES DONNÉES TRIAL...\n');
    
    // 1. Analyser les utilisateurs avec données trial
    console.log('👥 UTILISATEURS AVEC DONNÉES TRIAL:');
    const usersWithTrial = await userCollection.find({
      $or: [
        { 'subscription.isTrialActive': true },
        { 'subscription.hasUsedTrial': true },
        { 'subscription.trialStartDate': { $exists: true } },
        { 'subscription.trialEndDate': { $exists: true } }
      ]
    }).toArray();
    
    console.log(`📊 Total utilisateurs avec trial: ${usersWithTrial.length}`);
    
    // 2. Analyser les organisations avec données trial
    console.log('\n🏢 ORGANISATIONS AVEC DONNÉES TRIAL:');
    const organizationsWithTrial = await organizationCollection.find({
      $or: [
        { isTrialActive: true },
        { hasUsedTrial: true },
        { trialStartDate: { $exists: true } },
        { trialEndDate: { $exists: true } }
      ]
    }).toArray();
    
    console.log(`📊 Total organisations avec trial: ${organizationsWithTrial.length}`);
    
    // 3. Vérifier la cohérence des données
    console.log('\n🔄 VÉRIFICATION DE LA COHÉRENCE:');
    
    let validMigrations = 0;
    let inconsistentData = 0;
    let missingOrganizations = 0;
    
    const validationResults = [];
    
    for (const user of usersWithTrial) {
      try {
        // Trouver l'organisation de l'utilisateur
        const membership = await memberCollection.findOne({
          userId: user._id.toString()
        });
        
        if (!membership) {
          console.log(`⚠️ ${user.email}: Aucune organisation trouvée`);
          missingOrganizations++;
          validationResults.push({
            userEmail: user.email,
            userId: user._id.toString(),
            status: 'missing_organization',
            userTrialData: user.subscription
          });
          continue;
        }
        
        const organization = await organizationCollection.findOne({
          id: membership.organizationId
        });
        
        if (!organization) {
          console.log(`❌ ${user.email}: Organisation ${membership.organizationId} non trouvée`);
          missingOrganizations++;
          validationResults.push({
            userEmail: user.email,
            userId: user._id.toString(),
            organizationId: membership.organizationId,
            status: 'organization_not_found',
            userTrialData: user.subscription
          });
          continue;
        }
        
        // Comparer les données trial
        const userTrial = user.subscription || {};
        const orgTrial = {
          trialStartDate: organization.trialStartDate,
          trialEndDate: organization.trialEndDate,
          isTrialActive: organization.isTrialActive,
          hasUsedTrial: organization.hasUsedTrial
        };
        
        const isConsistent = (
          userTrial.trialStartDate?.getTime() === orgTrial.trialStartDate?.getTime() &&
          userTrial.trialEndDate?.getTime() === orgTrial.trialEndDate?.getTime() &&
          userTrial.isTrialActive === orgTrial.isTrialActive &&
          userTrial.hasUsedTrial === orgTrial.hasUsedTrial
        );
        
        if (isConsistent) {
          console.log(`✅ ${user.email}: Données cohérentes`);
          validMigrations++;
          validationResults.push({
            userEmail: user.email,
            userId: user._id.toString(),
            organizationId: membership.organizationId,
            status: 'consistent',
            userTrialData: userTrial,
            orgTrialData: orgTrial
          });
        } else {
          console.log(`⚠️ ${user.email}: Données incohérentes`);
          console.log(`   User: ${JSON.stringify(userTrial)}`);
          console.log(`   Org:  ${JSON.stringify(orgTrial)}`);
          inconsistentData++;
          validationResults.push({
            userEmail: user.email,
            userId: user._id.toString(),
            organizationId: membership.organizationId,
            status: 'inconsistent',
            userTrialData: userTrial,
            orgTrialData: orgTrial
          });
        }
        
      } catch (error) {
        console.error(`❌ Erreur lors de la validation de ${user.email}:`, error.message);
        inconsistentData++;
      }
    }
    
    // 4. Générer le rapport de validation
    console.log('\n📊 RÉSUMÉ DE LA VALIDATION:');
    console.log(`✅ Migrations valides: ${validMigrations}`);
    console.log(`⚠️ Données incohérentes: ${inconsistentData}`);
    console.log(`❌ Organisations manquantes: ${missingOrganizations}`);
    console.log(`📋 Total vérifié: ${usersWithTrial.length}`);
    
    // 5. Sauvegarder le rapport détaillé
    const reportDir = join(__dirname, '..', 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = join(reportDir, `trial-migration-validation-${timestamp}.json`);
    
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalUsersWithTrial: usersWithTrial.length,
        totalOrganizationsWithTrial: organizationsWithTrial.length,
        validMigrations,
        inconsistentData,
        missingOrganizations
      },
      validationResults,
      usersWithTrial: usersWithTrial.map(u => ({
        email: u.email,
        id: u._id.toString(),
        subscription: u.subscription
      })),
      organizationsWithTrial: organizationsWithTrial.map(o => ({
        id: o.id,
        name: o.name || o.companyName,
        trialData: {
          trialStartDate: o.trialStartDate,
          trialEndDate: o.trialEndDate,
          isTrialActive: o.isTrialActive,
          hasUsedTrial: o.hasUsedTrial
        }
      }))
    };
    
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`\n📄 Rapport détaillé sauvegardé: ${reportFile}`);
    
    // 6. Recommandations
    console.log('\n💡 RECOMMANDATIONS:');
    
    if (validMigrations === usersWithTrial.length) {
      console.log('🎉 Migration parfaitement réussie !');
      console.log('✅ Vous pouvez procéder au nettoyage des champs subscription des utilisateurs');
    } else {
      if (inconsistentData > 0) {
        console.log('⚠️ Certaines données sont incohérentes. Vérifiez le rapport détaillé.');
        console.log('🔧 Vous devrez peut-être relancer la migration pour ces utilisateurs.');
      }
      
      if (missingOrganizations > 0) {
        console.log('❌ Certains utilisateurs n\'ont pas d\'organisation associée.');
        console.log('🔧 Créez les organisations manquantes ou associez les utilisateurs à des organisations existantes.');
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur lors de la validation:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n📡 Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  validateTrialMigration()
    .then(() => {
      console.log('\n🎉 Validation terminée avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Erreur fatale:', error);
      process.exit(1);
    });
}

export default validateTrialMigration;
