/**
 * Transport HTTP commun aux API officielles des réseaux (Meta, LinkedIn,
 * TikTok, X) et erreur normalisée.
 *
 * Aucun jeton ni adresse complète n'apparaît dans les messages d'erreur :
 * seulement le réseau, la méthode et le chemin (les jetons voyagent parfois
 * dans la chaîne de requête, chez Meta).
 */

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * Erreur d'une API de réseau, déjà classée :
 * - kind : "config" (identifiants absents), "timeout", "network", "http",
 *   "auth" (jeton invalide et non rafraîchissable) ;
 * - category : errorCategory de la cible (voir socialPostMessages.js) ;
 * - transient : on peut réessayer plus tard sans rien changer ;
 * - authInvalid : jeton expiré ou révoqué (le compte doit être reconnecté,
 *   sauf si un rafraîchissement le sauve).
 */
export class DirectApiError extends Error {
  constructor(
    message,
    {
      network = null,
      kind = "http",
      status = null,
      code = null,
      subcode = null,
      category = null,
      transient = false,
      authInvalid = false,
      retryAfterMs = null,
      detail = null,
    } = {},
  ) {
    super(message);
    this.name = "DirectApiError";
    this.network = network;
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.category = category;
    this.transient = transient;
    this.authInvalid = authInvalid;
    this.retryAfterMs = retryAfterMs;
    // Message du réseau, gardé pour l'affichage (contenu refusé)
    this.detail = detail;
  }
}

/** Attente, remplaçable dans les tests (timing.sleep = async () => {}). */
export const timing = {
  sleep: (ms) =>
    ms > 0
      ? new Promise((resolve) => setTimeout(resolve, ms))
      : Promise.resolve(),
};

export const readHeader = (response, name) => {
  try {
    return response?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
};

const describe = (method, url) => {
  try {
    return `${method} ${new URL(url).pathname}`;
  } catch {
    return method;
  }
};

/**
 * Appel HTTP avec délai maximal. Le corps est du JSON (json), un formulaire
 * (form, x-www-form-urlencoded) ou un corps déjà prêt (body : FormData,
 * Buffer).
 *
 * @param {object} options
 * @param {string} options.network - « meta », « linkedin », « tiktok », « x »
 * @param {(response: object, data: any) => (DirectApiError|null)} options.check
 *   classe la réponse : une erreur à lever, ou null si tout va bien
 * @returns {Promise<{status: number, data: any, response: object}>}
 */
export async function directRequest({
  network,
  method = "GET",
  url,
  query,
  headers = {},
  json,
  form,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  check,
}) {
  const target = new URL(url);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  });
  const label = describe(method, target.toString());

  let payload = body;
  const finalHeaders = { Accept: "application/json", ...headers };
  if (json !== undefined) {
    payload = JSON.stringify(json);
    finalHeaders["Content-Type"] = "application/json; charset=UTF-8";
  } else if (form !== undefined) {
    const params = new URLSearchParams();
    Object.entries(form).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    });
    payload = params.toString();
    finalHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetch(target.toString(), {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const timedOut = error?.name === "AbortError" || controller.signal.aborted;
    throw new DirectApiError(
      timedOut
        ? `${network} ${label} : délai dépassé (${timeoutMs} ms)`
        : `${network} ${label} : ${error?.message || "erreur réseau"}`,
      { network, kind: timedOut ? "timeout" : "network", transient: true },
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 300) };
    }
  }

  const error = check ? check(response, data, label) : null;
  if (error) throw error;
  if (!response.ok) {
    // Filet : réponse en erreur que check n'a pas su classer
    throw new DirectApiError(`${network} ${label} : HTTP ${response.status}`, {
      network,
      status: response.status,
      transient: response.status >= 500 || response.status === 429,
      category: response.status === 429 ? "platform_rate_limit" : null,
    });
  }
  return { status: response.status, data, response };
}

/** Erreur passagère générique d'un réseau (5xx, réponse illisible). */
export const transientError = (network, message, status = null) =>
  new DirectApiError(message, { network, status, transient: true });

/** Configuration absente : le réseau en direct est indisponible. */
export const configError = (network, message) =>
  new DirectApiError(message, { network, kind: "config" });
