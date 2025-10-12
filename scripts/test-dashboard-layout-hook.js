#!/usr/bin/env node

/**
 * Script de test pour vérifier que le hook useDashboardLayout fonctionne sans erreurs
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(PROJECT_ROOT, 'NewbiV2/src/hooks/useDashboardLayout.js');

function testHookSyntax() {
  console.log('🧪 Test de syntaxe du hook useDashboardLayout...\n');
  
  if (!fs.existsSync(HOOK_PATH)) {
    console.error('❌ Hook introuvable:', HOOK_PATH);
    return false;
  }
  
  try {
    const content = fs.readFileSync(HOOK_PATH, 'utf8');
    
    // Tests de base
    const tests = [
      {
        name: 'Import useMemo',
        test: () => content.includes('useMemo'),
        fix: 'Ajouter: import { useMemo } from "react"'
      },
      {
        name: 'Vérifications de nullité',
        test: () => {
          // Vérifier qu'il n'y a pas d'accès direct à session.user sans ?
          const problematicPatterns = [
            /session\.user(?!\?)/g,
            /session\.user\.(?!\?)/g
          ];
          
          for (const pattern of problematicPatterns) {
            if (pattern.test(content)) {
              return false;
            }
          }
          return true;
        },
        fix: 'Remplacer session.user par session?.user'
      },
      {
        name: 'Cache localStorage',
        test: () => content.includes('localStorage') && content.includes('CACHE_DURATION'),
        fix: 'Vérifier la logique de cache localStorage'
      },
      {
        name: 'Gestion des erreurs',
        test: () => content.includes('try') && content.includes('catch'),
        fix: 'Ajouter la gestion d\'erreurs'
      },
      {
        name: 'Export du hook',
        test: () => content.includes('export function useDashboardLayout'),
        fix: 'Vérifier l\'export du hook'
      }
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
      try {
        if (test.test()) {
          console.log(`✅ ${test.name}`);
          passed++;
        } else {
          console.log(`❌ ${test.name} - ${test.fix}`);
          failed++;
        }
      } catch (error) {
        console.log(`❌ ${test.name} - Erreur: ${error.message}`);
        failed++;
      }
    }
    
    console.log(`\n📊 Résultat: ${passed} réussis, ${failed} échoués`);
    
    if (failed === 0) {
      console.log('🎉 Tous les tests sont passés !');
      return true;
    } else {
      console.log('⚠️  Certains tests ont échoué.');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erreur lecture du hook:', error.message);
    return false;
  }
}

function checkDependencies() {
  console.log('\n🔍 Vérification des dépendances...\n');
  
  try {
    const content = fs.readFileSync(HOOK_PATH, 'utf8');
    
    // Extraire les imports
    const importMatches = content.match(/import\s+{[^}]+}\s+from\s+['"][^'"]+['"]/g) || [];
    const requiredImports = [
      'useState',
      'useEffect', 
      'useMemo',
      'useSession',
      'useTrial',
      'updateOrganization',
      'toast'
    ];
    
    console.log('📦 Imports trouvés:');
    importMatches.forEach(imp => console.log(`   ${imp}`));
    
    console.log('\n🔍 Vérification des imports requis:');
    for (const required of requiredImports) {
      if (content.includes(required)) {
        console.log(`✅ ${required}`);
      } else {
        console.log(`❌ ${required} manquant`);
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur vérification dépendances:', error.message);
  }
}

function suggestImprovements() {
  console.log('\n💡 Suggestions d\'amélioration:\n');
  
  const suggestions = [
    '1. Tester le hook dans un composant réel',
    '2. Vérifier les performances avec React DevTools',
    '3. Tester la persistance localStorage',
    '4. Valider l\'invalidation du cache',
    '5. Tester avec différents états de session'
  ];
  
  suggestions.forEach(suggestion => console.log(suggestion));
}

function main() {
  console.log('🧪 Test du hook useDashboardLayout\n');
  
  const syntaxOk = testHookSyntax();
  checkDependencies();
  
  if (syntaxOk) {
    console.log('\n✅ Le hook semble prêt à être utilisé !');
    suggestImprovements();
  } else {
    console.log('\n❌ Le hook nécessite des corrections avant utilisation.');
  }
  
  console.log('\n📝 Prochaines étapes:');
  console.log('1. Corriger les erreurs identifiées');
  console.log('2. Tester dans l\'application');
  console.log('3. Vérifier le panel de debug');
  console.log('4. Valider l\'absence d\'erreurs console');
}

if (require.main === module) {
  main();
}

module.exports = { testHookSyntax, checkDependencies };
