import { getPubSub } from "../config/redis.js";
import logger from "../utils/logger.js";

/**
 * Canal PubSub des mises à jour de statut de signature, scoppé par document.
 * Permet au front d'afficher le passage à « Signé » en temps réel sans polling.
 */
export const signatureChannel = (documentId) =>
  `SIGNATURE_STATUS_UPDATED_${documentId}`;

/**
 * Publie une mise à jour de statut de signature pour un document.
 * Best-effort : un échec PubSub ne doit jamais casser le flux de signature.
 *
 * @param {object} signatureRequest - Document SignatureRequest à jour
 */
export const publishSignatureStatus = (signatureRequest) => {
  if (!signatureRequest?.documentId) return;
  try {
    const documentId = signatureRequest.documentId.toString();
    getPubSub().publish(signatureChannel(documentId), {
      signatureStatusUpdated: {
        documentId,
        documentType: signatureRequest.documentType,
        status: signatureRequest.status,
        signatureType: signatureRequest.signatureType || null,
      },
    });
  } catch (err) {
    logger.warn(`publishSignatureStatus: ${err.message}`);
  }
};

export default { publishSignatureStatus, signatureChannel };
