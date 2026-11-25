/**
 * Fournisseurs de boîte d'envoi de la prospection (GOOGLE, MICROSOFT) :
 * même interface pour les routes de connexion et le cron d'envoi.
 *
 *   getAuthUrl(state)                → adresse d'autorisation (promesse ou non)
 *   exchangeCode(code)               → { accessToken, refreshToken, expiresAt, scopes }
 *   getUserInfo(accessToken)         → { email, name }
 *   refreshAccessToken(refreshToken) → { accessToken, refreshToken, expiresAt, scopes }
 *   revokeToken(token)               → booléen (révocation au mieux)
 *   sendMessage({ accessToken, mime }) → { providerMessageId, threadId }
 *
 * Erreurs : MailProviderError (voir errors.js).
 */
import * as google from "./google.js";
import * as microsoft from "./microsoft.js";

export {
  MailProviderError,
  isMailProviderError,
  PROVIDER_ERROR_KINDS,
} from "./errors.js";

const PROVIDERS = { GOOGLE: google, MICROSOFT: microsoft };

export const PROVIDER_LABELS = { GOOGLE: "Gmail", MICROSOFT: "Outlook" };

/** Fournisseur d'une boîte (GOOGLE ou MICROSOFT). */
export function mailProvider(provider) {
  const found = PROVIDERS[provider];
  if (!found) throw new Error(`Fournisseur de boîte inconnu : ${provider}`);
  return found;
}

/**
 * Le droit d'envoi a-t-il été accordé ? Google laisse décocher chaque droit
 * à l'écran de consentement : sans gmail.send, la boîte ne servirait à
 * rien. Microsoft accorde tout ou rien (liste vide : rien à vérifier).
 */
export function hasSendScope(provider, scopes = []) {
  const list = (Array.isArray(scopes) ? scopes : []).map((s) =>
    String(s).toLowerCase(),
  );
  if (provider === "GOOGLE") {
    return list.includes(google.GOOGLE_SEND_SCOPE.toLowerCase());
  }
  if (!list.length) return true;
  return list.some((scope) => scope.endsWith("mail.send"));
}
