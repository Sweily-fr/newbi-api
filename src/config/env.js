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

const envPath = path.resolve(process.cwd(), envFile);

// Sous PM2 en production, le fichier fait foi pour les variables de l'app.
// PM2 redonne à chaque instance relancée (pm2 reload) l'environnement
// mémorisé au dernier `pm2 start` ou `--update-env` : sans cela, une valeur
// changée dans .env.production resterait masquée jusqu'à un arrêt complet de
// l'API, donc une coupure.
const fileWinsOverPm2 =
  process.env.NODE_ENV === "production" && process.env.pm_id !== undefined;

if (fileWinsOverPm2) {
  const fileValues = dotenv.config({ path: envPath, processEnv: {} }).parsed;
  for (const [key, value] of Object.entries(fileValues || {})) {
    if (process.env[key] === undefined || !isProcessOwned(key)) {
      process.env[key] = value;
    }
  }
} else {
  dotenv.config({ path: envPath });
}

// Variables du système et de PM2 : la valeur du processus reste la bonne (le
// .env.production du VPS contient une vieille copie d'environnement, PATH et
// HOME compris), et la numérotation des instances reste celle de PM2 (crons
// sur l'instance 0 seulement).
function isProcessOwned(key) {
  return (
    /^[a-z]/.test(key) || // configuration interne de PM2 : pm_id, unique_id…
    /^(PM2|NVM|SSH|XDG|LC|DBUS)_/.test(key) ||
    [
      "_",
      "HOME",
      "LANG",
      "LOGNAME",
      "MAIL",
      "NODE_APP_INSTANCE",
      "OLDPWD",
      "PATH",
      "PWD",
      "SHELL",
      "SHLVL",
      "TERM",
      "USER",
    ].includes(key)
  );
}
