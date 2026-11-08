/**
 * Identification des visiteurs d'un accès client : code à 6 chiffres envoyé
 * par e-mail, valable 10 minutes, 5 essais, comme pour un tableau kanban
 * partagé (services/boardVisitorEmailCode.js).
 */
import crypto from "crypto";
import mongoose from "mongoose";
import DocumentShareVisitorCode from "../models/DocumentShareVisitorCode.js";
import {
  isValidVisitorEmail,
  normalizeVisitorEmail,
} from "./boardVisitorEmailCode.js";
import { getAttemptCount, recordAttempt } from "../utils/attemptLimiter.js";
import { sendDocumentShareCodeEmail } from "../utils/documentShareEmails.js";

export { isValidVisitorEmail, normalizeVisitorEmail };

export const VISITOR_CODE_TTL_MS = 10 * 60 * 1000;
export const VISITOR_CODE_MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;
const MAX_SENDS_PER_EMAIL = 5;
const MAX_SENDS_PER_IP = 20;

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
    .update(`document-share-code:${shareId}:${email}:${code}`)
    .digest("hex");

/** Nom affiché de l'espace (expéditeur des documents). */
export async function workspaceDisplayIdentity(workspaceId) {
  const organization = await mongoose.connection.db
    .collection("organization")
    .findOne(
      { _id: new mongoose.Types.ObjectId(String(workspaceId)) },
      { projection: { name: 1, companyName: 1, logo: 1 } },
    );
  return {
    name: organization?.companyName || organization?.name || "",
    logo: organization?.logo || null,
  };
}

/**
 * Envoie un nouveau code (remplace le précédent).
 * @returns {Promise<{ok: true}|{ok: false, reason: "invalid_email"|"rate_limited"}>}
 */
export async function issueDocumentShareCode(share, rawEmail, { ip } = {}) {
  const email = normalizeVisitorEmail(rawEmail);
  if (!isValidVisitorEmail(email))
    return { ok: false, reason: "invalid_email" };

  const shareId = String(share._id);
  const emailKey = `document-share-code:email:${shareId}:${email}`;
  const ipKey = `document-share-code:ip:${ip || "inconnue"}`;
  const [emailSends, ipSends] = await Promise.all([
    getAttemptCount(emailKey),
    getAttemptCount(ipKey),
  ]);
  if (emailSends >= MAX_SENDS_PER_EMAIL || ipSends >= MAX_SENDS_PER_IP) {
    return { ok: false, reason: "rate_limited" };
  }
  await Promise.all([
    recordAttempt(emailKey, WINDOW_SECONDS),
    recordAttempt(ipKey, WINDOW_SECONDS),
  ]);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await DocumentShareVisitorCode.findOneAndUpdate(
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

  const workspace = await workspaceDisplayIdentity(share.workspaceId);
  await sendDocumentShareCodeEmail(email, {
    code,
    workspaceName: workspace.name,
  });
  return { ok: true };
}

/**
 * Vérifie et consomme un code. Faux si absent, expiré, incorrect ou après
 * trop d'essais (le code est alors invalidé).
 */
export async function consumeDocumentShareCode(share, rawEmail, rawCode) {
  const email = normalizeVisitorEmail(rawEmail);
  const code = String(rawCode || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return false;

  // Un essai est réservé avant la comparaison, en une seule écriture : des
  // requêtes simultanées ne peuvent pas tester plus de codes que la limite
  const entry = await DocumentShareVisitorCode.findOneAndUpdate(
    {
      email,
      shareId: share._id,
      attempts: { $lt: VISITOR_CODE_MAX_ATTEMPTS },
      expiresAt: { $gt: new Date() },
    },
    { $inc: { attempts: 1 } },
    { new: true },
  );
  if (!entry) {
    await DocumentShareVisitorCode.deleteOne({ email, shareId: share._id });
    return false;
  }

  const expected = Buffer.from(entry.codeHash);
  const provided = Buffer.from(hashCode(String(share._id), email, code));
  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    return false;
  }

  // Usage unique : seule la suppression effective valide le code
  const { deletedCount } = await DocumentShareVisitorCode.deleteOne({
    _id: entry._id,
    codeHash: entry.codeHash,
  });
  return deletedCount === 1;
}
