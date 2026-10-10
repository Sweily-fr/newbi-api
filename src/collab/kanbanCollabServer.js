// Édition collaborative (lettre par lettre) de la description des tâches
// kanban : serveur Hocuspocus (Yjs) monté sur le WebSocket de l'API,
// chemin /collab, même JWT que GraphQL.
//
// - Un document par tâche (`kanban-task:{taskId}`), champ Yjs "default".
// - Chargement : état Yjs stocké (KanbanCollabDoc) si le HTML de la tâche n'a
//   pas bougé entre-temps, sinon reconstruction depuis `task.description`
//   (modifié hors collab : app mobile, import…).
// - Enregistrement (débouncé par Hocuspocus) : état Yjs + HTML réécrit dans
//   `task.description` pour tout ce qui lit du HTML (cartes, PDF, mobile),
//   événement TASK_UPDATED pour les autres écrans, entrée d'activité
//   dédoublonnée.
// - Les 4 instances PM2 partagent les documents via l'extension Redis.
// - Description modifiée hors collab (updateTask : app mobile, éditeur de
//   repli) pendant qu'un document est ouvert : la nouvelle valeur est
//   appliquée au document en mémoire (voir syncExternalDescription), sinon
//   il l'écraserait au prochain enregistrement.
import crypto from "node:crypto";
import IORedis from "ioredis";
import * as Y from "yjs";
import { Hocuspocus } from "@hocuspocus/server";
import { Redis as HocuspocusRedis } from "@hocuspocus/extension-redis";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { generateHTML, generateJSON } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import { Task } from "../models/kanban.js";
import KanbanCollabDoc from "../models/KanbanCollabDoc.js";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { getActiveOrganization } from "../middlewares/org-resolver.js";
import { getEffectiveLevelsFor } from "../services/organizationRoleService.js";
import { levelsAllowLevel } from "../config/rolePermissions.js";
import { publishTaskUpdated } from "../resolvers/kanban.js";
import { getCacheClient, getPubSub, redisConfig } from "../config/redis.js";
import logger from "../utils/logger.js";

export const COLLAB_PATH = "/collab";
const DOCUMENT_PREFIX = "kanban-task:";
const FIELD = "default";
// Une seule entrée d'activité « a modifié la description » par personne et
// par tranche de 10 min, sinon chaque pause de frappe en créerait une.
const ACTIVITY_DEDUP_MS = 10 * 60 * 1000;

// Même schéma que l'éditeur côté front (StarterKit v3 inclut gras, italique,
// souligné, listes, citation, code, lien). L'historique est désactivé :
// c'est Yjs qui gère l'annulation en collaboratif.
// TrailingNode est désactivé : il ajoute un paragraphe vide en fin de
// document à l'ouverture (texte finissant par une liste, une citation…), ce
// qui compte comme une modification signée par celui qui a ouvert la tâche.
export const collabExtensions = [
  StarterKit.configure({ undoRedo: false, trailingNode: false }),
];

const sha1 = (s) =>
  crypto
    .createHash("sha1")
    .update(s || "")
    .digest("hex");

// HTML « vide » de ProseMirror → chaîne vide, comme l'ancien éditeur
const normalizeHtml = (html) => {
  if (!html) return "";
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text.length === 0 ? "" : html;
};

const taskIdFromDocumentName = (documentName) =>
  documentName.startsWith(DOCUMENT_PREFIX)
    ? documentName.slice(DOCUMENT_PREFIX.length)
    : null;

export const htmlToYdocUpdate = (html) => {
  const json = generateJSON(html || "<p></p>", collabExtensions);
  const ydoc = TiptapTransformer.toYdoc(json, FIELD, collabExtensions);
  return Y.encodeStateAsUpdate(ydoc);
};

export const ydocToHtml = (document) => {
  const json = TiptapTransformer.fromYdoc(document, FIELD);
  return normalizeHtml(generateHTML(json, collabExtensions));
};

const authenticate = async ({ token, documentName, connectionConfig }) => {
  try {
    return await authenticateOrThrow({
      token,
      documentName,
      connectionConfig,
    });
  } catch (error) {
    logger.warn(
      `[Collab] Connexion refusée sur ${documentName}: ${error.message}`,
    );
    throw error;
  }
};

