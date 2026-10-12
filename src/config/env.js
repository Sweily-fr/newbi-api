import dotenv from "dotenv";
import path from "path";

// Charge le fichier .env selon l'environnement. Ce module doit être le tout
// premier import de server.js : en ESM, tous les imports statiques sont
// évalués avant le corps du module, donc un `dotenv.config()` écrit dans
// server.js s'exécute APRÈS les singletons qui lisent process.env au
// chargement (emailReminderService, config/redis…). Jusqu'ici ça tenait
// grâce au `dotenv.config()` de utils/stripe.js, évalué avant eux par
// hasard d'ordre d'import.
export const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : ".env";

// Sous PM2 en production, le fichier fait foi. PM2 redonne à chaque instance
// relancée (pm2 reload) l'environnement mémorisé au dernier `pm2 start` ou
// `--update-env` : sans `override`, une valeur changée dans .env.production
// resterait masquée jusqu'à un arrêt complet de l'API, donc une coupure.
// La numérotation des instances reste celle de PM2 : les crons ne tournent
// que sur l'instance 0.
const fileWinsOverPm2 =
  process.env.NODE_ENV === "production" && process.env.pm_id !== undefined;
const pm2Numbering = ["pm_id", "NODE_APP_INSTANCE"].map((key) => [
  key,
  process.env[key],
]);

dotenv.config({
  path: path.resolve(process.cwd(), envFile),
  override: fileWinsOverPm2,
});

if (fileWinsOverPm2) {
  for (const [key, value] of pm2Numbering) {
    if (value !== undefined) process.env[key] = value;
  }
}
