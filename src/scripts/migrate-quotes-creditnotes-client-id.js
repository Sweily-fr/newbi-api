/**
 * Script de migration pour mettre à jour les IDs clients dans les devis et avoirs
 * 
 * Ce script recherche les devis et avoirs dont le client.id est null ou invalide,
 * puis tente de trouver le client correspondant dans la collection Client
 * en utilisant l'email ou le nom du client.
 * 
 * Usage: node src/scripts/migrate-quotes-creditnotes-client-id.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Quote from '../models/Quote.js';
import CreditNote from '../models/CreditNote.js';
import Client from '../models/Client.js';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');
  } catch (error) {
    console.error('❌ Erreur de connexion à MongoDB:', error);
    process.exit(1);
  }
}

async function findClientByEmailOrName(workspaceId, email, name) {
  // Chercher d'abord par email
  if (email) {
    const clientByEmail = await Client.findOne({ 
      workspaceId, 
      email: email.toLowerCase() 
    });
    if (clientByEmail) {
      return clientByEmail;
    }
  }
  
  // Sinon chercher par nom
  if (name) {
    const clientByName = await Client.findOne({ 
      workspaceId, 
      name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    });
    if (clientByName) {
      return clientByName;
    }
  }
  
  return null;
}

async function migrateQuotes() {
  console.log('\n📋 Migration des devis...');
  
  // Trouver tous les devis avec client.id null ou manquant
  const quotesWithoutClientId = await Quote.find({
    $or: [
      { 'client.id': null },
      { 'client.id': { $exists: false } },
      { 'client.id': '' }
    ]
  });
  
  console.log(`   Trouvé ${quotesWithoutClientId.length} devis sans client.id valide`);
  
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  
  for (const quote of quotesWithoutClientId) {
    try {
      const client = await findClientByEmailOrName(
        quote.workspaceId,
        quote.client?.email,
        quote.client?.name
      );
      
      if (client) {
        await Quote.updateOne(
          { _id: quote._id },
          { $set: { 'client.id': client._id.toString() } }
        );
        updated++;
        console.log(`   ✅ Devis ${quote.prefix}-${quote.number}: client.id mis à jour -> ${client._id}`);
      } else {
        notFound++;
        console.log(`   ⚠️ Devis ${quote.prefix}-${quote.number}: client non trouvé (email: ${quote.client?.email}, nom: ${quote.client?.name})`);
      }
    } catch (error) {
      errors++;
      console.error(`   ❌ Erreur pour le devis ${quote.prefix}-${quote.number}:`, error.message);
    }
  }
  
  console.log(`\n   Résumé devis:`);
  console.log(`   - Mis à jour: ${updated}`);
  console.log(`   - Non trouvés: ${notFound}`);
  console.log(`   - Erreurs: ${errors}`);
  
  return { updated, notFound, errors };
}

async function migrateCreditNotes() {
  console.log('\n📋 Migration des avoirs...');
  
  // Trouver tous les avoirs avec client.id null ou manquant
  const creditNotesWithoutClientId = await CreditNote.find({
    $or: [
      { 'client.id': null },
      { 'client.id': { $exists: false } },
      { 'client.id': '' }
    ]
  });
  
  console.log(`   Trouvé ${creditNotesWithoutClientId.length} avoirs sans client.id valide`);
  
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  
  for (const creditNote of creditNotesWithoutClientId) {
    try {
      const client = await findClientByEmailOrName(
        creditNote.workspaceId,
        creditNote.client?.email,
        creditNote.client?.name
      );
      
      if (client) {
        await CreditNote.updateOne(
          { _id: creditNote._id },
          { $set: { 'client.id': client._id.toString() } }
        );
        updated++;
        console.log(`   ✅ Avoir ${creditNote.prefix}-${creditNote.number}: client.id mis à jour -> ${client._id}`);
      } else {
        notFound++;
        console.log(`   ⚠️ Avoir ${creditNote.prefix}-${creditNote.number}: client non trouvé (email: ${creditNote.client?.email}, nom: ${creditNote.client?.name})`);
      }
    } catch (error) {
      errors++;
      console.error(`   ❌ Erreur pour l'avoir ${creditNote.prefix}-${creditNote.number}:`, error.message);
    }
  }
  
  console.log(`\n   Résumé avoirs:`);
  console.log(`   - Mis à jour: ${updated}`);
  console.log(`   - Non trouvés: ${notFound}`);
  console.log(`   - Erreurs: ${errors}`);
  
  return { updated, notFound, errors };
}

async function main() {
  console.log('🚀 Démarrage de la migration des IDs clients pour devis et avoirs\n');
  
  await connectDB();
  
  const quotesResult = await migrateQuotes();
  const creditNotesResult = await migrateCreditNotes();
  
  console.log('\n========================================');
  console.log('📊 RÉSUMÉ GLOBAL');
  console.log('========================================');
  console.log(`Devis: ${quotesResult.updated} mis à jour, ${quotesResult.notFound} non trouvés, ${quotesResult.errors} erreurs`);
  console.log(`Avoirs: ${creditNotesResult.updated} mis à jour, ${creditNotesResult.notFound} non trouvés, ${creditNotesResult.errors} erreurs`);
  console.log('========================================\n');
  
  await mongoose.disconnect();
  console.log('✅ Déconnecté de MongoDB');
  console.log('🎉 Migration terminée!');
}

main().catch(console.error);
