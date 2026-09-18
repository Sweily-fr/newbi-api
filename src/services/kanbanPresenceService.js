// Présence temps réel sur les tâches kanban : qui a ouvert quelle tâche.
//
// Stockage : un hash Redis par board (`kanban:presence:{workspaceId}:{boardId}`),
// champ = `userId:clientId` (un onglet = une entrée, un utilisateur peut en
// avoir plusieurs), valeur = { userId, clientId, taskId, name, image, since, at }.
// Le hash est partagé entre les 4 instances PM2. Le front envoie un battement
// de cœur toutes les ~30 s tant qu'une tâche est ouverte ; une entrée sans
// battement depuis STALE_MS est considérée périmée (onglet fermé sans
// prévenir, machine en veille) et purgée à la lecture suivante.
//
// Sans Redis (dev local), repli sur une Map mémoire : même API, non partagée
// entre processus, ce qui suffit pour un serveur unique.
import { getCacheClient } from "../config/redis.js";
import logger from "../utils/logger.js";

export const HEARTBEAT_MS = 30 * 1000;
// Large : un onglet en arrière-plan voit ses minuteurs ralentis à 1/min par
// Chrome, il faut que deux battements puissent manquer sans « disparaître ».
export const STALE_MS = 120 * 1000;
// Le hash entier expire s'il n'est plus jamais touché (board fermé par tous).
const KEY_TTL_SECONDS = 180;

const memoryStore = new Map();

const presenceKey = (workspaceId, boardId) =>
  `kanban:presence:${workspaceId}:${boardId}`;

// Champ du hash : un par onglet quand le client s'identifie, sinon un par
// utilisateur (clients d'avant le déploiement du clientId).
export const presenceField = (userId, clientId) =>
  clientId ? `${userId}:${clientId}` : String(userId);

const readAll = async (key) => {
  const client = getCacheClient();
  if (!client) {
    return new Map(memoryStore.get(key) || []);
  }
  try {
    const raw = await client.hgetall(key);
    const out = new Map();
    for (const [field, json] of Object.entries(raw || {})) {
      try {
        out.set(field, JSON.parse(json));
      } catch {
        // Entrée corrompue : ignorée, elle sera purgée avec les périmées
      }
    }
    return out;
  } catch (error) {
    logger.warn("[KanbanPresence] Lecture Redis impossible:", error.message);
    return new Map();
  }
};

