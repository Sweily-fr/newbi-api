import crypto from "crypto";

/**
 * Jeton d'accès d'un destinataire à un transfert protégé par mot de passe.
 *
 * /api/transfers/verify-password se contentait de répondre « valide » ou
 * « invalide » : aucune route de téléchargement ni d'aperçu ne contrôlait le
 * mot de passe, le lien seul suffisait donc à tout récupérer. La route remet
 * désormais ce jeton signé, de courte durée, lié au transfert et à son mot de
 * passe ; la page publique le transmet à chaque téléchargement et aperçu.
 * Le propriétaire n'en a pas besoin : son ownerDownloadToken suffit.
 */
export const TRANSFER_ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les jetons d'accès aux transferts",
    );
  }
  return secret;
}

// Empreinte du hash bcrypt : un changement de mot de passe invalide les
// jetons déjà remis
function passwordFingerprint(fileTransfer) {
  return crypto
    .createHash("sha256")
    .update(String(fileTransfer?.password || ""))
    .digest("hex")
    .slice(0, 32);
}

function sign(transferId, fingerprint, expiresAt) {
  // Préfixe dédié : un jeton propriétaire ne peut pas servir ici, et
  // inversement
  return crypto
    .createHmac("sha256", getSecret())
    .update(`transfer-password:${transferId}:${fingerprint}:${expiresAt}`)
    .digest("hex");
}

/**
 * @returns {{ token: string, expiresAt: number }|null} null si non signable
 */
export function createTransferAccessToken(
  fileTransfer,
  ttlMs = TRANSFER_ACCESS_TOKEN_TTL_MS,
) {
  const transferId = fileTransfer?._id || fileTransfer?.id;
  if (!transferId) return null;
  try {
    const expiresAt = Date.now() + ttlMs;
    const signature = sign(
      String(transferId),
      passwordFingerprint(fileTransfer),
      expiresAt,
    );
    return { token: `${expiresAt}.${signature}`, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Vérifie qu'un jeton a été remis pour ce transfert, avec son mot de passe
 * actuel, et n'a pas expiré.
 */
export function verifyTransferAccessToken(token, fileTransfer) {
  const transferId = fileTransfer?._id || fileTransfer?.id;
  if (typeof token !== "string" || !transferId) return false;

  const [rawExpiresAt, signature] = token.split(".");
  const expiresAt = Number(rawExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  if (!signature) return false;

  try {
    const expected = sign(
      String(transferId),
      passwordFingerprint(fileTransfer),
      expiresAt,
    );
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
