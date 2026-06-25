import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import esignatureService from "./esignatureService.js";
import { buildProofCertificatePdf } from "./esignatureCertificate.js";
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
        const baseKey = `esignature/${signatureRequest.organizationId}/${signatureRequest._id}`;

        if (Buffer.isBuffer(auditTrail)) {
          // Le provider a déjà renvoyé un PDF : on le stocke tel quel.
          signatureRequest.auditTrailUrl = await uploadFileToR2(
            auditTrail,
            `${baseKey}/audit-trail.pdf`,
            "application/pdf",
          );
        } else {
          // L'audit est un JSON (preuve technique). On archive le JSON brut ET on
          // génère un certificat PDF lisible, présentable au client.
          await uploadFileToR2(
            Buffer.from(JSON.stringify(auditTrail)),
            `${baseKey}/audit-trail.json`,
            "application/json",
          );

          try {
            const certificatePdf = await buildProofCertificatePdf(auditTrail, {
              documentNumber: signatureRequest.documentNumber,
              companyName: auditTrail?.data?.creatorData?.name,
            });
            signatureRequest.auditTrailUrl = await uploadFileToR2(
              certificatePdf,
              `${baseKey}/certificat-signature.pdf`,
              "application/pdf",
            );
          } catch (certError) {
            logger.error(
              `Génération certificat de preuve échouée: ${certError.message}`,
            );
          }
        }
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
