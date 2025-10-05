#!/usr/bin/env node

/**
 * Script de finalisation de la migration du système de cache
 * Migre automatiquement les derniers fichiers utilisant l'ancien contexte
 */

const fs = require('fs');
const path = require('path');

// Configuration
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NEWBI_V2_PATH = path.join(PROJECT_ROOT, 'NewbiV2');

// Fichiers à migrer automatiquement
const FILES_TO_MIGRATE = [
  'src/components/nav-documents.jsx',
  'src/components/nav-main.jsx', 
  'src/components/nav-secondary.jsx',
  'src/components/team-switcher.jsx',
  'src/components/pro-route-guard.jsx',
  'src/hooks/useStripeInvoices.js',
  'app/dashboard/account/page.jsx',
  'app/dashboard/collaborateurs/page.jsx',
  'app/dashboard/outils/page.jsx',
  'app/dashboard/subscribe/page.jsx'
];

// Fichiers à traiter manuellement (plus complexes)
const MANUAL_FILES = [
  'app/layout.jsx', // Root layout - nécessite attention particulière
  'app/dashboard/settings/components/BillingSection.jsx',
  'src/components/settings/facturation-section.jsx',
  'src/components/settings/preferences-section.jsx',
  'src/components/settings/subscription-section.jsx',
  'src/components/settings/user-info-section.jsx'
];

// Fonction pour migrer un fichier
function migrateFile(filePath) {
  try {
    const fullPath = path.join(NEWBI_V2_PATH, filePath);
    
    if (!fs.existsSync(fullPath)) {
      console.log(`⚠️  Fichier introuvable: ${filePath}`);
      return false;
    }
    
    let content = fs.readFileSync(fullPath, 'utf8');
    const originalContent = content;
    
    // Pattern principal : remplacer l'import useSubscription
    content = content.replace(
      /import\s*{\s*([^}]*,\s*)?useSubscription(\s*,\s*[^}]*)?\s*}\s*from\s*["']@\/src\/contexts\/subscription-context["'];?/g,
      (match, before, after) => {
        const otherImports = (before || '') + (after || '');
        if (otherImports.trim().replace(/,/g, '').trim()) {
          return `import { useSubscription } from "@/src/contexts/dashboard-layout-context";\nimport {${otherImports}} from "@/src/contexts/subscription-context";`;
        }
        return 'import { useSubscription } from "@/src/contexts/dashboard-layout-context";';
      }
    );
    
    // Pattern pour import simple de useSubscription
    content = content.replace(
      /import\s*{\s*useSubscription\s*}\s*from\s*["']@\/src\/contexts\/subscription-context["'];?/g,
      'import { useSubscription } from "@/src/contexts/dashboard-layout-context";'
    );
    
    // Sauvegarder si des changements ont été faits
    if (content !== originalContent) {
      fs.writeFileSync(fullPath, content, 'utf8');
      console.log(`✅ Migré: ${filePath}`);
      return true;
    } else {
      console.log(`ℹ️  Aucun changement nécessaire: ${filePath}`);
      return false;
    }
    
  } catch (error) {
    console.error(`❌ Erreur migration ${filePath}:`, error.message);
    return false;
  }
}

// Fonction pour créer un fichier de compatibilité temporaire
function createCompatibilityFile() {
  const compatibilityContent = `/**
 * Fichier de compatibilité temporaire pour l'ancien SubscriptionProvider
 * À supprimer une fois tous les composants migrés
 */

"use client";

import React from "react";
import { DashboardLayoutProvider } from "@/src/contexts/dashboard-layout-context";

/**
 * @deprecated Utiliser DashboardLayoutProvider à la place
 */
export function SubscriptionProvider({ children }) {
  console.warn('⚠️  SubscriptionProvider est déprécié. Utilisez DashboardLayoutProvider.');
  return <DashboardLayoutProvider>{children}</DashboardLayoutProvider>;
}

// Re-export pour compatibilité
export { useSubscription, useOnboarding } from "@/src/contexts/dashboard-layout-context";
`;

  const compatibilityPath = path.join(NEWBI_V2_PATH, 'src/contexts/subscription-context-compat.jsx');
  fs.writeFileSync(compatibilityPath, compatibilityContent, 'utf8');
  console.log('📄 Fichier de compatibilité créé: subscription-context-compat.jsx');
}

// Fonction principale
function main() {
  console.log('🔧 Finalisation de la migration du système de cache\n');
  
  if (!fs.existsSync(NEWBI_V2_PATH)) {
    console.error('❌ Dossier NewbiV2 introuvable:', NEWBI_V2_PATH);
    process.exit(1);
  }
  
  let migratedCount = 0;
  let errorCount = 0;
  
  // Migrer les fichiers automatiquement
  console.log('🚀 Migration automatique des fichiers...\n');
  
  for (const file of FILES_TO_MIGRATE) {
    try {
      if (migrateFile(file)) {
        migratedCount++;
      }
    } catch (error) {
      console.error(`❌ Erreur: ${file}`, error.message);
      errorCount++;
    }
  }
  
  // Créer le fichier de compatibilité
  console.log('\n📄 Création du fichier de compatibilité...');
  createCompatibilityFile();
  
  // Afficher les fichiers à traiter manuellement
  console.log('\n⚠️  Fichiers nécessitant une migration manuelle:');
  for (const file of MANUAL_FILES) {
    console.log(`   📝 ${file}`);
  }
  
  // Instructions pour les fichiers manuels
  console.log('\n📋 Instructions pour la migration manuelle:');
  console.log('1. Pour app/layout.jsx:');
  console.log('   - Vérifier si SubscriptionProvider est utilisé');
  console.log('   - Le remplacer par DashboardLayoutProvider si nécessaire');
  console.log('   - Attention: ce fichier affecte toute l\'application');
  
  console.log('\n2. Pour les composants de settings:');
  console.log('   - Remplacer les imports subscription-context');
  console.log('   - Tester les fonctionnalités d\'abonnement');
  console.log('   - Vérifier les modals et formulaires');
  
  // Résumé
  console.log('\n📊 Résumé de la finalisation:');
  console.log(`✅ Fichiers migrés automatiquement: ${migratedCount}`);
  console.log(`📝 Fichiers à migrer manuellement: ${MANUAL_FILES.length}`);
  console.log(`❌ Erreurs: ${errorCount}`);
  
  // Prochaines étapes
  console.log('\n🎯 Prochaines étapes:');
  console.log('1. Migrer manuellement les fichiers listés ci-dessus');
  console.log('2. Exécuter: node scripts/test-cache-system.js');
  console.log('3. Tester l\'application en mode développement');
  console.log('4. Vérifier le panel de debug en bas à droite');
  console.log('5. Valider l\'absence de flashs lors de la navigation');
  
  // Note sur la compatibilité
  console.log('\n💡 Note: Un fichier de compatibilité temporaire a été créé');
  console.log('   Il permet aux anciens imports de continuer à fonctionner');
  console.log('   À supprimer une fois la migration complète terminée');
  
  if (migratedCount > 0) {
    console.log('\n🎉 Migration automatique terminée avec succès !');
  }
}

// Exécuter le script
if (require.main === module) {
  main();
}

module.exports = { migrateFile, FILES_TO_MIGRATE, MANUAL_FILES };
