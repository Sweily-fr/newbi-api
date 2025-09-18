#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🔄 Redémarrage Propre PM2');
console.log('=========================');

async function cleanRestartPM2() {
  try {
    console.log('1️⃣ Arrêt de tous les processus newbi...');
    await execAsync('pm2 delete newbi').catch(() => {
      console.log('   Aucun processus newbi à supprimer');
    });

    console.log('2️⃣ Nettoyage du cache PM2...');
    await execAsync('pm2 kill').catch(() => {
      console.log('   PM2 daemon déjà arrêté');
    });

    console.log('3️⃣ Vérification que le port 4000 est libre...');
    try {
      const { stdout } = await execAsync('lsof -ti:4000');
      if (stdout.trim()) {
        console.log('   Port 4000 utilisé, libération...');
        await execAsync(`kill -9 ${stdout.trim()}`);
      }
    } catch (error) {
      console.log('   Port 4000 libre');
    }

    console.log('4️⃣ Démarrage avec ecosystem.config.cjs...');
    const { stdout } = await execAsync('pm2 start ecosystem.config.cjs');
    console.log(stdout);

    console.log('5️⃣ Sauvegarde de la configuration...');
    await execAsync('pm2 save');

    console.log('6️⃣ Vérification du statut...');
    const { stdout: status } = await execAsync('pm2 status');
    console.log(status);

    console.log('7️⃣ Test du port 4000...');
    try {
      const { stdout: portCheck } = await execAsync('netstat -tlnp | grep :4000');
      if (portCheck.trim()) {
        console.log('✅ Application écoute sur le port 4000');
        console.log(portCheck);
      } else {
        console.log('❌ Port 4000 non utilisé');
      }
    } catch (error) {
      console.log('❌ Port 4000 non trouvé');
    }

    console.log('8️⃣ Logs récents...');
    const { stdout: logs } = await execAsync('pm2 logs newbi --lines 5 --nostream');
    console.log(logs);

    console.log('\n✅ Redémarrage terminé!');
    console.log('🔗 Testez l\'API: curl https://api.newbi.fr');
    console.log('📊 Surveillez les logs: pm2 logs newbi --follow');

  } catch (error) {
    console.error('❌ Erreur lors du redémarrage:', error.message);
    console.log('\n🛠️  Actions manuelles:');
    console.log('1. pm2 delete newbi');
    console.log('2. pm2 kill');
    console.log('3. pm2 start ecosystem.config.cjs');
    console.log('4. pm2 save');
  }
}

cleanRestartPM2();
