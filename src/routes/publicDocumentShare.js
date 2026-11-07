/**
 * Routes publiques des liens clients (documents partagés) : sans compte, le
 * jeton du lien fait foi, plus le mot de passe s'il y en a un. Tout est relu à
 * chaque requête : révoquer, faire expirer ou fermer le dossier coupe l'accès
 * immédiatement, y compris pour une page déjà ouverte.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import DocumentShare from "../models/DocumentShare.js";
import {
  findShareDocument,
  listShareDocuments,
  loadShareFolders,
} from "../services/documentShareAccess.js";
import {
  streamDocumentDownload,
  streamDocumentPreview,
} from "../services/sharedDocumentFileResponse.js";
import { streamFolderAsZip } from "../services/sharedDocumentZipService.js";
import { getAttemptCount, recordAttempt } from "../utils/attemptLimiter.js";
import {
  createDocumentShareAccessToken,
  verifyDocumentShareAccessToken,
} from "../utils/documentShareAccessToken.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import logger from "../utils/logger.js";

const router = express.Router();

const TOKEN_RE = /^[0-9a-f]{64}$/;
// Le fichier ne doit rester dans aucun cache : la révocation doit agir
const NO_STORE = "private, no-store";

// Essais de mot de passe en échec tolérés sur 15 min, comme les tableaux
// partagés : par adresse IP, et par lien pour borner une attaque répartie
const PASSWORD_WINDOW_SECONDS = 15 * 60;
const PASSWORD_MAX_PER_IP = 20;
const PASSWORD_MAX_PER_SHARE = 50;

const limited = (max) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Trop de tentatives. Réessayez dans quelques minutes.",
    },
  });

const unlockLimiter = limited(30);
// Un ZIP lit tous les fichiers du dossier sur R2
const zipLimiter = limited(10);

router.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

const unavailable = (res) =>
  res.status(410).json({
    success: false,
    message: "Ce lien n'est plus disponible.",
  });

/** Lien existant, actif, non expiré, et dossier toujours partageable. */
async function loadOpenShare(req, res) {
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ success: false, message: "Lien introuvable." });
    return null;
  }
  const share = await DocumentShare.findOne({ token });
  if (!share) {
    res.status(404).json({ success: false, message: "Lien introuvable." });
    return null;
  }
  const folders = share.isValid() ? await loadShareFolders(share) : null;
  if (!folders) {
    unavailable(res);
    return null;
  }
  return { share, folders };
}

function hasProof(req, share) {
  if (!share.passwordHash) return true;
  // En query et non en en-tête : <img>, <video> et les liens de téléchargement
  // ne peuvent pas envoyer d'en-tête
  return verifyDocumentShareAccessToken(req.query.access, share);
}

/** Même chose, mot de passe compris ; répond 401 s'il manque. */
async function loadUnlockedShare(req, res) {
  const loaded = await loadOpenShare(req, res);
  if (!loaded) return null;
  if (!hasProof(req, loaded.share)) {
    res.status(401).json({
      success: false,
      requiresPassword: true,
      message: "Mot de passe requis",
    });
    return null;
  }
  return loaded;
}

async function loadWorkspaceIdentity(workspaceId) {
  const organization = await mongoose.connection.db
    .collection("organization")
    .findOne(
      { _id: workspaceId },
      { projection: { name: 1, companyName: 1, logo: 1 } },
    );
  return {
    name: organization?.companyName || organization?.name || "",
    logo: organization?.logo || null,
  };
}

const countDownload = (share) =>
  DocumentShare.updateOne(
    { _id: share._id },
    { $inc: { "stats.totalDownloads": 1 } },
  ).catch((error) => logger.warn(`Lien client : ${error.message}`));

/**
 * GET /:token
 * Identité de l'espace et, une fois le mot de passe passé, contenu du dossier.
 */
