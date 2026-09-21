// services/userActivityService.js
//
// Suivi léger de l'activité des utilisateurs (présence "en ligne" et
// dernière activité) pour l'affichage des avatars dans les tableaux kanban.
//
// - touchUserActivity : appelé à chaque requête GraphQL authentifiée, écrit
//   au plus une fois par minute et par utilisateur (par instance PM2) dans la
//   collection `user_activity`.
// - getUsersPresence : renvoie pour une liste d'utilisateurs la dernière
//   activité connue et l'état en ligne. Repli sur les sessions Better Auth
//   (updatedAt/createdAt) quand aucune activité n'est encore enregistrée.
import mongoose from "mongoose";
import logger from "../utils/logger.js";

export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const TOUCH_THROTTLE_MS = 60 * 1000;
const COLLECTION = "user_activity";

const lastTouchByUser = new Map();
let indexEnsured = false;

const toObjectId = (id) => {
  try {
    return typeof id === "string" ? new mongoose.Types.ObjectId(id) : id;
  } catch {
    return null;
  }
};

const ensureIndex = async (db) => {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await db
      .collection(COLLECTION)
      .createIndex({ userId: 1 }, { unique: true });
  } catch (error) {
    logger.warn(`[UserActivity] createIndex échoué: ${error.message}`);
  }
};

/**
 * Marque l'utilisateur comme actif maintenant (throttlé, non bloquant).
 */
export const touchUserActivity = (userId) => {
  if (!userId) return;
  const key = userId.toString();
  const now = Date.now();
  const last = lastTouchByUser.get(key) || 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  lastTouchByUser.set(key, now);

  // Nettoyage occasionnel de la map (évite une croissance infinie)
  if (lastTouchByUser.size > 5000) {
    for (const [k, t] of lastTouchByUser) {
      if (now - t > TOUCH_THROTTLE_MS * 10) lastTouchByUser.delete(k);
    }
  }

  const db = mongoose.connection.db;
  const objectId = toObjectId(key);
  if (!db || !objectId) return;

  ensureIndex(db)
    .then(() =>
      db
        .collection(COLLECTION)
        .updateOne(
          { userId: objectId },
          { $set: { lastActiveAt: new Date(now) } },
          { upsert: true },
        ),
    )
    .catch((error) => {
      logger.warn(`[UserActivity] touch échoué: ${error.message}`);
    });
};

/**
 * Présence d'une liste d'utilisateurs.
 * @returns {Map<string, { lastSeenAt: Date|null, isOnline: boolean }>}
 */
export const getUsersPresence = async (db, userIds) => {
  const result = new Map();
  const objectIds = (userIds || []).map(toObjectId).filter(Boolean);
  if (!db || objectIds.length === 0) return result;

  const idStrings = objectIds.map((id) => id.toString());
  const [activities, sessions] = await Promise.all([
    db
      .collection(COLLECTION)
      .find({ userId: { $in: objectIds } })
      .toArray(),
    db
      .collection("session")
      .find(
        {
          $or: [{ userId: { $in: objectIds } }, { userId: { $in: idStrings } }],
        },
        { projection: { userId: 1, updatedAt: 1, createdAt: 1 } },
      )
      .toArray(),
  ]);

  const lastSeen = new Map();
  const bump = (userId, date) => {
    if (!userId || !date) return;
    const key = userId.toString();
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return;
    const prev = lastSeen.get(key);
    if (!prev || d > prev) lastSeen.set(key, d);
  };

  sessions.forEach((s) => bump(s.userId, s.updatedAt || s.createdAt));
  activities.forEach((a) => bump(a.userId, a.lastActiveAt));

  const now = Date.now();
  idStrings.forEach((id) => {
    const lastSeenAt = lastSeen.get(id) || null;
    result.set(id, {
      lastSeenAt,
      isOnline: !!lastSeenAt && now - lastSeenAt.getTime() < ONLINE_WINDOW_MS,
    });
  });
  return result;
};
