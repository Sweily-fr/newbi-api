/**
 * Routes publiques des accès clients (documents partagés), sur le modèle du
 * partage d'un tableau kanban : sans compte Newbi, le visiteur ouvre le lien,
 * passe le mot de passe s'il y en a un, prouve son adresse e-mail par un code
 * reçu par e-mail, puis consulte. Si l'accès le permet, il dépose aussi des
 * documents dans les dossiers et supprime ceux qu'il a déposés. Tout est relu
 * à chaque requête : désactiver l'accès, le faire expirer, fermer un dossier
 * ou retirer l'accès d'un visiteur agit immédiatement, y compris sur une
 * page déjà ouverte (temps réel : publicDocumentShareChanged).
 */
import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import DocumentShare from "../models/DocumentShare.js";
import SharedDocument from "../models/SharedDocument.js";
import { checkSubscriptionActive } from "../middlewares/rbac.js";
import { publishSharedDocsChanged } from "../resolvers/sharedDocument.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  findShareDocument,
  isVisitorUpload,
  listShareDocuments,
  openShareByToken,
} from "../services/documentShareAccess.js";
import {
  assertStorageAvailable,
  recordStoredFile,
  STORAGE_QUOTA_EXCEEDED,
} from "../services/storage/storageService.js";
import {
  checkClientUpload,
  cleanUploadedName,
  CLIENT_VIDEO_MAX_BYTES,
} from "../utils/clientUploadType.js";
import {
  consumeDocumentShareCode,
  issueDocumentShareCode,
  isValidVisitorEmail,
  normalizeVisitorEmail,
  workspaceDisplayIdentity,
} from "../services/documentShareVisitors.js";
import {
  streamDocumentDownload,
  streamDocumentPreview,
} from "../services/sharedDocumentFileResponse.js";
import { streamSelectionAsZip } from "../services/sharedDocumentZipService.js";
import { getAttemptCount, recordAttempt } from "../utils/attemptLimiter.js";
import {
  createDocumentShareAccessToken,
  createDocumentShareSession,
  readDocumentShareSession,
  verifyDocumentShareAccessToken,
} from "../utils/documentShareAccessToken.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Le fichier ne doit rester dans aucun cache : la révocation doit agir
const NO_STORE = "private, no-store";
const NAME_MAX_LENGTH = 60;
const MESSAGE_MAX_LENGTH = 500;

// Essais de mot de passe en échec tolérés sur 15 min, comme les tableaux
// partagés : par adresse IP, et par accès pour borner une attaque répartie
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

const formLimiter = limited(60);
// Un ZIP lit tous les fichiers des dossiers sur R2
const zipLimiter = limited(10);
// Dépôts et suppressions d'un client : un dossier de plusieurs dizaines de
// pièces passe, un envoi en rafale est arrêté
const depositLimiter = limited(200);

// Un fichier par envoi, gardé en mémoire le temps du contrôle puis de
// l'envoi vers R2 (la plus grande taille acceptée est celle d'une vidéo)
const receiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CLIENT_VIDEO_MAX_BYTES, files: 1, fields: 5 },
}).single("file");

router.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", NO_STORE);
  next();
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const text = (value, max) =>
  String(value ?? "")
    .trim()
    .slice(0, max);

/**
 * Accès existant, actif, non expiré, avec au moins un dossier ouvert.
 * Accès anticipé : lien introuvable tant que l'espace n'a pas la
 * fonctionnalité.
 */
async function loadOpenShare(req, res) {
  const opened = await openShareByToken(req.params.token);
  if (opened.status === 404) {
    res.status(404).json({ success: false, message: "Lien introuvable." });
    return null;
  }
  if (opened.status === 410) {
    res
      .status(410)
      .json({ success: false, message: "Ce lien n'est plus disponible." });
    return null;
  }
  return opened;
}

const sessionOf = (req) => req.body?.session ?? req.query.session;

function hasPasswordProof(req, share) {
  if (!share.passwordHash) return true;
  return verifyDocumentShareAccessToken(
    req.body?.access ?? req.query.access,
    share,
  );
}

/** Accès ouvert + mot de passe passé ; sinon répond 401. */
async function loadUnlockedShare(req, res) {
  const loaded = await loadOpenShare(req, res);
  if (!loaded) return null;
  if (!hasPasswordProof(req, loaded.share)) {
    res.status(401).json({
      success: false,
      requiresPassword: true,
      message: "Mot de passe requis",
    });
    return null;
  }
  return loaded;
}