router.get("/:token", async (req, res) => {
  try {
    const loaded = await loadOpenShare(req, res);
    if (!loaded) return;
    const { share, folders } = loaded;
    const workspace = await loadWorkspaceIdentity(share.workspaceId);

    res.setHeader("Cache-Control", NO_STORE);
    if (!hasProof(req, share)) {
      return res.json({ success: true, requiresPassword: true, workspace });
    }

    const documents = await listShareDocuments(share, folders);
    await DocumentShare.updateOne(
      { _id: share._id },
      {
        $inc: { "stats.totalViews": 1 },
        $set: { "stats.lastViewedAt": new Date() },
      },
    );

    return res.json({
      success: true,
      requiresPassword: false,
      workspace,
      expiresAt: share.expiresAt,
      rootFolderId: String(folders.root._id),
      folders: folders.folders.map((folder) => ({
        id: String(folder._id),
        name: folder.name,
        parentId: folder.parentId ? String(folder.parentId) : null,
        order: folder.order || 0,
      })),
      documents: documents.map((document) => ({
        id: String(document._id),
        name: document.name,
        mimeType: document.mimeType,
        fileSize: document.fileSize,
        folderId: String(document.folderId),
        createdAt: document.createdAt,
      })),
    });
  } catch (error) {
    logger.error(`Lien client (consultation) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors du chargement" });
  }
});

/**
 * POST /:token/unlock
 * Vérifie le mot de passe et remet le jeton d'accès.
 */
router.post("/:token/unlock", unlockLimiter, async (req, res) => {
  try {
    const loaded = await loadOpenShare(req, res);
    if (!loaded) return;
    const { share } = loaded;
    if (!share.passwordHash) {
      return res.json({ success: true, accessToken: null });
    }

    const ipKey = `document-share-password:ip:${req.ip || "inconnue"}`;
    const shareKey = `document-share-password:share:${share._id}`;
    const [ipAttempts, shareAttempts] = await Promise.all([
      getAttemptCount(ipKey),
      getAttemptCount(shareKey),
    ]);
    if (
      ipAttempts >= PASSWORD_MAX_PER_IP ||
      shareAttempts >= PASSWORD_MAX_PER_SHARE
    ) {
      return res.status(429).json({
        success: false,
        message: "Trop de tentatives. Réessayez dans quelques minutes.",
      });
    }

    const password = req.body?.password;
    if (
      typeof password === "string" &&
      (await share.verifyPassword(password))
    ) {
      return res.json({
        success: true,
        accessToken: createDocumentShareAccessToken(share),
      });
    }

    await Promise.all([
      recordAttempt(ipKey, PASSWORD_WINDOW_SECONDS),
      recordAttempt(shareKey, PASSWORD_WINDOW_SECONDS),
    ]);
    return res
      .status(401)
      .json({ success: false, message: "Mot de passe incorrect" });
  } catch (error) {
    logger.error(`Lien client (mot de passe) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de la vérification" });
  }
});

/**
 * GET /:token/download-all
 * Le dossier partagé en ZIP, sans les branches privées ou à la corbeille.
 */
router.get("/:token/download-all", zipLimiter, async (req, res) => {
  try {
    const loaded = await loadUnlockedShare(req, res);
    if (!loaded) return;
    const { share, folders } = loaded;

    res.setHeader("Cache-Control", NO_STORE);
    await streamFolderAsZip(
      String(share.folderId),
      String(share.workspaceId),
      res,
      { canAccess: (folderId) => folders.folderIds.has(String(folderId)) },
    );
    await countDownload(share);
  } catch (error) {
    logger.error(`Lien client (ZIP) : ${error.message}`);
    if (!res.headersSent) {
      res
        .status(error.message === "Aucun document dans ce dossier" ? 404 : 500)
        .json({
          success: false,
          message:
            error.message === "Aucun document dans ce dossier"
              ? error.message
              : "Erreur lors du téléchargement",
        });
    }
  }
});

async function loadUnlockedDocument(req, res) {
  const loaded = await loadUnlockedShare(req, res);
  if (!loaded) return null;
  const { documentId } = req.params;
  const document = isObjectIdString(documentId)
    ? await findShareDocument(loaded.share, loaded.folders, documentId)
    : null;
  if (!document) {
    res.status(404).json({ success: false, message: "Document introuvable." });
    return null;
  }
  return { ...loaded, document };
}

/**
 * GET /:token/files/:documentId/preview
 * GET /:token/files/:documentId/download
 */
router.get("/:token/files/:documentId/preview", async (req, res) => {
  try {
    const loaded = await loadUnlockedDocument(req, res);
    if (!loaded) return;
    await streamDocumentPreview(loaded.document, res, {
      cacheControl: NO_STORE,
    });
  } catch (error) {
    logger.error(`Lien client (aperçu) : ${error.message}`);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Erreur lors de l'aperçu" });
    }
  }
});

router.get("/:token/files/:documentId/download", async (req, res) => {
  try {
    const loaded = await loadUnlockedDocument(req, res);
    if (!loaded) return;
    await streamDocumentDownload(loaded.document, res, {
      cacheControl: NO_STORE,
    });
    await countDownload(loaded.share);
  } catch (error) {
    logger.error(`Lien client (téléchargement) : ${error.message}`);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Erreur lors du téléchargement" });
    }
  }
});

export default router;