// Écritures ciblées (jamais de réécriture du hash entier) : deux utilisateurs
// qui enregistrent leur présence en même temps ne s'écrasent pas.
const applyChanges = async (key, { set = null, del = [] }) => {
  const client = getCacheClient();
  if (!client) {
    const entries = memoryStore.get(key) || new Map();
    for (const field of del) entries.delete(field);
    if (set) entries.set(set.field, set.entry);
    if (entries.size === 0) memoryStore.delete(key);
    else memoryStore.set(key, entries);
    return;
  }
  try {
    const pipeline = client.pipeline();
    if (del.length > 0) pipeline.hdel(key, ...del);
    if (set) {
      pipeline.hset(key, set.field, JSON.stringify(set.entry));
      pipeline.expire(key, KEY_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (error) {
    logger.warn("[KanbanPresence] Écriture Redis impossible:", error.message);
  }
};

const isFresh = (entry, now) =>
  entry &&
  entry.taskId &&
  typeof entry.at === "number" &&
  now - entry.at < STALE_MS;

// Signature d'un état = ce que voient les clients (couples utilisateur/tâche,
// un utilisateur sur la même tâche dans deux onglets ne compte qu'une fois).
// Sert à ne publier que lorsque la composition change, pas à chaque battement.
const signature = (entries) =>
  Array.from(
    new Set(Array.from(entries.values()).map((e) => `${e.userId}:${e.taskId}`)),
  )
    .sort()
    .join("|");

// Un avatar par utilisateur et par tâche, daté de son premier onglet
const toViewers = (entries) => {
  const byUserTask = new Map();
  for (const e of entries.values()) {
    const k = `${e.userId}:${e.taskId}`;
    const prev = byUserTask.get(k);
    if (!prev || (e.since || 0) < (prev.since || 0)) byUserTask.set(k, e);
  }
  return Array.from(byUserTask.values()).map((e) => ({
    userId: e.userId,
    taskId: e.taskId,
    name: e.name || null,
    image: e.image || null,
    since: e.since ? new Date(e.since).toISOString() : null,
  }));
};

// Retire les entrées périmées de `entries` (en place) et renvoie leurs champs
const purgeStale = (entries, now) => {
  const stale = [];
  for (const [field, entry] of entries) {
    if (!isFresh(entry, now)) {
      entries.delete(field);
      stale.push(field);
    }
  }
  return stale;
};

/**
 * Liste des présences fraîches d'un board, en purgeant les périmées.
 * `changed` = la purge a modifié ce que voient les clients → à diffuser,
 * sinon un onglet fermé sans prévenir resterait affiché jusqu'au prochain
 * mouvement sur le tableau.
 */
export const listTaskPresence = async ({ workspaceId, boardId }) => {
  const key = presenceKey(workspaceId, boardId);
  const now = Date.now();
  const entries = await readAll(key);
  const before = signature(entries);
  const stale = purgeStale(entries, now);
  if (stale.length > 0) await applyChanges(key, { del: stale });
  return {
    viewers: toViewers(entries),
    changed: signature(entries) !== before,
  };
};

/**
 * Enregistre (taskId) ou retire (taskId null) la présence d'un onglet.
 * Retourne { viewers, changed } : `changed` est faux quand seul le battement
 * de cœur a été rafraîchi, auquel cas il n'y a rien à diffuser.
 */
export const setTaskPresence = async ({
  workspaceId,
  boardId,
  user,
  clientId = null,
  taskId,
}) => {
  const key = presenceKey(workspaceId, boardId);
  const now = Date.now();
  const entries = await readAll(key);
  // La signature de référence est prise AVANT la purge : une expiration est
  // un changement visible, elle doit être diffusée.
  const before = signature(entries);
  const stale = purgeStale(entries, now);

  const userId = String(user.id);
  const field = presenceField(userId, clientId);
  let set = null;
  if (taskId) {
    const previous = entries.get(field);
    const sameTask = previous && previous.taskId === String(taskId);
    const entry = {
      userId,
      clientId: clientId || null,
      taskId: String(taskId),
      name: user.name || null,
      image: user.image || null,
      since: sameTask ? previous.since : now,
      at: now,
    };
    entries.set(field, entry);
    set = { field, entry };
  } else if (entries.has(field)) {
    entries.delete(field);
    stale.push(field);
  }

  await applyChanges(key, { set, del: stale });
  return {
    viewers: toViewers(entries),
    changed: signature(entries) !== before,
  };
};

/**
 * Retrait différé après fermeture du WebSocket : on ne retire l'entrée que
 * si l'onglet ne s'est pas ré-annoncé depuis `disconnectedAt` (une simple
 * reconnexion se ré-annonce en quelques centaines de ms, une vraie
 * fermeture jamais). Retourne null quand il n'y a rien à diffuser.
 */
export const clearTaskPresenceIfIdle = async ({
  workspaceId,
  boardId,
  userId,
  clientId = null,
  disconnectedAt,
}) => {
  const key = presenceKey(workspaceId, boardId);
  const entries = await readAll(key);
  const field = presenceField(userId, clientId);
  const entry = entries.get(field);
  if (!entry || (typeof entry.at === "number" && entry.at > disconnectedAt)) {
    return null;
  }
  const before = signature(entries);
  entries.delete(field);
  await applyChanges(key, { del: [field] });
  const changed = signature(entries) !== before;
  return changed ? { viewers: toViewers(entries), changed } : null;
};