/**
 * Accès ouvert + visiteur identifié (session valable, qui vaut aussi pour
 * le mot de passe). `allowBanned` : seulement pour redemander l'accès.
 */
async function loadVisitor(req, res, { allowBanned = false } = {}) {
  const loaded = await loadOpenShare(req, res);
  if (!loaded) return null;
  const email = readDocumentShareSession(sessionOf(req), loaded.share);
  if (!email) {
    res.status(401).json({
      success: false,
      requiresIdentity: true,
      message: "Identifiez-vous pour accéder aux documents",
    });
    return null;
  }
  if (!allowBanned && loaded.share.isBanned(email)) {
    res.status(403).json({
      success: false,
      banned: true,
      message: "Votre accès à ces documents a été retiré",
    });
    return null;
  }
  return { ...loaded, email };
}

const visitorView = (share, email) => {
  const visitor = share.visitors.find((v) => v.email === email);
  return {
    email,
    firstName: visitor?.firstName || "",
    lastName: visitor?.lastName || "",
  };
};

async function recordVisit(share, email) {
  const now = new Date();
  const counters = {
    $inc: { "stats.totalViews": 1 },
    $set: { "stats.lastViewedAt": now },
  };
  const { matchedCount } = await DocumentShare.updateOne(
    { _id: share._id, "visitors.email": email },
    {
      $inc: { ...counters.$inc, "visitors.$.visitCount": 1 },
      $set: { ...counters.$set, "visitors.$.lastVisitAt": now },
    },
  );
  if (matchedCount === 0) {
    await DocumentShare.updateOne(
      { _id: share._id },
      {
        ...counters,
        $push: {
          visitors: {
            email,
            firstVisitAt: now,
            lastVisitAt: now,
            visitCount: 1,
          },
        },
      },
    );
  }
}

const countUpload = (share, email) =>
  DocumentShare.updateOne(
    { _id: share._id, "visitors.email": email },
    {
      $inc: {
        "stats.totalUploads": 1,
        "visitors.$.uploadCount": 1,
      },
    },
  ).catch((error) => logger.warn(`Accès client : ${error.message}`));

const countDownload = (share, email) =>
  DocumentShare.updateOne(
    { _id: share._id, "visitors.email": email },
    {
      $inc: {
        "stats.totalDownloads": 1,
        "visitors.$.downloadCount": 1,
      },
    },
  ).catch((error) => logger.warn(`Accès client : ${error.message}`));

/** Document tel que le voit le visiteur : rien d'interne. */
const documentView = (document, email) => ({
  id: String(document._id),
  name: document.name,
  mimeType: document.mimeType,
  fileSize: document.fileSize,
  folderId: String(document.folderId),
  createdAt: document.createdAt,
  // Déposé par ce visiteur : il peut le supprimer
  mine: isVisitorUpload(document, email),
});

/**
 * GET /:token
 * État de la visite (`password`, `identify`, `banned`) ou, pour un visiteur
 * identifié, le contenu des dossiers. `refresh=1` : relecture de la page
 * ouverte (temps réel, après un dépôt), qui ne compte pas comme une visite.
 */
