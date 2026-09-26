// services/deviceHistoryService.js
//
// Historique des appareils et des versions d'app (collection
// `user_device_log`), lu par le back-office (page Activité et fiche
// utilisateur) : quand un client signale un bug, on veut savoir depuis quel
// appareil et sur quelle version il travaillait.
//
// Deux écrivains, un document par (utilisateur, appareil) :
//   - ici : chaque requête GraphQL authentifiée met à jour « vu le » et la
//     version du client (en-tête `x-app-client`), throttlé par instance PM2 ;
//   - NewbiV2 (hook Better Auth session.create.after) : ajoute les
//     connexions (`logins`).
//
// Écriture best-effort : ne bloque jamais une requête, n'échoue jamais.
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import {
  deviceKeyFor,
  parseDevice,
  parseAppClient,
} from "../utils/deviceIdentity.js";

const COLLECTION = "user_device_log";
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
// Bornes des historiques conservés dans le document (le reste est purgé par
// $slice, on garde les plus récents).
const MAX_VERSIONS = 30;

const lastTouch = new Map();
let indexEnsured = false;

const ensureIndexes = async (db) => {
  if (indexEnsured) return;
  indexEnsured = true;
  try {
    await Promise.all([
      db
        .collection(COLLECTION)
        .createIndex({ userId: 1, deviceKey: 1 }, { unique: true }),
      db.collection(COLLECTION).createIndex({ lastSeenAt: -1 }),
    ]);
  } catch (error) {
    logger.warn(`[DeviceHistory] createIndex échoué: ${error.message}`);
  }
};

/** Première IP de la chaîne x-forwarded-for (le VPS est derrière Nginx). */
const ipOf = (req) => {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim().slice(0, 60);
  }
  return String(req.ip || req.socket?.remoteAddress || "").slice(0, 60);
};

/**
 * Marque l'appareil courant comme vu maintenant, avec sa version d'app.
 * Throttlé par (utilisateur, appareil, version) pour ne pas écrire à chaque
 * requête : un changement de version est donc enregistré tout de suite.
 *
 * @param {*} userId
 * @param {import("express").Request} req
 */
export const touchDeviceHistory = (userId, req) => {
  if (!userId || !req) return;

  const userAgent = String(req.headers?.["user-agent"] || "").slice(0, 400);
  const { client, appVersion } = parseAppClient(req.headers?.["x-app-client"]);
  const deviceKey = deviceKeyFor(userAgent);
  const key = `${userId}:${deviceKey}:${appVersion || ""}`;
  const now = Date.now();
  if (now - (lastTouch.get(key) || 0) < TOUCH_THROTTLE_MS) return;
  lastTouch.set(key, now);

  if (lastTouch.size > 5000) {
    for (const [k, t] of lastTouch) {
      if (now - t > TOUCH_THROTTLE_MS * 10) lastTouch.delete(k);
    }
  }

  const db = mongoose.connection.db;
  if (!db) return;

  const device = parseDevice(userAgent);
  const at = new Date(now);
  const version = appVersion || null;
  const build = device.appBuild || null;

  const write = async () => {
    await ensureIndexes(db);
    const filter = { userId: String(userId), deviceKey };

    await db.collection(COLLECTION).updateOne(
      filter,
      {
        $set: {
          lastSeenAt: at,
          userAgent,
          ipAddress: ipOf(req),
          kind: device.kind,
          platform: device.platform,
          label: device.label,
          client: client || null,
          appVersion: version,
          appBuild: build,
        },
        $setOnInsert: { firstSeenAt: at },
        $inc: { seenCount: 1 },
      },
      { upsert: true },
    );

    // Historique des versions vues sur cet appareil : on prolonge la période
    // de la version courante, ou on en ouvre une nouvelle.
    if (!version && !build) return;
    const bumped = await db.collection(COLLECTION).updateOne(
      { ...filter, "versions.version": version, "versions.build": build },
      { $set: { "versions.$.lastSeenAt": at } },
    );
    if (bumped.matchedCount === 0) {
      await db.collection(COLLECTION).updateOne(filter, {
        $push: {
          versions: {
            $each: [{ version, build, firstSeenAt: at, lastSeenAt: at }],
            $slice: -MAX_VERSIONS,
          },
        },
      });
    }
  };

  write().catch((error) => {
    logger.warn(`[DeviceHistory] écriture échouée: ${error.message}`);
  });
};
