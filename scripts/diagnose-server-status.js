#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🔍 Diagnostic Serveur Production');
console.log('=================================');

async function checkPM2Status() {
  console.log('1️⃣ Vérification statut PM2...');
  try {
    const { stdout } = await execAsync('pm2 status');
    console.log(stdout);
  } catch (error) {
    console.error('❌ Erreur PM2 status:', error.message);
  }
  console.log('');
}

async function checkPM2Logs() {
  console.log('2️⃣ Logs PM2 récents...');
  try {
    const { stdout } = await execAsync('pm2 logs newbi --lines 20 --nostream');
    console.log(stdout);
  } catch (error) {
    console.error('❌ Erreur PM2 logs:', error.message);
  }
  console.log('');
}

async function checkPortUsage() {
  console.log('3️⃣ Vérification ports utilisés...');
  try {
    const { stdout } = await execAsync('netstat -tlnp | grep :4000');
    if (stdout.trim()) {
      console.log('Port 4000 utilisé:');
      console.log(stdout);
    } else {
      console.log('❌ Port 4000 non utilisé - application probablement arrêtée');
    }
  } catch (error) {
    console.log('❌ Port 4000 non trouvé - application arrêtée');
  }
  console.log('');
}

async function checkProcesses() {
  console.log('4️⃣ Processus Node.js actifs...');
  try {
    const { stdout } = await execAsync('ps aux | grep node | grep -v grep');
    if (stdout.trim()) {
      console.log(stdout);
    } else {
      console.log('❌ Aucun processus Node.js trouvé');
    }
  } catch (error) {
    console.log('❌ Erreur vérification processus:', error.message);
  }
  console.log('');
}

async function checkDiskSpace() {
  console.log('5️⃣ Espace disque disponible...');
  try {
    const { stdout } = await execAsync('df -h');
    console.log(stdout);
  } catch (error) {
    console.error('❌ Erreur vérification disque:', error.message);
  }
  console.log('');
}

async function checkMemory() {
  console.log('6️⃣ Utilisation mémoire...');
  try {
    const { stdout } = await execAsync('free -h');
    console.log(stdout);
  } catch (error) {
    console.error('❌ Erreur vérification mémoire:', error.message);
  }
  console.log('');
}

async function testMongoConnection() {
  console.log('7️⃣ Test connexion MongoDB...');
  try {
    const { stdout } = await execAsync('mongo --eval "db.adminCommand(\'ping\')" --quiet');
    if (stdout.includes('ok')) {
      console.log('✅ MongoDB accessible');
    } else {
      console.log('❌ MongoDB inaccessible');
    }
  } catch (error) {
    console.log('❌ MongoDB inaccessible:', error.message);
  }
  console.log('');
}

async function suggestActions() {
  console.log('🛠️  Actions suggérées:');
  console.log('=====================');
  
  // Vérifier si l'app est en cours d'exécution
  try {
    const { stdout } = await execAsync('pm2 status | grep newbi');
    if (stdout.includes('stopped') || stdout.includes('errored')) {
      console.log('1. Redémarrer l\'application: pm2 restart newbi');
      console.log('2. Ou démarrer: pm2 start ecosystem.config.cjs');
    } else if (stdout.includes('online')) {
      console.log('1. Application en ligne mais port inaccessible');
      console.log('2. Vérifier configuration Caddy');
      console.log('3. Vérifier port d\'écoute dans ecosystem.config.cjs');
    }
  } catch (error) {
    console.log('1. PM2 non configuré - démarrer manuellement');
    console.log('2. cd ~/api.newbi.fr && npm start');
  }
  
  console.log('3. Vérifier logs détaillés: pm2 logs newbi --follow');
  console.log('4. Test manuel: node src/server.js');
  console.log('5. Vérifier variables d\'environnement: node scripts/check-env-vars.js');
}

async function runDiagnostic() {
  await checkPM2Status();
  await checkPM2Logs();
  await checkPortUsage();
  await checkProcesses();
  await checkDiskSpace();
  await checkMemory();
  await testMongoConnection();
  await suggestActions();
}

runDiagnostic().catch(console.error);
