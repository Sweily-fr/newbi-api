/**
 * Stockage par espace : état (utilisé / quota), refus des nouveaux envois à
 * la limite, mise à jour du compteur à chaque envoi et suppression,
 * réconciliation périodique et alertes à 80 % et 100 %.
 *
 * Règles :
 * - seuls les NOUVEAUX envois sont refusés ; rien n'est jamais supprimé, un
 *   espace déjà au-dessus garde tous ses fichiers ;
 * - les PDF légaux générés automatiquement (archivage d'une facture émise,
 *   Factur-X) ne sont jamais refusés, mais ils sont comptés ;
 * - tant que le premier calcul d'un espace n'est pas terminé, les envois
 *   passent (on ne bloque jamais sur une valeur inconnue).
 */
import mongoose from "mongoose";
import logger from "../../utils/logger.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";

import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../middlewares/rbac.js";
import WorkspaceStorageUsage from "../../models/WorkspaceStorageUsage.js";
import WorkspaceStorageObject from "../../models/WorkspaceStorageObject.js";
import {
  computeStorageQuota,
  formatBytes,
  normalizeInterval,
  normalizePlan,
  recommendStorageOptions,
  STORAGE_FULL_RATIO,
  STORAGE_WARNING_RATIO,
} from "./storageConfig.js";
import {
  STORAGE_CATEGORIES,
  STORAGE_COMPUTE_VERSION,
  UNATTRIBUTED,
} from "./storageCategories.js";

// Le recalcul lit R2 (cloudflareService) : chargé seulement quand il sert,
// pour que les modules qui comptent un envoi n'en dépendent pas au chargement
async function computeWorkspaceStorage(workspaceId, options) {
  const { computeWorkspaceStorage: compute } =
    await import("./storageUsageCompute.js");
  return compute(workspaceId, options);
}

export const STORAGE_QUOTA_EXCEEDED = ERROR_CODES.STORAGE_QUOTA_EXCEEDED;

// Verrou d'un calcul complet (plusieurs instances PM2)
const COMPUTE_LOCK_MS = 5 * 60 * 1000;
// Attente maximale d'un premier calcul lors d'un envoi
const UPLOAD_WAIT_MS = 4000;
// Un résultat plus vieux est recalculé par la réconciliation
export const RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const inFlight = new Map();

function isValidWorkspaceId(workspaceId) {
  return Boolean(workspaceId) && String(workspaceId).length > 0;
}

// ---------------------------------------------------------------------------
// Offre et packs
// ---------------------------------------------------------------------------

/**
 * Offre, intervalle de facturation et abonnement actif de l'espace.
 * Sans abonnement actif (essai, abonnement échu) : quota Freelance, packs
 * ignorés.
 */
export async function getWorkspaceStorageSubscription(workspaceId) {
  const db = mongoose.connection.db;
  if (!db || !workspaceId) {
    return { plan: normalizePlan(null), interval: "month", live: false };
  }
  const id = String(workspaceId);
  const refs = [{ referenceId: id }, { organizationId: id }];
  if (mongoose.Types.ObjectId.isValid(id)) {
    const oid = new mongoose.Types.ObjectId(id);
    refs.push({ referenceId: oid }, { organizationId: oid });
  }
  const subscriptions = await db
    .collection("subscription")
    .find(
      { $or: refs },
      { projection: { plan: 1, status: 1, periodEnd: 1, billingInterval: 1 } },
    )
    .toArray();
  const now = new Date();
  const live =
    subscriptions.find((s) =>
      ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status),
    ) ||
    subscriptions.find(
      (s) =>
        s.status === "canceled" && s.periodEnd && new Date(s.periodEnd) > now,
    );
  return {
    plan: normalizePlan(live?.plan),
    interval: normalizeInterval(live?.billingInterval),
    live: Boolean(live),
  };
}

// ---------------------------------------------------------------------------
// Compteur
// ---------------------------------------------------------------------------

