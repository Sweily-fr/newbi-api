/**
 * Erreurs des fournisseurs de messagerie (Google, Microsoft), classées pour
 * le cron d'envoi :
 *
 *   AUTH       jeton refusé ou droit retiré (invalid_grant, 401, 403 hors
 *              quota) : boîte à reconnecter (EXPIRED) ;
 *   QUOTA      limite d'envoi du fournisseur atteinte (429, « quota
 *              exceeded ») : reprise au début de la plage du lendemain ;
 *   RECIPIENT  adresse refusée (400 sur le destinataire) : FAILED ;
 *   PERMANENT  message refusé pour une autre raison (400) : FAILED ;
 *   TEMPORARY  erreur passagère (réseau, 5xx) : nouvel essai, 3 au plus.
 */
export const PROVIDER_ERROR_KINDS = [
  "AUTH",
  "QUOTA",
  "RECIPIENT",
  "PERMANENT",
  "TEMPORARY",
];

export class MailProviderError extends Error {
  constructor(kind, message, { status = null, code = null } = {}) {
    super(message);
    this.name = "MailProviderError";
    this.kind = PROVIDER_ERROR_KINDS.includes(kind) ? kind : "TEMPORARY";
    this.status = status;
    this.code = code;
  }
}

export const isMailProviderError = (error) =>
  error instanceof MailProviderError || error?.name === "MailProviderError";

/** Corps JSON d'une réponse (null si illisible). */
export async function readJson(response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Appel réseau : une panne de connexion devient une erreur TEMPORARY. */
export async function request(url, options, label) {
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new MailProviderError(
      "TEMPORARY",
      `${label} injoignable : ${error?.message || "erreur réseau"}`,
    );
  }
}
