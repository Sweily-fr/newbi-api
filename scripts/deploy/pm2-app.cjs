#!/usr/bin/env node
// Lecture de l'état PM2 pour scripts/deploy/deploy-vps.sh (sortie de
// `pm2 jlist` sur l'entrée standard).
//
//   pm2 jlist | node pm2-app.cjs supports-reload <app>
//     code 0 si l'app tourne déjà avec wait_ready (pm2 reload sans coupure
//     possible), 1 sinon (premier passage : arrêt complet unique)
//   pm2 jlist | node pm2-app.cjs all-online <app> <ecosystem>
//     code 0 si toutes les instances prévues par l'ecosystem sont en ligne

const path = require("path");

const [command, appName, ecosystemPath] = process.argv.slice(2);

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const processes = JSON.parse(input).filter((proc) => proc.name === appName);

  if (command === "supports-reload") {
    const ready =
      processes.length > 0 &&
      processes.every((proc) => proc.pm2_env.wait_ready === true);
    process.exit(ready ? 0 : 1);
  }

  if (command === "all-online") {
    const app = require(path.resolve(ecosystemPath)).apps.find(
      (candidate) => candidate.name === appName,
    );
    const expected = Number(app?.instances) || 1;
    const online = processes.filter(
      (proc) => proc.pm2_env.status === "online",
    ).length;
    console.log(`   ${online}/${expected} instance(s) ${appName} en ligne`);
    process.exit(online >= expected ? 0 : 1);
  }

  console.error(`Commande inconnue : ${command}`);
  process.exit(2);
});
