import crypto from "crypto";
import FileTransfer from "../models/FileTransfer.js";
import TransferDownloadLock from "../models/TransferDownloadLock.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import { sendDownloadNotificationEmail } from "../utils/mailer.js";
import { verifyOwnerDownloadToken } from "../utils/ownerDownloadToken.js";

// Fenêtre de validité du verrou lorsqu'une session de téléchargement est
// fournie : l'identifiant étant unique par clic, elle sert seulement à borner
// la durée d'un téléchargement (streaming de très gros fichiers compris).
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Fenêtre de repli, sur empreinte du téléchargeur, quand aucune session n'est
// transmise (téléchargement direct hors interface, ZIP natif). Assez large
// pour couvrir une session de téléchargement, assez courte pour ne pas avaler
// le téléchargement d'un autre destinataire.
const FINGERPRINT_WINDOW_MS = 10 * 60 * 1000;

function getClientIp(req) {
  return (
    req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req?.ip ||
    req?.connection?.remoteAddress ||
    "unknown"
  );
}

/**
 * Empreinte du téléchargeur : IP + user agent. Hachée pour ne pas stocker de
 * PII dans une collection technique.
 */
function buildFingerprint(req) {
  const raw = `${getClientIp(req)}|${req?.headers?.["user-agent"] || ""}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Identifiant de session émis par la page publique à chaque clic de
 * téléchargement, transmis en query (navigation mobile) ou en header.
 */
function getSessionId(req, explicitSessionId) {
  const raw =
    explicitSessionId ||
    req?.body?.downloadSessionId ||
    req?.query?.session ||
    req?.headers?.["x-download-session"];
  if (typeof raw !== "string") return null;
  // Borné et normalisé : la valeur entre dans une clé d'index
  const cleaned = raw.trim().slice(0, 64);
  return /^[a-zA-Z0-9._-]+$/.test(cleaned) ? cleaned : null;
}

/**
 * Le propriétaire téléchargeant depuis son tableau de bord ne doit ni gonfler
 * le compteur (qui mesure les téléchargements des destinataires) ni recevoir
 * une notification de son propre téléchargement. Le jeton est signé et remis
 * au seul propriétaire authentifié (voir ownerDownloadToken).
 */
function isOwnerDownload(fileTransfer, req) {
  const token =
    req?.query?.ownerToken || req?.headers?.["x-owner-download-token"];
  return verifyOwnerDownloadToken(token, fileTransfer._id, fileTransfer.userId);
}

/**
 * Pose le verrou du téléchargement. Retourne true si l'appelant est le premier
 * à le traiter, false s'il a déjà été comptabilisé et notifié.
 *
 * L'opération est atomique côté MongoDB (upsert conditionnel + index unique) :
 * elle reste correcte avec les 4 workers PM2 et les fichiers téléchargés en
 * parallèle au sein d'une même session.
 */
async function acquireDownloadLock(key, windowMs) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);

  // Filet de sécurité si l'index unique n'est pas encore construit au démarrage :
  // l'atomicité repose sur lui, cette lecture couvre le cas non concurrent.
  const existing = await TransferDownloadLock.findOne({ key }).lean();
  if (existing && existing.notifiedAt >= cutoff) {
    return false;
  }

  try {
    await TransferDownloadLock.findOneAndUpdate(
      { key, notifiedAt: { $lt: cutoff } },
      { $set: { notifiedAt: now } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    // E11000 : un verrou valide existe déjà, l'upsert a tenté un insert en
    // doublon — c'est le cas nominal du deuxième endpoint traversé.
    if (error?.code === 11000) {
      return false;
    }
    throw error;
  }
}

/**
 * Nom affiché dans le mail, identique quel que soit l'endpoint d'origine :
 * le nom du fichier si le transfert n'en contient qu'un, sinon le nombre.
 */
function buildDisplayName(fileTransfer, fallbackFileName) {
  const files = fileTransfer.files || [];
  if (files.length > 1) {
    return `${files.length} fichiers`;
  }
  return files[0]?.originalName || fallbackFileName || "Vos fichiers";
}

async function sendOwnerNotification(fileTransfer, fileName) {
  const owner = await User.findById(fileTransfer.userId);
  if (!owner?.email) return false;

  await sendDownloadNotificationEmail(owner.email, {
    fileName: buildDisplayName(fileTransfer, fileName),
    downloadDate: new Date(),
    filesCount: (fileTransfer.files || []).length,
    shareLink: fileTransfer.shareLink,
    transferUrl: `${process.env.FRONTEND_URL}/dashboard/outils/transferts-fichiers`,
  });

  logger.info("📧 Notification de téléchargement envoyée", {
    transferId: String(fileTransfer._id),
    ownerEmail: owner.email,
  });
  return true;
}

/**
 * Comptabilise un téléchargement de transfert et notifie le propriétaire si
 * l'option est activée.
 *
 * À appeler depuis TOUS les chemins de téléchargement : la déduplication est
 * gérée ici, pas par l'appelant, de sorte qu'un clic de l'utilisateur vaut
 * exactement un incrément et une notification, quel que soit le nombre de
 * fichiers servis. Ne lève jamais — un mail raté ne doit pas casser un
 * téléchargement.
 *
 * @returns {Promise<{counted: boolean, notified: boolean}>}
 */
export async function registerTransferDownload(
  fileTransfer,
  { req, fileName, sessionId } = {},
) {
  const result = { counted: false, notified: false, isOwner: false };

  try {
    if (!fileTransfer?._id) return result;

    if (isOwnerDownload(fileTransfer, req)) {
      result.isOwner = true;
      logger.debug?.(
        "📥 Téléchargement par le propriétaire, non comptabilisé",
        {
          transferId: String(fileTransfer._id),
        },
      );
      return result;
    }

    const session = getSessionId(req, sessionId);
    const key = `${fileTransfer._id}:${session || buildFingerprint(req)}`;
    const windowMs = session ? SESSION_WINDOW_MS : FINGERPRINT_WINDOW_MS;

    if (!(await acquireDownloadLock(key, windowMs))) {
      logger.debug?.("📥 Téléchargement déjà comptabilisé", {
        transferId: String(fileTransfer._id),
      });
      return result;
    }

    // $inc atomique plutôt qu'un save() sur le document : plusieurs
    // téléchargements du même transfert peuvent être traités simultanément
    // par des workers différents.
    await FileTransfer.updateOne(
      { _id: fileTransfer._id },
      { $inc: { downloadCount: 1 }, $set: { lastDownloadDate: new Date() } },
    );
    result.counted = true;

    if (fileTransfer.notifyOnDownload) {
      result.notified = await sendOwnerNotification(fileTransfer, fileName);
    }

    return result;
  } catch (error) {
    logger.error("❌ Erreur enregistrement téléchargement:", error);
    return result;
  }
}

export default { registerTransferDownload };
