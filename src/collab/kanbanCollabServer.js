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
import { publishTaskUpdated } from "../resolvers/kanban.js";
import { redisConfig } from "../config/redis.js";
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

const authenticate = async ({ token, documentName }) => {
  try {
    return await authenticateOrThrow({ token, documentName });
  } catch (error) {
    logger.warn(
      `[Collab] Connexion refusée sur ${documentName}: ${error.message}`,
    );
    throw error;
  }
};

const authenticateOrThrow = async ({ token, documentName }) => {
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

  logger.info(`[Collab] ${userId} connecté sur la tâche ${taskId}`);
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

let hocuspocus = null;

export const createKanbanCollabServer = () => {
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
    onAuthenticate: authenticate,
    onLoadDocument: loadDocument,
    onStoreDocument: storeDocument,
  });

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
  if (!hocuspocus) return;
  try {
    await hocuspocus.destroy();
  } catch (error) {
    logger.debug("[Collab] Arrêt:", error.message);
  }
  hocuspocus = null;
};
