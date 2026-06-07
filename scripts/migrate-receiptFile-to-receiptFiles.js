import mongoose from "mongoose";
import dotenv from "dotenv";

// Migration: receiptFile (object) -> receiptFiles ([object])
// Pour chaque transaction avec un `receiptFile.url`, wrap dans receiptFiles[].
// Puis $unset le champ receiptFile.

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

async function migrate() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connecté à MongoDB");

    const db = mongoose.connection.db;
    const collection = db.collection("transactions");

    // 1. Trouver toutes les transactions avec un receiptFile.url
    const txnsWithReceipt = await collection
      .find({ "receiptFile.url": { $exists: true, $ne: null } })
      .toArray();

    console.log(
      `📊 ${txnsWithReceipt.length} transactions avec receiptFile à migrer`,
    );

    let migrated = 0;
    let skipped = 0;

    for (const tx of txnsWithReceipt) {
      // Si receiptFiles existe déjà et n'est pas vide, on skip
      if (Array.isArray(tx.receiptFiles) && tx.receiptFiles.length > 0) {
        skipped++;
        continue;
      }

      const receiptFileObj = {
        url: tx.receiptFile.url,
        key: tx.receiptFile.key,
        filename: tx.receiptFile.filename,
        mimetype: tx.receiptFile.mimetype,
        size: tx.receiptFile.size,
        uploadedAt: tx.receiptFile.uploadedAt || new Date(),
        uploadedBy: tx.receiptFile.uploadedBy,
      };

      await collection.updateOne(
        { _id: tx._id },
        {
          $set: { receiptFiles: [receiptFileObj] },
          $unset: { receiptFile: "" },
        },
      );
      migrated++;
    }

    console.log(`✅ Migration terminée : ${migrated} migrés, ${skipped} skip`);

    // 2. Nettoyer les transactions qui ont un receiptFile mais sans url
    // (orphelins éventuels)
    const cleanup = await collection.updateMany(
      { receiptFile: { $exists: true } },
      { $unset: { receiptFile: "" } },
    );
    if (cleanup.modifiedCount > 0) {
      console.log(
        `🧹 ${cleanup.modifiedCount} champs receiptFile orphelins nettoyés`,
      );
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Erreur migration:", err);
    await mongoose.disconnect();
    process.exit(1);
  }
}

migrate();
