import crypto from "crypto";
import mongoose from "mongoose";

/**
 * Boîte d'envoi de la prospection (Communication > Prospection) : la boîte
 * Gmail ou Outlook d'un membre, connectée par OAuth avec les seuls droits
 * d'envoi (gmail.send, Mail.Send). Les e-mails de prospection partent de
 * cette boîte, jamais par Resend. Une boîte par membre et par espace.
 *
 * Statuts :
 *   ACTIVE        envoie selon ses réglages (limite du jour, plage) ;
 *   EXPIRED       jeton refusé par le fournisseur : à reconnecter, les
 *                 prospections attendent (un e-mail prévient le membre une
 *                 fois, `expiredNotifiedAt`) ;
 *   PAUSED        coupe-circuit de réputation (`pauseKind` REPUTATION) :
 *                 reprise à la main en relançant une prospection ;
 *   DISCONNECTED  déconnectée par le membre, jetons effacés.
 *
 * Jetons chiffrés comme ceux de GmailConnection (AES-256-CBC, clé dérivée
 * de CALENDAR_ENCRYPTION_KEY, repli SMTP_ENCRYPTION_KEY) : même format
 * « encrypted:<iv>:<données> ». La clé est lue à l'usage, pas au chargement.
 *
 * Envoi par le cron (services/prospecting/sending.js) : `lockedUntil`
 * réserve la boîte le temps d'un envoi, `nextSendAfter` espace les envois
 * (3 à 8 minutes) ou reporte au lendemain (quota du fournisseur).
 */

export const MAILBOX_PROVIDERS = ["GOOGLE", "MICROSOFT"];
export const MAILBOX_STATUSES = ["ACTIVE", "EXPIRED", "PAUSED", "DISCONNECTED"];
export const MAILBOX_PAUSE_KINDS = ["MANUAL", "REPUTATION"];

export const DEFAULT_DAILY_LIMIT = 30;
export const MIN_DAILY_LIMIT = 5;
export const DEFAULT_SEND_DAYS = Object.freeze([1, 2, 3, 4, 5]);
export const DEFAULT_START_HOUR = 9;
export const DEFAULT_END_HOUR = 18;

const ALGORITHM = "aes-256-cbc";
const PREFIX = "encrypted:";

function encryptionKey() {
  const raw =
    process.env.CALENDAR_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CALENDAR_ENCRYPTION_KEY (ou SMTP_ENCRYPTION_KEY) doit être défini pour chiffrer les jetons des boîtes d'envoi",
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/** Jeton chiffré (déjà chiffré ou vide : tel quel). */
export function encryptToken(value) {
  if (!value || String(value).startsWith(PREFIX)) return value || null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted =
    cipher.update(String(value), "utf8", "hex") + cipher.final("hex");
  return `${PREFIX}${iv.toString("hex")}:${encrypted}`;
}

/** Jeton en clair (valeur non chiffrée : telle quelle). */
export function decryptToken(value) {
  if (!value || !String(value).startsWith(PREFIX)) return value || null;
  const [, ivHex, data] = String(value).split(":");
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivHex, "hex"),
  );
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
}

const sendWindowSchema = new mongoose.Schema(
  {
    // 1 = lundi … 7 = dimanche (heure de Paris)
    days: { type: [Number], default: () => [...DEFAULT_SEND_DAYS] },
    startHour: { type: Number, default: DEFAULT_START_HOUR, min: 0, max: 23 },
    // Exclusive : 18 = dernier envoi avant 18 h
    endHour: { type: Number, default: DEFAULT_END_HOUR, min: 1, max: 24 },
  },
  { _id: false },
);

const mailboxConnectionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provider: { type: String, enum: MAILBOX_PROVIDERS, required: true },
    accountEmail: { type: String, required: true, trim: true, lowercase: true },
    accountName: { type: String, default: null },
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    status: { type: String, enum: MAILBOX_STATUSES, default: "ACTIVE" },
    pausedReason: { type: String, default: null },
    pauseKind: {
      type: String,
      enum: [...MAILBOX_PAUSE_KINDS, null],
      default: null,
    },
    dailyLimit: { type: Number, default: DEFAULT_DAILY_LIMIT },
    sendWindow: { type: sendWindowSchema, default: () => ({}) },
    signatureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailSignatureV2",
      default: null,
    },
    // Départ de la montée progressive (première connexion de cette adresse)
    connectedAt: { type: Date, default: () => new Date() },
    nextSendAfter: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    expiredNotifiedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, collection: "mailbox_connections" },
);

// Jetons toujours chiffrés en base, même affectés en clair
mailboxConnectionSchema.pre("save", function encryptTokens(next) {
  if (this.isModified("accessToken")) {
    this.accessToken = encryptToken(this.accessToken);
  }
  if (this.isModified("refreshToken")) {
    this.refreshToken = encryptToken(this.refreshToken);
  }
  next();
});

mailboxConnectionSchema.methods.getAccessToken = function getAccessToken() {
  return decryptToken(this.accessToken);
};

mailboxConnectionSchema.methods.getRefreshToken = function getRefreshToken() {
  return decryptToken(this.refreshToken);
};

// Une boîte par membre et par espace
mailboxConnectionSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
// Cron : boîtes actives dont le prochain envoi est dû
mailboxConnectionSchema.index({ status: 1, nextSendAfter: 1 });

export default mongoose.models.MailboxConnection ||
  mongoose.model("MailboxConnection", mailboxConnectionSchema);
