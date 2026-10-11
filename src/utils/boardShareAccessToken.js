import crypto from "crypto";
import { hasPasswordProtection } from "../models/PublicBoardShare.js";
import { getAttemptCount, recordAttempt } from "./attemptLimiter.js";

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
 * @param {object} [options]
 * @param {boolean} [options.allowExpired] - abonnement déjà ouvert : seul un
 *   changement de mot de passe (ou de partage) l'interrompt
 */
export function verifyBoardShareAccessToken(
  token,
  share,
  { allowExpired = false } = {},
) {
  const shareId = share?._id || share?.id;
  if (typeof token !== "string" || !shareId) return false;

  const [rawExpiresAt, signature] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  if (!allowExpired && expiresAt < Date.now()) return false;
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

// Essais de mot de passe en échec tolérés sur 15 min, comme
// /api/transfers/verify-password : par adresse IP, et par partage pour
// borner une attaque répartie sur plusieurs adresses
export const BOARD_SHARE_PASSWORD_WINDOW_SECONDS = 15 * 60;
export const BOARD_SHARE_PASSWORD_MAX_PER_IP = 20;
export const BOARD_SHARE_PASSWORD_MAX_PER_SHARE = 50;

const PROOF_MESSAGES = {
  required: "Mot de passe requis",
  incorrect: "Mot de passe incorrect",
  rate_limited: "Trop de tentatives. Réessayez dans quelques minutes.",
};

/**
 * Preuve d'accès exigée d'un visiteur pour un partage protégé : un jeton
 * remis par getPublicBoard, ou le mot de passe (essais en échec limités par
 * adresse IP et par partage). Toujours acquise pour un partage sans mot de
 * passe.
 * @param {object} share - document PublicBoardShare
 * @param {object} proof
 * @param {string} [proof.password]
 * @param {string} [proof.accessToken]
 * @param {string} [proof.ip] - adresse du client (compteur d'essais)
 * @returns {Promise<{ok: true}|{ok: false, reason: string, message: string}>}
 */
export async function checkBoardShareProof(
  share,
  { password, accessToken, ip } = {},
) {
  if (!hasPasswordProtection(share)) return { ok: true };
  if (verifyBoardShareAccessToken(accessToken, share)) return { ok: true };

  const deny = (reason) => ({
    ok: false,
    reason,
    message: PROOF_MESSAGES[reason],
  });
  if (!password) return deny("required");

  const ipKey = `board-share-password:ip:${ip || "inconnue"}`;
  const shareKey = `board-share-password:share:${share._id}`;
  const [ipAttempts, shareAttempts] = await Promise.all([
    getAttemptCount(ipKey),
    getAttemptCount(shareKey),
  ]);
  if (
    ipAttempts >= BOARD_SHARE_PASSWORD_MAX_PER_IP ||
    shareAttempts >= BOARD_SHARE_PASSWORD_MAX_PER_SHARE
  ) {
    return deny("rate_limited");
  }

  if (await share.verifyPassword(password)) return { ok: true };

  await Promise.all([
    recordAttempt(ipKey, BOARD_SHARE_PASSWORD_WINDOW_SECONDS),
    recordAttempt(shareKey, BOARD_SHARE_PASSWORD_WINDOW_SECONDS),
  ]);
  return deny("incorrect");
}
