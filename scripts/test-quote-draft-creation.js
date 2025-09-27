#!/usr/bin/env node

/**
 * Script de test pour vérifier la création de devis brouillons via l'API
 * et s'assurer qu'ils utilisent bien le format DRAFT-numéro
 */

import mongoose from 'mongoose';
import Quote from '../src/models/Quote.js';
import User from '../src/models/User.js';
import { generateQuoteNumber } from '../src/utils/documentNumbers.js';

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

async function findTestUser() {
  // Chercher un utilisateur existant pour les tests
  const user = await User.findOne().limit(1);
  if (!user) {
    console.error('❌ Aucun utilisateur trouvé pour les tests');
    process.exit(1);
  }
  console.log(`📋 Utilisateur de test: ${user.email} (${user._id})`);
  return user;
}

async function testQuoteDraftCreation() {
  console.log('\n🧪 Test de création de devis brouillons\n');

  const user = await findTestUser();
  const workspaceId = new mongoose.Types.ObjectId();

  try {
    // Test 1: Créer un devis brouillon sans numéro manuel
    console.log('📝 Test 1: Création devis brouillon sans numéro manuel');
    
    const draftNumber1 = await generateQuoteNumber('D', {
      isDraft: true,
      workspaceId: workspaceId,
      userId: user._id
    });
    
    console.log(`   Numéro généré: ${draftNumber1}`);
    
    // Vérifier le format
    const isValidFormat1 = /^DRAFT-\d{6}$/.test(draftNumber1);
    console.log(`   ✅ Format DRAFT-XXXXXX: ${isValidFormat1 ? '✅' : '❌'}`);

    // Test 2: Créer un deuxième devis brouillon
    console.log('\n📝 Test 2: Création deuxième devis brouillon');
    
    const draftNumber2 = await generateQuoteNumber('D', {
      isDraft: true,
      workspaceId: workspaceId,
      userId: user._id
    });
    
    console.log(`   Numéro généré: ${draftNumber2}`);
    
    // Vérifier le format
    const isValidFormat2 = /^DRAFT-\d{6}$/.test(draftNumber2);
    console.log(`   ✅ Format DRAFT-XXXXXX: ${isValidFormat2 ? '✅' : '❌'}`);

    // Vérifier que les numéros sont séquentiels
    if (isValidFormat1 && isValidFormat2) {
      const num1 = parseInt(draftNumber1.replace('DRAFT-', ''));
      const num2 = parseInt(draftNumber2.replace('DRAFT-', ''));
      const isSequential = num2 === num1 + 1;
      console.log(`   ✅ Numérotation séquentielle: ${isSequential ? '✅' : '❌'} (${num1} → ${num2})`);
    }

    // Test 3: Créer un devis brouillon avec numéro manuel
    console.log('\n📝 Test 3: Création devis brouillon avec numéro manuel');
    
    const draftNumber3 = await generateQuoteNumber('D', {
      isDraft: true,
      manualNumber: '000010',
      workspaceId: workspaceId,
      userId: user._id
    });
    
    console.log(`   Numéro généré: ${draftNumber3}`);
    console.log(`   ✅ Format attendu DRAFT-000010: ${draftNumber3 === 'DRAFT-000010' ? '✅' : '❌'}`);

    // Test 4: Vérifier qu'aucun ancien format n'est généré
    console.log('\n🔍 Test 4: Vérification absence anciens formats');
    const allNumbers = [draftNumber1, draftNumber2, draftNumber3];
    const hasOldFormat = allNumbers.some(num => 
      /DRAFT-[A-Z0-9]{8,}/.test(num) && !/DRAFT-\d{6}(-\d+)?$/.test(num)
    );
    console.log(`   ✅ Aucun ancien format détecté: ${!hasOldFormat ? '✅' : '❌'}`);

    // Afficher un résumé
    console.log('\n📊 Résumé des numéros générés:');
    allNumbers.forEach((num, index) => {
      console.log(`   ${index + 1}. ${num}`);
    });

  } catch (error) {
    console.error('❌ Erreur lors des tests:', error.message);
    console.error(error.stack);
  }
}

async function main() {
  console.log('🚀 Démarrage des tests de création de devis brouillons');
  
  await connectDB();
  await testQuoteDraftCreation();
  
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
