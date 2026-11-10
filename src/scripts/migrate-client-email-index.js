/**
 * Index d'unicité de l'email des clients : version partielle.
 *
 * Pourquoi
 *   « Générer des prospects » crée des fiches entreprise qui n'ont parfois
 *   qu'un téléphone. L'ancien index unique { email, workspaceId }
 *   (« email_1_workspaceId_1 ») compte un email absent comme null : la
 *   deuxième fiche sans email d'un même espace serait refusée. Le nouvel
 *   index (« client_email_unique_per_workspace ») ne porte que sur les
 *   emails renseignés. Pour les fiches existantes, qui ont toutes un email,
 *   la règle ne change pas.
 *
 *   Mongoose ne remplace pas un index existant de lui-même : ce script doit
 *   passer avant d'activer PROSPECTS_ENABLED.
 *
 * Usage
 *   Aperçu (par défaut, n'écrit rien) :
 *     node src/scripts/migrate-client-email-index.js
 *   Appliquer :
 *     node src/scripts/migrate-client-email-index.js --apply
 *   Revenir à l'ancien index (refusé s'il existe déjà des fiches sans email) :
 *     node src/scripts/migrate-client-email-index.js --restore
 *
 *   Se connecte à MONGODB_URI. Relançable sans risque.
 */
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const RESTORE = process.argv.includes("--restore");

const KEYS = { email: 1, workspaceId: 1 };
const OLD_NAME = "email_1_workspaceId_1";
const NEW_NAME = "client_email_unique_per_workspace";
const NEW_OPTIONS = {
  name: NEW_NAME,
  unique: true,
  partialFilterExpression: { email: { $type: "string" } },
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI absent");
    process.exit(1);
  }
  const mode = RESTORE ? "RESTORE" : APPLY ? "APPLY" : "APERÇU";
  console.log(`[migrate-client-email-index] connexion (${mode})…`);
  await mongoose.connect(uri);
  const clients = mongoose.connection.db.collection("clients");

  const indexes = await clients.indexes();
  const hasOld = indexes.some((i) => i.name === OLD_NAME);
  const hasNew = indexes.some((i) => i.name === NEW_NAME);
  const withoutEmail = await clients.countDocuments({
    $or: [{ email: { $exists: false } }, { email: null }],
  });
  const [duplicate] = await clients
    .aggregate([
      { $match: { email: { $type: "string" } } },
      {
        $group: { _id: { email: "$email", w: "$workspaceId" }, n: { $sum: 1 } },
      },
      { $match: { n: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();

  console.log(
    `  ancien index (${OLD_NAME}) : ${hasOld ? "présent" : "absent"}`,
  );
  console.log(
    `  nouvel index (${NEW_NAME}) : ${hasNew ? "présent" : "absent"}`,
  );
  console.log(`  fiches sans email : ${withoutEmail}`);
  console.log(`  doublons email/espace : ${duplicate ? "OUI" : "aucun"}`);

  if (duplicate) {
    console.error("Doublons trouvés : rien n'est modifié.");
    process.exit(1);
  }

  if (RESTORE) {
    if (withoutEmail > 0) {
      console.error(
        "Des fiches sans email existent : l'ancien index les refuserait. Rien n'est modifié.",
      );
      process.exit(1);
    }
    if (!hasOld)
      await clients.createIndex(KEYS, { name: OLD_NAME, unique: true });
    if (hasNew) await clients.dropIndex(NEW_NAME);
    console.log("Ancien index rétabli.");
    return;
  }

  if (hasNew && !hasOld) {
    console.log("Déjà migré, rien à faire.");
    return;
  }
  if (!APPLY) {
    console.log("Aperçu seulement. Relancer avec --apply pour migrer.");
    return;
  }

  if (!hasNew) {
    try {
      await clients.createIndex(KEYS, NEW_OPTIONS);
    } catch (error) {
      // Même clés qu'un index existant : il faut d'abord retirer l'ancien
      if (![85, 86].includes(error.code) || !hasOld) throw error;
      await clients.dropIndex(OLD_NAME);
      try {
        await clients.createIndex(KEYS, NEW_OPTIONS);
      } catch (createError) {
        await clients.createIndex(KEYS, { name: OLD_NAME, unique: true });
        console.error("Échec : ancien index rétabli.");
        throw createError;
      }
      console.log("Index remplacé.");
      return;
    }
  }
  if (hasOld && (await clients.indexes()).some((i) => i.name === OLD_NAME)) {
    await clients.dropIndex(OLD_NAME);
  }
  console.log("Index remplacé.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
