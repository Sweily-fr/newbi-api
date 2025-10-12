#!/usr/bin/env node

/**
 * Script pour identifier et corriger les numéros de factures en doublon
 * qui causent l'erreur E11000 duplicate key error
 */

import mongoose from 'mongoose';
import Invoice from '../src/models/Invoice.js';

// Configuration MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://newbiAdmin:newbiPassword2024@localhost:27017/newbi?authSource=admin';

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connexion MongoDB réussie');
  } catch (error) {
    console.error('❌ Erreur de connexion MongoDB:', error);
    process.exit(1);
  }
}

async function findDuplicateInvoices() {
  console.log('\n🔍 Recherche des factures avec numéros en doublon...');
  
  // Agrégation pour trouver les doublons par workspaceId, number et année
  const duplicates = await Invoice.aggregate([
    {
      $addFields: {
        issueYear: { $year: '$issueDate' }
      }
    },
    {
      $group: {
        _id: {
          workspaceId: '$workspaceId',
          number: '$number',
          issueYear: '$issueYear'
        },
        count: { $sum: 1 },
        invoices: { $push: { id: '$_id', status: '$status', createdAt: '$createdAt', number: '$number' } }
      }
    },
    {
      $match: {
        count: { $gt: 1 }
      }
    }
  ]);
  
  return duplicates;
}

async function fixDuplicateInvoices(dryRun = true) {
  console.log(`\n🔧 ${dryRun ? 'SIMULATION' : 'CORRECTION'} des doublons...`);
  
  const duplicates = await findDuplicateInvoices();
  
  if (duplicates.length === 0) {
    console.log('✅ Aucun doublon trouvé!');
    return;
  }
  
  console.log(`📋 ${duplicates.length} groupe(s) de doublons trouvé(s):`);
  
  for (const duplicate of duplicates) {
    const { workspaceId, number, issueYear } = duplicate._id;
    const invoices = duplicate.invoices;
    
    console.log(`\n📄 Doublon détecté:`);
    console.log(`   WorkspaceId: ${workspaceId}`);
    console.log(`   Numéro: ${number}`);
    console.log(`   Année: ${issueYear}`);
    console.log(`   Nombre de factures: ${invoices.length}`);
    
    // Trier par date de création (garder la plus ancienne)
    invoices.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    console.log(`   📋 Factures concernées:`);
    invoices.forEach((invoice, index) => {
      console.log(`     ${index + 1}. ID: ${invoice.id} | Status: ${invoice.status} | Créée: ${new Date(invoice.createdAt).toLocaleString()}`);
    });
    
    // Garder la première (plus ancienne), renommer les autres
    const [keepInvoice, ...duplicateInvoices] = invoices;
    
    console.log(`   ✅ Garder: ${keepInvoice.id} (plus ancienne)`);
    
    for (let i = 0; i < duplicateInvoices.length; i++) {
      const duplicateInvoice = duplicateInvoices[i];
      const timestamp = Date.now().toString().slice(-6);
      const newNumber = `${number}-${timestamp}-${i + 1}`;
      
      console.log(`   🔄 Renommer: ${duplicateInvoice.id} → ${newNumber}`);
      
      if (!dryRun) {
        try {
          await Invoice.findByIdAndUpdate(duplicateInvoice.id, {
            number: newNumber
          });
          console.log(`     ✅ Renommé avec succès`);
        } catch (error) {
          console.log(`     ❌ Erreur lors du renommage: ${error.message}`);
        }
      }
    }
  }
  
  if (dryRun) {
    console.log('\n⚠️  SIMULATION TERMINÉE - Aucune modification appliquée');
    console.log('💡 Exécutez avec --fix pour appliquer les corrections');
  } else {
    console.log('\n✅ CORRECTIONS APPLIQUÉES');
  }
}

async function validateUniqueConstraint() {
  console.log('\n🔍 Validation de la contrainte d\'unicité...');
  
  try {
    // Tenter de créer l'index unique pour vérifier s'il y a encore des conflits
    await Invoice.collection.createIndex(
      { number: 1, workspaceId: 1, issueYear: 1 },
      { 
        unique: true, 
        name: 'number_workspaceId_year_unique_test',
        background: true 
      }
    );
    
    console.log('✅ Contrainte d\'unicité respectée - aucun conflit détecté');
    
    // Supprimer l'index de test
    await Invoice.collection.dropIndex('number_workspaceId_year_unique_test');
    
  } catch (error) {
    if (error.code === 11000) {
      console.log('❌ Contrainte d\'unicité violée - des doublons existent encore');
      console.log('🔍 Détails de l\'erreur:', error.message);
      return false;
    } else {
      console.log('⚠️  Erreur lors de la validation:', error.message);
      return false;
    }
  }
  
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--fix');
  
  console.log('🔧 Correction des numéros de factures en doublon');
  console.log('=' .repeat(50));
  
  if (dryRun) {
    console.log('🔍 MODE SIMULATION - Aucune modification ne sera appliquée');
  } else {
    console.log('⚠️  MODE CORRECTION - Les modifications seront appliquées');
  }
  
  await connectDB();
  
  try {
    // Étape 1: Identifier les doublons
    const duplicates = await findDuplicateInvoices();
    
    if (duplicates.length === 0) {
      console.log('\n🎉 Aucun doublon trouvé!');
      
      // Valider la contrainte d'unicité
      const isValid = await validateUniqueConstraint();
      if (isValid) {
        console.log('✅ La base de données est prête pour la contrainte d\'unicité');
      }
    } else {
      console.log(`\n⚠️  ${duplicates.length} groupe(s) de doublons détecté(s)`);
      
      // Étape 2: Corriger les doublons
      await fixDuplicateInvoices(dryRun);
      
      if (!dryRun) {
        // Étape 3: Valider après correction
        console.log('\n🔍 Validation post-correction...');
        const isValid = await validateUniqueConstraint();
        if (isValid) {
          console.log('🎉 Tous les doublons ont été corrigés avec succès!');
        } else {
          console.log('❌ Des doublons persistent - une intervention manuelle peut être nécessaire');
        }
      }
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
