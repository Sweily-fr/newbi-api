#!/usr/bin/env node

/**
 * Script de test pour vérifier la conversion de devis en facture
 * et la résolution des conflits de numérotation
 */

import mongoose from 'mongoose';
import Quote from '../src/models/Quote.js';
import Invoice from '../src/models/Invoice.js';
import { generateInvoiceNumber } from '../src/utils/documentNumbers.js';

// Configuration MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:newbiPassword2024@localhost:27017/newbi?authSource=admin';

const testOptions = {
  workspaceId: new mongoose.Types.ObjectId('68cda7822596343b3c6ea330'),
  userId: new mongoose.Types.ObjectId('68cce0e34badcc0b4fcdf6e8'),
  year: 2025
};

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connexion MongoDB réussie');
  } catch (error) {
    console.error('❌ Erreur de connexion MongoDB:', error);
    process.exit(1);
  }
}

async function cleanupTestData() {
  console.log('\n🧹 Nettoyage des données de test...');
  
  // Supprimer les factures de test
  await Invoice.deleteMany({
    workspaceId: testOptions.workspaceId,
    number: { $regex: /^(DRAFT-000003|000003)/ }
  });
  
  console.log('✅ Données de test nettoyées');
}

async function testConversionConflict() {
  console.log('\n🧪 Test de conversion devis → facture avec conflit de numérotation');
  
  try {
    // Étape 1: Créer une facture existante avec le numéro "DRAFT-000003"
    console.log('\n📝 Étape 1: Créer une facture existante avec numéro DRAFT-000003');
    const existingInvoice = new Invoice({
      number: 'DRAFT-000003',
      prefix: 'F-202510',
      status: 'DRAFT',
      issueDate: new Date(),
      workspaceId: testOptions.workspaceId,
      createdBy: testOptions.userId,
      client: new mongoose.Types.ObjectId(),
      items: [{
        description: 'Test item',
        quantity: 1,
        unitPrice: 100,
        vatRate: 20
      }],
      totalHT: 100,
      totalTTC: 120,
      finalTotalHT: 100,
      finalTotalTTC: 120
    });
    
    await existingInvoice.save();
    console.log(`   ✅ Facture existante créée: ${existingInvoice.number}`);
    
    // Étape 2: Tenter de générer un nouveau numéro de facture (simulation de conversion)
    console.log('\n🔄 Étape 2: Générer un nouveau numéro de facture (simulation conversion devis)');
    const newInvoiceNumber = await generateInvoiceNumber('F-202510', {
      isDraft: true,
      workspaceId: testOptions.workspaceId,
      userId: testOptions.userId,
      year: 2025
    });
    
    console.log(`   ✅ Nouveau numéro généré: ${newInvoiceNumber}`);
    
    // Étape 3: Vérifier que le nouveau numéro est différent et unique
    if (newInvoiceNumber === 'DRAFT-000003') {
      console.log('   ❌ ERREUR: Le nouveau numéro est identique à l\'existant!');
      return false;
    } else if (newInvoiceNumber.startsWith('DRAFT-000003-')) {
      console.log('   ✅ SUCCESS: Conflit résolu avec suffixe unique');
    } else {
      console.log(`   ✅ SUCCESS: Nouveau numéro séquentiel généré: ${newInvoiceNumber}`);
    }
    
    // Étape 4: Créer la nouvelle facture pour vérifier qu'il n'y a pas d'erreur MongoDB
    console.log('\n💾 Étape 3: Créer la nouvelle facture en base');
    const newInvoice = new Invoice({
      number: newInvoiceNumber,
      prefix: 'F-202510',
      status: 'DRAFT',
      issueDate: new Date(),
      workspaceId: testOptions.workspaceId,
      createdBy: testOptions.userId,
      client: new mongoose.Types.ObjectId(),
      items: [{
        description: 'Test item from quote conversion',
        quantity: 1,
        unitPrice: 200,
        vatRate: 20
      }],
      totalHT: 200,
      totalTTC: 240,
      finalTotalHT: 200,
      finalTotalTTC: 240
    });
    
    await newInvoice.save();
    console.log(`   ✅ Nouvelle facture créée avec succès: ${newInvoice.number}`);
    
    // Étape 5: Vérifier l'unicité des numéros
    console.log('\n🔍 Étape 4: Vérifier l\'unicité des numéros');
    const allInvoices = await Invoice.find({
      workspaceId: testOptions.workspaceId,
      number: { $regex: /^DRAFT-000003/ }
    }).select('number');
    
    console.log('   📋 Factures trouvées:');
    allInvoices.forEach(invoice => {
      console.log(`     - ${invoice.number}`);
    });
    
    // Vérifier qu'il n'y a pas de doublons
    const numbers = allInvoices.map(inv => inv.number);
    const uniqueNumbers = [...new Set(numbers)];
    
    if (numbers.length === uniqueNumbers.length) {
      console.log('   ✅ SUCCESS: Tous les numéros sont uniques');
      return true;
    } else {
      console.log('   ❌ ERREUR: Des doublons détectés!');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du test:', error);
    return false;
  }
}

async function main() {
  console.log('🧪 Test de conversion devis → facture avec gestion des conflits');
  console.log('=' .repeat(60));
  
  await connectDB();
  
  try {
    // Nettoyer les données de test précédentes
    await cleanupTestData();
    
    // Exécuter le test principal
    const success = await testConversionConflict();
    
    if (success) {
      console.log('\n🎉 TOUS LES TESTS RÉUSSIS!');
      console.log('✅ La conversion devis → facture gère correctement les conflits de numérotation');
    } else {
      console.log('\n❌ ÉCHEC DES TESTS');
      console.log('❌ Des problèmes ont été détectés dans la gestion des conflits');
    }
    
  } catch (error) {
    console.error('❌ Erreur générale:', error);
  } finally {
    // Nettoyer les données de test
    await cleanupTestData();
    await mongoose.disconnect();
    console.log('\n👋 Déconnexion MongoDB');
  }
}

// Exécuter le script
main().catch(console.error);
