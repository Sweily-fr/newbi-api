import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../.env") });

// Mode réel uniquement avec --apply, sinon simulation (dry-run)
const APPLY = process.argv.includes("--apply");

// Anciennes descriptions génériques d'assignation (sans nom de membre) :
//   - "a assigné 1 membre" / "a assigné 2 membres"
//   - "a retiré tous les membres assignés"
// Les nouvelles descriptions sont nominatives ("a assigné Jean Dupont"),
// donc ce pattern ne les touche pas.
const LEGACY_DESCRIPTION =
  /^(a assigné \d+ membres?|a retiré tous les membres assignés)$/;

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connecté à MongoDB");
  } catch (error) {
    console.error("❌ Erreur de connexion MongoDB:", error);
    process.exit(1);
  }
};

const cleanLegacyAssignedActivities = async () => {
  const Client = mongoose.model(
    "Client",
    new mongoose.Schema({}, { strict: false }),
  );

  // Récupérer uniquement les clients ayant au moins une activité "assigned"
  const clients = await Client.find({ "activity.type": "assigned" }).select(
    "_id name activity",
  );
  console.log(
    `📊 ${clients.length} client(s) avec au moins une activité "assigned"`,
  );

  let totalToRemove = 0;
  let clientsTouched = 0;

  for (const client of clients) {
    const legacy = (client.activity || []).filter(
      (a) =>
        a.type === "assigned" &&
        typeof a.description === "string" &&
        LEGACY_DESCRIPTION.test(a.description.trim()),
    );

    if (legacy.length === 0) continue;

    clientsTouched++;
    totalToRemove += legacy.length;
    console.log(
      `  • ${client.name || client._id} : ${legacy.length} entrée(s) à supprimer`,
    );
    legacy.forEach((a) => console.log(`      - "${a.description}"`));

    if (APPLY) {
      await Client.updateOne(
        { _id: client._id },
        {
          $pull: {
            activity: {
              type: "assigned",
              description: LEGACY_DESCRIPTION,
            },
          },
        },
      );
    }
  }

  console.log("");
  console.log(
    `📈 Résumé : ${totalToRemove} activité(s) génériques dans ${clientsTouched} client(s)`,
  );
  if (APPLY) {
    console.log("✅ Suppression appliquée.");
  } else {
    console.log(
      "ℹ️  Simulation (dry-run). Relancez avec --apply pour supprimer réellement.",
    );
  }
};

const run = async () => {
  await connectDB();
  await cleanLegacyAssignedActivities();
  await mongoose.connection.close();
  console.log("✅ Script terminé");
  process.exit(0);
};

run();
