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

dotenv.config({ path: path.resolve(process.cwd(), envFile) });
