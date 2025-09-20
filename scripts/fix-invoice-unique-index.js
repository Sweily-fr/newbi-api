import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: join(__dirname, '../.env') });

// Fallback vers ecosystem.config.cjs si les variables d'environnement ne sont pas disponibles
let mongoUri = process.env.MONGODB_URI;

async function loadConfig() {
  if (!mongoUri) {
    try {
      const ecosystemPath = join(__dirname, '../ecosystem.config.cjs');
      const ecosystem = await import(ecosystemPath);
      mongoUri = ecosystem.default.apps[0].env.MONGODB_URI;
    } catch (error) {
      console.error('❌ Impossible de charger la configuration:', error.message);
      process.exit(1);
    }
  }
  
  if (!mongoUri) {
    console.error('❌ MONGODB_URI non trouvée dans les variables d\'environnement ou ecosystem.config.cjs');
    process.exit(1);
  }
  
  return mongoUri;
}

async function fixDocumentUniqueIndexes() {
  try {
    // Charger la configuration
    const uri = await loadConfig();
    
    console.log('🚀 Connexion à MongoDB...');
    await mongoose.connect(uri);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;
    
    // Collections à traiter
    const collections = [
      { 
        name: 'invoices', 
        oldIndexes: ['number_createdBy_year_unique'], 
        newIndex: 'number_workspaceId_year_unique' 
      },
      { 
        name: 'creditnotes', 
        oldIndexes: ['creditnote_number_createdBy_year_unique'], 
        newIndex: 'creditnote_number_workspaceId_year_unique' 
      },
      { 
        name: 'quotes', 
        oldIndexes: ['number_createdBy_year_unique', 'number_1_createdBy_1'], 
        newIndex: 'number_workspaceId_year_unique' 
      }
    ];

    for (const collectionInfo of collections) {
      console.log(`\n🔄 Traitement de la collection: ${collectionInfo.name}`);
      const collection = db.collection(collectionInfo.name);
      
      // Vérifier si la collection existe
      const collectionExists = await db.listCollections({ name: collectionInfo.name }).hasNext();
      if (!collectionExists) {
        console.log(`⚠️  Collection ${collectionInfo.name} n'existe pas, passage à la suivante`);
        continue;
      }

      console.log(`\n📋 Analyse des index existants pour ${collectionInfo.name}...`);
      const indexes = await collection.indexes();
      console.log('Index existants:', indexes.map(idx => ({ name: idx.name, key: idx.key })));

      // Supprimer tous les anciens index
      for (const oldIndexName of collectionInfo.oldIndexes) {
        const oldIndexExists = indexes.some(idx => idx.name === oldIndexName);
        
        if (oldIndexExists) {
          console.log(`\n🗑️  Suppression de l'ancien index ${oldIndexName}...`);
          try {
            await collection.dropIndex(oldIndexName);
            console.log('✅ Ancien index supprimé avec succès');
          } catch (error) {
            if (error.code === 27) {
              console.log('⚠️  L\'index n\'existe pas (déjà supprimé)');
            } else {
              throw error;
            }
          }
        } else {
          console.log(`ℹ️  L'ancien index ${oldIndexName} n'existe pas`);
        }
      }

      // Ajouter le champ issueYear aux documents existants qui n'en ont pas
      console.log(`\n📅 Mise à jour des documents ${collectionInfo.name} avec issueYear...`);
      const result = await collection.updateMany(
        { issueYear: { $exists: false } },
        [
          {
            $set: {
              issueYear: {
                $year: {
                  $ifNull: ['$issueDate', new Date()]
                }
              }
            }
          }
        ]
      );
      console.log(`✅ ${result.modifiedCount} documents mis à jour avec issueYear`);

      // Vérifier et nettoyer les documents avec workspaceId null
      console.log(`\n🧹 Vérification des documents avec workspaceId null...`);
      const nullWorkspaceCount = await collection.countDocuments({ workspaceId: null });
      
      if (nullWorkspaceCount > 0) {
        console.log(`⚠️  Trouvé ${nullWorkspaceCount} documents avec workspaceId null`);
        
        // Lister quelques exemples pour diagnostic
        const examples = await collection.find({ workspaceId: null }).limit(5).toArray();
        console.log('Exemples de documents problématiques:');
        examples.forEach((doc, index) => {
          console.log(`  ${index + 1}. ID: ${doc._id}, number: ${doc.number}, createdBy: ${doc.createdBy}`);
        });
        
        console.log('❌ Impossible de créer l\'index unique avec des workspaceId null');
        console.log('💡 Solutions possibles:');
        console.log('   1. Supprimer ces documents orphelins');
        console.log('   2. Leur assigner un workspaceId valide');
        console.log('   3. Les exclure de l\'index unique');
        
        // Proposer de supprimer les documents orphelins
        console.log('\n🗑️  Suppression des documents orphelins avec workspaceId null...');
        const deleteResult = await collection.deleteMany({ workspaceId: null });
        console.log(`✅ ${deleteResult.deletedCount} documents orphelins supprimés`);
      } else {
        console.log('✅ Aucun document avec workspaceId null trouvé');
      }

      // Créer le nouvel index
      console.log(`\n🔧 Création du nouvel index ${collectionInfo.newIndex}...`);
      try {
        await collection.createIndex(
          {
            number: 1,
            workspaceId: 1,
            issueYear: 1
          },
          {
            unique: true,
            partialFilterExpression: { number: { $exists: true } },
            name: collectionInfo.newIndex
          }
        );
        console.log('✅ Nouvel index créé avec succès');
      } catch (error) {
        if (error.code === 85) {
          console.log('⚠️  L\'index existe déjà');
        } else {
          throw error;
        }
      }

      // Vérifier les index finaux
      console.log(`\n📋 Vérification des index finaux pour ${collectionInfo.name}...`);
      const finalIndexes = await collection.indexes();
      const newIndex = finalIndexes.find(idx => idx.name === collectionInfo.newIndex);
      
      if (newIndex) {
        console.log('✅ Nouvel index confirmé:', newIndex);
      } else {
        console.log('❌ Nouvel index non trouvé');
      }

      // Statistiques
      console.log(`\n📊 Statistiques de ${collectionInfo.name}...`);
      const totalDocs = await collection.countDocuments();
      const docsWithNumbers = await collection.countDocuments({ number: { $exists: true } });
      const docsWithYear = await collection.countDocuments({ issueYear: { $exists: true } });
      
      console.log(`Total: ${totalDocs}`);
      console.log(`Avec numéro: ${docsWithNumbers}`);
      console.log(`Avec issueYear: ${docsWithYear}`);
    }

    console.log('\n🎉 Correction de tous les index terminée avec succès!');
    console.log('\nℹ️  Les documents peuvent maintenant être créés avec:');
    console.log('   - Même numéro dans différentes organisations');
    console.log('   - Même numéro dans différentes années');
    console.log('   - Unicité par: numéro + organisation + année');

  } catch (error) {
    console.error('❌ Erreur lors de la correction des index:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  fixDocumentUniqueIndexes()
    .then(() => {
      console.log('✅ Script terminé avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Erreur fatale:', error);
      process.exit(1);
    });
}

export default fixDocumentUniqueIndexes;
