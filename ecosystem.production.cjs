// Configuration PM2 de la production (api.newbi.fr), utilisée par
// scripts/deploy/deploy-vps.sh. Le staging garde sa propre configuration,
// propre au VPS (~/staging/ecosystem.config.cjs).
//
// L'environnement n'est pas chargé ici : chaque instance lit .env.production
// à son démarrage (src/config/env.js). Le charger ici le figeait dans la copie
// que PM2 garde du dernier `pm2 start`, et seul un arrêt complet de l'API le
// rafraîchissait.
module.exports = {
  apps: [
    {
      name: "newbi",
      script: "./src/server.js",
      // Chemin en dur : lancé par erreur depuis ~/staging, ce fichier ne doit
      // pas remplacer la prod par le code du staging.
      cwd: "/home/joaquim/api.newbi.fr",
      instances: 4,
      exec_mode: "cluster",
      error_file: "./log/pm2/newbi-prod-error.log",
      out_file: "./log/pm2/newbi-prod-out.log",
      time: true,
      max_memory_restart: "500M",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      watch: false,
      // Redémarrage sans coupure (pm2 reload) : PM2 remplace les instances une
      // par une et n'arrête l'ancienne qu'une fois la nouvelle prête
      // (process.send("ready") dans server.js, ~30 s de démarrage). L'ancienne
      // a ensuite kill_timeout pour finir ses requêtes (20 s d'attente maximum
      // dans src/utils/gracefulShutdown.js, puis Redis et les files d'attente).
      wait_ready: true,
      listen_timeout: 90000,
      kill_timeout: 30000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
