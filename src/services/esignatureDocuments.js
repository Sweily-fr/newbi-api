import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import esignatureService from "./esignatureService.js";
import logger from "../utils/logger.js";

/**
 * Upload un fichier vers R2 (bucket OCR, réutilisé pour les documents signés/cachetés)
 */
export async function uploadFileToR2(fileBuffer, key, contentType) {
  const client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_API_URL,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const command = new PutObjectCommand({
    Bucket: process.env.OCR_BUCKET,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await client.send(command);

  const publicUrl = process.env.OCR_URL;
  const cleanUrl = publicUrl?.endsWith("/")
    ? publicUrl.slice(0, -1)
    : publicUrl;
  return `${cleanUrl}/${key}`;
}

/**
 * Télécharge le document signé/cacheté + l'audit trail depuis l'API eSignature,
 * les stocke sur R2 et met à jour la SignatureRequest.
 *
 * Idempotent : ne fait rien si le document a déjà été récupéré.
 * Appelé par le webhook (cas prod) ET par la resync au read (utile en local).
 *
 * @param {object} signatureRequest - Document Mongoose SignatureRequest (status DONE)
 * @returns {Promise<boolean>} true si un document a été téléchargé et stocké
 */
export async function storeSignedDocuments(signatureRequest) {
  if (
    !signatureRequest ||
    signatureRequest.status !== "DONE" ||
    !signatureRequest.externalSignatureId
  ) {
    return false;
  }
  // Déjà récupéré → ne rien refaire
  if (signatureRequest.signedDocumentUrl) {
    return false;
  }

  try {
    const signedDocBuffer = await esignatureService.downloadSignedDocument(
      signatureRequest.externalSignatureId,
    );

    if (signedDocBuffer && Buffer.isBuffer(signedDocBuffer)) {
      const key = `esignature/${signatureRequest.organizationId}/${signatureRequest._id}/signed-${signatureRequest.documentNumber || signatureRequest.documentId}.pdf`;
      signatureRequest.signedDocumentUrl = await uploadFileToR2(
        signedDocBuffer,
        key,
        "application/pdf",
      );
    }

    // Audit trail (best-effort)
    try {
      const auditTrail = await esignatureService.downloadAuditTrail(
        signatureRequest.externalSignatureId,
      );
      if (auditTrail) {
        const isPdf = Buffer.isBuffer(auditTrail);
        const auditBuffer = isPdf
          ? auditTrail
          : Buffer.from(JSON.stringify(auditTrail));
        const auditKey = `esignature/${signatureRequest.organizationId}/${signatureRequest._id}/audit-trail.${isPdf ? "pdf" : "json"}`;
        signatureRequest.auditTrailUrl = await uploadFileToR2(
          auditBuffer,
          auditKey,
          isPdf ? "application/pdf" : "application/json",
        );
      }
    } catch (auditError) {
      logger.warn(
        `Impossible de télécharger l'audit trail: ${auditError.message}`,
      );
    }

    // Date de signature des signataires
    if (Array.isArray(signatureRequest.signers)) {
      signatureRequest.signers = signatureRequest.signers.map((signer) => ({
        ...(signer.toObject ? signer.toObject() : signer),
        signedAt: signer.signedAt || new Date(),
      }));
    }

    await signatureRequest.save();
    return true;
  } catch (error) {
    logger.error(
      `Erreur téléchargement document signé (${signatureRequest._id}): ${error.message}`,
    );
    return false;
  }
}

export default { uploadFileToR2, storeSignedDocuments };
