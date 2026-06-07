import mongoose from "mongoose";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";

// Fix: ajoute un _id ObjectId à chaque subdoc de receiptFiles qui n'en a pas
// (cas des docs migrés via raw driver sans Mongoose pré-init du _id).

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

async function fixIds() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connecté à MongoDB");

    const db = mongoose.connection.db;
    const collection = db.collection("transactions");

    // Trouver tous les docs avec au moins un subdoc receiptFiles sans _id
    const txns = await collection
      .find({
        receiptFiles: { $exists: true, $not: { $size: 0 } },
      })
      .toArray();

    console.log(`📊 ${txns.length} transactions avec receiptFiles examinées`);

    let fixed = 0;
    let totalSubdocsFixed = 0;

    for (const tx of txns) {
      const files = Array.isArray(tx.receiptFiles) ? tx.receiptFiles : [];
      const needsFix = files.some((f) => !f?._id);
      if (!needsFix) continue;

      const patched = files.map((f) =>
        f._id ? f : { _id: new ObjectId(), ...f },
      );
      const fixedCount = patched.filter((p, i) => !files[i]?._id).length;

      await collection.updateOne(
        { _id: tx._id },
        { $set: { receiptFiles: patched } },
      );
      fixed++;
      totalSubdocsFixed += fixedCount;
    }

    console.log(
      `✅ Terminé : ${fixed} transactions patchées, ${totalSubdocsFixed} subdocs receiptFiles ont reçu un _id`,
    );

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("❌ Erreur:", err);
    await mongoose.disconnect();
    process.exit(1);
  }
}

fixIds();
