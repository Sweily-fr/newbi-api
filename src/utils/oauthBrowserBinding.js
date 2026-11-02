// Retour OAuth lié au navigateur qui a lancé la connexion (Gmail, agendas).
//
// Le state signé prouve que le parcours a été lancé par un utilisateur
// Newbi, pas que c'est lui qui le termine : l'adresse d'autorisation du
// fournisseur, envoyée à quelqu'un d'autre, rattachait la boîte Gmail ou
// l'agenda de cette personne à l'espace de celui qui l'avait lancée. Le
// callback ne reçoit aucune session Newbi (redirection du fournisseur vers
// l'API, cookie de session posé par le site).
//
// À l'autorisation (requête du site vers l'API, avec credentials), l'API
// pose un cookie propre à ce parcours (HttpOnly, SameSite=Lax : renvoyé par
// le navigateur lors de la redirection du fournisseur, qui est une
// navigation de premier niveau). Au retour, le cookie doit être là et
// correspondre au state ; il est alors effacé.
import crypto from "crypto";

const COOKIE_PREFIX = "nb_oauth_";

export const oauthBindingCookieName = (nonce) =>
  `${COOKIE_PREFIX}${crypto
    .createHash("sha256")
    .update(String(nonce))
    .digest("hex")
    .slice(0, 16)}`;

const cookieOptions = (path, maxAgeMs) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path,
  ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
});

/** À l'autorisation : lie le parcours (nonce du state) à ce navigateur. */
export function bindOAuthToBrowser(res, { nonce, path, ttlMs }) {
  if (!nonce) throw new Error("nonce requis");
  res.cookie(
    oauthBindingCookieName(nonce),
    String(nonce),
    cookieOptions(path, ttlMs),
  );
}

const readCookie = (req, name) => {
  if (req.cookies && typeof req.cookies[name] === "string") {
    return req.cookies[name];
  }
  const header = req.headers?.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
};

/** Au retour : vrai si ce navigateur a lancé le parcours (cookie effacé). */
export function isOAuthBoundToBrowser(req, res, { nonce, path }) {
  if (!nonce) return false;
  const name = oauthBindingCookieName(nonce);
  const value = readCookie(req, name);
  if (res?.clearCookie) res.clearCookie(name, cookieOptions(path));
  if (typeof value !== "string" || value.length !== String(nonce).length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(String(nonce)));
}
