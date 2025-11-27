#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Script pour nettoyer les commissions orphelines
 * (commissions dont le referralId n'existe plus dans la collection user)
 */

async function cleanOrphanCommissions() {
  try {
    console.log('🔄 Connexion à MongoDB...');
    
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/invoice-app';
    await mongoose.connect(mongoUri);
    
    console.log('✅ Connecté à MongoDB');
    console.log('📊 Recherche des commissions orphelines...\n');

    const db = mongoose.connection.db;
    const commissionsCollection = db.collection('partnercommissions');
    const usersCollection = db.collection('user');

    // Récupérer toutes les commissions
    const commissions = await commissionsCollection.find({}).toArray();
    console.log(`📈 ${commissions.length} commissions trouvées\n`);

    const orphanCommissions = [];

    for (const commission of commissions) {
      // Vérifier si le filleul existe
      const referral = await usersCollection.findOne({ _id: commission.referralId });
      
      if (!referral) {
        orphanCommissions.push(commission);
        console.log(`❌ Commission orpheline: ${commission._id}`);
        console.log(`   - Montant: ${commission.commissionAmount}€`);
        console.log(`   - Statut: ${commission.status}`);
        console.log(`   - Filleul manquant: ${commission.referralId}\n`);
      }
    }

    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 RÉSUMÉ');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`❌ Commissions orphelines: ${orphanCommissions.length}`);
    console.log(`✅ Commissions valides: ${commissions.length - orphanCommissions.length}`);
    
    const totalOrphanAmount = orphanCommissions.reduce((sum, c) => sum + (c.commissionAmount || 0), 0);
    console.log(`💰 Montant total orphelin: ${totalOrphanAmount.toFixed(2)}€`);
    console.log('═══════════════════════════════════════════════════════\n');

    if (orphanCommissions.length === 0) {
      console.log('✅ Aucune commission orpheline trouvée!');
      return;
    }

    // Demander confirmation
    console.log('⚠️  ATTENTION: Cette opération va SUPPRIMER définitivement ces commissions!');
    console.log('Pour continuer, relancez le script avec --confirm\n');

    if (!process.argv.includes('--confirm')) {
      console.log('ℹ️  Mode DRY-RUN - Aucune suppression effectuée');
      console.log('   Pour supprimer réellement, utilisez: node scripts/clean-orphan-commissions.js --confirm');
      return;
    }

    // Supprimer les commissions orphelines
    const orphanIds = orphanCommissions.map(c => c._id);
    const result = await commissionsCollection.deleteMany({
      _id: { $in: orphanIds }
    });

    console.log(`\n✅ ${result.deletedCount} commissions orphelines supprimées`);
    console.log('🎉 Nettoyage terminé avec succès!');

  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

console.log('═══════════════════════════════════════════════════════');
console.log('🧹 NETTOYAGE DES COMMISSIONS ORPHELINES');
console.log('═══════════════════════════════════════════════════════');
console.log('Ce script va identifier et supprimer les commissions');
console.log('dont les filleuls n\'existent plus dans la base.');
console.log('═══════════════════════════════════════════════════════\n');

cleanOrphanCommissions()
  .then(() => {
    console.log('\n✅ Script terminé');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  });
