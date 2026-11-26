/**
 * Noms affichés des membres (auteur d'une prospection, propriétaire d'une
 * boîte), lus dans la collection Better Auth `user`.
 */
import mongoose from "mongoose";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { splitName } from "../signatureProfile.js";

/** « Prénom Nom », sinon l'adresse e-mail, sinon null. */
export async function userDisplayName(userId) {
  const id = toObjectIdOrNull(String(userId ?? ""));
  if (!id) return null;
  let raw = null;
  try {
    raw = await mongoose.connection.db
      .collection("user")
      .findOne({ _id: id }, { projection: { name: 1, lastName: 1, email: 1 } });
  } catch {
    raw = null;
  }
  if (!raw) return null;
  const { firstName, lastName } = splitName(raw.name, raw.lastName);
  return [firstName, lastName].filter(Boolean).join(" ") || raw.email || null;
}
