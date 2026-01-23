/**
 * Script de migration des visiteurs existants vers la collection UserInvited
 * 
 * Ce script migre les visiteurs stockés dans PublicBoardShare.visitors
 * vers la nouvelle collection UserInvited pour une gestion persistante.
 * 
 * Usage: node scripts/migrateVisitorsToUserInvited.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';

// Schéma simplifié pour la migration
const boardAccessSchema = new mongoose.Schema({
  boardId: mongoose.Schema.Types.ObjectId,
  shareId: mongoose.Schema.Types.ObjectId,
  workspaceId: mongoose.Schema.Types.ObjectId,
  grantedAt: { type: Date, default: Date.now },
  lastVisitAt: { type: Date, default: Date.now },
  visitCount: { type: Number, default: 1 },
  status: { type: String, default: 'active' }
}, { _id: true });

const userInvitedSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, default: null },
  requiresPassword: { type: Boolean, default: false },
  firstName: String,
  lastName: String,
  name: String,
  image: String,
  imageKey: String,
  linkedUserId: mongoose.Schema.Types.ObjectId,
  boardsAccess: [boardAccessSchema],
  stats: {
    totalVisits: { type: Number, default: 0 },
    totalComments: { type: Number, default: 0 },
    totalBoardsAccessed: { type: Number, default: 0 }
  },
  sessionToken: String,
  sessionExpiresAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastLoginAt: Date
});

async function migrate() {
  console.log('🚀 Démarrage de la migration des visiteurs vers UserInvited...\n');
  
  try {
    // Connexion à MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB\n');
    
    const db = mongoose.connection.db;
    
    // Créer le modèle UserInvited s'il n'existe pas
    const UserInvited = mongoose.models.UserInvited || mongoose.model('UserInvited', userInvitedSchema);
    
    // Récupérer tous les PublicBoardShare avec des visiteurs
    const shares = await db.collection('publicboardshares').find({
      'visitors.0': { $exists: true }
    }).toArray();
    
    console.log(`📋 ${shares.length} partages publics avec visiteurs trouvés\n`);
    
    let migratedCount = 0;
    let updatedCount = 0;
    let errorCount = 0;
    const processedEmails = new Set();
    
    for (const share of shares) {
      console.log(`\n📁 Traitement du partage: ${share._id} (Board: ${share.boardId})`);
      
      for (const visitor of share.visitors || []) {
        if (!visitor.email) {
          console.log(`  ⚠️ Visiteur sans email ignoré`);
          continue;
        }
        
        const email = visitor.email.toLowerCase().trim();
        
        try {
          // Vérifier si l'utilisateur existe déjà
          let userInvited = await UserInvited.findOne({ email });
          
          if (userInvited) {
            // Mettre à jour l'accès au board si nécessaire
            const existingAccess = userInvited.boardsAccess.find(
              b => b.boardId?.toString() === share.boardId?.toString()
            );
            
            if (!existingAccess) {
              userInvited.boardsAccess.push({
                boardId: share.boardId,
                shareId: share._id,
                workspaceId: share.workspaceId,
                grantedAt: visitor.firstVisitAt || new Date(),
                lastVisitAt: visitor.lastVisitAt || new Date(),
                visitCount: visitor.visitCount || 1,
                status: 'active'
              });
              
              userInvited.stats.totalVisits += visitor.visitCount || 1;
              userInvited.stats.totalBoardsAccessed = userInvited.boardsAccess.filter(b => b.status === 'active').length;
              
              await userInvited.save();
              updatedCount++;
              console.log(`  🔄 Accès ajouté pour: ${email}`);
            } else {
              console.log(`  ⏭️ Accès existant pour: ${email}`);
            }
          } else {
            // Créer un nouvel utilisateur invité
            const newUser = new UserInvited({
              email,
              firstName: visitor.firstName,
              lastName: visitor.lastName,
              name: visitor.name || [visitor.firstName, visitor.lastName].filter(Boolean).join(' ') || email.split('@')[0],
              image: visitor.image,
              requiresPassword: false,
              boardsAccess: [{
                boardId: share.boardId,
                shareId: share._id,
                workspaceId: share.workspaceId,
                grantedAt: visitor.firstVisitAt || new Date(),
                lastVisitAt: visitor.lastVisitAt || new Date(),
                visitCount: visitor.visitCount || 1,
                status: 'active'
              }],
              stats: {
                totalVisits: visitor.visitCount || 1,
                totalComments: 0,
                totalBoardsAccessed: 1
              },
              createdAt: visitor.firstVisitAt || new Date(),
              updatedAt: new Date()
            });
            
            await newUser.save();
            migratedCount++;
            console.log(`  ✅ Créé: ${email} (${newUser.name})`);
          }
          
          processedEmails.add(email);
          
        } catch (error) {
          if (error.code === 11000) {
            // Duplicate key - l'utilisateur a été créé entre-temps
            console.log(`  ⚠️ Duplicate ignoré: ${email}`);
          } else {
            console.error(`  ❌ Erreur pour ${email}:`, error.message);
            errorCount++;
          }
        }
      }
    }
    
    // Vérifier les comptes Newbi liés
    console.log('\n\n🔗 Recherche des comptes Newbi liés...\n');
    
    const allUserInvited = await UserInvited.find({});
    let linkedCount = 0;
    
    for (const userInvited of allUserInvited) {
      if (userInvited.linkedUserId) continue;
      
      // Chercher un compte Newbi avec le même email
      const newbiUser = await db.collection('user').findOne({
        email: userInvited.email
      });
      
      if (newbiUser) {
        userInvited.linkedUserId = newbiUser._id;
        
        // Copier les infos manquantes
        if (!userInvited.firstName && (newbiUser.name || newbiUser.profile?.firstName)) {
          userInvited.firstName = newbiUser.profile?.firstName || newbiUser.name;
        }
        if (!userInvited.lastName && (newbiUser.lastName || newbiUser.profile?.lastName)) {
          userInvited.lastName = newbiUser.profile?.lastName || newbiUser.lastName;
        }
        if (!userInvited.image && (newbiUser.image || newbiUser.avatar)) {
          userInvited.image = newbiUser.image || newbiUser.avatar;
        }
        
        await userInvited.save();
        linkedCount++;
        console.log(`  🔗 Lié: ${userInvited.email} -> Newbi user ${newbiUser._id}`);
      }
    }
    
    // Résumé
    console.log('\n\n========================================');
    console.log('📊 RÉSUMÉ DE LA MIGRATION');
    console.log('========================================');
    console.log(`✅ Nouveaux utilisateurs créés: ${migratedCount}`);
    console.log(`🔄 Accès ajoutés à utilisateurs existants: ${updatedCount}`);
    console.log(`🔗 Comptes liés à Newbi: ${linkedCount}`);
    console.log(`❌ Erreurs: ${errorCount}`);
    console.log(`📧 Emails uniques traités: ${processedEmails.size}`);
    console.log('========================================\n');
    
    // Statistiques finales
    const totalUserInvited = await UserInvited.countDocuments();
    console.log(`📈 Total UserInvited en base: ${totalUserInvited}\n`);
    
  } catch (error) {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Déconnecté de MongoDB');
  }
}

// Exécuter la migration
migrate().then(() => {
  console.log('\n✅ Migration terminée avec succès!');
  process.exit(0);
}).catch((error) => {
  console.error('\n❌ Migration échouée:', error);
  process.exit(1);
});
