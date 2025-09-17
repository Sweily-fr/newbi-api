import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement depuis ecosystem.config.cjs
const ecosystemPath = path.join(__dirname, '..', 'ecosystem.config.cjs');
console.log('📄 Chargement des variables depuis ecosystem.config.cjs');

try {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const ecosystemConfig = require(ecosystemPath);
  const appConfig = ecosystemConfig.apps[0];
  
  if (appConfig && appConfig.env) {
    Object.assign(process.env, appConfig.env);
    console.log('✅ Variables d\'environnement chargées depuis ecosystem.config.cjs');
  }
} catch (error) {
  console.error('❌ Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
  process.exit(1);
}

async function diagnoseLoginIssue() {
  console.log('🔍 DIAGNOSTIC DES PROBLÈMES DE CONNEXION POST-MIGRATION');
  console.log('============================================================');
  
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db();
    
    // 1. Vérifier les collections d'utilisateurs
    console.log('\n📋 1. ANALYSE DES COLLECTIONS D\'UTILISATEURS');
    console.log('------------------------------------------------------------');
    
    const collections = await db.listCollections().toArray();
    const userCollections = collections.filter(c => 
      c.name.toLowerCase().includes('user')
    );
    
    console.log('Collections liées aux utilisateurs:');
    for (const collection of userCollections) {
      const count = await db.collection(collection.name).countDocuments();
      console.log(`  - ${collection.name}: ${count} documents`);
    }
    
    // 2. Vérifier la structure des utilisateurs dans la collection 'user'
    console.log('\n📋 2. STRUCTURE DES UTILISATEURS DANS LA COLLECTION "user"');
    console.log('------------------------------------------------------------');
    
    const userCount = await db.collection('user').countDocuments();
    console.log(`Total utilisateurs dans 'user': ${userCount}`);
    
    if (userCount > 0) {
      // Prendre quelques exemples d'utilisateurs
      const sampleUsers = await db.collection('user').find({}).limit(3).toArray();
      
      console.log('\n📊 Échantillon d\'utilisateurs:');
      for (const user of sampleUsers) {
        console.log(`\n  👤 Utilisateur: ${user.email}`);
        console.log(`     - ID: ${user._id}`);
        console.log(`     - Password: ${user.password ? 'Présent (hashé)' : '❌ MANQUANT'}`);
        console.log(`     - Email vérifié: ${user.isEmailVerified ? '✅' : '❌'}`);
        console.log(`     - Compte désactivé: ${user.isDisabled ? '❌ OUI' : '✅ Non'}`);
        console.log(`     - WorkspaceId: ${user.workspaceId || user.organizationId || '❌ MANQUANT'}`);
        console.log(`     - Créé le: ${user.createdAt}`);
        console.log(`     - Modifié le: ${user.updatedAt}`);
        
        // Vérifier les champs critiques
        const criticalFields = ['email', 'password'];
        const missingFields = criticalFields.filter(field => !user[field]);
        if (missingFields.length > 0) {
          console.log(`     ⚠️  Champs critiques manquants: ${missingFields.join(', ')}`);
        }
      }
    }
    
    // 3. Vérifier les index de la collection 'user'
    console.log('\n📋 3. INDEX DE LA COLLECTION "user"');
    console.log('------------------------------------------------------------');
    
    const indexes = await db.collection('user').indexes();
    console.log('Index existants:');
    for (const index of indexes) {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
      if (index.unique) {
        console.log(`    → Index unique`);
      }
      if (index.sparse) {
        console.log(`    → Index sparse`);
      }
    }
    
    // 4. Tester une requête de connexion simulée
    console.log('\n📋 4. TEST DE REQUÊTE DE CONNEXION SIMULÉE');
    console.log('------------------------------------------------------------');
    
    if (userCount > 0) {
      const testUser = await db.collection('user').findOne({});
      if (testUser) {
        console.log(`🧪 Test avec l'utilisateur: ${testUser.email}`);
        
        // Simuler une recherche par email (comme lors de la connexion)
        const foundUser = await db.collection('user').findOne({ 
          email: testUser.email.toLowerCase() 
        });
        
        if (foundUser) {
          console.log('✅ Utilisateur trouvé par recherche email');
          console.log(`   - ID trouvé: ${foundUser._id}`);
          console.log(`   - Email trouvé: ${foundUser.email}`);
        } else {
          console.log('❌ Utilisateur NON trouvé par recherche email');
        }
      }
    }
    
    // 5. Vérifier les organisations liées
    console.log('\n📋 5. ORGANISATIONS ET WORKSPACES');
    console.log('------------------------------------------------------------');
    
    const orgCount = await db.collection('organization').countDocuments();
    const memberCount = await db.collection('member').countDocuments();
    
    console.log(`Organisations: ${orgCount}`);
    console.log(`Membres: ${memberCount}`);
    
    if (orgCount > 0) {
      const sampleOrg = await db.collection('organization').findOne({});
      console.log(`\n📊 Exemple d'organisation:`);
      console.log(`   - ID: ${sampleOrg._id}`);
      console.log(`   - Nom: ${sampleOrg.name || 'Non défini'}`);
      console.log(`   - Créée le: ${sampleOrg.createdAt}`);
    }
    
    // 6. Vérifier les sessions actives
    console.log('\n📋 6. SESSIONS ACTIVES');
    console.log('------------------------------------------------------------');
    
    const sessionCount = await db.collection('session').countDocuments();
    console.log(`Sessions totales: ${sessionCount}`);
    
    if (sessionCount > 0) {
      const activeSessions = await db.collection('session').find({
        expires: { $gt: new Date() }
      }).toArray();
      
      console.log(`Sessions actives: ${activeSessions.length}`);
      
      if (activeSessions.length > 0) {
        console.log('\n📊 Sessions actives:');
        for (const session of activeSessions.slice(0, 3)) {
          const sessionData = JSON.parse(session.session || '{}');
          console.log(`   - Session ID: ${session._id}`);
          console.log(`   - Expire le: ${session.expires}`);
          console.log(`   - Utilisateur: ${sessionData.passport?.user || 'Non défini'}`);
        }
      }
    }
    
    // 7. Recommandations
    console.log('\n📋 7. DIAGNOSTIC ET RECOMMANDATIONS');
    console.log('============================================================');
    
    const issues = [];
    const recommendations = [];
    
    if (userCount === 0) {
      issues.push('❌ Aucun utilisateur dans la collection "user"');
      recommendations.push('Vérifier si la migration s\'est correctement déroulée');
    }
    
    if (orgCount !== userCount) {
      issues.push(`⚠️  Nombre d'organisations (${orgCount}) différent du nombre d'utilisateurs (${userCount})`);
      recommendations.push('Vérifier que chaque utilisateur a bien son organisation');
    }
    
    if (sessionCount > 0) {
      issues.push('⚠️  Des sessions existent encore');
      recommendations.push('Redémarrer l\'application ou vider les sessions pour forcer une nouvelle authentification');
    }
    
    if (issues.length === 0) {
      console.log('✅ Aucun problème majeur détecté dans la structure des données');
      recommendations.push('Vérifier les logs de l\'application lors des tentatives de connexion');
      recommendations.push('Tester la connexion avec un utilisateur spécifique');
      recommendations.push('Vérifier que l\'application utilise bien la nouvelle structure');
    } else {
      console.log('❌ Problèmes détectés:');
      issues.forEach(issue => console.log(`   ${issue}`));
    }
    
    console.log('\n💡 Recommandations:');
    recommendations.forEach(rec => console.log(`   • ${rec}`));
    
    console.log('\n🔧 Commandes utiles pour déboguer:');
    console.log('   • Tester une connexion: node scripts/test-user-login.js <email>');
    console.log('   • Vider les sessions: db.session.deleteMany({})');
    console.log('   • Redémarrer l\'app: pm2 restart newbi');
    
  } catch (error) {
    console.error('❌ Erreur lors du diagnostic:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n✅ Connexion MongoDB fermée');
  }
}

diagnoseLoginIssue().catch(console.error);
