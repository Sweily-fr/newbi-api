/**
 * Routes publiques des accès clients (documents partagés), sur le modèle du
 * partage d'un tableau kanban : sans compte Newbi, le visiteur ouvre le lien,
 * passe le mot de passe s'il y en a un, prouve son adresse e-mail par un code
 * reçu par e-mail, puis consulte. Tout est relu à chaque requête : désactiver
 * l'accès, le faire expirer, fermer un dossier ou retirer l'accès d'un
 * visiteur agit immédiatement, y compris sur une page déjà ouverte.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import DocumentShare from "../models/DocumentShare.js";
import {
  findShareDocument,
  listShareDocuments,
  loadShareFolders,
} from "../services/documentShareAccess.js";
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
import { isFeatureEnabled } from "../utils/featureAccess.js";

const router = express.Router();

const TOKEN_RE = /^[0-9a-f]{64}$/;
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

/** Accès existant, actif, non expiré, avec au moins un dossier ouvert. */
async function loadOpenShare(req, res) {
  const { token } = req.params;
  const share = TOKEN_RE.test(token)
    ? await DocumentShare.findOne({ token })
    : null;
  // Accès anticipé : lien introuvable tant que l'espace n'a pas la
  // fonctionnalité
  if (!share || !isFeatureEnabled("documentShares", share.workspaceId)) {
    res.status(404).json({ success: false, message: "Lien introuvable." });
    return null;
  }
  const folders = share.isValid() ? await loadShareFolders(share) : null;
  if (!folders) {
    res
      .status(410)
      .json({ success: false, message: "Ce lien n'est plus disponible." });
    return null;
  }
  return { share, folders };
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

/**
 * GET /:token
 * État de la visite (`password`, `identify`, `banned`) ou, pour un visiteur
 * identifié, le contenu des dossiers.
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
    await recordVisit(share, email);

    return res.json({
      success: true,
      status: "ready",
      workspace,
      name: share.name,
      expiresAt: share.expiresAt,
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

export default router;