router.get("/:token", async (req, res) => {
  try {
    const loaded = await loadOpenShare(req, res);
    if (!loaded) return;
    const { share, folders } = loaded;
    const workspace = await workspaceDisplayIdentity(share.workspaceId);

    const email = readDocumentShareSession(req.query.session, share);
    if (!email) {
      return res.json({
        success: true,
        status: hasPasswordProof(req, share) ? "identify" : "password",
        workspace,
      });
    }

    if (share.isBanned(email)) {
      const request = [...share.accessRequests]
        .reverse()
        .find((r) => r.email === email);
      return res.json({
        success: true,
        status: "banned",
        workspace,
        visitor: visitorView(share, email),
        accessRequest: request ? request.status : null,
      });
    }

    const documents = await listShareDocuments(share, folders);
    if (req.query.refresh !== "1") await recordVisit(share, email);

    return res.json({
      success: true,
      status: "ready",
      workspace,
      name: share.name,
      expiresAt: share.expiresAt,
      allowUploads: Boolean(share.allowUploads),
      visitor: visitorView(share, email),
      rootFolderIds: folders.roots.map((folder) => String(folder._id)),
      folders: folders.folders.map((folder) => ({
        id: String(folder._id),
        name: folder.name,
        parentId: folder.parentId ? String(folder.parentId) : null,
        order: folder.order || 0,
        // Couleur choisie dans Newbi (page du visiteur au même visuel)
        color: HEX_COLOR.test(folder.color || "") ? folder.color : null,
      })),
      documents: documents.map((document) => documentView(document, email)),
    });
  } catch (error) {
    logger.error(`Accès client (consultation) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors du chargement" });
  }
});

/**
 * POST /:token/unlock { password }
 * Vérifie le mot de passe et remet le jeton qui ouvre l'identification.
 */
router.post("/:token/unlock", formLimiter, async (req, res) => {
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
    logger.error(`Accès client (mot de passe) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de la vérification" });
  }
});

/**
 * POST /:token/identify/code { email, access }
 * Envoie un code de vérification à l'adresse. Même réponse que l'adresse ait
 * déjà visité ou non : rien ne révèle qui a accès.
 */
router.post("/:token/identify/code", formLimiter, async (req, res) => {
  try {
    const loaded = await loadUnlockedShare(req, res);
    if (!loaded) return;
    const result = await issueDocumentShareCode(loaded.share, req.body?.email, {
      ip: req.ip,
    });
    if (!result.ok) {
      return res.status(result.reason === "rate_limited" ? 429 : 400).json({
        success: false,
        message:
          result.reason === "rate_limited"
            ? "Trop de demandes. Réessayez dans quelques minutes."
            : "Adresse e-mail invalide",
      });
    }
    return res.json({
      success: true,
      message: "Un code vous a été envoyé par e-mail",
    });
  } catch (error) {
    logger.error(`Accès client (envoi du code) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de l'envoi du code" });
  }
});

/**
 * POST /:token/identify/verify { email, code, access }
 * Vérifie le code et remet la session visiteur. Un visiteur dont l'accès a
 * été retiré la reçoit aussi, pour pouvoir redemander l'accès.
 */
router.post("/:token/identify/verify", formLimiter, async (req, res) => {
  try {
    const loaded = await loadUnlockedShare(req, res);
    if (!loaded) return;
    const { share } = loaded;
    const email = normalizeVisitorEmail(req.body?.email);
    if (
      !isValidVisitorEmail(email) ||
      !(await consumeDocumentShareCode(share, email, req.body?.code))
    ) {
      return res
        .status(401)
        .json({ success: false, message: "Code incorrect ou expiré" });
    }

    const now = new Date();
    const { matchedCount } = await DocumentShare.updateOne(
      { _id: share._id, "visitors.email": email },
      { $set: { "visitors.$.lastVisitAt": now } },
    );
    if (matchedCount === 0) {
      await DocumentShare.updateOne(
        { _id: share._id },
        {
          $push: {
            visitors: { email, firstVisitAt: now, lastVisitAt: now },
          },
        },
      );
    }
    const visitor = share.visitors.find((v) => v.email === email);

    return res.json({
      success: true,
      session: createDocumentShareSession(share, email),
      needsProfile: !visitor?.firstName && !visitor?.lastName,
    });
  } catch (error) {
    logger.error(`Accès client (vérification du code) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de la vérification" });
  }
});

/**
 * POST /:token/profile { session, firstName, lastName }
 * Nom du visiteur, demandé à sa première visite (affiché au propriétaire).
 */
router.post("/:token/profile", formLimiter, async (req, res) => {
  try {
    const loaded = await loadVisitor(req, res, { allowBanned: true });
    if (!loaded) return;
    await DocumentShare.updateOne(
      { _id: loaded.share._id, "visitors.email": loaded.email },
      {
        $set: {
          "visitors.$.firstName": text(req.body?.firstName, NAME_MAX_LENGTH),
          "visitors.$.lastName": text(req.body?.lastName, NAME_MAX_LENGTH),
        },
      },
    );
    return res.json({ success: true });
  } catch (error) {
    logger.error(`Accès client (profil) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de l'enregistrement" });
  }
});

/**
 * POST /:token/access-request { session, message }
 * Un visiteur dont l'accès a été retiré demande à le retrouver.
 */
router.post("/:token/access-request", formLimiter, async (req, res) => {
  try {
    const loaded = await loadVisitor(req, res, { allowBanned: true });
    if (!loaded) return;
    const { share, email } = loaded;
    if (!share.isBanned(email)) {
      return res
        .status(400)
        .json({ success: false, message: "Vous avez déjà accès" });
    }
    const visitor = visitorView(share, email);
    const name = [visitor.firstName, visitor.lastName]
      .filter(Boolean)
      .join(" ");
    // Une seule demande en attente par adresse
    const { modifiedCount } = await DocumentShare.updateOne(
      {
        _id: share._id,
        accessRequests: { $not: { $elemMatch: { email, status: "pending" } } },
      },
      {
        $push: {
          accessRequests: {
            email,
            name,
            message: text(req.body?.message, MESSAGE_MAX_LENGTH),
          },
        },
      },
    );
    return res.json({ success: true, alreadyPending: modifiedCount === 0 });
  } catch (error) {
    logger.error(`Accès client (demande d'accès) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de la demande" });
  }
});

/**
 * GET /:token/download-all?session=
 * Tous les dossiers de l'accès en un ZIP, sans branche privée ni corbeille.
 */
router.get("/:token/download-all", zipLimiter, async (req, res) => {
  try {
    const loaded = await loadVisitor(req, res);
    if (!loaded) return;
    const { share, folders, email } = loaded;
    await streamSelectionAsZip(
      {
        folderIds: folders.roots.map((folder) => String(folder._id)),
        workspaceId: String(share.workspaceId),
        canAccess: (folderId) => folders.folderIds.has(String(folderId)),
        zipName:
          folders.roots.length === 1
            ? folders.roots[0].name
            : share.name || "documents",
      },
      res,
    );
    await countDownload(share, email);
  } catch (error) {
    logger.error(`Accès client (ZIP) : ${error.message}`);
    if (!res.headersSent) {
      const empty = error.message === "Aucun document dans la sélection";
      res.status(empty ? 404 : 500).json({
        success: false,
        message: empty
          ? "Aucun document à télécharger"
          : "Erreur lors du téléchargement",
      });
    }
  }
});

async function loadVisitorDocument(req, res) {
  const loaded = await loadVisitor(req, res);
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
 * GET /:token/files/:documentId/preview?session=
 * GET /:token/files/:documentId/download?session=
 */
router.get("/:token/files/:documentId/preview", async (req, res) => {
  try {
    const loaded = await loadVisitorDocument(req, res);
    if (!loaded) return;
    // La page du visiteur (site) affiche l'aperçu par une balise <img>,
    // <video> ou <audio> pointée sur l'API, une autre origine : sans cela,
    // le « same-origin » posé par helmet fait bloquer l'image par le
    // navigateur. L'accès reste contrôlé par la session du visiteur.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    await streamDocumentPreview(loaded.document, res, {
      cacheControl: NO_STORE,
    });
  } catch (error) {
    logger.error(`Accès client (aperçu) : ${error.message}`);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Erreur lors de l'aperçu" });
    }
  }
});

router.get("/:token/files/:documentId/download", async (req, res) => {
  try {
    const loaded = await loadVisitorDocument(req, res);
    if (!loaded) return;
    await streamDocumentDownload(loaded.document, res, {
      cacheControl: NO_STORE,
    });
    await countDownload(loaded.share, loaded.email);
  } catch (error) {
    logger.error(`Accès client (téléchargement) : ${error.message}`);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ success: false, message: "Erreur lors du téléchargement" });
    }
  }
});

