import mongoose from "mongoose";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Fix: ajoute un _id ObjectId à chaque subdoc de receiptFiles qui n'en a pas
// (cas des docs migrés via raw driver sans Mongoose pré-init du _id).
//
// Sans _id persisté, Mongoose en génère un nouveau à chaque chargement : le
// front reçoit un id qui n'existe pas en base → « Justificatif introuvable »
// à la suppression et « Aucun fichier disponible » à l'aperçu.
//
// Usage :
//   node scripts/fix-missing-receiptfile-ids.js            # dry run (aucune écriture)
//   node scripts/fix-missing-receiptfile-ids.js --apply    # écrit, après sauvegarde JSON
//
// Une sauvegarde des documents concernés (état avant modification) est
// écrite dans ~/backups/receiptfiles-ids-<date>.json avant toute écriture.

dotenv.config();

const APPLY = process.argv.includes("--apply");

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

async function fixIds() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log(`✅ Connecté à MongoDB (${APPLY ? "APPLY" : "DRY RUN"})`);

    const db = mongoose.connection.db;
    const collection = db.collection("transactions");

    // Uniquement les docs avec au moins un subdoc receiptFiles sans _id
    const txns = await collection
      .find({ receiptFiles: { $elemMatch: { _id: { $exists: false } } } })
      .toArray();

    console.log(`📊 ${txns.length} transactions avec receiptFiles sans _id`);
    for (const tx of txns) {
      const missing = (tx.receiptFiles || []).filter((f) => !f?._id);
      console.log(
        `  - ${tx._id} (ws ${tx.workspaceId}) : ${missing.length}/${tx.receiptFiles.length} sans _id → ${missing
          .map((f) => f.filename)
          .join(", ")}`,
      );
    }

    if (!APPLY) {
      console.log("ℹ️ Dry run : aucune écriture. Relancer avec --apply.");
      await mongoose.disconnect();
      process.exit(0);
    }

    if (txns.length > 0) {
      const backupDir = path.join(process.env.HOME || ".", "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(
        backupDir,
        `receiptfiles-ids-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      fs.writeFileSync(backupPath, JSON.stringify(txns, null, 2));
      console.log(`💾 Sauvegarde écrite : ${backupPath}`);
    }

    let fixed = 0;
    let skipped = 0;
    let totalSubdocsFixed = 0;

    for (const tx of txns) {
      const files = Array.isArray(tx.receiptFiles) ? tx.receiptFiles : [];
      const patched = files.map((f) =>
        f._id ? f : { _id: new ObjectId(), ...f },
      );
      const fixedCount = patched.filter((p, i) => !files[i]?._id).length;

      // Update conditionnel : on ne réécrit le tableau que s'il est encore
      // strictement identique à ce qu'on a lu (aucun ajout/suppression
      // concurrent entre la lecture et l'écriture).
      const result = await collection.updateOne(
        { _id: tx._id, receiptFiles: files },
        { $set: { receiptFiles: patched } },
      );
      if (result.matchedCount === 0) {
        skipped++;
        console.warn(
          `⚠️ ${tx._id} : receiptFiles modifié entre-temps, non touché (relancer le script)`,
        );
        continue;
      }
      fixed++;
      totalSubdocsFixed += fixedCount;
    }

    console.log(
      `✅ Terminé : ${fixed} transactions patchées, ${totalSubdocsFixed} subdocs receiptFiles ont reçu un _id, ${skipped} ignorées`,
    );

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Erreur:", err);
    process.exit(1);
  }
}

fixIds();