async function acquireComputeLock(workspaceId) {
  const now = new Date();
  try {
    const doc = await WorkspaceStorageUsage.findOneAndUpdate(
      {
        workspaceId,
        $or: [{ computingUntil: null }, { computingUntil: { $lt: now } }],
      },
      {
        $set: { computingUntil: new Date(now.getTime() + COMPUTE_LOCK_MS) },
        $setOnInsert: { workspaceId },
      },
      { upsert: true, new: true },
    );
    return Boolean(doc);
  } catch (error) {
    // Clé en double : le document existe et un calcul est en cours ailleurs
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Recalcul complet de l'espace (une seule exécution à la fois par espace).
 * @returns {Promise<object|null>} le document à jour, null si un autre
 *   calcul est déjà en cours
 */
export async function refreshWorkspaceStorage(workspaceId, options = {}) {
  const id = String(workspaceId);
  if (inFlight.has(id)) return inFlight.get(id);

  const run = (async () => {
    if (!(await acquireComputeLock(id))) return null;
    try {
      const result = await computeWorkspaceStorage(id, options);
      const doc = await WorkspaceStorageUsage.findOneAndUpdate(
        { workspaceId: id },
        {
          $set: {
            ...result,
            computedAt: new Date(),
            computingUntil: null,
            stale: false,
            version: STORAGE_COMPUTE_VERSION,
          },
        },
        { new: true },
      ).lean();
      await checkStorageAlerts(id).catch((error) =>
        logger.warn(`[storage] Alerte non vérifiée : ${error.message}`),
      );
      return doc;
    } catch (error) {
      await WorkspaceStorageUsage.updateOne(
        { workspaceId: id },
        { $set: { computingUntil: null } },
      ).catch(() => {});
      throw error;
    }
  })();

  inFlight.set(id, run);
  try {
    return await run;
  } finally {
    inFlight.delete(id);
  }
}

/** Attend la fin des recalculs en cours sur cette instance (arrêt, tests). */
export async function waitForStorageRefreshes() {
  while (inFlight.size > 0 || backgroundTasks.size > 0) {
    await Promise.allSettled([
      ...inFlight.values(),
      ...backgroundTasks.values(),
    ]);
  }
}

// Tâches lancées sans être attendues (alertes, recalcul d'un résultat
// périmé) : suivies pour pouvoir les attendre
const backgroundTasks = new Set();
function inBackground(promise) {
  backgroundTasks.add(promise);
  promise.finally(() => backgroundTasks.delete(promise)).catch(() => {});
  return promise;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Espace utilisé (document du cache). Premier calcul fait à la volée ; un
 * résultat périmé est servi tel quel et recalculé en arrière-plan.
 * @param {{ waitMs?: number }} options attente maximale d'un premier calcul
 * @returns {Promise<object|null>} null si le premier calcul n'est pas fini
 */
export async function getWorkspaceStorageUsage(workspaceId, options = {}) {
  const id = String(workspaceId);
  const doc = await WorkspaceStorageUsage.findOne({ workspaceId: id }).lean();
  const ready = doc?.computedAt && doc.version === STORAGE_COMPUTE_VERSION;

  if (ready) {
    if (doc.stale) {
      inBackground(
        refreshWorkspaceStorage(id).catch((error) =>
          logger.warn(`[storage] Recalcul en échec (${id}) : ${error.message}`),
        ),
      );
    }
    return doc;
  }

  const pending = refreshWorkspaceStorage(id).catch((error) => {
    logger.warn(`[storage] Premier calcul en échec (${id}) : ${error.message}`);
    return null;
  });
  const waitMs = options.waitMs ?? UPLOAD_WAIT_MS;
  const computed = waitMs > 0 ? await withTimeout(pending, waitMs) : undefined;
  if (computed) return computed;
  // Ancien calcul (autre version) : servi en attendant le nouveau
  return doc?.computedAt ? doc : null;
}

/**
 * État du stockage de l'espace : utilisé, quota, reste, niveau d'alerte.
 * `ready: false` tant que le premier calcul n'est pas terminé.
 */
export async function getWorkspaceStorageState(workspaceId, options = {}) {
  const [usage, subscription] = await Promise.all([
    getWorkspaceStorageUsage(workspaceId, options),
    getWorkspaceStorageSubscription(workspaceId),
  ]);
  const packs = subscription.live ? usage?.packs?.quantity || 0 : 0;
  const quota = computeStorageQuota({ plan: subscription.plan, packs });
  const usedBytes = Math.max(0, Number(usage?.totalBytes) || 0);
  const ratio = quota.quotaBytes > 0 ? usedBytes / quota.quotaBytes : 0;
  return {
    workspaceId: String(workspaceId),
    ready: Boolean(usage),
    plan: quota.plan,
    interval: subscription.interval,
    subscriptionActive: subscription.live,
    usedBytes,
    quotaBytes: quota.quotaBytes,
    baseQuotaBytes: quota.baseBytes,
    packs: quota.packs,
    packBytes: quota.packBytes,
    remainingBytes: Math.max(0, quota.quotaBytes - usedBytes),
    ratio,
    level:
      ratio >= STORAGE_FULL_RATIO
        ? "full"
        : ratio >= STORAGE_WARNING_RATIO
          ? "warning"
          : "ok",
    byCategory: usage?.byCategory || {},
    byUser: usage?.byUser || {},
    fileCount: usage?.fileCount || 0,
    unknownSizeCount: usage?.unknownSizeCount || 0,
    computedAt: usage?.computedAt || null,
  };
}

/** Message lisible du refus (affiché tel quel par le site et l'app). */
export function storageQuotaExceededMessage({
  usedBytes,
  quotaBytes,
  incomingBytes,
}) {
  const fileLine =
    incomingBytes > 0
      ? `Ce fichier (${formatBytes(incomingBytes)}) ne peut pas être enregistré.`
      : "Ce fichier ne peut pas être enregistré.";
  return (
    `Espace de stockage plein : ${formatBytes(usedBytes)} utilisés sur ${formatBytes(quotaBytes)}. ` +
    `${fileLine} Vos fichiers existants restent disponibles. ` +
    "Supprimez des fichiers dont vous n'avez plus besoin ou augmentez le stockage de l'espace."
  );
}

/**
 * Refuse un nouvel envoi qui ferait dépasser le quota de l'espace.
 * @param {string} workspaceId
 * @param {number} bytes taille de l'envoi (0 si inconnue : refusé seulement
 *   si l'espace est déjà plein)
 * @param {{ legal?: boolean }} [options] legal = PDF légal généré
 *   automatiquement, jamais refusé
 */
export async function assertStorageAvailable(workspaceId, bytes, options = {}) {
  if (options.legal || !isValidWorkspaceId(workspaceId)) return null;
  const incomingBytes = Math.max(0, Number(bytes) || 0);
  let state;
  try {
    state = await getWorkspaceStorageState(workspaceId, {
      waitMs: options.waitMs ?? UPLOAD_WAIT_MS,
    });
  } catch (error) {
    // Compteur indisponible : on n'empêche pas l'envoi
    logger.warn(
      `[storage] Contrôle impossible (${workspaceId}) : ${error.message}`,
    );
    return null;
  }
  if (!state.ready) return state;

  const exceeds =
    incomingBytes > 0
      ? state.usedBytes + incomingBytes > state.quotaBytes
      : state.usedBytes >= state.quotaBytes;
  if (!exceeds) return state;

  const offer = recommendStorageOptions({
    plan: state.plan,
    interval: state.interval,
    usedBytes: state.usedBytes,
    currentPacks: state.packs,
    incomingBytes,
  });
  inBackground(checkStorageAlerts(String(workspaceId)).catch(() => {}));
  throw new AppError(
    storageQuotaExceededMessage({
      usedBytes: state.usedBytes,
      quotaBytes: state.quotaBytes,
      incomingBytes,
    }),
    STORAGE_QUOTA_EXCEEDED,
    {
      usedBytes: state.usedBytes,
      quotaBytes: state.quotaBytes,
      incomingBytes,
      plan: state.plan,
      interval: state.interval,
      packs: state.packs,
      offer,
    },
  );
}

// ---------------------------------------------------------------------------
// Envois en plusieurs temps (transferts) : tailles annoncées en attente
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 6 * 60 * 60 * 1000;
const memoryPending = new Map();

function pendingKey(workspaceId) {
  return `storage:pending:${workspaceId}`;
}

async function readPending(workspaceId) {
  const now = Date.now();
  let entries = {};
  try {
    const { getCacheClient } = await import("../../config/redis.js");
    const client = getCacheClient();
    if (client) {
      entries = (await client.hgetall(pendingKey(workspaceId))) || {};
    } else {
      entries = Object.fromEntries(
        memoryPending.get(String(workspaceId)) || [],
      );
    }
  } catch {
    entries = Object.fromEntries(memoryPending.get(String(workspaceId)) || []);
  }
  let total = 0;
  for (const raw of Object.values(entries)) {
    const [bytes, at] = String(raw).split("@").map(Number);
    if (now - (at || 0) < PENDING_TTL_MS) total += bytes || 0;
  }
  return total;
}

/**
 * Fichier d'un transfert en cours d'envoi : sa taille annoncée compte dans
 * le contrôle des fichiers suivants, jusqu'à la création du transfert.
 */
export async function reservePendingUpload(workspaceId, uploadId, bytes) {
  if (!isValidWorkspaceId(workspaceId) || !uploadId) return;
  const value = `${Math.max(0, Number(bytes) || 0)}@${Date.now()}`;
  try {
    const { getCacheClient } = await import("../../config/redis.js");
    const client = getCacheClient();
    if (client) {
      await client.hset(pendingKey(workspaceId), String(uploadId), value);
      await client.pexpire(pendingKey(workspaceId), PENDING_TTL_MS);
      return;
    }
  } catch {
    // repli en mémoire
  }
  const map = memoryPending.get(String(workspaceId)) || new Map();
  map.set(String(uploadId), value);
  memoryPending.set(String(workspaceId), map);
}

export async function releasePendingUploads(workspaceId, uploadIds = []) {
  if (!isValidWorkspaceId(workspaceId) || uploadIds.length === 0) return;
  const ids = uploadIds.map(String);
  try {
    const { getCacheClient } = await import("../../config/redis.js");
    const client = getCacheClient();
    if (client) await client.hdel(pendingKey(workspaceId), ...ids);
  } catch {
    // sans effet
  }
  const map = memoryPending.get(String(workspaceId));
  if (map) for (const id of ids) map.delete(id);
}

/**
 * Contrôle d'un fichier de transfert : sa taille plus celle des autres
 * fichiers en cours d'envoi dans l'espace doit tenir dans le quota.
 */
export async function assertTransferStorageAvailable(
  workspaceId,
  uploadId,
  bytes,
) {
  if (!isValidWorkspaceId(workspaceId)) return null;
  const pending = await readPending(workspaceId);
  const state = await assertStorageAvailable(
    workspaceId,
    Math.max(0, Number(bytes) || 0) + pending,
  );
  if (uploadId && Number(bytes) > 0) {
    await reservePendingUpload(workspaceId, uploadId, bytes);
  }
  return state;
}

/** Relance un refus de stockage pris dans un catch qui renvoie success:false. */
export function rethrowStorageError(error) {
  if (error?.code === STORAGE_QUOTA_EXCEEDED) throw error;
}

/** Variante booléenne, pour les envois automatiques qui passent leur tour. */
export async function hasStorageAvailable(workspaceId, bytes) {
  try {
    await assertStorageAvailable(workspaceId, bytes);
    return true;
  } catch (error) {
    if (error?.code === STORAGE_QUOTA_EXCEEDED) return false;
    return true;
  }
}

async function applyDelta(workspaceId, { bytes, category, userId, files }) {
  if (!bytes && !files) return;
  const user = userId ? String(userId) : UNATTRIBUTED;
  const cat = STORAGE_CATEGORIES[category] ? category : "other";
  await WorkspaceStorageUsage.updateOne(
    { workspaceId: String(workspaceId), computedAt: { $ne: null } },
    {
      $inc: {
        totalBytes: bytes,
        [`byCategory.${cat}`]: bytes,
        [`byUser.${user}`]: bytes,
        fileCount: files,
      },
    },
  );
}

/**
 * Enregistre un fichier envoyé vers R2 : taille mémorisée, compteur mis à
 * jour. Ne lève jamais (le fichier est déjà envoyé).
 * @param {{ workspaceId: string, key: string, bucket?: string, size: number,
 *           category: string, userId?: string }} file
 */
export async function recordStoredFile(file) {
  const { workspaceId, key, bucket, category, userId } = file || {};
  if (!isValidWorkspaceId(workspaceId) || !key) return;
  const size = Math.max(0, Number(file.size) || 0);
  // Taille inconnue (copie serveur à serveur) : lue au prochain recalcul
  if (size === 0) {
    await markStorageStale(workspaceId);
    return;
  }
  try {
    const previous = await WorkspaceStorageObject.findOneAndUpdate(
      { key },
      {
        $set: {
          workspaceId: String(workspaceId),
          bucket: bucket || null,
          size,
          category: category || null,
          uploadedBy: userId ? String(userId) : null,
          source: "upload",
        },
      },
      { upsert: true, new: false },
    ).lean();
    // Même clé réécrite (archive du même mois) : seul l'écart compte
    const delta = size - (previous?.size || 0);
    await applyDelta(workspaceId, {
      bytes: delta,
      category,
      userId,
      files: previous ? 0 : 1,
    });
    if (delta > 0) {
      inBackground(
        checkStorageAlerts(String(workspaceId)).catch((error) =>
          logger.warn(`[storage] Alerte non vérifiée : ${error.message}`),
        ),
      );
    }
  } catch (error) {
    logger.warn(`[storage] Envoi non compté (${key}) : ${error.message}`);
    await markStorageStale(workspaceId);
  }
}

/**
 * Enregistre la suppression définitive d'un fichier de R2. Taille inconnue :
 * le prochain passage refait le calcul complet.
 */
export async function recordStoredFileDeleted(file) {
  const { workspaceId, key, category, userId } = file || {};
  if (!isValidWorkspaceId(workspaceId)) return;
  try {
    const previous = key
      ? await WorkspaceStorageObject.findOneAndDelete({ key }).lean()
      : null;
    const size = Number(file.size) > 0 ? Number(file.size) : previous?.size;
    if (!(size > 0)) {
      await markStorageStale(workspaceId);
      return;
    }
    await applyDelta(workspaceId, {
      bytes: -size,
      category: category || previous?.category,
      userId: userId || previous?.uploadedBy,
      files: -1,
    });
  } catch (error) {
    logger.warn(`[storage] Suppression non comptée : ${error.message}`);
    await markStorageStale(workspaceId);
  }
}

/**
 * Fichier qui en remplace un autre dans un document (archive PDF refaite) :
 * l'ancien ne compte plus, le nouveau compte.
 */
export async function recordReplacedFile({ previousKey, ...file }) {
  if (previousKey && previousKey !== file.key) {
    await recordStoredFileDeleted({
      workspaceId: file.workspaceId,
      key: previousKey,
      category: file.category,
    });
  }
  await recordStoredFile(file);
}

/** Transfert expiré ou supprimé : ses fichiers ne comptent plus. */
export async function recordTransferRemoved(transfer) {
  if (!transfer?.workspaceId) return;
  for (const file of transfer.files || []) {
    if (file?.storageType !== "r2" || !file.r2Key) continue;
    await recordStoredFileDeleted({
      workspaceId: transfer.workspaceId,
      key: file.r2Key,
      size: file.size,
      category: "transfers",
    });
  }
}

/** Le prochain passage refera le calcul complet de l'espace. */
export async function markStorageStale(workspaceId) {
  if (!isValidWorkspaceId(workspaceId)) return;
  try {
    await WorkspaceStorageUsage.updateOne(
      { workspaceId: String(workspaceId) },
      { $set: { stale: true } },
    );
  } catch (error) {
    logger.warn(`[storage] Marquage impossible : ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Alertes 80 % / 100 %
// ---------------------------------------------------------------------------

const ALERTS = {
  80: {
    type: "STORAGE_ALMOST_FULL",
    title: "Espace de stockage presque plein",
    message: (state) =>
      `Votre espace utilise ${formatBytes(state.usedBytes)} sur ${formatBytes(state.quotaBytes)} (${Math.floor(state.ratio * 100)} %). Les nouveaux envois seront refusés une fois la limite atteinte.`,
  },
  100: {
    type: "STORAGE_FULL",
    title: "Espace de stockage plein",
    message: (state) =>
      `Votre espace utilise ${formatBytes(state.usedBytes)} sur ${formatBytes(state.quotaBytes)}. Les nouveaux envois de fichiers sont refusés ; vos fichiers existants restent disponibles.`,
  },
};

function levelOf(ratio) {
  if (ratio >= STORAGE_FULL_RATIO) return 100;
  if (ratio >= STORAGE_WARNING_RATIO) return 80;
  return 0;
}

async function billingRecipients(workspaceId) {
  const db = mongoose.connection.db;
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId))) return [];
  const orgId = new mongoose.Types.ObjectId(String(workspaceId));
  const members = await db
    .collection("member")
    .find({ organizationId: orgId }, { projection: { userId: 1, role: 1 } })
    .toArray();
  const { getEffectiveLevelsFor } =
    await import("../organizationRoleService.js");
  const { hasPermission } = await import("../../middlewares/rbac.js");
  const recipients = [];
  for (const member of members) {
    try {
      const levels = await getEffectiveLevelsFor(
        String(workspaceId),
        member.role,
      );
      if (hasPermission(member.role, "billing", "view", levels)) {
        recipients.push(member.userId);
      }
    } catch {
      if (member.role === "owner") recipients.push(member.userId);
    }
  }
  return recipients;
}

/**
 * Notifie les personnes qui gèrent l'abonnement quand l'espace franchit 80 %
 * puis 100 %. Une seule notification par seuil, remise à zéro quand
 * l'espace redescend.
 */
export async function checkStorageAlerts(workspaceId) {
  const usage = await WorkspaceStorageUsage.findOne(
    { workspaceId: String(workspaceId) },
    { alertLevel: 1, computedAt: 1 },
  ).lean();
  if (!usage?.computedAt) return null;
  const state = await getWorkspaceStorageState(workspaceId, { waitMs: 0 });
  const level = levelOf(state.ratio);
  const current = usage.alertLevel || 0;

  if (level < current) {
    await WorkspaceStorageUsage.updateOne(
      { workspaceId: String(workspaceId) },
      { $set: { alertLevel: level } },
    );
    return null;
  }
  if (level === 0 || level === current) return null;

  // Une seule instance gagne le passage au nouveau seuil
  const claimed = await WorkspaceStorageUsage.updateOne(
    { workspaceId: String(workspaceId), alertLevel: { $lt: level } },
    { $set: { alertLevel: level } },
  );
  if (!claimed.modifiedCount) return null;

  const alert = ALERTS[level];
  const url = `${process.env.FRONTEND_URL || ""}/dashboard?parametres=stockage`;
  const recipients = await billingRecipients(workspaceId);
  const { default: Notification } =
    await import("../../models/Notification.js");
  const created = [];
  for (const userId of recipients) {
    try {
      const notification = await Notification.create({
        userId,
        workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
        type: alert.type,
        title: alert.title,
        message: alert.message(state),
        data: { url },
      });
      created.push(notification);
      try {
        const { publishNotification } =
          await import("../../resolvers/notification.js");
        await publishNotification(notification);
      } catch (error) {
        logger.debug(`[storage] Notification non publiée : ${error.message}`);
      }
    } catch (error) {
      logger.warn(`[storage] Notification non créée : ${error.message}`);
    }
  }
  return { level, notified: created.length };
}

// ---------------------------------------------------------------------------
// Réconciliation
// ---------------------------------------------------------------------------

/**
 * Recalcule les espaces dont le compteur est marqué périmé, ou plus vieux
 * que RECONCILE_MAX_AGE_MS, ou d'une ancienne version du calcul.
 */
export async function reconcileWorkspaceStorage({
  limit = 50,
  now = new Date(),
} = {}) {
  const docs = await WorkspaceStorageUsage.find(
    {
      $or: [
        { stale: true },
        { computedAt: null },
        { computedAt: { $lt: new Date(now.getTime() - RECONCILE_MAX_AGE_MS) } },
        { version: { $ne: STORAGE_COMPUTE_VERSION } },
        // Tailles restées inconnues (R2 injoignable) : nouvel essai après 1 h
        {
          unknownSizeCount: { $gt: 0 },
          computedAt: { $lt: new Date(now.getTime() - 60 * 60 * 1000) },
        },
      ],
    },
    { workspaceId: 1 },
  )
    .sort({ stale: -1, computedAt: 1 })
    .limit(limit)
    .lean();

  let refreshed = 0;
  for (const doc of docs) {
    try {
      const result = await refreshWorkspaceStorage(doc.workspaceId);
      if (result) refreshed += 1;
    } catch (error) {
      logger.warn(
        `[storage] Réconciliation en échec (${doc.workspaceId}) : ${error.message}`,
      );
    }
  }
  return { candidates: docs.length, refreshed };
}