const authenticateOrThrow = async ({
  token,
  documentName,
  connectionConfig,
}) => {
  const taskId = taskIdFromDocumentName(documentName);
  if (!taskId) throw new Error("Document inconnu");
  if (!token) throw new Error("Non authentifié");

  const fakeReq = {
    headers: { authorization: `Bearer ${token}` },
    ip: "127.0.0.1",
    get: (h) =>
      h.toLowerCase() === "authorization" ? `Bearer ${token}` : null,
  };
  const user = await betterAuthJWTMiddleware(fakeReq);
  if (!user) throw new Error("Non authentifié");
  const userId = user._id.toString();

  const task = await Task.findById(taskId).select("workspaceId boardId");
  if (!task) throw new Error("Tâche introuvable");
  const organization = await getActiveOrganization(
    userId,
    task.workspaceId?.toString(),
  );
  if (!organization) throw new Error("Accès refusé");

  // Droits du rôle sur le kanban : sans lecture, pas de connexion ; en
  // lecture seule, la connexion reçoit les modifications sans pouvoir en
  // envoyer (Hocuspocus ignore ses mises à jour)
  const levels = await getEffectiveLevelsFor(
    organization.id,
    organization.memberRole,
  );
  if (!levelsAllowLevel(levels, "kanban", "read")) {
    throw new Error("Accès refusé");
  }
  const readOnly = !levelsAllowLevel(levels, "kanban", "write");
  if (readOnly && connectionConfig) connectionConfig.readOnly = true;

  logger.info(
    `[Collab] ${userId} connecté sur la tâche ${taskId}${readOnly ? " (lecture seule)" : ""}`,
  );
  return {
    user: { id: userId },
    taskId,
    workspaceId: task.workspaceId.toString(),
    boardId: task.boardId?.toString(),
  };
};

const loadDocument = async ({ documentName, document }) => {
  const taskId = taskIdFromDocumentName(documentName);
  logger.info(`[Collab] Chargement du document de la tâche ${taskId}`);
  const task = await Task.findById(taskId).select("description");
  if (!task) return document;
  const html = task.description || "";
  const stored = await KanbanCollabDoc.findOne({ taskId }).lean();

  if (stored && stored.htmlHash === sha1(html)) {
    Y.applyUpdate(document, new Uint8Array(stored.state.buffer));
  } else {
    // Première ouverture, ou description modifiée hors collab : on repart
    // du HTML de la tâche (source de vérité pour tous les autres écrans)
    Y.applyUpdate(document, htmlToYdocUpdate(html));
    if (stored) {
      logger.info(
        `[Collab] Description de ${taskId} modifiée hors collab, document reconstruit`,
      );
    }
  }
  return document;
};

const storeDocument = async ({ documentName, document, lastContext }) => {
  const taskId = taskIdFromDocumentName(documentName);
  const html = ydocToHtml(document);
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  const userId = lastContext?.user?.id || null;

  const task = await Task.findById(taskId);
  if (!task) return;

  if ((task.description || "") !== html) {
    logger.info(
      `[Collab] Description de ${taskId} enregistrée (${html.length} car.) par ${userId || "?"}`,
    );
    task.description = html;
    task.updatedAt = new Date();
    if (userId) {
      const last = [...(task.activity || [])]
        .reverse()
        .find((a) => a.field === "description");
      const recent =
        last &&
        String(last.userId) === userId &&
        Date.now() - new Date(last.createdAt).getTime() < ACTIVITY_DEDUP_MS;
      if (!recent) {
        task.activity.push({
          userId,
          type: "updated",
          field: "description",
          description: "a modifié la description",
          createdAt: new Date(),
        });
      }
    }
    await task.save();
    publishTaskUpdated(task, task.workspaceId?.toString()).catch((error) => {
      logger.warn(
        "[Collab] Publication TASK_UPDATED impossible:",
        error.message,
      );
    });
  }

  await KanbanCollabDoc.updateOne(
    { taskId },
    {
      $set: { field: FIELD, state, htmlHash: sha1(html), lastEditedBy: userId },
    },
    { upsert: true },
  );
};

// Remplace le contenu du champ Yjs par le HTML donné, avec la même
// conversion que loadDocument. Les nœuds sont clonés depuis un document
// temporaire (un type Yjs ne peut pas changer de document). Renvoie false
// quand le document contient déjà ce HTML.
export const replaceDocumentHtml = (document, html) => {
  const source = new Y.Doc();
  try {
    Y.applyUpdate(source, htmlToYdocUpdate(html));
    if (ydocToHtml(document) === ydocToHtml(source)) return false;
    const nodes = source
      .getXmlFragment(FIELD)
      .toArray()
      .map((node) => node.clone());
    const fragment = document.getXmlFragment(FIELD);
    document.transact(() => {
      fragment.delete(0, fragment.length);
      fragment.insert(0, nodes);
    });
    return true;
  } finally {
    source.destroy();
  }
};

