import crypto from "crypto";

/**
 * Jetons des visiteurs d'un accès client, signés (HMAC, secret serveur), sans
 * état côté serveur :
 * - jeton du mot de passe : remis après le mot de passe, il ouvre seulement
 *   l'étape d'identification (12 h) ;
 * - session visiteur : remise une fois l'adresse e-mail prouvée, exigée par
 *   le contenu et les fichiers (30 jours). Elle est liée à l'accès, à
 *   l'adresse et au mot de passe actuel : le changer coupe toutes les
 *   sessions. Un visiteur dont l'accès a été retiré est refusé à chaque
 *   requête (liste relue en base).
 * Les fichiers s'ouvrent dans <img>, <video> ou par un lien de
 * téléchargement : les jetons voyagent donc en paramètre d'adresse.
 */
export const DOCUMENT_SHARE_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const DOCUMENT_SHARE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les jetons des accès clients",
    );
  }
  return secret;
}

const passwordFingerprint = (share) =>
  crypto
    .createHash("sha256")
    .update(String(share.passwordHash || ""))
    .digest("hex");

// Préfixes dédiés : un jeton d'une autre fonctionnalité ne peut pas servir ici
const hmac = (payload) =>
  crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");

const sameSignature = (given, expected) => {
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const signAccess = (share, expiresAt) =>
  hmac(
    `document-share-password:${share._id}:${passwordFingerprint(share)}:${expiresAt}`,
  );

/** @returns {string} jeton `<expiration>.<signature>` */
export function createDocumentShareAccessToken(share) {
  const expiresAt = Date.now() + DOCUMENT_SHARE_ACCESS_TTL_MS;
  return `${expiresAt}.${signAccess(share, expiresAt)}`;
}

export function verifyDocumentShareAccessToken(token, share) {
  if (typeof token !== "string" || token.length > 256) return false;
  const [rawExpiresAt, signature] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return false;
  }
  return sameSignature(signature, signAccess(share, expiresAt));
}

const signSession = (share, email, expiresAt) =>
  hmac(
    `document-share-visitor:v1:${share._id}:${email}:${passwordFingerprint(share)}:${expiresAt}`,
  );

/** @returns {string} `v1.<adresse en base64url>.<expiration>.<signature>` */
export function createDocumentShareSession(share, email) {
  const expiresAt = Date.now() + DOCUMENT_SHARE_SESSION_TTL_MS;
  return [
    "v1",
    Buffer.from(email).toString("base64url"),
    expiresAt,
    signSession(share, email, expiresAt),
  ].join(".");
}

/** Adresse du visiteur de la session, ou null (falsifiée, expirée, autre accès). */
export function readDocumentShareSession(token, share) {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, rawEmail, rawExpiresAt, signature] = parts;
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const email = Buffer.from(rawEmail, "base64url").toString("utf8");
  if (!email) return null;
  return sameSignature(signature, signSession(share, email, expiresAt))
    ? email
    : null;
}
