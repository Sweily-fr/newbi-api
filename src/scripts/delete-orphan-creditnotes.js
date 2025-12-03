/**
 * Script pour supprimer les avoirs orphelins (sans client.id valide)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import CreditNote from '../models/CreditNote.js';

dotenv.config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connecté à MongoDB');

  // Trouver les avoirs sans client.id valide
  const orphanCreditNotes = await CreditNote.find({
    $or: [
      { 'client.id': null },
      { 'client.id': { $exists: false } },
      { 'client.id': '' }
    ]
  });

  console.log(`\n📋 Avoirs orphelins trouvés: ${orphanCreditNotes.length}`);
  
  for (const cn of orphanCreditNotes) {
    console.log(`   - ${cn.prefix}-${cn.number} (client: ${cn.client?.name})`);
  }

  if (orphanCreditNotes.length > 0) {
    // Supprimer les avoirs orphelins
    const result = await CreditNote.deleteMany({
      $or: [
        { 'client.id': null },
        { 'client.id': { $exists: false } },
        { 'client.id': '' }
      ]
    });

    console.log(`\n🗑️ Avoirs supprimés: ${result.deletedCount}`);
  }

  await mongoose.disconnect();
  console.log('✅ Déconnecté de MongoDB');
}

main().catch(console.error);
