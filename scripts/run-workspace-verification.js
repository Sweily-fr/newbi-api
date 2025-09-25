#!/usr/bin/env node

/**
 * Script d'exécution rapide pour la vérification des workspaceId en production
 * Utilise les variables d'environnement de production
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger la configuration depuis ecosystem.config.cjs si disponible
let config = {};
try {
  const ecosystemPath = join(__dirname, '../../ecosystem.config.cjs');
  const ecosystemModule = await import(`file://${ecosystemPath}`);
  const ecosystemConfig = ecosystemModule.default || ecosystemModule;
  
  if (ecosystemConfig.apps && ecosystemConfig.apps[0] && ecosystemConfig.apps[0].env) {
    config = ecosystemConfig.apps[0].env;
    console.log('✅ Configuration chargée depuis ecosystem.config.cjs');
  }
} catch (error) {
  console.log('⚠️  ecosystem.config.cjs non trouvé, utilisation des variables d\'environnement système');
}

// Définir les variables d'environnement
const env = {
  ...process.env,
  ...config,
  MONGODB_URI: config.MONGODB_URI || process.env.MONGODB_URI || 'mongodb://newbiAdmin:newbi2024@localhost:27017/newbi?authSource=admin',
  NODE_ENV: 'production'
};

console.log('🚀 Vérification des WorkspaceId en Production');
console.log('===========================================');
console.log(`📍 MongoDB URI: ${env.MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
console.log(`🗄️  Base de données: newbi`);
console.log('');

try {
  // Exécuter le script de vérification
  console.log('🔍 Lancement de la vérification...\n');
  
  execSync('node verify-workspace-ids.js', {
    stdio: 'inherit',
    env: env,
    cwd: __dirname
  });
  
  console.log('\n✅ Vérification terminée !');
  console.log('\n💡 Prochaines étapes possibles :');
  console.log('   - Si des problèmes sont détectés :');
  console.log('     node fix-missing-workspace-ids.js (simulation)');
  console.log('     node fix-missing-workspace-ids.js --apply (correction)');
  console.log('   - Pour une collection spécifique :');
  console.log('     node fix-missing-workspace-ids.js --collection=invoices --apply');
  
} catch (error) {
  console.error('❌ Erreur lors de l\'exécution:', error.message);
  process.exit(1);
}
