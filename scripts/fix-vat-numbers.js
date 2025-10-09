import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Invoice from '../src/models/Invoice.js';
import Quote from '../src/models/Quote.js';
import { VAT_FR_REGEX } from '../src/utils/validators.js';

dotenv.config();

/**
 * Script de migration pour corriger les numéros de TVA invalides
 * dans les factures et devis existants
 * 
 * Ce script :
 * 1. Trouve toutes les factures/devis avec des numéros de TVA invalides
 * 2. Vide le champ vatNumber s'il est invalide
 * 3. Log les modifications effectuées
 * 
 * Usage: node scripts/fix-vat-numbers.js
 */

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');
  } catch (error) {
    console.error('❌ Erreur de connexion à MongoDB:', error);
    process.exit(1);
  }
}

async function fixInvoiceVATNumbers() {
  console.log('\n📄 Traitement des factures...');
  
  try {
    // Trouver toutes les factures
    const invoices = await Invoice.find({});
    console.log(`   Trouvé ${invoices.length} factures`);
    
    let fixed = 0;
    let skipped = 0;
    const errors = [];
    
    for (const invoice of invoices) {
      const vatNumber = invoice.companyInfo?.vatNumber;
      
      // Si le numéro de TVA existe et est invalide
      if (vatNumber && !VAT_FR_REGEX.test(vatNumber)) {
        try {
          // Vider le champ vatNumber
          invoice.companyInfo.vatNumber = '';
          
          // Sauvegarder sans validation pour éviter d'autres erreurs
          await invoice.save({ validateBeforeSave: false });
          
          fixed++;
          console.log(`   ✓ Facture ${invoice.number || invoice._id}: TVA invalide "${vatNumber}" → vidé`);
        } catch (error) {
          errors.push({
            id: invoice._id,
            number: invoice.number,
            error: error.message
          });
          console.error(`   ✗ Erreur facture ${invoice.number || invoice._id}:`, error.message);
        }
      } else {
        skipped++;
      }
    }
    
    console.log(`\n   Résumé factures:`);
    console.log(`   - Corrigées: ${fixed}`);
    console.log(`   - Ignorées (OK): ${skipped}`);
    console.log(`   - Erreurs: ${errors.length}`);
    
    if (errors.length > 0) {
      console.log('\n   Erreurs détaillées:');
      errors.forEach(err => {
        console.log(`   - ${err.number || err.id}: ${err.error}`);
      });
    }
    
    return { fixed, skipped, errors };
  } catch (error) {
    console.error('❌ Erreur lors du traitement des factures:', error);
    throw error;
  }
}

async function fixQuoteVATNumbers() {
  console.log('\n📋 Traitement des devis...');
  
  try {
    // Trouver tous les devis
    const quotes = await Quote.find({});
    console.log(`   Trouvé ${quotes.length} devis`);
    
    let fixed = 0;
    let skipped = 0;
    const errors = [];
    
    for (const quote of quotes) {
      const vatNumber = quote.companyInfo?.vatNumber;
      
      // Si le numéro de TVA existe et est invalide
      if (vatNumber && !VAT_FR_REGEX.test(vatNumber)) {
        try {
          // Vider le champ vatNumber
          quote.companyInfo.vatNumber = '';
          
          // Sauvegarder sans validation pour éviter d'autres erreurs
          await quote.save({ validateBeforeSave: false });
          
          fixed++;
          console.log(`   ✓ Devis ${quote.number || quote._id}: TVA invalide "${vatNumber}" → vidé`);
        } catch (error) {
          errors.push({
            id: quote._id,
            number: quote.number,
            error: error.message
          });
          console.error(`   ✗ Erreur devis ${quote.number || quote._id}:`, error.message);
        }
      } else {
        skipped++;
      }
    }
    
    console.log(`\n   Résumé devis:`);
    console.log(`   - Corrigés: ${fixed}`);
    console.log(`   - Ignorés (OK): ${skipped}`);
    console.log(`   - Erreurs: ${errors.length}`);
    
    if (errors.length > 0) {
      console.log('\n   Erreurs détaillées:');
      errors.forEach(err => {
        console.log(`   - ${err.number || err.id}: ${err.error}`);
      });
    }
    
    return { fixed, skipped, errors };
  } catch (error) {
    console.error('❌ Erreur lors du traitement des devis:', error);
    throw error;
  }
}

async function main() {
  console.log('🔧 Script de correction des numéros de TVA');
  console.log('==========================================\n');
  
  try {
    await connectDB();
    
    const invoiceResults = await fixInvoiceVATNumbers();
    const quoteResults = await fixQuoteVATNumbers();
    
    console.log('\n==========================================');
    console.log('✅ Migration terminée avec succès!');
    console.log('\nRésumé global:');
    console.log(`- Factures corrigées: ${invoiceResults.fixed}`);
    console.log(`- Devis corrigés: ${quoteResults.fixed}`);
    console.log(`- Total corrigé: ${invoiceResults.fixed + quoteResults.fixed}`);
    console.log(`- Total erreurs: ${invoiceResults.errors.length + quoteResults.errors.length}`);
    
  } catch (error) {
    console.error('\n❌ Erreur lors de la migration:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Déconnexion de MongoDB');
  }
}

// Exécuter le script
main();