const UPLOADS_CLOSED = {
  success: false,
  message: "Le dépôt de documents n'est pas ouvert sur cet accès.",
};

/** Accès qui accepte les dépôts, pour un visiteur identifié. */
async function loadDepositor(req, res) {
  const loaded = await loadVisitor(req, res);
  if (!loaded) return null;
  if (!loaded.share.allowUploads) {
    res.status(403).json(UPLOADS_CLOSED);
    return null;
  }
  return loaded;
}

const parseUpload = (req, res) =>
  new Promise((resolve) => {
    receiveUpload(req, res, (error) => resolve(error || null));
  });

/**
 * POST /:token/folders/:folderId/files?session=  (multipart, champ « file »)
 * Le visiteur dépose un document dans un dossier de son accès. Il arrive
 * dans le dossier de l'espace comme un envoi d'un membre, compté dans son
 * stockage, et apparaît en temps réel chez les membres et les visiteurs.
 */
router.post(
  "/:token/folders/:folderId/files",
  depositLimiter,
  async (req, res) => {
    try {
      // Session lue dans l'adresse : le corps est le fichier
      const loaded = await loadDepositor(req, res);
      if (!loaded) return;
      const { share, folders, email } = loaded;
      const { folderId } = req.params;
      if (!folders.folderIds.has(String(folderId))) {
        return res
          .status(404)
          .json({ success: false, message: "Dossier introuvable." });
      }
      const workspaceId = String(share.workspaceId);
      try {
        await checkSubscriptionActive({ workspaceId });
      } catch {
        return res.status(403).json({
          success: false,
          message:
            "Cet espace ne peut pas recevoir de documents pour le moment.",
        });
      }

      const parseError = await parseUpload(req, res);
      if (parseError) {
        const tooLarge = parseError.code === "LIMIT_FILE_SIZE";
        return res.status(tooLarge ? 413 : 400).json({
          success: false,
          message: tooLarge
            ? `Fichier trop volumineux (${CLIENT_VIDEO_MAX_BYTES / 1024 / 1024} Mo maximum).`
            : "Envoi du fichier impossible.",
        });
      }
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "Aucun fichier reçu." });
      }

      const filename = cleanUploadedName(req.file.originalname);
      const buffer = req.file.buffer;
      const checked = checkClientUpload({ filename, buffer });
      if (!checked.ok) {
        return res
          .status(checked.status)
          .json({ success: false, message: checked.message });
      }

      try {
        await assertStorageAvailable(workspaceId, buffer.length);
      } catch (error) {
        if (error?.code !== STORAGE_QUOTA_EXCEEDED) throw error;
        return res.status(507).json({
          success: false,
          message:
            "L'espace de stockage de votre interlocuteur est plein : le document n'a pas pu être déposé.",
        });
      }

      const createdBy = String(share.createdBy);
      const stored = await cloudflareService.uploadImage(
        buffer,
        filename,
        createdBy,
        "sharedDocuments",
        workspaceId,
      );
      await recordStoredFile({
        workspaceId,
        key: stored.key,
        bucket: cloudflareService.sharedDocumentsBucketName,
        size: buffer.length,
        category: "sharedDocuments",
        userId: createdBy,
      });

      const visitor = visitorView(share, email);
      const visitorName = [visitor.firstName, visitor.lastName]
        .filter(Boolean)
        .join(" ");
      const document = await SharedDocument.create({
        name: filename,
        originalName: filename,
        fileUrl: stored.url,
        fileKey: stored.key,
        mimeType: checked.mime,
        fileSize: buffer.length,
        fileExtension: checked.extension,
        fileHash: crypto.createHash("sha256").update(buffer).digest("hex"),
        workspaceId: share.workspaceId,
        folderId,
        // Membre qui a ouvert l'accès ; le client est nommé à côté
        uploadedBy: share.createdBy,
        uploadedByName: `${visitorName || email} (client)`,
        status: "classified",
        isSharedWithAccountant: true,
        clientUpload: { shareId: share._id, email },
      });

      await countUpload(share, email);
      publishSharedDocsChanged(workspaceId, "CREATED", document._id);
      return res.status(201).json({
        success: true,
        document: documentView(document, email),
      });
    } catch (error) {
      logger.error(`Accès client (dépôt) : ${error.message}`);
      if (!res.headersSent) {
        return res
          .status(500)
          .json({ success: false, message: "Erreur lors du dépôt" });
      }
    }
  },
);

/**
 * DELETE /:token/files/:documentId?session=
 * Le visiteur retire un document qu'il a déposé. Il part dans la corbeille
 * de l'espace, d'où un membre peut le restaurer.
 */
router.delete("/:token/files/:documentId", depositLimiter, async (req, res) => {
  try {
    const loaded = await loadVisitorDocument(req, res);
    if (!loaded) return;
    const { share, email, document } = loaded;
    if (!share.allowUploads) return res.status(403).json(UPLOADS_CLOSED);
    if (!isVisitorUpload(document, email)) {
      return res.status(403).json({
        success: false,
        message:
          "Vous ne pouvez supprimer que les documents que vous avez déposés.",
      });
    }
    await SharedDocument.updateOne(
      { _id: document._id, trashedAt: null },
      { $set: { trashedAt: new Date(), originalFolderId: document.folderId } },
    );
    publishSharedDocsChanged(share.workspaceId, "DELETED", document._id);
    return res.json({ success: true });
  } catch (error) {
    logger.error(`Accès client (suppression) : ${error.message}`);
    return res
      .status(500)
      .json({ success: false, message: "Erreur lors de la suppression" });
  }
});

export default router;
