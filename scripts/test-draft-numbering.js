#!/usr/bin/env node

/**
 * Script de test pour vérifier que les brouillons utilisent bien le format DRAFT-numéro
 * au lieu de DRAFT-ID unique
 */

import mongoose from 'mongoose';
import { generateQuoteNumber, generateInvoiceNumber, generateCreditNoteNumber } from '../src/utils/documentNumbers.js';

// Configuration MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:newbiPassword2024@localhost:27017/newbi?authSource=admin';

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connexion MongoDB réussie');
  } catch (error) {
    console.error('❌ Erreur connexion MongoDB:', error.message);
    process.exit(1);
  }
}

async function testDraftNumbering() {
  console.log('\n🧪 Test de la numérotation des brouillons\n');

  const testOptions = {
    workspaceId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    year: 2024
  };

  try {
    // Test 1: Devis brouillon sans numéro manuel
    console.log('📝 Test 1: Devis brouillon sans numéro manuel');
    const quoteDraft1 = await generateQuoteNumber('D', {
      ...testOptions,
      isDraft: true
    });
    console.log(`   Résultat: ${quoteDraft1}`);
    console.log(`   ✅ Format attendu: DRAFT-000001 | Obtenu: ${quoteDraft1.startsWith('DRAFT-') && /DRAFT-\d{6}/.test(quoteDraft1) ? '✅' : '❌'}`);

    // Test 2: Facture brouillon sans numéro manuel
    console.log('\n💰 Test 2: Facture brouillon sans numéro manuel');
    const invoiceDraft1 = await generateInvoiceNumber('F', {
      ...testOptions,
      isDraft: true
    });
    console.log(`   Résultat: ${invoiceDraft1}`);
    console.log(`   ✅ Format attendu: DRAFT-000001 | Obtenu: ${invoiceDraft1.startsWith('DRAFT-') && /DRAFT-\d{6}/.test(invoiceDraft1) ? '✅' : '❌'}`);

    // Test 3: Avoir brouillon sans numéro manuel
    console.log('\n🧾 Test 3: Avoir brouillon sans numéro manuel');
    const creditNoteDraft1 = await generateCreditNoteNumber('A', {
      ...testOptions,
      isDraft: true
    });
    console.log(`   Résultat: ${creditNoteDraft1}`);
    console.log(`   ✅ Format attendu: DRAFT-000001 | Obtenu: ${creditNoteDraft1.startsWith('DRAFT-') && /DRAFT-\d{6}/.test(creditNoteDraft1) ? '✅' : '❌'}`);

    // Test 4: Devis brouillon avec numéro manuel
    console.log('\n📝 Test 4: Devis brouillon avec numéro manuel');
    const quoteDraft2 = await generateQuoteNumber('D', {
      ...testOptions,
      isDraft: true,
      manualNumber: '000005'
    });
    console.log(`   Résultat: ${quoteDraft2}`);
    console.log(`   ✅ Format attendu: DRAFT-000005 | Obtenu: ${quoteDraft2 === 'DRAFT-000005' ? '✅' : '❌'}`);

    // Test 5: Vérifier que les anciens formats ne sont plus générés
    console.log('\n🔍 Test 5: Vérification absence anciens formats');
    const formats = [quoteDraft1, invoiceDraft1, creditNoteDraft1];
    const hasOldFormat = formats.some(format => 
      format.includes(Date.now().toString(36).toUpperCase().slice(-5)) ||
      /DRAFT-[A-Z0-9]{8,}/.test(format)
    );
    console.log(`   ✅ Aucun ancien format détecté: ${!hasOldFormat ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error.message);
    console.error(error.stack);
  }
}

async function main() {
  console.log('🚀 Démarrage des tests de numérotation des brouillons');
  
  await connectDB();
  await testDraftNumbering();
  
  console.log('\n✅ Tests terminés');
  await mongoose.disconnect();
  process.exit(0);
}

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Erreur non gérée:', reason);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n⏹️  Arrêt du script...');
  await mongoose.disconnect();
  process.exit(0);
});

main().catch(console.error);
