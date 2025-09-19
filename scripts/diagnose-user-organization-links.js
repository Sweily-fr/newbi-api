import { MongoClient, ObjectId } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DRY_RUN = true;

// Fonction pour charger les variables d'environnement
async function loadEnvironmentVariables() {
  try {
    const ecosystemPath = path.join(__dirname, '..', 'ecosystem.config.cjs');
    if (fs.existsSync(ecosystemPath)) {
      console.log('📁 Chargement des variables depuis ecosystem.config.cjs...');
      const ecosystem = await import(`file://${ecosystemPath}`);
      if (ecosystem.default && ecosystem.default.apps && ecosystem.default.apps[0] && ecosystem.default.apps[0].env) {
        Object.assign(process.env, ecosystem.default.apps[0].env);
        console.log('✅ Variables d\'environnement chargées');
      }
    }
  } catch (error) {
    console.log('⚠️  Impossible de charger ecosystem.config.cjs:', error.message);
  }
}

// Fonction de diagnostic des liens user-organization
async function diagnoseUserOrganizationLinks() {
  let client;
  
  try {
    await loadEnvironmentVariables();

    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non défini');
    }

    console.log('🔗 Connexion à MongoDB...');
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db();
    console.log('✅ Connecté à MongoDB');

    console.log('\n📊 DIAGNOSTIC DES LIENS USER ↔ ORGANIZATION');
    console.log('==============================================');

    // 1. Analyser la structure des utilisateurs
    console.log('\n1️⃣ STRUCTURE DES UTILISATEURS');
    console.log('------------------------------');
    
    const userSample = await db.collection('user').findOne({});
    if (userSample) {
      console.log('Champs disponibles dans user:');
      Object.keys(userSample).forEach(key => {
        const value = userSample[key];
        const type = typeof value;
        console.log(`  ${key}: ${type} ${type === 'object' && value ? `(${value.constructor.name})` : ''}`);
      });
      
      // Vérifier les champs de liaison potentiels
      const linkFields = ['organizationId', 'workspaceId', 'orgId', 'companyId'];
      console.log('\nChamps de liaison recherchés:');
      linkFields.forEach(field => {
        const exists = userSample.hasOwnProperty(field);
        const value = userSample[field];
        console.log(`  ${field}: ${exists ? `✅ ${value}` : '❌ absent'}`);
      });
    } else {
      console.log('❌ Aucun utilisateur trouvé');
    }

    // 2. Analyser la structure des organisations
    console.log('\n2️⃣ STRUCTURE DES ORGANISATIONS');
    console.log('-------------------------------');
    
    const orgSample = await db.collection('organization').findOne({});
    if (orgSample) {
      console.log('Champs disponibles dans organization:');
      Object.keys(orgSample).forEach(key => {
        const value = orgSample[key];
        const type = typeof value;
        console.log(`  ${key}: ${type} ${type === 'object' && value ? `(${value.constructor.name})` : ''}`);
      });
    } else {
      console.log('❌ Aucune organisation trouvée');
    }

    // 3. Statistiques générales
    console.log('\n3️⃣ STATISTIQUES');
    console.log('----------------');
    
    const userCount = await db.collection('user').countDocuments();
    const orgCount = await db.collection('organization').countDocuments();
    const memberCount = await db.collection('member').countDocuments();
    
    console.log(`Utilisateurs: ${userCount}`);
    console.log(`Organisations: ${orgCount}`);
    console.log(`Membres: ${memberCount}`);

    // 4. Analyser les champs de liaison dans tous les utilisateurs
    console.log('\n4️⃣ ANALYSE DES CHAMPS DE LIAISON');
    console.log('---------------------------------');
    
    const linkFieldsAnalysis = await db.collection('user').aggregate([
      {
        $project: {
          hasOrganizationId: { $ne: ['$organizationId', null] },
          hasWorkspaceId: { $ne: ['$workspaceId', null] },
          hasOrgId: { $ne: ['$orgId', null] },
          hasCompanyId: { $ne: ['$companyId', null] },
          organizationId: '$organizationId',
          workspaceId: '$workspaceId',
          orgId: '$orgId',
          companyId: '$companyId'
        }
      },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          usersWithOrganizationId: { $sum: { $cond: ['$hasOrganizationId', 1, 0] } },
          usersWithWorkspaceId: { $sum: { $cond: ['$hasWorkspaceId', 1, 0] } },
          usersWithOrgId: { $sum: { $cond: ['$hasOrgId', 1, 0] } },
          usersWithCompanyId: { $sum: { $cond: ['$hasCompanyId', 1, 0] } },
          organizationIdExamples: { $push: '$organizationId' },
          workspaceIdExamples: { $push: '$workspaceId' }
        }
      }
    ]).toArray();

    if (linkFieldsAnalysis.length > 0) {
      const analysis = linkFieldsAnalysis[0];
      console.log(`Utilisateurs avec organizationId: ${analysis.usersWithOrganizationId}/${analysis.totalUsers}`);
      console.log(`Utilisateurs avec workspaceId: ${analysis.usersWithWorkspaceId}/${analysis.totalUsers}`);
      console.log(`Utilisateurs avec orgId: ${analysis.usersWithOrgId}/${analysis.totalUsers}`);
      console.log(`Utilisateurs avec companyId: ${analysis.usersWithCompanyId}/${analysis.totalUsers}`);
    }

    // 5. Analyser les organisations avec createdBy
    console.log('\n5️⃣ ORGANISATIONS AVEC CREATEDBY');
    console.log('-------------------------------');
    
    const orgsWithCreatedBy = await db.collection('organization').find({ 
      createdBy: { $exists: true, $ne: null } 
    }).limit(5).toArray();
    
    console.log(`Organisations avec createdBy: ${orgsWithCreatedBy.length}`);
    
    for (let i = 0; i < Math.min(3, orgsWithCreatedBy.length); i++) {
      const org = orgsWithCreatedBy[i];
      console.log(`\nOrganisation ${i + 1}:`);
      console.log(`  ID: ${org._id}`);
      console.log(`  Nom: ${org.name || 'N/A'}`);
      console.log(`  CreatedBy: ${org.createdBy} (${typeof org.createdBy})`);
      
      // Essayer de trouver l'utilisateur correspondant
      let user = await db.collection('user').findOne({ _id: org.createdBy });
      if (!user && typeof org.createdBy === 'string') {
        try {
          user = await db.collection('user').findOne({ _id: new ObjectId(org.createdBy) });
        } catch (e) {}
      }
      if (!user && org.createdBy instanceof ObjectId) {
        user = await db.collection('user').findOne({ _id: org.createdBy.toString() });
      }
      
      console.log(`  Utilisateur trouvé: ${user ? `✅ ${user.email}` : '❌ Non trouvé'}`);
      
      if (user) {
        console.log(`    Utilisateur ID: ${user._id} (${typeof user._id})`);
        console.log(`    organizationId: ${user.organizationId || 'N/A'}`);
        console.log(`    workspaceId: ${user.workspaceId || 'N/A'}`);
      }
    }

    // 6. Stratégies possibles
    console.log('\n6️⃣ STRATÉGIES POSSIBLES');
    console.log('------------------------');
    
    const totalOrgsWithCreatedBy = await db.collection('organization').countDocuments({ 
      createdBy: { $exists: true, $ne: null } 
    });
    
    console.log('Stratégies identifiées:');
    console.log(`1. Utiliser createdBy pour créer les memberships (${totalOrgsWithCreatedBy} organisations)`);
    console.log('2. Migrer d\'abord les organizationId/workspaceId depuis users vers user');
    console.log('3. Utiliser l\'email pour faire le lien entre users.company et user');
    
    // 7. Vérifier s'il y a des données dans users.company
    console.log('\n7️⃣ DONNÉES COMPANY DANS USERS');
    console.log('------------------------------');
    
    try {
      const usersWithCompany = await db.collection('users').countDocuments({ 
        company: { $exists: true, $ne: null } 
      });
      console.log(`Utilisateurs avec company dans 'users': ${usersWithCompany}`);
      
      if (usersWithCompany > 0) {
        const usersSample = await db.collection('users').findOne({ 
          company: { $exists: true, $ne: null } 
        });
        console.log('Exemple de company dans users:');
        console.log(`  Email: ${usersSample.email}`);
        console.log(`  Company: ${JSON.stringify(usersSample.company, null, 2)}`);
      }
    } catch (error) {
      console.log('❌ Collection users non accessible ou inexistante');
    }

    console.log('\n✅ Diagnostic terminé');

  } catch (error) {
    console.error('❌ Erreur lors du diagnostic:', error);
  } finally {
    if (client) {
      await client.close();
      console.log('🔒 Connexion fermée');
    }
  }
}

// Exécution du script
if (import.meta.url === `file://${__filename}`) {
  console.log('🔍 DIAGNOSTIC DES LIENS USER ↔ ORGANIZATION');
  console.log('==============================================');
  
  diagnoseUserOrganizationLinks()
    .then(() => {
      console.log('\n🎉 Diagnostic terminé avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Erreur fatale:', error);
      process.exit(1);
    });
}

export { diagnoseUserOrganizationLinks };
