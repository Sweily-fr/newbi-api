import { oauthBindingCookieName } from "../../src/utils/oauthBrowserBinding.js";

/**
 * En-tête Cookie du navigateur qui a lancé le parcours OAuth du state
 * (cookie posé par /authorize, voir src/utils/oauthBrowserBinding.js).
 */
export function browserCookieFor(state) {
  try {
    const [encoded] = String(state).split(".");
    const { nonce } = JSON.parse(Buffer.from(encoded, "base64url").toString());
    return nonce ? `${oauthBindingCookieName(nonce)}=${nonce}` : "";
  } catch {
    return "";
  }
}
