#!/usr/bin/env node

/**
 * Script pour diagnostiquer le conflit spécifique avec DRAFT-000003
 * et tester la résolution
 */

import mongoose from 'mongoose';
import Invoice from '../src/models/Invoice.js';
import { generateInvoiceNumber } from '../src/utils/documentNumbers.js';

// Configuration MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:newbiPassword2024@localhost:27017/newbi?authSource=admin';

// WorkspaceId de production mentionné dans l'erreur
const WORKSPACE_ID = '68cda7822596343b3c6ea330';

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connexion MongoDB réussie');
  } catch (error) {
    console.error('❌ Erreur de connexion MongoDB:', error);
    process.exit(1);
  }
}

async function analyzeExistingInvoices() {
  console.log('\n🔍 Analyse des factures existantes...');
  
  // Rechercher toutes les factures avec des numéros similaires à 000003
  const invoices = await Invoice.find({
    workspaceId: WORKSPACE_ID,
    $or: [
      { number: '000003' },
      { number: 'DRAFT-000003' },
      { number: { $regex: /^000003/ } },
      { number: { $regex: /^DRAFT-000003/ } }
    ],
    $expr: { $eq: [{ $year: '$issueDate' }, 2025] }
  }).select('number status issueDate createdAt').sort({ createdAt: 1 });
  
  console.log(`📋 ${invoices.length} facture(s) trouvée(s) avec numéro similaire à 000003:`);
  
  invoices.forEach((invoice, index) => {
    console.log(`   ${index + 1}. ${invoice.number} | ${invoice.status} | ${new Date(invoice.issueDate).toLocaleDateString()} | Créée: ${new Date(invoice.createdAt).toLocaleString()}`);
  });
  
  return invoices;
}

async function testNumberGeneration() {
  console.log('\n🧪 Test de génération de numéro...');
  
  const testOptions = {
    workspaceId: WORKSPACE_ID,
    userId: new mongoose.Types.ObjectId('68cce0e34badcc0b4fcdf6e8'), // ID utilisateur de l'erreur
    isDraft: true,
    year: 2025
  };
  
  try {
    console.log('🔄 Génération d\'un nouveau numéro de facture brouillon...');
    const newNumber = await generateInvoiceNumber('F-202510-', testOptions);
    console.log(`✅ Numéro généré: ${newNumber}`);
    
    // Vérifier si ce numéro existe déjà
    const existing = await Invoice.findOne({
      number: newNumber,
      workspaceId: WORKSPACE_ID,
      $expr: { $eq: [{ $year: '$issueDate' }, 2025] }
    });
    
    if (existing) {
      console.log(`❌ CONFLIT: Le numéro ${newNumber} existe déjà!`);
      console.log(`   Facture existante: ID ${existing._id}, Status: ${existing.status}`);
      return false;
    } else {
      console.log(`✅ Le numéro ${newNumber} est unique`);
      return true;
    }
    
  } catch (error) {
    console.error('❌ Erreur lors de la génération:', error.message);
    return false;
  }
}

