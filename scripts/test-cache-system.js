#!/usr/bin/env node

/**
 * Script de test automatique pour valider le système de cache du dashboard
 * Vérifie que tous les composants utilisent correctement le nouveau contexte
 */

const fs = require('fs');
const path = require('path');

// Configuration
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NEWBI_V2_PATH = path.join(PROJECT_ROOT, 'NewbiV2');

// Tests à effectuer
const TESTS = [
  {
    name: 'Vérification des imports dashboard-layout-context',
    test: checkDashboardLayoutContextImports
  },
  {
    name: 'Vérification absence anciens imports subscription-context',
    test: checkNoOldSubscriptionContextImports
  },
  {
    name: 'Vérification structure des fichiers de cache',
    test: checkCacheFilesStructure
  },
  {
    name: 'Vérification compatibilité des hooks',
    test: checkHookCompatibility
  }
];

// Fonction pour trouver tous les fichiers JS/JSX/TS/TSX
function findFiles(dir, extensions = ['.js', '.jsx', '.ts', '.tsx']) {
  let files = [];
  
  try {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (!['node_modules', '.git', '.next', 'dist', 'build'].includes(item)) {
          files = files.concat(findFiles(fullPath, extensions));
        }
      } else if (extensions.some(ext => item.endsWith(ext))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.warn(`Erreur lecture dossier ${dir}:`, error.message);
  }
  
  return files;
}

// Test 1: Vérifier les imports du nouveau contexte
function checkDashboardLayoutContextImports() {
  const files = findFiles(NEWBI_V2_PATH);
  const results = {
    passed: 0,
    failed: 0,
    details: []
  };
  
  const dashboardLayoutContextFiles = files.filter(file => {
    try {
      const content = fs.readFileSync(file, 'utf8');
      return content.includes('dashboard-layout-context');
    } catch (error) {
      return false;
    }
  });
  
  console.log(`📁 ${dashboardLayoutContextFiles.length} fichiers utilisent dashboard-layout-context`);
  
  // Vérifier que les fichiers clés utilisent le nouveau contexte
  const criticalFiles = [
    'src/components/section-cards.jsx',
    'src/components/nav-user.jsx',
    'src/components/app-sidebar.jsx',
    'src/components/trial-counter.jsx',
    'app/dashboard/layout.jsx'
  ];
  
  for (const criticalFile of criticalFiles) {
    const fullPath = path.join(NEWBI_V2_PATH, criticalFile);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes('dashboard-layout-context')) {
          results.passed++;
          results.details.push(`✅ ${criticalFile} utilise le nouveau contexte`);
        } else {
          results.failed++;
          results.details.push(`❌ ${criticalFile} n'utilise pas le nouveau contexte`);
        }
      } catch (error) {
        results.failed++;
        results.details.push(`❌ ${criticalFile} erreur de lecture: ${error.message}`);
      }
    } else {
      results.failed++;
      results.details.push(`❌ ${criticalFile} introuvable`);
    }
  }
  
  return results;
}

// Test 2: Vérifier l'absence des anciens imports
function checkNoOldSubscriptionContextImports() {
  const files = findFiles(NEWBI_V2_PATH);
  const results = {
    passed: 0,
    failed: 0,
    details: []
  };
  
  const problematicFiles = [];
  
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const relativePath = path.relative(NEWBI_V2_PATH, file);
      
      // Ignorer les fichiers de contexte eux-mêmes
      if (relativePath.includes('subscription-context.jsx') || 
          relativePath.includes('dashboard-layout-context.jsx')) {
        continue;
      }
      
      // Chercher les anciens imports problématiques
      if (content.includes('from "@/src/contexts/subscription-context"') ||
          content.includes('from "@/src/hooks/useOnboarding"')) {
        problematicFiles.push(relativePath);
        results.failed++;
        results.details.push(`❌ ${relativePath} utilise encore l'ancien contexte`);
      } else {
        results.passed++;
      }
    } catch (error) {
      // Ignorer les erreurs de lecture
    }
  }
  
  if (problematicFiles.length === 0) {
    results.details.push('✅ Aucun fichier n\'utilise l\'ancien contexte');
  }
  
  return results;
}

