import crypto from "crypto";

/**
 * Jeton prouvant qu'un téléchargement est déclenché par le propriétaire du
 * transfert depuis son tableau de bord.
 *
 * Les routes /api/files sont publiques (elles n'exigent que le secret de
 * partage, que le propriétaire détient aussi) : sans ce jeton, impossible d'y
 * distinguer le propriétaire d'un destinataire, et le propriétaire recevait
 * une notification pour son propre téléchargement. Un simple drapeau en query
 * ne conviendrait pas — un destinataire pourrait l'ajouter pour télécharger
 * sans laisser de trace. Le jeton est donc signé côté serveur et remis
 * uniquement à l'utilisateur authentifié propriétaire du transfert.
 */
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les jetons de téléchargement propriétaire",
    );
  }
  return secret;
}

function sign(transferId, userId, expiresAt) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`${transferId}:${userId}:${expiresAt}`)
    .digest("hex");
}

/**
 * @returns {string|null} jeton `<expiration>.<signature>`, null si non signable
 */
export function createOwnerDownloadToken(
  transferId,
  userId,
  ttlMs = DEFAULT_TTL_MS,
) {
  if (!transferId || !userId) return null;
  try {
    const expiresAt = Date.now() + ttlMs;
    return `${expiresAt}.${sign(String(transferId), String(userId), expiresAt)}`;
  } catch (error) {
    // Secret absent : on dégrade sans casser la lecture des transferts
    return null;
  }
}

/**
 * Vérifie qu'un jeton correspond bien au propriétaire déclaré du transfert.
 */
export function verifyOwnerDownloadToken(token, transferId, userId) {
  if (typeof token !== "string" || !transferId || !userId) return false;

  const [rawExpiresAt, signature] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  if (!signature) return false;

  try {
    const expected = sign(String(transferId), String(userId), expiresAt);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