async function simulateQuoteConversion() {
  console.log('\n🔄 Simulation de conversion devis → facture...');
  
  try {
    // Simuler exactement ce qui se passe dans le resolver de conversion
    const prefix = 'F-202510-';
    const options = {
      isDraft: true,
      workspaceId: WORKSPACE_ID,
      userId: new mongoose.Types.ObjectId('68cce0e34badcc0b4fcdf6e8')
    };
    
    console.log('📝 Génération du numéro de facture pour conversion...');
    const invoiceNumber = await generateInvoiceNumber(prefix, options);
    console.log(`✅ Numéro généré: ${invoiceNumber}`);
    
    // Tenter de créer une facture avec ce numéro (simulation)
    console.log('💾 Test de création de facture...');
    
    const testInvoice = new Invoice({
      number: invoiceNumber,
      prefix: prefix,
      status: 'DRAFT',
      issueDate: new Date(),
      workspaceId: WORKSPACE_ID,
      createdBy: new mongoose.Types.ObjectId('68cce0e34badcc0b4fcdf6e8'),
      client: new mongoose.Types.ObjectId(),
      items: [{
        description: 'Test conversion devis',
        quantity: 1,
        unitPrice: 100,
        vatRate: 20
      }],
      totalHT: 100,
      totalTTC: 120,
      finalTotalHT: 100,
      finalTotalTTC: 120
    });
    
    await testInvoice.save();
    console.log(`✅ Facture de test créée avec succès: ${testInvoice._id}`);
    
    // Nettoyer la facture de test
    await Invoice.findByIdAndDelete(testInvoice._id);
    console.log('🧹 Facture de test supprimée');
    
    return true;
    
  } catch (error) {
    if (error.code === 11000) {
      console.log('❌ ERREUR E11000 - Conflit de numéro détecté!');
      console.log('🔍 Détails:', error.message);
      
      // Extraire les détails du conflit
      const match = error.message.match(/dup key: \{ number: "([^"]+)", workspaceId: ObjectId\('([^']+)'\), issueYear: (\d+) \}/);
      if (match) {
        const [, conflictNumber, conflictWorkspace, conflictYear] = match;
        console.log(`   Numéro en conflit: ${conflictNumber}`);
        console.log(`   WorkspaceId: ${conflictWorkspace}`);
        console.log(`   Année: ${conflictYear}`);
      }
      
      return false;
    } else {
      console.error('❌ Autre erreur:', error.message);
      return false;
    }
  }
}

async function proposeFixStrategy() {
  console.log('\n💡 Stratégie de correction proposée:');
  
  // Analyser les factures existantes
  const existingInvoices = await analyzeExistingInvoices();
  
  if (existingInvoices.length === 0) {
    console.log('✅ Aucune facture conflictuelle trouvée');
    return;
  }
  
  console.log('\n🔧 Actions recommandées:');
  
  // Identifier les doublons exacts
  const duplicates = existingInvoices.filter(inv => inv.number === 'DRAFT-000003');
  
  if (duplicates.length > 1) {
    console.log(`1. 🔄 Renommer ${duplicates.length - 1} facture(s) en doublon:`);
    duplicates.slice(1).forEach((dup, index) => {
      const newName = `DRAFT-000003-${Date.now()}-${index + 1}`;
      console.log(`   - Facture ${dup._id}: ${dup.number} → ${newName}`);
    });
  }
  
  // Vérifier les numéros qui pourraient causer des conflits futurs
  const problematicNumbers = existingInvoices.filter(inv => 
    inv.number.includes('000003') && inv.number !== 'DRAFT-000003'
  );
  
  if (problematicNumbers.length > 0) {
    console.log(`2. ⚠️  Surveiller les numéros potentiellement problématiques:`);
    problematicNumbers.forEach(inv => {
      console.log(`   - ${inv.number} (${inv.status})`);
    });
  }
  
  console.log('\n3. ✅ Après correction, tester à nouveau la conversion devis → facture');
}

async function main() {
  console.log('🔍 Diagnostic du conflit DRAFT-000003');
  console.log('=' .repeat(40));
  
  await connectDB();
  
  try {
    // Étape 1: Analyser les factures existantes
    await analyzeExistingInvoices();
    
    // Étape 2: Tester la génération de numéro
    const generationOk = await testNumberGeneration();
    
    // Étape 3: Simuler la conversion devis → facture
    const conversionOk = await simulateQuoteConversion();
    
    // Étape 4: Proposer une stratégie de correction
    if (!generationOk || !conversionOk) {
      await proposeFixStrategy();
    } else {
      console.log('\n🎉 Aucun problème détecté - la conversion devrait fonctionner');
    }
    
  } catch (error) {
    console.error('❌ Erreur générale:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Déconnexion MongoDB');
  }
}

// Exécuter le script
main().catch(console.error);
