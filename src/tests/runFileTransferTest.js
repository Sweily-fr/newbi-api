import dotenv from "dotenv";
dotenv.config();

import { exec } from "child_process";

// Afficher un message de démarrage
console.log("Démarrage des tests de l'API de transfert de fichiers...");

// Exécuter le fichier de test
exec("node src/tests/fileTransfer.test.js", (error, stdout, stderr) => {
  if (error) {
    console.error(`Erreur d'exécution: ${error.message}`);
    return;
  }

  if (stderr) {
    console.error(`Erreurs: ${stderr}`);
    return;
  }

  console.log(`Résultats des tests:\n${stdout}`);
  console.log("\nTests terminés avec succès!");
});
