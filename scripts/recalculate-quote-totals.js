/**
 * Script pour forcer le recalcul des totaux des devis
 * Cela déclenchera le pre-save hook qui calculera finalTotalVAT
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI non défini dans les variables d\'environnement');
  process.exit(1);
}

// Importer le modèle Quote
import Quote from '../src/models/Quote.js';

async function recalculateQuotes() {
  try {
    console.log('🔌 Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB\n');

    console.log('📋 Récupération de tous les devis...');
    const quotes = await Quote.find({});
    
    console.log(`   Trouvé ${quotes.length} devis à recalculer\n`);

    let updated = 0;
    let errors = 0;
    for (const quote of quotes) {
      try {
        // Sauvegarder le devis pour déclencher le pre-save hook
        await quote.save({ validateBeforeSave: false });
        updated++;
      } catch (error) {
        console.log(`\n   ⚠️  Erreur pour le devis ${quote.number}: ${error.message}`);
        errors++;
      }
      
      if ((updated + errors) % 5 === 0) {
        process.stdout.write(`\r   Progression: ${updated + errors}/${quotes.length}`);
      }
    }

    console.log(`\r   ✅ ${updated} devis recalculés`);
    console.log(`\n✅ Recalcul terminé avec succès!`);

  } catch (error) {
    console.error('❌ Erreur lors du recalcul:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

// Exécuter le recalcul
recalculateQuotes();
