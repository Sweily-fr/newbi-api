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

async function fixRollbackIndexes() {
  console.log('🔧 CORRECTION DES INDEX POUR ROLLBACK COMPLET');
  console.log('============================================================');
  
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db();
    
    // Supprimer temporairement les index problématiques
    console.log('\n🗑️  Suppression des index problématiques...');
    
    try {
      // Index quotes: workspaceId_1_number_1
      await db.collection('quotes').dropIndex('workspaceId_1_number_1');
      console.log('✅ Index workspaceId_1_number_1 supprimé de quotes');
    } catch (error) {
      console.log('⚠️  Index workspaceId_1_number_1 n\'existe pas ou déjà supprimé');
    }
    
    try {
      // Index clients: email_1_workspaceId_1
      await db.collection('clients').dropIndex('email_1_workspaceId_1');
      console.log('✅ Index email_1_workspaceId_1 supprimé de clients');
    } catch (error) {
      console.log('⚠️  Index email_1_workspaceId_1 n\'existe pas ou déjà supprimé');
    }
    
    // Maintenant supprimer les workspaceId restants
    console.log('\n🔄 Suppression des workspaceId restants...');
    
    // Quotes
    const quotesResult = await db.collection('quotes').updateMany(
      { workspaceId: { $exists: true, $ne: null } },
      { $unset: { workspaceId: 1 } }
    );
    console.log(`✅ ${quotesResult.modifiedCount} workspaceId supprimés de quotes`);
    
    // Clients
    const clientsResult = await db.collection('clients').updateMany(
      { workspaceId: { $exists: true, $ne: null } },
      { $unset: { workspaceId: 1 } }
    );
    console.log(`✅ ${clientsResult.modifiedCount} workspaceId supprimés de clients`);
    
    // Vérification finale
    console.log('\n🔍 Vérification finale...');
    
    const quotesWithWorkspace = await db.collection('quotes').countDocuments({ workspaceId: { $exists: true, $ne: null } });
    const clientsWithWorkspace = await db.collection('clients').countDocuments({ workspaceId: { $exists: true, $ne: null } });
    
    console.log(`📊 Quotes avec workspaceId: ${quotesWithWorkspace}`);
    console.log(`📊 Clients avec workspaceId: ${clientsWithWorkspace}`);
    
    if (quotesWithWorkspace === 0 && clientsWithWorkspace === 0) {
      console.log('\n🎉 ROLLBACK COMPLET RÉUSSI');
      console.log('✅ Tous les workspaceId ont été supprimés');
      console.log('✅ Prêt pour relancer la migration');
    } else {
      console.log('\n⚠️  Il reste des workspaceId à supprimer manuellement');
    }
    
  } catch (error) {
    console.error('❌ Erreur lors de la correction:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('✅ Connexion MongoDB fermée');
  }
}

fixRollbackIndexes().catch(console.error);
