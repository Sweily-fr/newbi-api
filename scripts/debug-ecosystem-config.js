import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔍 DIAGNOSTIC DE LA CONFIGURATION ECOSYSTEM');
console.log('===========================================');

// 1. Vérifier l'existence du fichier ecosystem.config.cjs
const ecosystemPath = path.join(__dirname, '..', 'ecosystem.config.cjs');
console.log(`\n📄 Chemin du fichier ecosystem: ${ecosystemPath}`);

try {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  
  console.log('📋 Tentative de chargement du fichier ecosystem...');
  const ecosystemConfig = require(ecosystemPath);
  
  console.log('✅ Fichier ecosystem.config.cjs chargé avec succès');
  console.log('📊 Structure du fichier:');
  console.log(JSON.stringify(ecosystemConfig, null, 2));
  
  if (ecosystemConfig.apps && ecosystemConfig.apps.length > 0) {
    const appConfig = ecosystemConfig.apps[0];
    console.log('\n📱 Configuration de la première app:');
    console.log(`   - Nom: ${appConfig.name}`);
    console.log(`   - Script: ${appConfig.script}`);
    
    if (appConfig.env) {
      console.log('\n🔧 Variables d\'environnement disponibles:');
      Object.keys(appConfig.env).forEach(key => {
        if (key.includes('MONGO')) {
          console.log(`   - ${key}: ${appConfig.env[key]}`);
        } else {
          console.log(`   - ${key}: [MASQUÉ]`);
        }
      });
      
      // Appliquer les variables d'environnement
      Object.assign(process.env, appConfig.env);
      console.log('\n✅ Variables d\'environnement appliquées');
      
      // Vérifier MONGODB_URI spécifiquement
      if (process.env.MONGODB_URI) {
        console.log(`\n🎯 MONGODB_URI trouvé: ${process.env.MONGODB_URI}`);
        
        // Extraire le nom de la base de données
        const dbName = process.env.DB_NAME || process.env.MONGODB_URI.split('/').pop();
        console.log(`📊 Nom de la base de données: ${dbName}`);
      } else {
        console.log('\n❌ MONGODB_URI non trouvé dans les variables d\'environnement');
      }
    } else {
      console.log('\n❌ Aucune variable d\'environnement trouvée dans la configuration');
    }
  } else {
    console.log('\n❌ Aucune application trouvée dans la configuration ecosystem');
  }
  
} catch (error) {
  console.error('\n❌ Erreur lors du chargement d\'ecosystem.config.cjs:');
  console.error(`   Message: ${error.message}`);
  console.error(`   Code: ${error.code}`);
  
  // Vérifier si le fichier existe
  try {
    const fs = await import('fs');
    const stats = fs.statSync(ecosystemPath);
    console.log(`   Fichier existe: OUI (${stats.size} bytes)`);
  } catch (fsError) {
    console.log(`   Fichier existe: NON (${fsError.message})`);
  }
}

console.log('\n🔍 Variables d\'environnement actuelles (filtrées):');
Object.keys(process.env)
  .filter(key => key.includes('MONGO') || key.includes('DB'))
  .forEach(key => {
    console.log(`   - ${key}: ${process.env[key]}`);
  });

console.log('\n✅ Diagnostic terminé');
