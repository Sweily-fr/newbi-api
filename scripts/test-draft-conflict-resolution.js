#!/usr/bin/env node

/**
 * Script de test pour vérifier que la résolution des conflits de brouillons
 * ne génère plus de double préfixe DRAFT-DRAFT-
 */

import mongoose from 'mongoose';
import Quote from '../src/models/Quote.js';
import Invoice from '../src/models/Invoice.js';
import { generateQuoteNumber, generateInvoiceNumber } from '../src/utils/documentNumbers.js';

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

async function testDraftConflictResolution() {
  console.log('\n🧪 Test de résolution des conflits de brouillons\n');

  const testOptions = {
    workspaceId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    year: 2024
  };

  try {
    // Test 1: Créer un devis brouillon avec numéro manuel
    console.log('📝 Test 1: Création devis brouillon avec numéro manuel');
    
    const quoteDraft1 = await generateQuoteNumber('D', {
      ...testOptions,
      isDraft: true,
      manualNumber: '000002'
    });
    
    console.log(`   Premier brouillon: ${quoteDraft1}`);
    
    // Simuler la création du devis en base
    const testQuote = new Quote({
      number: quoteDraft1,
      status: 'DRAFT',
      workspaceId: testOptions.workspaceId,
      createdBy: testOptions.userId,
      prefix: 'D',
      issueDate: new Date(),
      validUntil: new Date(),
      client: { name: 'Test Client', email: 'test@test.com' },
      companyInfo: { name: 'Test Company', email: 'company@test.com' },
      items: [],
      totalHT: 0,
      totalTTC: 0,
      totalVAT: 0,
      finalTotalHT: 0,
      finalTotalTTC: 0
    });
    
    await testQuote.save();
    console.log(`   ✅ Devis sauvé en base avec numéro: ${testQuote.number}`);

    // Test 2: Créer un second devis brouillon avec le même numéro (conflit)
    console.log('\n📝 Test 2: Création second devis avec même numéro (conflit)');
    
    const quoteDraft2 = await generateQuoteNumber('D', {
      ...testOptions,
      isDraft: true,
      manualNumber: '000002'
    });
    
    console.log(`   Second brouillon: ${quoteDraft2}`);
    
    // Vérifier que l'ancien brouillon a été renommé
    const updatedQuote = await Quote.findById(testQuote._id);
    console.log(`   Ancien brouillon renommé: ${updatedQuote.number}`);
    
    // Vérifications
    const hasDoublePrefix = updatedQuote.number.includes('DRAFT-DRAFT-');
    console.log(`   ❌ Double préfixe DRAFT-DRAFT-: ${hasDoublePrefix ? 'DÉTECTÉ' : 'ABSENT'}`);
    console.log(`   ✅ Format correct: ${!hasDoublePrefix ? '✅' : '❌'}`);
    
    // Test 3: Même test pour les factures
    console.log('\n💰 Test 3: Test identique pour les factures');
    
    const invoiceDraft1 = await generateInvoiceNumber('F', {
      ...testOptions,
      isDraft: true,
      manualNumber: '000003'
    });
    
    console.log(`   Premier brouillon facture: ${invoiceDraft1}`);
    
    // Simuler la création de la facture en base
    const testInvoice = new Invoice({
      number: invoiceDraft1,
      status: 'DRAFT',
      workspaceId: testOptions.workspaceId,
      createdBy: testOptions.userId,
      prefix: 'F',
      issueDate: new Date(),
      executionDate: new Date(),
      client: { name: 'Test Client', email: 'test@test.com' },
      companyInfo: { name: 'Test Company', email: 'company@test.com' },
      items: [],
      totalHT: 0,
      totalTTC: 0,
      totalVAT: 0,
      finalTotalHT: 0,
      finalTotalTTC: 0
    });
    
    await testInvoice.save();
    console.log(`   ✅ Facture sauvée en base avec numéro: ${testInvoice.number}`);

    // Créer un conflit
    const invoiceDraft2 = await generateInvoiceNumber('F', {
      ...testOptions,
      isDraft: true,
      manualNumber: '000003'
    });
    
    console.log(`   Second brouillon facture: ${invoiceDraft2}`);
    
    // Vérifier que l'ancienne facture a été renommée
    const updatedInvoice = await Invoice.findById(testInvoice._id);
    console.log(`   Ancienne facture renommée: ${updatedInvoice.number}`);
    
    // Vérifications
    const invoiceHasDoublePrefix = updatedInvoice.number.includes('DRAFT-DRAFT-');
    console.log(`   ❌ Double préfixe DRAFT-DRAFT-: ${invoiceHasDoublePrefix ? 'DÉTECTÉ' : 'ABSENT'}`);
    console.log(`   ✅ Format correct: ${!invoiceHasDoublePrefix ? '✅' : '❌'}`);

    // Test 4: Test avec un numéro qui commence déjà par DRAFT-
    console.log('\n🔍 Test 4: Test avec numéro commençant déjà par DRAFT-');
    
    const quoteDraft3 = await generateQuoteNumber('D', {
      ...testOptions,
      isDraft: true,
      manualNumber: 'DRAFT-000004'  // Numéro qui commence déjà par DRAFT-
    });
    
    console.log(`   Brouillon avec préfixe existant: ${quoteDraft3}`);
    
    // Créer le devis
    const testQuote2 = new Quote({
      number: quoteDraft3,
      status: 'DRAFT',
      workspaceId: testOptions.workspaceId,
      createdBy: testOptions.userId,
      prefix: 'D',
      issueDate: new Date(),
      validUntil: new Date(),
      client: { name: 'Test Client', email: 'test@test.com' },
      companyInfo: { name: 'Test Company', email: 'company@test.com' },
      items: [],
      totalHT: 0,
      totalTTC: 0,
      totalVAT: 0,
      finalTotalHT: 0,
      finalTotalTTC: 0
    });
    
    await testQuote2.save();
    
    // Créer un conflit avec le même numéro
    const quoteDraft4 = await generateQuoteNumber('D', {
      ...testOptions,
      isDraft: true,
      manualNumber: 'DRAFT-000004'  // Même numéro avec préfixe
    });
    
    console.log(`   Second brouillon avec préfixe: ${quoteDraft4}`);
    
    // Vérifier le renommage
    const updatedQuote2 = await Quote.findById(testQuote2._id);
    console.log(`   Ancien brouillon renommé: ${updatedQuote2.number}`);
    
    const hasTriplePrefix = updatedQuote2.number.includes('DRAFT-DRAFT-DRAFT-');
    const hasDoublePrefix2 = updatedQuote2.number.includes('DRAFT-DRAFT-') && !hasTriplePrefix;
    
    console.log(`   ❌ Triple préfixe DRAFT-DRAFT-DRAFT-: ${hasTriplePrefix ? 'DÉTECTÉ' : 'ABSENT'}`);
    console.log(`   ❌ Double préfixe DRAFT-DRAFT-: ${hasDoublePrefix2 ? 'DÉTECTÉ' : 'ABSENT'}`);
    console.log(`   ✅ Format correct: ${!hasTriplePrefix && !hasDoublePrefix2 ? '✅' : '❌'}`);

    // Nettoyage
    await Quote.deleteMany({ workspaceId: testOptions.workspaceId });
    await Invoice.deleteMany({ workspaceId: testOptions.workspaceId });
    console.log('\n🧹 Nettoyage des données de test terminé');

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error.message);
    console.error(error.stack);
  }
}

async function main() {
  console.log('🚀 Démarrage des tests de résolution des conflits de brouillons');
  
  await connectDB();
  await testDraftConflictResolution();
  
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