let hocuspocus = null;

// --- Description modifiée hors collaboration ---------------------------------
//
// En cluster PM2, le document peut être ouvert sur une autre instance que
// celle qui reçoit la mutation : le changement est diffusé à toutes les
// instances par le PubSub Redis de l'API. Seule une instance qui a déjà le
// document en mémoire l'applique (verrou Redis quand plusieurs l'ont : deux
// remplacements concurrents dupliqueraient le texte à la fusion), et jamais
// en le chargeant : rechargé depuis la base, il serait reconstruit avec une
// autre histoire Yjs que celui ouvert ailleurs, et l'extension Redis
// fusionnerait les deux en doublant le contenu. Document fermé partout :
// rien à faire, l'empreinte htmlHash ne correspond plus et il sera
// reconstruit depuis task.description à la prochaine ouverture.
const EXTERNAL_DESCRIPTION_CHANNEL = "KANBAN_COLLAB_EXTERNAL_DESCRIPTION";
const EXTERNAL_LOCK_PREFIX = "kanban-collab:external-description:";
const EXTERNAL_LOCK_TTL_MS = 30 * 1000;
let externalSubscription = null;

const isDocumentInMemory = (documentName) =>
  !!hocuspocus &&
  (hocuspocus.documents.has(documentName) ||
    hocuspocus.loadingDocuments.has(documentName));

// Une seule instance applique un message donné. Sans Redis (développement
// local, PubSub en mémoire) il n'y a qu'une instance : pas de verrou.
const acquireExternalLock = async (messageId) => {
  const client = getCacheClient();
  if (!client || !messageId) return true;
  try {
    const result = await client.set(
      `${EXTERNAL_LOCK_PREFIX}${messageId}`,
      String(process.pid),
      "PX",
      EXTERNAL_LOCK_TTL_MS,
      "NX",
    );
    return result === "OK";
  } catch (error) {
    // Mieux vaut ne pas appliquer que risquer un double remplacement
    logger.warn(
      "[Collab] Verrou de description externe indisponible:",
      error.message,
    );
    return false;
  }
};

/**
 * Applique une description modifiée hors collab au document de la tâche s'il
 * est en mémoire sur cette instance (sans jamais le charger), puis
 * l'enregistre aussitôt : task.description (HTML normalisé par l'éditeur) et
 * KanbanCollabDoc.htmlHash restent alignés sur le document.
 * @returns {Promise<"applied"|"unchanged"|"not-loaded">}
 */
export const applyExternalDescription = async (taskId, html) => {
  if (!hocuspocus || !taskId) return "not-loaded";
  const documentName = `${DOCUMENT_PREFIX}${taskId}`;
  const loading = hocuspocus.loadingDocuments.get(documentName);
  if (loading) await loading.catch(() => null);
  // Pas d'await entre ce test et l'ouverture : createDocument renvoie le
  // document déjà en mémoire sans passer par onLoadDocument
  if (!hocuspocus?.documents.has(documentName)) return "not-loaded";
  const connection = await hocuspocus.openDirectConnection(documentName, {
    externalDescription: true,
  });
  let changed = false;
  try {
    await connection.transact((document) => {
      changed = replaceDocumentHtml(document, html || "");
    });
  } finally {
    // Enregistrement immédiat (pas d'utilisateur dans le contexte : pas
    // d'entrée d'activité, updateTask a déjà tracé la modification)
    await connection.disconnect();
  }
  return changed ? "applied" : "unchanged";
};

/**
 * Traite un message de description externe reçu par cette instance.
 * @returns {Promise<"applied"|"unchanged"|"not-loaded"|"locked">}
 */
export const handleExternalDescriptionMessage = async (message) => {
  const taskId = message?.taskId;
  if (!taskId || !isDocumentInMemory(`${DOCUMENT_PREFIX}${taskId}`)) {
    return "not-loaded";
  }
  if (!(await acquireExternalLock(message.id))) return "locked";
  const status = await applyExternalDescription(taskId, message.html);
  if (status === "applied") {
    logger.info(
      `[Collab] Description de ${taskId} modifiée hors collab, appliquée au document ouvert`,
    );
  }
  return status;
};

/**
 * À appeler après l'écriture de task.description hors collab (updateTask) :
 * transmet la nouvelle valeur au document ouvert, quelle que soit
 * l'instance PM2 qui l'a en mémoire. Ne lève jamais d'erreur.
 */
