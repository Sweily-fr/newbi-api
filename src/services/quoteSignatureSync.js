import Quote from "../models/Quote.js";
import SignatureRequest from "../models/SignatureRequest.js";
import logger from "../utils/logger.js";
import documentAutomationService from "./documentAutomationService.js";
import { syncQuoteIfNeeded } from "./pennylaneSyncHelper.js";
import esignatureService from "./esignatureService.js";
import { publishSignatureStatus } from "./esignaturePubsub.js";

const ACTIVE_SIGNATURE_STATUSES = [
  "PENDING",
  "WAIT_VALIDATION",
  "WAIT_SIGN",
  "WAIT_SIGNER",
];

/**
 * Annule les demandes de signature encore actives d'un devis.
 *
 * Appelé quand le devis est accepté ou refusé manuellement : la décision est
 * prise, le client ne doit plus pouvoir signer. La demande est supprimée côté
 * provider (best effort) puis marquée CANCELLED en base.
 *
 * @param {string|object} quoteId - Identifiant du devis
 * @returns {Promise<number>} nombre de demandes annulées
 */
export async function cancelActiveQuoteSignatures(quoteId) {
  const activeRequests = await SignatureRequest.find({
    documentType: "quote",
    documentId: quoteId,
    status: { $in: ACTIVE_SIGNATURE_STATUSES },
  });

  for (const request of activeRequests) {
    if (request.externalSignatureId) {
      try {
        await esignatureService.deleteSignature(request.externalSignatureId);
      } catch (err) {
        logger.warn(
          `Annulation signature ${request._id}: suppression externe impossible: ${err.message}`,
        );
      }
    }
    request.status = "CANCELLED";
    await request.save();
    publishSignatureStatus(request);
    logger.info(
      `Signature ${request._id} annulée automatiquement (décision manuelle sur le devis ${quoteId})`,
    );
  }

  return activeRequests.length;
}

/**
 * Accepte automatiquement un devis lorsque sa demande de signature passe à DONE.
 *
 * Une signature signée par le CLIENT (SES ou QES_otp) vaut « bon pour accord » et fait
 * passer le devis en accepté. Le QES automatique (QES_automatic) est un cachet posé
 * automatiquement par la société sur son propre document : il certifie le document mais
 * ne vaut PAS acceptation du client, donc il n'accepte pas le devis.
 *
 * Centralisé ici pour être appelé à la fois par le webhook eSignature et par la
 * resynchronisation de statut côté resolver (utile en local sans webhook).
 *
 * @param {object} signatureRequest - Document SignatureRequest à jour
 * @returns {Promise<boolean>} true si le devis a été passé en COMPLETED
 */
export async function acceptQuoteOnSignature(signatureRequest) {
  if (
    !signatureRequest ||
    signatureRequest.documentType !== "quote" ||
    signatureRequest.signatureType === "QES_automatic" ||
    signatureRequest.status !== "DONE"
  ) {
    return false;
  }

  const quote = await Quote.findById(signatureRequest.documentId);
  if (!quote) {
    logger.warn(
      `Auto-acceptation devis: devis ${signatureRequest.documentId} introuvable`,
    );
    return false;
  }

  // Ne toucher qu'aux devis en attente / importés (pas aux COMPLETED/CANCELED/DRAFT)
  if (!["PENDING", "IMPORTED"].includes(quote.status)) {
    return false;
  }

  quote.status = "COMPLETED";
  await quote.save();
  logger.info(
    `Devis ${quote._id} (${quote.number || "?"}) auto-accepté suite à signature DONE`,
  );

  // Rejouer les mêmes effets de bord qu'une acceptation manuelle (fire-and-forget).
  const workspaceId = signatureRequest.workspaceId || quote.workspaceId;
  const userId = quote.createdBy ? quote.createdBy.toString() : null;

  documentAutomationService
    .executeAutomations(
      "QUOTE_ACCEPTED",
      workspaceId,
      {
        documentId: quote._id.toString(),
        documentType: "quote",
        documentNumber: quote.number,
        prefix: quote.prefix || "",
        clientName: quote.client?.name || "",
        issueDate: quote.issueDate || quote.createdAt,
        clientId: quote.client?._id || quote.clientId || null,
      },
      userId,
    )
    .catch((err) =>
      logger.error(`Auto-acceptation devis — automations: ${err.message}`),
    );

  syncQuoteIfNeeded(
    quote,
    signatureRequest.organizationId || workspaceId,
  ).catch((err) =>
    logger.error(`Auto-acceptation devis — sync Pennylane: ${err.message}`),
  );

  return true;
}

export default { acceptQuoteOnSignature, cancelActiveQuoteSignatures };
