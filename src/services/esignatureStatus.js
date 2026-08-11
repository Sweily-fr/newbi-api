import logger from "../utils/logger.js";

/**
 * Correspondance des états renvoyés par l'API eSignature (OpenAPI) vers nos
 * statuts internes. `WAIT_SIGNERS` (pluriel) est la forme réellement observée
 * en production pour une demande en attente du signataire ; `WAIT_SIGNER`
 * reste accepté, l'API ayant utilisé les deux.
 */
const STATUS_MAP = {
  WAIT_VALIDATION: "WAIT_VALIDATION",
  WAIT_SIGN: "WAIT_SIGN",
  WAIT_SIGNER: "WAIT_SIGNER",
  WAIT_SIGNERS: "WAIT_SIGNER",
  DONE: "DONE",
  ERROR: "ERROR",
};

/**
 * Mapper un état externe vers notre statut interne.
 *
 * Renvoie `null` — et surtout PAS "PENDING" — quand l'état est inconnu ou
 * absent : "PENDING" signifie « demande jamais confirmée côté fournisseur » et
 * autorise l'auto-annulation au renvoi (voir `requestDocumentSignature`).
 * Rétrograder une demande vivante vers PENDING la faisait supprimer chez
 * OpenAPI dès que l'utilisateur relançait l'envoi. L'appelant doit traiter
 * `null` comme « statut inchangé ».
 *
 * @param {string} externalState - État brut renvoyé par l'API
 * @returns {string|null} - Statut interne, ou null si l'état est inexploitable
 */
export function mapExternalStatus(externalState) {
  // Normaliser la casse : l'API peut renvoyer l'état en minuscules/casse mixte
  const key = String(externalState ?? "")
    .trim()
    .toUpperCase();
  const mapped = STATUS_MAP[key];

  if (!mapped) {
    logger.warn(
      `mapExternalStatus: état eSignature inconnu "${externalState}", statut inchangé`,
    );
    return null;
  }

  return mapped;
}

export default mapExternalStatus;
