import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';

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

// Récupérer l'email de l'utilisateur depuis les arguments
const userEmail = process.argv[2];
const confirmFlag = process.argv[3];

if (!userEmail) {
  console.log('❌ Usage: node delete-user-complete.js <email> [--confirm]');
  console.log('📋 Exemple: node delete-user-complete.js user@example.com --confirm');
  console.log('⚠️  ATTENTION: Cette action est IRRÉVERSIBLE !');
  process.exit(1);
}

const DRY_RUN = confirmFlag !== '--confirm';

async function deleteUserComplete() {
  console.log('🗑️  SUPPRESSION COMPLÈTE D\'UTILISATEUR');
  console.log('============================================================');
  console.log(`📧 Utilisateur: ${userEmail}`);
  console.log(`🔄 Mode: ${DRY_RUN ? 'DRY-RUN (simulation)' : 'PRODUCTION (réel)'}`);
  console.log('============================================================');
  
  if (DRY_RUN) {
    console.log('⚠️  MODE DRY-RUN: Aucune suppression ne sera effectuée');
    console.log('⚠️  Utilisez --confirm pour exécuter réellement');
  }
  
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db();
    
    // 1. Trouver l'utilisateur
    console.log('\n🔍 Recherche de l\'utilisateur...');
    const user = await db.collection('user').findOne({ email: userEmail });
    
    if (!user) {
      console.log('❌ Utilisateur non trouvé');
      return;
    }
    
    console.log(`✅ Utilisateur trouvé: ${user.email} (ID: ${user._id})`);
    const userId = user._id.toString();
    const workspaceId = user.workspaceId || user.organizationId;
    
    if (workspaceId) {
      console.log(`📋 WorkspaceId: ${workspaceId}`);
    }
    
    // 2. Compter toutes les données liées
    console.log('\n📊 Analyse des données liées...');
    
    const collections = [
      { name: 'invoices', userField: 'createdBy' },
      { name: 'quotes', userField: 'createdBy' },
      { name: 'clients', userField: 'createdBy' },
      { name: 'expenses', userField: 'userId' },
      { name: 'creditnotes', userField: 'createdBy' },
      { name: 'transactions', userField: 'userId' },
      { name: 'events', userField: 'userId' },
      { name: 'products', userField: 'createdBy' },
      { name: 'documentsettings', userField: 'userId' },
      { name: 'emailsignatures', userField: 'userId' },
      { name: 'purchaseorders', userField: 'createdBy' },
      { name: 'kanbanboards', userField: 'createdBy' }
    ];
    
    const deletionStats = {};
    let totalDocuments = 0;
    
    for (const collection of collections) {
      const query = workspaceId 
        ? { workspaceId: new ObjectId(workspaceId) }
        : { [collection.userField]: new ObjectId(userId) };
        
      const count = await db.collection(collection.name).countDocuments(query);
      deletionStats[collection.name] = count;
      totalDocuments += count;
      
      if (count > 0) {
        console.log(`  📋 ${collection.name}: ${count} documents`);
      }
    }
    
    // 3. Compter les données d'organisation
    let organizationCount = 0;
    let memberCount = 0;
    
    if (workspaceId) {
      organizationCount = await db.collection('organization').countDocuments({ _id: new ObjectId(workspaceId) });
      memberCount = await db.collection('member').countDocuments({ organizationId: new ObjectId(workspaceId) });
      
      console.log(`  📋 organization: ${organizationCount} documents`);
      console.log(`  📋 member: ${memberCount} documents`);
    }
    
    console.log(`\n📊 TOTAL: ${totalDocuments + organizationCount + memberCount + 1} documents à supprimer`);
    
    if (totalDocuments === 0 && organizationCount === 0 && memberCount === 0) {
      console.log('✅ Aucune donnée liée trouvée, suppression de l\'utilisateur uniquement');
    }
    
    // 4. Confirmation si mode production
    if (!DRY_RUN) {
      console.log('\n⚠️  ATTENTION: Cette action est IRRÉVERSIBLE !');
      console.log('⚠️  Toutes les données de cet utilisateur seront définitivement supprimées');
      
      // En mode script, on procède directement
      console.log('🚀 Démarrage de la suppression...');
    }
    
    // 5. Supprimer les données liées
    console.log('\n🗑️  Suppression des données liées...');
    
    for (const collection of collections) {
      if (deletionStats[collection.name] > 0) {
        const query = workspaceId 
          ? { workspaceId: new ObjectId(workspaceId) }
          : { [collection.userField]: new ObjectId(userId) };
          
        if (!DRY_RUN) {
          const result = await db.collection(collection.name).deleteMany(query);
          console.log(`✅ ${collection.name}: ${result.deletedCount} documents supprimés`);
        } else {
          console.log(`🔍 [DRY-RUN] ${collection.name}: ${deletionStats[collection.name]} documents seraient supprimés`);
        }
      }
    }
    
    // 6. Supprimer l'organisation et les membres
    if (workspaceId) {
      console.log('\n🗑️  Suppression de l\'organisation...');
      
      if (!DRY_RUN) {
        const memberResult = await db.collection('member').deleteMany({ organizationId: new ObjectId(workspaceId) });
        console.log(`✅ member: ${memberResult.deletedCount} documents supprimés`);
        
        const orgResult = await db.collection('organization').deleteOne({ _id: new ObjectId(workspaceId) });
        console.log(`✅ organization: ${orgResult.deletedCount} documents supprimés`);
      } else {
        console.log(`🔍 [DRY-RUN] member: ${memberCount} documents seraient supprimés`);
        console.log(`🔍 [DRY-RUN] organization: ${organizationCount} documents seraient supprimés`);
      }
    }
    
    // 7. Supprimer l'utilisateur
    console.log('\n🗑️  Suppression de l\'utilisateur...');
    
    if (!DRY_RUN) {
      const userResult = await db.collection('user').deleteOne({ _id: user._id });
      console.log(`✅ user: ${userResult.deletedCount} document supprimé`);
    } else {
      console.log(`🔍 [DRY-RUN] user: 1 document serait supprimé`);
    }
    
    // 8. Résumé final
    console.log('\n📈 RÉSUMÉ DE SUPPRESSION');
    console.log('============================================================');
    
    const totalDeleted = totalDocuments + organizationCount + memberCount + 1;
    
    if (!DRY_RUN) {
      console.log(`✅ Suppression terminée: ${totalDeleted} documents supprimés`);
      console.log(`✅ Utilisateur ${userEmail} et toutes ses données ont été supprimés`);
    } else {
      console.log(`🔍 Simulation terminée: ${totalDeleted} documents seraient supprimés`);
      console.log(`🔍 Pour exécuter réellement: node delete-user-complete.js ${userEmail} --confirm`);
    }
    
    console.log('\n📋 Détail par collection:');
    for (const [collection, count] of Object.entries(deletionStats)) {
      if (count > 0) {
        console.log(`  - ${collection}: ${count}`);
      }
    }
    if (organizationCount > 0) console.log(`  - organization: ${organizationCount}`);
    if (memberCount > 0) console.log(`  - member: ${memberCount}`);
    console.log(`  - user: 1`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la suppression:', error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('✅ Connexion MongoDB fermée');
  }
}

deleteUserComplete().catch(console.error);
