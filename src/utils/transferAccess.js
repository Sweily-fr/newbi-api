import { verifyOwnerDownloadToken } from "./ownerDownloadToken.js";
import { verifyTransferAccessToken } from "./transferAccessToken.js";

/**
 * Contrôles d'accès communs aux routes publiques d'un transfert
 * (téléchargement unitaire, ZIP, URL signées, aperçus).
 *
 * Le secret de partage (shareLink + accessKey) reste vérifié par chaque
 * route. S'y ajoutent ici, pour un destinataire : le paiement, le mot de
 * passe (jeton remis par verify-password) et le filigrane, qui interdit le
 * téléchargement. Le propriétaire (ownerDownloadToken, remis par l'API à
 * l'utilisateur authentifié qui a créé le transfert) n'est soumis à aucun
 * des trois.
 */

/** Jeton propriétaire transmis en query (navigation, mobile) ou en header. */
export function getOwnerTokenFromRequest(req) {
  return req?.query?.ownerToken || req?.headers?.["x-owner-download-token"];
}

export function isTransferOwnerRequest(fileTransfer, req) {
  if (!fileTransfer?._id) return false;
  return verifyOwnerDownloadToken(
    getOwnerTokenFromRequest(req),
    fileTransfer._id,
    fileTransfer.userId,
  );
}

/** Jeton mot de passe transmis en query, en header ou dans le corps. */
export function getTransferAccessTokenFromRequest(req) {
  const token =
    req?.query?.accessToken ||
    req?.headers?.["x-transfer-access-token"] ||
    req?.body?.accessToken;
  return typeof token === "string" ? token : null;
}

export const TRANSFER_ACCESS_ERRORS = {
  PAYMENT_REQUIRED: {
    status: 402,
    code: "PAYMENT_REQUIRED",
    error: "Paiement requis",
  },
  PASSWORD_REQUIRED: {
    status: 401,
    code: "PASSWORD_REQUIRED",
    error: "Mot de passe requis pour accéder à ce transfert",
  },
  DOWNLOAD_BLOCKED: {
    status: 403,
    code: "DOWNLOAD_BLOCKED",
    error:
      "Les fichiers de ce transfert sont protégés par un filigrane et ne peuvent pas être téléchargés.",
  },
};

/**
 * @param {object} fileTransfer - document FileTransfer (secret déjà vérifié)
 * @param {object} req - requête Express
 * @param {object} [options]
 * @param {"download"|"preview"} [options.usage] - un aperçu reste permis
 *   malgré le filigrane (il est affiché par-dessus)
 * @param {boolean} [options.payment] - false si la route gère déjà le
 *   paiement elle-même
 * @returns {null|{status: number, code: string, error: string}} null si
 *   l'accès est permis
 */
export function checkTransferRecipientAccess(
  fileTransfer,
  req,
  { usage = "download", payment = true } = {},
) {
  if (isTransferOwnerRequest(fileTransfer, req)) return null;

  if (payment && fileTransfer.isPaymentRequired && !fileTransfer.isPaid) {
    return TRANSFER_ACCESS_ERRORS.PAYMENT_REQUIRED;
  }

  if (
    fileTransfer.passwordProtected &&
    !verifyTransferAccessToken(
      getTransferAccessTokenFromRequest(req),
      fileTransfer,
    )
  ) {
    return TRANSFER_ACCESS_ERRORS.PASSWORD_REQUIRED;
  }

  if (usage === "download" && fileTransfer.hasWatermark) {
    return TRANSFER_ACCESS_ERRORS.DOWNLOAD_BLOCKED;
  }

  return null;
}

// Retire l'UUID de stockage en tête des anciens noms :
// xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_
const STORAGE_UUID_PREFIX =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_/i;
const cleanFileName = (fileName) =>
  fileName ? fileName.replace(STORAGE_UUID_PREFIX, "") : fileName;

/**
 * Fichiers d'un transfert tels qu'exposés aux destinataires. Jamais
 * l'adresse de stockage (URL publique du bucket ou URL signée 24 h, clé
 * R2) : elle permettait de télécharger sans mot de passe, malgré le
 * filigrane et sans payer. Les destinataires passent par les routes de
 * l'API (/api/files/download, /api/files/preview, ZIP).
 */
export function toPublicTransferFiles(fileTransfer) {
  return (fileTransfer?.files || []).map((file) => {
    const raw = typeof file.toObject === "function" ? file.toObject() : file;
    return {
      id: String(raw._id || raw.id),
      fileId: raw.fileId || null,
      fileName: raw.fileName,
      originalName: cleanFileName(raw.originalName),
      displayName: cleanFileName(raw.displayName || raw.originalName),
      mimeType: raw.mimeType,
      size: raw.size,
      storageType: raw.storageType || null,
      uploadedAt: raw.uploadedAt || null,
      filePath: "",
      downloadUrl: null,
      r2Key: null,
    };
  });
}
