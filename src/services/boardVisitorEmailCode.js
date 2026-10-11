import crypto from "crypto";
import BoardVisitorCode from "../models/BoardVisitorCode.js";
import { Board } from "../models/kanban.js";
import { getAttemptCount, recordAttempt } from "../utils/attemptLimiter.js";
import { sendBoardVisitorCodeEmail } from "../utils/mailer.js";
import logger from "../utils/logger.js";

/**
 * Vérification de l'adresse e-mail d'un visiteur d'un tableau partagé :
 * code à 6 chiffres envoyé par e-mail, valable 10 minutes, 5 essais.
 */
export const VISITOR_CODE_TTL_MS = 10 * 60 * 1000;
export const VISITOR_CODE_MAX_ATTEMPTS = 5;
// Envois limités sur 15 min : par adresse et lien, et par adresse IP
export const VISITOR_CODE_WINDOW_SECONDS = 15 * 60;
export const VISITOR_CODE_MAX_SENDS_PER_EMAIL = 5;
export const VISITOR_CODE_MAX_SENDS_PER_IP = 20;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour les codes visiteur",
    );
  }
  return secret;
}

const hashCode = (shareId, email, code) =>
  crypto
    .createHmac("sha256", getSecret())
    .update(`board-visitor-code:${shareId}:${email}:${code}`)
    .digest("hex");

export const normalizeVisitorEmail = (email) =>
  String(email || "")
    .toLowerCase()
    .trim();

export const isValidVisitorEmail = (email) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * Envoie un nouveau code (remplace le précédent).
 * @returns {Promise<{ok: true}|{ok: false, reason: "invalid_email"|"rate_limited"}>}
 */
export async function issueVisitorEmailCode(share, rawEmail, { ip } = {}) {
  const email = normalizeVisitorEmail(rawEmail);
  if (!isValidVisitorEmail(email))
    return { ok: false, reason: "invalid_email" };

  const shareId = String(share._id);
  const emailKey = `board-visitor-code:email:${shareId}:${email}`;
  const ipKey = `board-visitor-code:ip:${ip || "inconnue"}`;
  const [emailSends, ipSends] = await Promise.all([
    getAttemptCount(emailKey),
    getAttemptCount(ipKey),
  ]);
  if (
    emailSends >= VISITOR_CODE_MAX_SENDS_PER_EMAIL ||
    ipSends >= VISITOR_CODE_MAX_SENDS_PER_IP
  ) {
    return { ok: false, reason: "rate_limited" };
  }
  await Promise.all([
    recordAttempt(emailKey, VISITOR_CODE_WINDOW_SECONDS),
    recordAttempt(ipKey, VISITOR_CODE_WINDOW_SECONDS),
  ]);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await BoardVisitorCode.findOneAndUpdate(
    { email, shareId: share._id },
    {
      $set: {
        codeHash: hashCode(shareId, email, code),
        attempts: 0,
        expiresAt: new Date(Date.now() + VISITOR_CODE_TTL_MS),
      },
    },
    { upsert: true },
  );

  const board = await Board.findById(share.boardId).select("title").lean();
  const sent = await sendBoardVisitorCodeEmail(email, {
    code,
    boardTitle: board?.title || share.name || "Tableau partagé",
  });
  if (!sent) {
    logger.warn(`[BoardVisitorCode] Envoi du code impossible à ${email}`);
  }
  return { ok: true };
}

/**
 * Vérifie et consomme un code. Faux si absent, expiré, incorrect ou après
 * trop d'essais (le code est alors invalidé).
 */
export async function consumeVisitorEmailCode(share, rawEmail, rawCode) {
  const email = normalizeVisitorEmail(rawEmail);
  const code = String(rawCode || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;

  const entry = await BoardVisitorCode.findOne({ email, shareId: share._id });
  if (!entry) return false;
  if (
    entry.expiresAt < new Date() ||
    entry.attempts >= VISITOR_CODE_MAX_ATTEMPTS
  ) {
    await entry.deleteOne();
    return false;
  }

  const expected = Buffer.from(entry.codeHash);
  const provided = Buffer.from(hashCode(String(share._id), email, code));
  const matches =
    expected.length === provided.length &&
    crypto.timingSafeEqual(expected, provided);

  if (!matches) {
    await BoardVisitorCode.updateOne(
      { _id: entry._id },
      { $inc: { attempts: 1 } },
    );
    return false;
  }

  // Usage unique : seule la suppression effective valide le code (deux
  // requêtes simultanées avec le même code n'en valident qu'une)
  const { deletedCount } = await BoardVisitorCode.deleteOne({
    _id: entry._id,
    codeHash: entry.codeHash,
  });
  return deletedCount === 1;
}
