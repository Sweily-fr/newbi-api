import mongoose from "mongoose";

/**
 * Construit les infos d'un membre assigné (même format que le kanban).
 * Better Auth stocke l'avatar dans 'image' ou 'avatar', parfois "null"/"" en string.
 * @param {string} idStr - ID utilisateur (string)
 * @param {object|null} user - document user de la collection Better Auth
 */
export function buildAssignedMemberInfo(idStr, user) {
  if (!user) {
    return { id: idStr, userId: idStr, name: idStr, email: null, image: null };
  }
  const rawImage = user.image || user.avatar;
  const image =
    rawImage && rawImage !== "null" && rawImage !== "" ? rawImage : null;
  const name =
    [user.name, user.lastName].filter(Boolean).join(" ") || user.email || idStr;
  return { id: idStr, userId: idStr, name, email: user.email || null, image };
}

/**
 * Charge en une requête les users correspondant aux IDs assignés.
 * @param {string[]} memberIds
 * @param {object} db - connexion MongoDB native (context.db)
 * @returns {Promise<Map<string, object>>} Map id → user
 */
export async function loadAssignedUsers(memberIds, db) {
  const usersMap = new Map();
  const objectIds = memberIds
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (objectIds.length === 0 || !db) return usersMap;

  const users = await db
    .collection("user")
    .find({ _id: { $in: objectIds } })
    .toArray();

  for (const user of users) {
    usersMap.set(user._id.toString(), user);
  }
  return usersMap;
}
