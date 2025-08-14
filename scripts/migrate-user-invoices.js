#!/usr/bin/env node

/**
 * Script de migration spécifique pour migrer les factures d'un utilisateur
 * vers le système workspace
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

// Import des modèles
import User from '../src/models/User.js';
import Invoice from '../src/models/Invoice.js';

async function migrateUserInvoices() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    // ID de l'utilisateur et du workspace
    const userId = '685ff0250e083b9a2987a0b9';
    const workspaceId = '68932751626f06764f62ca2e';

    console.log(`🔍 Migration des factures pour:`);
    console.log(`   - User ID: ${userId}`);
    console.log(`   - Workspace ID: ${workspaceId}`);

    // Vérifier que l'utilisateur existe
    const user = await User.findById(userId);
    if (!user) {
      throw new Error(`Utilisateur ${userId} non trouvé`);
    }
    console.log(`👤 Utilisateur trouvé: ${user.email}`);

    // Trouver les factures sans workspaceId
    const invoicesWithoutWorkspace = await Invoice.find({
      createdBy: userId,
      workspaceId: { $exists: false }
    });

    console.log(`📄 Factures à migrer: ${invoicesWithoutWorkspace.length}`);

    if (invoicesWithoutWorkspace.length === 0) {
      console.log('✅ Aucune facture à migrer');
      return;
    }

    // Migrer les factures
    let migratedCount = 0;
    for (const invoice of invoicesWithoutWorkspace) {
      try {
        await Invoice.updateOne(
          { _id: invoice._id },
          { $set: { workspaceId: workspaceId } }
        );
        migratedCount++;
        console.log(`✅ Facture ${invoice.number} migrée`);
      } catch (error) {
        console.error(`❌ Erreur migration facture ${invoice.number}:`, error.message);
      }
    }

    console.log(`\n🎉 Migration terminée:`);
    console.log(`   - Factures migrées: ${migratedCount}/${invoicesWithoutWorkspace.length}`);

    // Vérification
    const invoicesWithWorkspace = await Invoice.countDocuments({
      createdBy: userId,
      workspaceId: workspaceId
    });

    console.log(`✅ Vérification: ${invoicesWithWorkspace} factures ont maintenant le workspaceId`);

  } catch (error) {
    console.error('❌ Erreur de migration:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécuter la migration
migrateUserInvoices();
