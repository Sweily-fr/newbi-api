/**
 * Erreurs des fournisseurs de messagerie (Google, Microsoft), classées pour
 * le cron d'envoi :
 *
 *   AUTH       jeton refusé ou droit retiré (invalid_grant, invalid_client,
 *              401, 403 hors quota) : boîte à reconnecter (EXPIRED) ;
 *   QUOTA      limite d'envoi du fournisseur atteinte (429, « quota
 *              exceeded ») : reprise au début de la plage du lendemain ;
 *   ACCOUNT    refus propre au compte, pas au message (Gmail désactivé,
 *              « Precondition check failed », MIME refusé par Graph…) :
 *              boîte en pause, aucun destinataire en échec ;
 *   RECIPIENT  adresse refusée (400 sur le destinataire) : FAILED ;
 *   PERMANENT  message refusé pour une autre raison (400) : FAILED ;
 *   TEMPORARY  erreur passagère, rien n'est parti (5xx, serveur
 *              injoignable) : nouvel essai, 3 au plus ;
 *   UNCERTAIN  le message a pu partir (coupure en plein échange, délai
 *              dépassé, 502/504 à l'envoi) : jamais de nouvel essai.
 */
export const PROVIDER_ERROR_KINDS = [
  "AUTH",
  "QUOTA",
  "ACCOUNT",
  "RECIPIENT",
  "PERMANENT",
  "TEMPORARY",
  "UNCERTAIN",
];

/** Délai d'un appel à un fournisseur : un appel bloqué ne fige pas le cron. */
export const PROVIDER_TIMEOUT_MS = 30 * 1000;

// Panne avant tout échange avec le serveur : la requête n'est pas partie
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

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

/**
 * Appel réseau borné à 30 secondes. Panne avant tout échange : erreur
 * TEMPORARY ; pour un envoi (`sending`), une coupure en plein échange ou un
 * délai dépassé laisse le message peut-être parti : erreur UNCERTAIN.
 */
export async function request(
  url,
  options = {},
  label,
  { sending = false } = {},
) {
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || "");
    const timeout =
      error?.name === "TimeoutError" || error?.name === "AbortError";
    const uncertain = sending && (timeout || !NOT_SENT_CODES.has(code));
    throw new MailProviderError(
      uncertain ? "UNCERTAIN" : "TEMPORARY",
      `${label} ${timeout ? "sans réponse" : "injoignable"} : ${error?.message || "erreur réseau"}`,
      { code: code || null },
    );
  }
}

/** Promesse bornée (appels de MSAL, qui ne reçoivent pas de signal). */
export function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new MailProviderError("TEMPORARY", `${label} sans réponse`, {
              code: "TIMEOUT",
            }),
          ),
        PROVIDER_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
