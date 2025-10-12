#!/usr/bin/env node

/**
 * Script de migration automatique pour remplacer les imports de subscription-context
 * par dashboard-layout-context dans tous les fichiers de l'application
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NEWBI_V2_PATH = path.join(PROJECT_ROOT, 'NewbiV2');

// Patterns de remplacement
const MIGRATION_PATTERNS = [
  {
    // Import de useSubscription depuis subscription-context
    search: /import\s*{\s*useSubscription\s*}\s*from\s*["']@\/src\/contexts\/subscription-context["'];?/g,
    replace: 'import { useSubscription } from "@/src/contexts/dashboard-layout-context";'
  },
  {
    // Import de useSubscription avec d'autres imports depuis subscription-context
    search: /import\s*{\s*([^}]*,\s*)?useSubscription(\s*,\s*[^}]*)?\s*}\s*from\s*["']@\/src\/contexts\/subscription-context["'];?/g,
    replace: (match, before, after) => {
      const otherImports = (before || '') + (after || '');
      if (otherImports.trim()) {
        return `import { useSubscription } from "@/src/contexts/dashboard-layout-context";\nimport {${otherImports}} from "@/src/contexts/subscription-context";`;
      }
      return 'import { useSubscription } from "@/src/contexts/dashboard-layout-context";';
    }
  },
  {
    // Import de SubscriptionProvider depuis subscription-context
    search: /import\s*{\s*SubscriptionProvider\s*}\s*from\s*["']@\/src\/contexts\/subscription-context["'];?/g,
    replace: 'import { SubscriptionProvider } from "@/src/contexts/subscription-context";'
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
        // Ignorer certains dossiers
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

// Fonction pour migrer un fichier
function migrateFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    let hasChanges = false;
    const originalContent = content;
    
    // Appliquer les patterns de migration
    for (const pattern of MIGRATION_PATTERNS) {
      if (typeof pattern.replace === 'function') {
        content = content.replace(pattern.search, (...args) => {
          hasChanges = true;
          return pattern.replace(...args);
        });
      } else {
        const newContent = content.replace(pattern.search, pattern.replace);
        if (newContent !== content) {
          hasChanges = true;
          content = newContent;
        }
      }
    }
    
    // Sauvegarder si des changements ont été faits
    if (hasChanges) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Migré: ${path.relative(PROJECT_ROOT, filePath)}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Erreur migration ${filePath}:`, error.message);
    return false;
  }
}

// Fonction principale
function main() {
  console.log('🚀 Démarrage de la migration subscription-context → dashboard-layout-context\n');
  
  if (!fs.existsSync(NEWBI_V2_PATH)) {
    console.error('❌ Dossier NewbiV2 introuvable:', NEWBI_V2_PATH);
    process.exit(1);
  }
  
  // Trouver tous les fichiers à migrer
  console.log('🔍 Recherche des fichiers à migrer...');
  const files = findFiles(NEWBI_V2_PATH);
  console.log(`📁 ${files.length} fichiers trouvés\n`);
  
  // Migrer chaque fichier
  let migratedCount = 0;
  let errorCount = 0;
  
  for (const file of files) {
    try {
      if (migrateFile(file)) {
        migratedCount++;
      }
    } catch (error) {
      console.error(`❌ Erreur: ${file}`, error.message);
      errorCount++;
    }
  }
  
  // Résumé
  console.log('\n📊 Résumé de la migration:');
  console.log(`✅ Fichiers migrés: ${migratedCount}`);
  console.log(`📁 Fichiers analysés: ${files.length}`);
  console.log(`❌ Erreurs: ${errorCount}`);
  
  if (migratedCount > 0) {
    console.log('\n🎉 Migration terminée avec succès !');
    console.log('\n📝 Prochaines étapes:');
    console.log('1. Vérifier que l\'application compile sans erreur');
    console.log('2. Tester les fonctionnalités d\'abonnement');
    console.log('3. Valider le comportement du cache');
  } else {
    console.log('\n✨ Aucune migration nécessaire - tous les fichiers sont déjà à jour');
  }
}

// Exécuter le script
if (require.main === module) {
  main();
}

module.exports = { migrateFile, findFiles, MIGRATION_PATTERNS };
