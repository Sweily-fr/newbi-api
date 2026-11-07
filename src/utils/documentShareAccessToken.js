import crypto from "crypto";

/**
 * Jeton remis à un visiteur après le mot de passe d'un lien client : les
 * fichiers s'ouvrent dans <img>, <video> ou par un lien de téléchargement,
 * qui ne peuvent pas renvoyer le mot de passe. Il est lié au lien et à son
 * mot de passe actuel : le changer invalide les jetons déjà remis.
 */
export const DOCUMENT_SHARE_ACCESS_TTL_MS = 12 * 60 * 60 * 1000;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les jetons d'accès aux liens clients",
    );
  }
  return secret;
}

function sign(share, expiresAt) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(String(share.passwordHash || ""))
    .digest("hex");
  // Préfixe dédié : un jeton d'une autre fonctionnalité ne peut pas servir ici
  return crypto
    .createHmac("sha256", getSecret())
    .update(`document-share-password:${share._id}:${fingerprint}:${expiresAt}`)
    .digest("hex");
}

/** @returns {string} jeton `<expiration>.<signature>` */
export function createDocumentShareAccessToken(share) {
  const expiresAt = Date.now() + DOCUMENT_SHARE_ACCESS_TTL_MS;
  return `${expiresAt}.${sign(share, expiresAt)}`;
}

export function verifyDocumentShareAccessToken(token, share) {
  if (typeof token !== "string") return false;
  const [rawExpiresAt, signature] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return false;
  }
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(share, expiresAt));
  return (
    given.length === expected.length && crypto.timingSafeEqual(given, expected)
  );
}
