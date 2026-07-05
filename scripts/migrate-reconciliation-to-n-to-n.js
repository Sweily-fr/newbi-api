// Migration one-shot : passe les champs de rapprochement de la relation 1↔1
// singular (linkedInvoiceId / linkedTransactionId) à la relation N↔N array
// (linkedInvoiceIds / linkedTransactionIds).
//
// Usage :
//   node scripts/migrate-reconciliation-to-n-to-n.js               (utilise .env)
//   NODE_ENV=staging node scripts/migrate-reconciliation-to-n-to-n.js   (utilise .env.staging)
//   NODE_ENV=production node scripts/...                          (utilise .env.production)
//
// À exécuter UNE FOIS après le déploiement du refactor N↔N. Idempotent :
// une seconde exécution ne modifie plus rien.

import mongoose from "mongoose";
import dotenv from "dotenv";

// Charge .env.<NODE_ENV> si NODE_ENV est défini, sinon .env (aligné sur le
// pattern d'environnements du backend : .env / .env.staging / .env.production).
const envFile = process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : ".env";
dotenv.config({ path: envFile });
console.log(`Env chargée : ${envFile}`);

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI absent — impossible de migrer.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connecté à MongoDB");

  const db = mongoose.connection.db;

  // ── Transaction : linkedInvoiceId (singular) → linkedInvoiceIds (array) ──
  const txResult = await db.collection("transactions").updateMany(
    {
      linkedInvoiceId: { $exists: true, $ne: null },
      $or: [
        { linkedInvoiceIds: { $exists: false } },
        { linkedInvoiceIds: { $size: 0 } },
      ],
    },
    [
      {
        $set: {
          linkedInvoiceIds: ["$linkedInvoiceId"],
        },
      },
    ],
  );
  console.log(
    `Transactions migrées (linkedInvoiceId → linkedInvoiceIds) : ${txResult.modifiedCount}`,
  );

  // Retire l'ancien champ singular après avoir copié.
  const txUnset = await db
    .collection("transactions")
    .updateMany(
      { linkedInvoiceId: { $exists: true } },
      { $unset: { linkedInvoiceId: "" } },
    );
  console.log(
    `Transactions nettoyées (unset linkedInvoiceId) : ${txUnset.modifiedCount}`,
  );

  // ── Invoice : linkedTransactionId (singular) → linkedTransactionIds (array) ──
  const invResult = await db.collection("invoices").updateMany(
    {
      linkedTransactionId: { $exists: true, $ne: null },
      $or: [
        { linkedTransactionIds: { $exists: false } },
        { linkedTransactionIds: { $size: 0 } },
      ],
    },
    [
      {
        $set: {
          linkedTransactionIds: ["$linkedTransactionId"],
        },
      },
    ],
  );
  console.log(
    `Invoices migrées (linkedTransactionId → linkedTransactionIds) : ${invResult.modifiedCount}`,
  );

  const invUnset = await db
    .collection("invoices")
    .updateMany(
      { linkedTransactionId: { $exists: true } },
      { $unset: { linkedTransactionId: "" } },
    );
  console.log(
    `Invoices nettoyées (unset linkedTransactionId) : ${invUnset.modifiedCount}`,
  );

  await mongoose.disconnect();
  console.log("Migration terminée.");
}

main().catch((err) => {
  console.error("Erreur migration :", err);
  process.exit(1);
});
