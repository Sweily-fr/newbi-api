// Présence temps réel sur les tâches kanban : qui a ouvert quelle tâche.
//
// Stockage : un hash Redis par board (`kanban:presence:{workspaceId}:{boardId}`),
// champ = userId, valeur = { userId, taskId, name, image, since, at }. Le hash
// est partagé entre les 4 instances PM2. Le front envoie un battement de cœur
// toutes les HEARTBEAT_MS tant qu'une tâche est ouverte ; une entrée sans
// battement depuis STALE_MS est considérée périmée (onglet fermé sans
// prévenir) et purgée à la lecture suivante.
//
// Sans Redis (dev local), repli sur une Map mémoire : même API, non partagée
// entre processus, ce qui suffit pour un serveur unique.
import { getCacheClient } from "../config/redis.js";
import logger from "../utils/logger.js";

export const HEARTBEAT_MS = 30 * 1000;
export const STALE_MS = 75 * 1000;
// Le hash entier expire s'il n'est plus jamais touché (board fermé par tous).
const KEY_TTL_SECONDS = 120;

const memoryStore = new Map();

const presenceKey = (workspaceId, boardId) =>
  `kanban:presence:${workspaceId}:${boardId}`;

const readAll = async (key) => {
  const client = getCacheClient();
  if (!client) {
    return new Map(memoryStore.get(key) || []);
  }
  try {
    const raw = await client.hgetall(key);
    const out = new Map();
    for (const [userId, json] of Object.entries(raw || {})) {
      try {
        out.set(userId, JSON.parse(json));
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
    for (const userId of del) entries.delete(userId);
    if (set) entries.set(set.userId, set);
    if (entries.size === 0) memoryStore.delete(key);
    else memoryStore.set(key, entries);
    return;
  }
  try {
    const pipeline = client.pipeline();
    if (del.length > 0) pipeline.hdel(key, ...del);
    if (set) {
      pipeline.hset(key, set.userId, JSON.stringify(set));
      pipeline.expire(key, KEY_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch (error) {
    logger.warn("[KanbanPresence] Écriture Redis impossible:", error.message);
  }
};

const isFresh = (entry, now) =>
  entry && entry.taskId && typeof entry.at === "number" && now - entry.at < STALE_MS;

// Signature d'un état = ce que voient les clients. Sert à ne publier que
// lorsque la composition change (pas à chaque battement de cœur).
const signature = (entries) =>
  Array.from(entries.values())
    .map((e) => `${e.userId}:${e.taskId}`)
    .sort()
    .join("|");

const toViewers = (entries) =>
  Array.from(entries.values()).map((e) => ({
    userId: e.userId,
    taskId: e.taskId,
    name: e.name || null,
    image: e.image || null,
    since: e.since ? new Date(e.since).toISOString() : null,
  }));

/**
 * Liste des présences fraîches d'un board (purge les périmées au passage).
 */
export const listTaskPresence = async ({ workspaceId, boardId }) => {
  const key = presenceKey(workspaceId, boardId);
  const now = Date.now();
  const entries = await readAll(key);
  const stale = [];
  for (const [userId, entry] of entries) {
    if (!isFresh(entry, now)) {
      entries.delete(userId);
      stale.push(userId);
    }
  }
  if (stale.length > 0) await applyChanges(key, { del: stale });
  return toViewers(entries);
};

/**
 * Enregistre (taskId) ou retire (taskId null) la présence d'un utilisateur.
 * Retourne { viewers, changed } : `changed` est faux quand seul le battement
 * de cœur a été rafraîchi, auquel cas il n'y a rien à diffuser.
 */
export const setTaskPresence = async ({
  workspaceId,
  boardId,
  user,
  taskId,
}) => {
  const key = presenceKey(workspaceId, boardId);
  const now = Date.now();
  const entries = await readAll(key);
  const stale = [];
  for (const [userId, entry] of entries) {
    if (!isFresh(entry, now)) {
      entries.delete(userId);
      stale.push(userId);
    }
  }
  const before = signature(entries);

  const userId = String(user.id);
  let set = null;
  if (taskId) {
    const previous = entries.get(userId);
    const sameTask = previous && previous.taskId === String(taskId);
    set = {
      userId,
      taskId: String(taskId),
      name: user.name || null,
      image: user.image || null,
      since: sameTask ? previous.since : now,
      at: now,
    };
    entries.set(userId, set);
  } else if (entries.has(userId)) {
    entries.delete(userId);
    stale.push(userId);
  }

  await applyChanges(key, { set, del: stale });
  return { viewers: toViewers(entries), changed: signature(entries) !== before };
};
