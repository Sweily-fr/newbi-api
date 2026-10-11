import crypto from "crypto";
import { hasPasswordProtection } from "../models/PublicBoardShare.js";

/**
 * Jeton d'accès d'un visiteur à un tableau partagé protégé par mot de passe.
 *
 * getPublicBoard vérifie le mot de passe du partage, mais la subscription
 * publicTaskUpdated (tâches, commentaires et pièces jointes en temps réel)
 * ne demandait que le lien : elle contournait la protection. getPublicBoard
 * remet désormais ce jeton signé une fois le mot de passe vérifié ; la page
 * visiteur le renvoie à ses rechargements et à l'abonnement, sans garder le
 * mot de passe lui-même.
 */
export const BOARD_SHARE_ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les jetons d'accès aux tableaux partagés",
    );
  }
  return secret;
}

// Empreinte du mot de passe enregistré : le changer (ou le retirer puis le
// remettre) invalide les jetons déjà remis
function passwordFingerprint(share) {
  return crypto
    .createHash("sha256")
    .update(String(share?.passwordHash || share?.password || ""))
    .digest("hex")
    .slice(0, 32);
}

function sign(shareId, fingerprint, expiresAt) {
  // Préfixe dédié : un jeton d'une autre fonctionnalité ne peut pas servir ici
  return crypto
    .createHmac("sha256", getSecret())
    .update(`board-share-password:${shareId}:${fingerprint}:${expiresAt}`)
    .digest("hex");
}

/**
 * @returns {string|null} jeton `<expiration>.<signature>`, null si non signable
 */
export function createBoardShareAccessToken(
  share,
  ttlMs = BOARD_SHARE_ACCESS_TOKEN_TTL_MS,
) {
  const shareId = share?._id || share?.id;
  if (!shareId) return null;
  try {
    const expiresAt = Date.now() + ttlMs;
    const signature = sign(
      String(shareId),
      passwordFingerprint(share),
      expiresAt,
    );
    return `${expiresAt}.${signature}`;
  } catch {
    return null;
  }
}

/**
 * Vérifie qu'un jeton a été remis pour ce partage, avec son mot de passe
 * actuel, et n'a pas expiré.
 */
export function verifyBoardShareAccessToken(token, share) {
  const shareId = share?._id || share?.id;
  if (typeof token !== "string" || !shareId) return false;

  const [rawExpiresAt, signature] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  if (!signature) return false;

  try {
    const expected = sign(
      String(shareId),
      passwordFingerprint(share),
      expiresAt,
    );
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Preuve d'accès exigée d'un visiteur pour un partage protégé : le mot de
 * passe, ou un jeton remis par getPublicBoard. Toujours vraie pour un
 * partage sans mot de passe.
 */
export async function hasBoardShareAccess(share, { password, accessToken }) {
  if (!hasPasswordProtection(share)) return true;
  if (verifyBoardShareAccessToken(accessToken, share)) return true;
  return Boolean(password) && (await share.verifyPassword(password));
}
