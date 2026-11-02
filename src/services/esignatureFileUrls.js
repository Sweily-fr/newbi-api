import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { signedDocumentsBucket } from "./esignatureDocuments.js";
import logger from "../utils/logger.js";

/** Durée de validité d'un lien vers un document de signature (1 heure). */
export const SIGNED_FILE_URL_TTL_SECONDS = 3600;

let client = null;
const r2Client = () => {
  client ||= new S3Client({
    region: "auto",
    endpoint: process.env.R2_API_URL,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
};

const KEY_FIELDS = {
  signedDocument: ["signedDocumentKey", "signedDocumentUrl"],
  auditTrail: ["auditTrailKey", "auditTrailUrl"],
};

/**
 * Adresse d'un document de signature pour l'affichage :
 *  - document rangé dans le bucket privé (clé) : URL présignée d'une heure ;
 *  - document plus ancien (adresse enregistrée sur la demande) : cette
 *    adresse, inchangée, pour qu'il reste lisible.
 * Le resolver appelant ne sert la demande qu'à une personne qui peut la voir.
 * @param {object|null} signatureRequest
 * @param {"signedDocument"|"auditTrail"} kind
 * @returns {Promise<string|null>}
 */
export async function signedFileUrl(signatureRequest, kind) {
  if (!signatureRequest) return null;
  const [keyField, legacyUrlField] = KEY_FIELDS[kind];
  const key = signatureRequest[keyField];
  if (!key) return signatureRequest[legacyUrlField] || null;
  try {
    return await getSignedUrl(
      r2Client(),
      new GetObjectCommand({
        Bucket: signatureRequest.documentsBucket || signedDocumentsBucket(),
        Key: key,
      }),
      { expiresIn: SIGNED_FILE_URL_TTL_SECONDS },
    );
  } catch (error) {
    logger.error(`URL du document de signature impossible: ${error.message}`);
    return null;
  }
}