export const syncExternalDescription = async (taskId, html) => {
  const message = {
    id: crypto.randomUUID(),
    taskId: String(taskId),
    html: html || "",
  };
  try {
    let pubsub = null;
    try {
      pubsub = getPubSub();
    } catch {
      pubsub = null;
    }
    if (pubsub) {
      try {
        await pubsub.publish(EXTERNAL_DESCRIPTION_CHANNEL, message);
        return;
      } catch (error) {
        logger.warn(
          "[Collab] Diffusion de la description impossible, application locale:",
          error.message,
        );
      }
    }
    await handleExternalDescriptionMessage(message);
  } catch (error) {
    logger.warn(
      `[Collab] Description externe de ${taskId} non appliquée:`,
      error.message,
    );
  }
};

// Abonnement de cette instance aux descriptions externes, pris avec le
// serveur collab : une instance sans serveur collab n'a aucun document ouvert
const subscribeExternalDescriptions = () => {
  if (externalSubscription) return;
  try {
    const pubsub = getPubSub();
    externalSubscription = Promise.resolve(
      pubsub.subscribe(EXTERNAL_DESCRIPTION_CHANNEL, (message) => {
        handleExternalDescriptionMessage(message).catch((error) => {
          logger.warn(
            "[Collab] Description externe non appliquée:",
            error.message,
          );
        });
      }),
    ).catch((error) => {
      logger.warn(
        "[Collab] Abonnement aux descriptions externes impossible:",
        error.message,
      );
      return null;
    });
  } catch (error) {
    logger.warn(
      "[Collab] PubSub indisponible, descriptions externes appliquées localement seulement:",
      error.message,
    );
  }
};

const unsubscribeExternalDescriptions = async () => {
  if (!externalSubscription) return;
  const subscription = externalSubscription;
  externalSubscription = null;
  try {
    const subscriptionId = await subscription;
    if (subscriptionId !== null && subscriptionId !== undefined) {
      getPubSub().unsubscribe(subscriptionId);
    }
  } catch (error) {
    logger.debug("[Collab] Désabonnement:", error.message);
  }
};

// `authenticate` injectable pour les tests (pas de JWT sous la main)
export const createKanbanCollabServer = ({ authenticate: authFn } = {}) => {
  if (hocuspocus) return hocuspocus;

  // Même connexion Redis que le reste de l'API (REDIS_URL en prod/staging,
  // hôte/port en local). Deux clients (pub/sub) créés par l'extension.
  const extensions = [];
  try {
    const redisUrl = process.env.REDIS_URL;
    const createClient = () =>
      redisUrl
        ? new IORedis(redisUrl)
        : new IORedis({
            host: redisConfig.host,
            port: redisConfig.port,
            db: redisConfig.db,
            password: redisConfig.password,
          });
    extensions.push(
      new HocuspocusRedis({ createClient, prefix: "kanban-collab" }),
    );
  } catch (error) {
    logger.warn(
      "[Collab] Extension Redis indisponible, instances non synchronisées:",
      error.message,
    );
  }

  hocuspocus = new Hocuspocus({
    name: `newbi-collab-${process.pid}`,
    quiet: true,
    // Enregistrement 2 s après la dernière frappe, au plus tard toutes les 10 s
    debounce: 2000,
    maxDebounce: 10000,
    unloadImmediately: false,
    extensions,
    onAuthenticate: authFn || authenticate,
    onLoadDocument: loadDocument,
    onStoreDocument: storeDocument,
  });

  subscribeExternalDescriptions();

  return hocuspocus;
};

// Branche une connexion `ws` brute (déjà upgradée) sur Hocuspocus. La
// requête Node est convertie en Request web (attendue par Hocuspocus v4).
export const handleCollabConnection = (ws, req) => {
  const instance = createKanbanCollabServer();
  const request = new Request(
    `http://${req.headers.host || "localhost"}${req.url}`,
    {
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(", ") : v,
        ]),
      ),
    },
  );
  const connection = instance.handleConnection(ws, request);
  ws.on("message", (data) => {
    connection.handleMessage(
      data instanceof Uint8Array ? data : new Uint8Array(data),
    );
  });
  ws.on("close", (code, reason) => {
    connection.handleClose({ code, reason: reason?.toString?.() || "" });
  });
  ws.on("error", (error) => {
    logger.warn("[Collab] Erreur WebSocket:", error.message);
  });
};

export const destroyKanbanCollabServer = async () => {
  await unsubscribeExternalDescriptions();
  if (!hocuspocus) return;
  try {
    await hocuspocus.destroy();
  } catch (error) {
    logger.debug("[Collab] Arrêt:", error.message);
  }
  hocuspocus = null;
};
