import crypto from "crypto";
import mongoose from "mongoose";

/**
 * Lien d'abonnement au calendrier (fichier .ics suivi par Google Agenda,
 * Apple Calendrier ou Outlook) : un par utilisateur et par espace.
 *
 * Le jeton n'est jamais stocké en clair :
 *   - `tokenHash` (SHA-256) sert à retrouver le lien quand une application
 *     le lit ;
 *   - `tokenEncrypted` (AES-256-GCM, clé dérivée de CALENDAR_ENCRYPTION_KEY
 *     comme les jetons des calendriers connectés) permet de réafficher
 *     l'adresse à son propriétaire.
 * Régénérer remplace les deux (l'ancienne adresse ne mène plus à rien),
 * désactiver supprime le document.
 */
const calendarFeedTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    tokenHash: { type: String, required: true },
    tokenEncrypted: { type: String, required: true },
    // Création du lien actuel (remise à zéro à chaque régénération)
    createdAt: { type: Date, default: Date.now },
    // Dernière lecture par une application (null : jamais lu)
    lastAccessedAt: { type: Date, default: null },
  },
  { collection: "calendar_feed_tokens", versionKey: false },
);

calendarFeedTokenSchema.index({ tokenHash: 1 }, { unique: true });
calendarFeedTokenSchema.index({ userId: 1, workspaceId: 1 }, { unique: true });

// ─── Jeton ────────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "v1";

// Clé lue à l'usage (pas au chargement du module) : une variable absente ne
// casse que les liens d'abonnement, pas le démarrage de l'API
function encryptionKey() {
  const raw =
    process.env.CALENDAR_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CALENDAR_ENCRYPTION_KEY (ou SMTP_ENCRYPTION_KEY) doit être défini pour les liens d'abonnement au calendrier",
    );
  }
  // Clé propre à cet usage, dérivée de la clé des calendriers connectés
  return crypto
    .createHmac("sha256", raw)
    .update("calendar-feed-token")
    .digest();
}

/** Jeton aléatoire de 256 bits, en base64url (43 caractères). */
export function generateFeedToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export const FEED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashFeedToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Format : v1:iv:tag:données (base64url). */
export function encryptFeedToken(token) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(String(token), "utf8"),
    cipher.final(),
  ]);
  return [
    PREFIX,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    data.toString("base64url"),
  ].join(":");
}

/** Jeton en clair, ou null si la valeur est illisible (clé changée…). */
export function decryptFeedToken(value) {
  try {
    const [prefix, iv, tag, data] = String(value || "").split(":");
    if (prefix !== PREFIX || !iv || !tag || !data) return null;
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

const CalendarFeedToken =
  mongoose.models.CalendarFeedToken ||
  mongoose.model("CalendarFeedToken", calendarFeedTokenSchema);

export default CalendarFeedToken;
