import mongoose from "mongoose";
import dotenv from "dotenv";

/**
 * Backfill du champ Transaction.reference (libellé bancaire brut).
 *
 * Contexte : depuis le 26/06/2026 la synchro Bridge stocke
 * provider_description (libellé brut, qui conserve les références de virement
 * type "F-202605-0016") dans Transaction.reference. Les transactions
 * synchronisées avant cette date ont reference: null, alors que le libellé
 * brut est disponible dans metadata.bridgeProviderDescription et/ou dans
 * raw.provider_description. Sans backfill, le rapprochement par référence et
 * l'affichage de la référence échouent sur tout l'historique.
 *
 * Usage (depuis la racine de l'API, avec .env.production à côté) :
 *   node scripts/backfill-transaction-reference.js --dry-run
 *   node scripts/backfill-transaction-reference.js
 *
 * Options :
 *   --dry-run       compte et liste un échantillon, sans rien écrire
 *   --limit <n>     limite le nombre de transactions traitées
 *   --env <fichier> fichier d'env à charger (défaut .env.production)
 */

const args = process.argv.slice(2);
const getOpt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const LIMIT = Number(getOpt("limit")) || 0;
const ENV_FILE = getOpt("env") || ".env.production";

dotenv.config({ path: ENV_FILE });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(`MONGODB_URI manquant (fichier d'env chargé : ${ENV_FILE})`);
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(
    `✅ Connecté à MongoDB (${DRY_RUN ? "DRY-RUN" : "exécution réelle"})`,
  );

  const collection = mongoose.connection.db.collection("transactions");

  const query = {
    $and: [
      { $or: [{ reference: null }, { reference: { $exists: false } }] },
      {
        $or: [
          { "metadata.bridgeProviderDescription": { $nin: [null, ""] } },
          { "raw.provider_description": { $nin: [null, ""] } },
        ],
      },
    ],
  };

  const total = await collection.countDocuments(query);
  console.log(`${total} transaction(s) sans reference avec libellé brut connu`);

  const cursor = collection
    .find(query, {
      projection: {
        _id: 1,
        date: 1,
        description: 1,
        "metadata.bridgeProviderDescription": 1,
        "raw.provider_description": 1,
      },
    })
    .sort({ date: 1 });

  let processed = 0;
  let updated = 0;

  for await (const tx of cursor) {
    if (LIMIT && processed >= LIMIT) break;
    processed += 1;

    const reference =
      tx.metadata?.bridgeProviderDescription ||
      tx.raw?.provider_description ||
      null;
    if (!reference) continue;

    if (DRY_RUN) {
      if (processed <= 20) {
        console.log(
          `[DRY-RUN] ${tx._id} (${tx.date?.toISOString?.()?.slice(0, 10) || "?"}) ` +
            `"${tx.description}" → reference "${reference}"`,
        );
      }
      updated += 1;
      continue;
    }

    // updateOne raw driver : ne déclenche ni validation Mongoose (données
    // legacy hors enum) ni hooks, et ne touche que le champ reference.
    const res = await collection.updateOne(
      {
        _id: tx._id,
        $or: [{ reference: null }, { reference: { $exists: false } }],
      },
      { $set: { reference } },
    );
    updated += res.modifiedCount;

    if (processed % 500 === 0) {
      console.log(
        `... ${processed}/${total} traitées, ${updated} mises à jour`,
      );
    }
  }

  console.log(
    `${DRY_RUN ? "[DRY-RUN] " : ""}Terminé : ${processed} traitées, ${updated} ` +
      `${DRY_RUN ? "auraient été mises à jour" : "mises à jour"}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Erreur backfill:", err);
  process.exit(1);
});
