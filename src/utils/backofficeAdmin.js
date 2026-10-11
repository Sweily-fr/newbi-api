import mongoose from "mongoose";

/**
 * Administrateur du back-office interne : id présent dans la liste blanche
 * BACKOFFICE_ADMIN_USER_IDS (ids séparés par des virgules) ET compte
 * @sweily.fr ou @newbi.fr. Fermé si la variable est absente. Mêmes règles
 * que les routes /api/backoffice (routes/backofficeAdmin.js).
 */
export function getBackofficeAdminAllowlist() {
  return (process.env.BACKOFFICE_ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function isBackofficeAdmin(userId) {
  if (!userId || !mongoose.isValidObjectId(String(userId))) return false;
  if (!getBackofficeAdminAllowlist().includes(String(userId))) return false;
  const user = await mongoose.connection.db
    .collection("user")
    .findOne(
      { _id: new mongoose.Types.ObjectId(String(userId)) },
      { projection: { email: 1 } },
    );
  const email = user?.email || "";
  return email.endsWith("@sweily.fr") || email.endsWith("@newbi.fr");
}
