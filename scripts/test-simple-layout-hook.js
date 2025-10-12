#!/usr/bin/env node

/**
 * Script pour tester que la version simplifiée du hook ne cause pas de boucles infinies
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SIMPLE_HOOK_PATH = path.join(PROJECT_ROOT, 'NewbiV2/src/hooks/useDashboardLayoutSimple.js');
const CONTEXT_PATH = path.join(PROJECT_ROOT, 'NewbiV2/src/contexts/dashboard-layout-context.jsx');

function testSimpleHook() {
  console.log('🧪 Test du hook simplifié useDashboardLayoutSimple...\n');
  
  if (!fs.existsSync(SIMPLE_HOOK_PATH)) {
    console.error('❌ Hook simplifié introuvable:', SIMPLE_HOOK_PATH);
    return false;
  }
  
  try {
    const content = fs.readFileSync(SIMPLE_HOOK_PATH, 'utf8');
    
    const tests = [
      {
        name: 'Pas de useCallback complexe',
        test: () => !content.includes('useCallback'),
        description: 'Vérifie l\'absence de useCallback qui pourrait causer des boucles'
      },
      {
        name: 'Pas de useMemo complexe',
        test: () => !content.includes('useMemo'),
        description: 'Vérifie l\'absence de useMemo qui pourrait causer des boucles'
      },
      {
        name: 'Pas de cache localStorage',
        test: () => !content.includes('localStorage'),
        description: 'Vérifie l\'absence de logique de cache complexe'
      },
      {
        name: 'useEffect simples',
        test: () => {
          const effectMatches = content.match(/useEffect\(/g) || [];
          return effectMatches.length <= 3; // Maximum 3 useEffect simples
        },
        description: 'Vérifie un nombre limité de useEffect'
      },
      {
        name: 'Pas de références à cachedData',
        test: () => !content.includes('cachedData'),
        description: 'Vérifie l\'absence de références à cachedData'
      },
      {
        name: 'Fonction de rafraîchissement simple',
        test: () => content.includes('window.location.reload'),
        description: 'Vérifie la présence d\'une fonction de rafraîchissement simple'
      }
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
      try {
        if (test.test()) {
          console.log(`✅ ${test.name}`);
          console.log(`   ${test.description}\n`);
          passed++;
        } else {
          console.log(`❌ ${test.name}`);
          console.log(`   ${test.description}\n`);
          failed++;
        }
      } catch (error) {
        console.log(`❌ ${test.name} - Erreur: ${error.message}\n`);
        failed++;
      }
    }
    
    console.log(`📊 Résultat: ${passed} réussis, ${failed} échoués`);
    
    return failed === 0;
    
  } catch (error) {
    console.error('❌ Erreur lecture du hook:', error.message);
    return false;
  }
}

function testContextIntegration() {
  console.log('\n🔍 Test de l\'intégration du contexte...\n');
  
  if (!fs.existsSync(CONTEXT_PATH)) {
    console.error('❌ Contexte introuvable:', CONTEXT_PATH);
    return false;
  }
  
  try {
    const content = fs.readFileSync(CONTEXT_PATH, 'utf8');
    
    if (content.includes('useDashboardLayoutSimple')) {
      console.log('✅ Le contexte utilise la version simplifiée du hook');
      return true;
    } else {
      console.log('❌ Le contexte n\'utilise pas la version simplifiée');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erreur lecture du contexte:', error.message);
    return false;
  }
}

function provideSolution() {
  console.log('\n💡 Solution temporaire appliquée:\n');
  
  const steps = [
    '1. Création d\'un hook simplifié sans cache (useDashboardLayoutSimple)',
    '2. Suppression de toute logique de cache complexe',
    '3. Utilisation de useEffect simples sans dépendances circulaires',
    '4. Remplacement temporaire dans le contexte',
    '5. Fonction de rafraîchissement simple (window.location.reload)'
  ];
  
  steps.forEach(step => console.log(step));
  
  console.log('\n📝 Prochaines étapes:');
  console.log('1. Tester l\'application - l\'erreur de boucle infinie devrait être résolue');
  console.log('2. Vérifier que les fonctionnalités de base fonctionnent');
  console.log('3. Une fois stable, optimiser progressivement le cache');
  console.log('4. Revenir à la version complète du hook quand prêt');
}

function main() {
  console.log('🧪 Test de la solution temporaire anti-boucle infinie\n');
  
  const hookTest = testSimpleHook();
  const contextTest = testContextIntegration();
  
  if (hookTest && contextTest) {
    console.log('\n✅ Solution temporaire appliquée avec succès !');
    console.log('L\'erreur de boucle infinie devrait être résolue.');
  } else {
    console.log('\n❌ Problèmes détectés dans la solution temporaire.');
  }
  
  provideSolution();
}

if (require.main === module) {
  main();
}

module.exports = { testSimpleHook, testContextIntegration };