// Test 3: Vérifier la structure des fichiers de cache
function checkCacheFilesStructure() {
  const results = {
    passed: 0,
    failed: 0,
    details: []
  };
  
  const requiredFiles = [
    'src/hooks/useDashboardLayout.js',
    'src/contexts/dashboard-layout-context.jsx',
    'src/components/cache-debug-panel.jsx'
  ];
  
  for (const requiredFile of requiredFiles) {
    const fullPath = path.join(NEWBI_V2_PATH, requiredFile);
    if (fs.existsSync(fullPath)) {
      results.passed++;
      results.details.push(`✅ ${requiredFile} existe`);
      
      // Vérifier le contenu des fichiers critiques
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        
        if (requiredFile.includes('useDashboardLayout.js')) {
          if (content.includes('localStorage') && content.includes('CACHE_DURATION')) {
            results.details.push(`✅ ${requiredFile} contient la logique de cache`);
          } else {
            results.failed++;
            results.details.push(`❌ ${requiredFile} manque la logique de cache`);
          }
        }
        
        if (requiredFile.includes('dashboard-layout-context.jsx')) {
          if (content.includes('DashboardLayoutProvider') && content.includes('useSubscription')) {
            results.details.push(`✅ ${requiredFile} contient les hooks de compatibilité`);
          } else {
            results.failed++;
            results.details.push(`❌ ${requiredFile} manque les hooks de compatibilité`);
          }
        }
        
      } catch (error) {
        results.failed++;
        results.details.push(`❌ ${requiredFile} erreur de lecture: ${error.message}`);
      }
    } else {
      results.failed++;
      results.details.push(`❌ ${requiredFile} manquant`);
    }
  }
  
  return results;
}

// Test 4: Vérifier la compatibilité des hooks
function checkHookCompatibility() {
  const results = {
    passed: 0,
    failed: 0,
    details: []
  };
  
  const contextFile = path.join(NEWBI_V2_PATH, 'src/contexts/dashboard-layout-context.jsx');
  
  if (!fs.existsSync(contextFile)) {
    results.failed++;
    results.details.push('❌ Fichier de contexte introuvable');
    return results;
  }
  
  try {
    const content = fs.readFileSync(contextFile, 'utf8');
    
    // Vérifier les exports de compatibilité
    const compatibilityChecks = [
      { name: 'useSubscription', pattern: /export function useSubscription/ },
      { name: 'useOnboarding', pattern: /export function useOnboarding/ },
      { name: 'useDashboardLayoutContext', pattern: /export function useDashboardLayoutContext/ },
      { name: 'DashboardLayoutProvider', pattern: /export function DashboardLayoutProvider/ }
    ];
    
    for (const check of compatibilityChecks) {
      if (check.pattern.test(content)) {
        results.passed++;
        results.details.push(`✅ Hook ${check.name} disponible`);
      } else {
        results.failed++;
        results.details.push(`❌ Hook ${check.name} manquant`);
      }
    }
    
  } catch (error) {
    results.failed++;
    results.details.push(`❌ Erreur lecture contexte: ${error.message}`);
  }
  
  return results;
}

// Fonction principale
function main() {
  console.log('🧪 Tests du système de cache dashboard\n');
  
  if (!fs.existsSync(NEWBI_V2_PATH)) {
    console.error('❌ Dossier NewbiV2 introuvable:', NEWBI_V2_PATH);
    process.exit(1);
  }
  
  let totalPassed = 0;
  let totalFailed = 0;
  
  // Exécuter tous les tests
  for (const test of TESTS) {
    console.log(`🔍 ${test.name}...`);
    const result = test.test();
    
    totalPassed += result.passed;
    totalFailed += result.failed;
    
    // Afficher les détails
    for (const detail of result.details) {
      console.log(`  ${detail}`);
    }
    
    console.log(`  📊 Résultat: ${result.passed} réussis, ${result.failed} échoués\n`);
  }
  
  // Résumé final
  console.log('📋 RÉSUMÉ FINAL:');
  console.log(`✅ Tests réussis: ${totalPassed}`);
  console.log(`❌ Tests échoués: ${totalFailed}`);
  console.log(`📊 Score: ${totalPassed}/${totalPassed + totalFailed} (${Math.round(totalPassed / (totalPassed + totalFailed) * 100)}%)`);
  
  if (totalFailed === 0) {
    console.log('\n🎉 Tous les tests sont passés ! Le système de cache est prêt.');
  } else {
    console.log('\n⚠️  Certains tests ont échoué. Veuillez corriger les problèmes identifiés.');
  }
  
  // Recommandations
  console.log('\n📝 PROCHAINES ÉTAPES:');
  console.log('1. Démarrer l\'application en mode développement');
  console.log('2. Vérifier que le panel de debug apparaît en bas à droite');
  console.log('3. Naviguer entre les pages et observer l\'absence de flashs');
  console.log('4. Tester les fonctionnalités d\'abonnement et d\'onboarding');
  console.log('5. Valider les performances avec les DevTools');
  
  process.exit(totalFailed > 0 ? 1 : 0);
}

// Exécuter le script
if (require.main === module) {
  main();
}

module.exports = { 
  checkDashboardLayoutContextImports,
  checkNoOldSubscriptionContextImports,
  checkCacheFilesStructure,
  checkHookCompatibility
};
