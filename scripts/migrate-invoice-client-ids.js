/**
 * Script de migration pour ajouter l'ID du client original aux factures existantes
 * 
 * Ce script recherche les factures sans client.id et essaie de trouver le client
 * correspondant dans la collection Client par email.
 * 
 * Usage: 
 *   node scripts/migrate-invoice-client-ids.js          # Mode dry-run (par défaut)
 *   node scripts/migrate-invoice-client-ids.js --execute  # Exécuter la migration
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Mode dry-run par défaut (sécurité pour la production)
const DRY_RUN = !process.argv.includes('--execute');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';

// Schéma simplifié pour la migration
const invoiceSchema = new mongoose.Schema({}, { strict: false });
const clientSchema = new mongoose.Schema({}, { strict: false });

const Invoice = mongoose.model('Invoice', invoiceSchema);
const Client = mongoose.model('Client', clientSchema);

async function migrateInvoiceClientIds() {
  try {
    console.log('🔄 Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');
    
    if (DRY_RUN) {
      console.log('\n⚠️  MODE DRY-RUN: Aucune modification ne sera effectuée');
      console.log('   Pour exécuter la migration, ajoutez --execute\n');
    }

    // Trouver toutes les factures sans client.id
    const invoicesWithoutClientId = await Invoice.find({
      'client.id': { $exists: false }
    }).lean();

    console.log(`📊 ${invoicesWithoutClientId.length} facture(s) sans client.id trouvée(s)`);

    if (invoicesWithoutClientId.length === 0) {
      console.log('✅ Aucune migration nécessaire');
      return;
    }

    let updated = 0;
    let notFound = 0;
    let errors = 0;

    for (const invoice of invoicesWithoutClientId) {
      try {
        const clientEmail = invoice.client?.email?.toLowerCase();
        const workspaceId = invoice.workspaceId;

        if (!clientEmail) {
          console.log(`⚠️ Facture ${invoice.number}: pas d'email client`);
          notFound++;
          continue;
        }

        // Chercher le client par email et workspaceId
        const client = await Client.findOne({
          email: clientEmail,
          workspaceId: workspaceId
        }).lean();

        if (client) {
          if (DRY_RUN) {
            console.log(`🔍 Facture ${invoice.number}: client.id serait = ${client._id}`);
          } else {
            // Mettre à jour la facture avec l'ID du client
            await Invoice.updateOne(
              { _id: invoice._id },
              { $set: { 'client.id': client._id.toString() } }
            );
            console.log(`✅ Facture ${invoice.number}: client.id = ${client._id}`);
          }
          updated++;
        } else {
          console.log(`⚠️ Facture ${invoice.number}: client non trouvé (${clientEmail})`);
          notFound++;
        }
      } catch (err) {
        console.error(`❌ Erreur pour la facture ${invoice.number}:`, err.message);
        errors++;
      }
    }

    console.log('\n📊 Résumé de la migration:');
    console.log(`   ✅ Mises à jour: ${updated}`);
    console.log(`   ⚠️ Clients non trouvés: ${notFound}`);
    console.log(`   ❌ Erreurs: ${errors}`);

  } catch (error) {
    console.error('❌ Erreur de migration:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Déconnecté de MongoDB');
  }
}

// Exécuter la migration
migrateInvoiceClientIds();
