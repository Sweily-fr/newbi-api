import crypto from "crypto";
import mongoose from "mongoose";
import UserInvited from "../models/UserInvited.js";

/**
 * Session d'un visiteur d'un tableau kanban partagé par lien public.
 *
 * Jusqu'ici l'identité d'un visiteur était l'e-mail qu'il déclarait à chaque
 * appel (getPublicBoard, commentaires, profil, abonnement temps réel) : un
 * visiteur banni revenait sous une autre adresse, et n'importe qui pouvait
 * commenter sous l'adresse d'un autre. La session est désormais remise par
 * authenticateInvitedUser une fois l'adresse prouvée (code reçu par e-mail,
 * ou mot de passe d'un compte dont l'adresse a déjà été vérifiée), et
 * exigée par toutes les opérations visiteur.
 *
 * Jeton signé (HMAC-SHA256, secret serveur), sans état côté serveur pour
 * tenir sur plusieurs appareils : `v1.<userInvitedId>.<shareId>.<expiration>.<signature>`.
 * Lié à l'utilisateur invité, au lien de partage et à la version de session
 * de l'utilisateur (incrémentée à la déconnexion et au changement de mot de
 * passe, ce qui invalide toutes ses sessions).
 */
export const VISITOR_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERSION = "v1";

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les sessions visiteur",
    );
  }
  return secret;
}

function sign(userInvitedId, shareId, expiresAt, sessionVersion) {
  // Préfixe dédié : un jeton d'une autre fonctionnalité ne peut pas servir ici
  return crypto
    .createHmac("sha256", getSecret())
    .update(
      `board-visitor-session:${VERSION}:${userInvitedId}:${shareId}:${expiresAt}:${sessionVersion}`,
    )
    .digest("base64url");
}

/**
 * @param {object} userInvited - document UserInvited
 * @param {object} share - document PublicBoardShare
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function createVisitorSessionToken(
  userInvited,
  share,
  ttlMs = VISITOR_SESSION_TTL_MS,
) {
  const userInvitedId = String(userInvited._id || userInvited.id);
  const shareId = String(share._id || share.id);
  const expiresAt = Date.now() + ttlMs;
  const signature = sign(
    userInvitedId,
    shareId,
    expiresAt,
    userInvited.sessionVersion || 0,
  );
  return [VERSION, userInvitedId, shareId, expiresAt, signature].join(".");
}

function parse(token) {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) return null;
  const [, userInvitedId, shareId, rawExpiresAt, signature] = parts;
  const expiresAt = Number(rawExpiresAt);
  if (
    !mongoose.isValidObjectId(userInvitedId) ||
    !mongoose.isValidObjectId(shareId) ||
    !Number.isFinite(expiresAt) ||
    !signature
  ) {
    return null;
  }
  return { userInvitedId, shareId, expiresAt, signature };
}

/**
 * Utilisateur invité de la session, ou null (jeton absent, falsifié,
 * expiré, révoqué, ou remis pour un autre lien de partage).
 * @param {string} token
 * @param {object} [options]
 * @param {object} [options.share] - lien de partage attendu
 * @returns {Promise<object|null>} document UserInvited
 */
export async function resolveVisitorSession(token, { share } = {}) {
  const parsed = parse(token);
  if (!parsed) return null;
  if (parsed.expiresAt < Date.now()) return null;
  if (share && String(share._id || share.id) !== parsed.shareId) return null;

  const userInvited = await UserInvited.findById(parsed.userInvitedId);
  if (!userInvited) return null;

  let expected;
  try {
    expected = sign(
      parsed.userInvitedId,
      parsed.shareId,
      parsed.expiresAt,
      userInvited.sessionVersion || 0,
    );
  } catch {
    return null;
  }
  const a = Buffer.from(parsed.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userInvited;
}

/** Lien de partage d'une session (sans vérification de signature). */
export function visitorSessionShareId(token) {
  return parse(token)?.shareId || null;
}
