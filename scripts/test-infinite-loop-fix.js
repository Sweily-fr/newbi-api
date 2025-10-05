#!/usr/bin/env node

/**
 * Script pour tester que le hook useDashboardLayout ne cause plus de boucles infinies
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HOOK_PATH = path.join(PROJECT_ROOT, 'NewbiV2/src/hooks/useDashboardLayout.js');

function analyzeHookForInfiniteLoops() {
  console.log('🔍 Analyse du hook pour détecter les risques de boucles infinies...\n');
  
  if (!fs.existsSync(HOOK_PATH)) {
    console.error('❌ Hook introuvable:', HOOK_PATH);
    return false;
  }
  
  try {
    const content = fs.readFileSync(HOOK_PATH, 'utf8');
    
    const tests = [
      {
        name: 'Protection contre appels multiples (useRef)',
        test: () => content.includes('isLoadingRef') && content.includes('useRef'),
        description: 'Vérifie la présence d\'un mécanisme de protection contre les appels simultanés'
      },
      {
        name: 'Dépendances useCallback simplifiées',
        test: () => {
          const callbackMatches = content.match(/useCallback\([^,]+,\s*\[[^\]]*\]/g) || [];
          // Vérifier qu'aucun useCallback n'inclut cachedData dans ses dépendances
          return !callbackMatches.some(match => match.includes('cachedData'));
        },
        description: 'Vérifie que les useCallback n\'incluent pas cachedData dans leurs dépendances'
      },
      {
        name: 'useEffect avec timeout pour éviter appels fréquents',
        test: () => content.includes('setTimeout') && content.includes('clearTimeout'),
        description: 'Vérifie la présence de timeouts pour éviter les appels trop fréquents'
      },
      {
        name: 'Force refresh parameter',
        test: () => content.includes('forceRefresh') && content.includes('forceRefresh = false'),
        description: 'Vérifie la présence du paramètre forceRefresh pour contrôler les rechargements'
      },
      {
        name: 'Pas d\'accès direct à cachedData dans loadLayoutData',
        test: () => {
          // Extraire la fonction loadLayoutData
          const loadLayoutDataMatch = content.match(/const loadLayoutData = useCallback\(([^}]+}){2,}/s);
          if (!loadLayoutDataMatch) return false;
          
          const loadLayoutDataContent = loadLayoutDataMatch[0];
          // Vérifier qu'elle n'accède pas directement à cachedData (sauf pour les logs)
          return !loadLayoutDataContent.includes('cachedData.lastUpdate') || 
                 loadLayoutDataContent.includes('// Éviter');
        },
        description: 'Vérifie que loadLayoutData n\'accède pas directement à cachedData'
      },
      {
        name: 'Gestion d\'erreur dans localStorage',
        test: () => content.includes('try') && content.includes('localStorage') && content.includes('catch'),
        description: 'Vérifie la gestion d\'erreur pour les opérations localStorage'
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
    
    if (failed === 0) {
      console.log('\n🎉 Le hook semble protégé contre les boucles infinies !');
      return true;
    } else {
      console.log('\n⚠️  Le hook présente encore des risques de boucles infinies.');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erreur lecture du hook:', error.message);
    return false;
  }
}

function checkDependencyArrays() {
  console.log('\n🔍 Analyse des tableaux de dépendances...\n');
  
  try {
    const content = fs.readFileSync(HOOK_PATH, 'utf8');
    
    // Extraire tous les useEffect et useCallback
    const hookMatches = content.match(/(useEffect|useCallback)\([^,]+,\s*\[[^\]]*\]/g) || [];
    
    console.log('📋 Hooks avec dépendances trouvés:');
    hookMatches.forEach((match, index) => {
      console.log(`   ${index + 1}. ${match.substring(0, 80)}...`);
    });
    
    // Vérifier les patterns problématiques
    const problematicPatterns = [
      { pattern: /cachedData(?!\.user|\.organization)/, description: 'Référence directe à cachedData' },
      { pattern: /loadLayoutData.*cachedData/, description: 'loadLayoutData dépend de cachedData' },
      { pattern: /setState.*useEffect/, description: 'setState dans useEffect sans protection' }
    ];
    
    console.log('\n⚠️  Patterns problématiques détectés:');
    let hasProblems = false;
    
    for (const { pattern, description } of problematicPatterns) {
      if (pattern.test(content)) {
        console.log(`   ❌ ${description}`);
        hasProblems = true;
      }
    }
    
    if (!hasProblems) {
      console.log('   ✅ Aucun pattern problématique détecté');
    }
    
    return !hasProblems;
    
  } catch (error) {
    console.error('❌ Erreur analyse dépendances:', error.message);
    return false;
  }
}

function suggestBestPractices() {
  console.log('\n💡 Bonnes pratiques pour éviter les boucles infinies:\n');
  
  const practices = [
    '1. Utiliser useRef pour les flags de protection',
    '2. Éviter cachedData dans les dépendances des hooks',
    '3. Utiliser setTimeout pour débouncer les appels',
    '4. Implémenter forceRefresh pour contrôler les rechargements',
    '5. Séparer la logique de cache de la logique de chargement',
    '6. Utiliser des fonctions de callback stables',
    '7. Tester avec React DevTools Profiler'
  ];
  
  practices.forEach(practice => console.log(practice));
}

function main() {
  console.log('🧪 Test de protection contre les boucles infinies\n');
  
  const hookAnalysis = analyzeHookForInfiniteLoops();
  const dependencyAnalysis = checkDependencyArrays();
  
  if (hookAnalysis && dependencyAnalysis) {
    console.log('\n✅ Le hook semble sûr contre les boucles infinies !');
    console.log('\n📝 Prochaines étapes:');
    console.log('1. Tester dans l\'application réelle');
    console.log('2. Surveiller les performances avec React DevTools');
    console.log('3. Vérifier l\'absence d\'erreurs console');
    console.log('4. Valider le comportement du cache');
  } else {
    console.log('\n❌ Le hook nécessite encore des améliorations.');
    suggestBestPractices();
  }
}

if (require.main === module) {
  main();
}

module.exports = { analyzeHookForInfiniteLoops, checkDependencyArrays };
