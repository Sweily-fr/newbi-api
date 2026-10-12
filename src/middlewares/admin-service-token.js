import crypto from "crypto";
import logger from "../utils/logger.js";

/**
 * Jeton de service du back-office newbi-admin (admin.newbi.fr).
 *
 * newbi-admin ne lit la base qu'en lecture seule : ses écritures passent par
 * /api/admin-service, appelé de serveur à serveur avec ce jeton
 * (Authorization: Bearer). L'admin connecté là-bas (Google + liste blanche)
 * est transmis dans x-admin-email, pour le journal.
 *
 * Fermé si ADMIN_SERVICE_TOKEN est absente ou trop courte.
 * ADMIN_SERVICE_TOKEN_ALT est aussi acceptée, pour changer le jeton sans
 * coupure (même principe que INTERNAL_API_SECRET_ALT).
 */

const MIN_TOKEN_LENGTH = 32;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const digest = (value) =>
  crypto.createHash("sha256").update(value, "utf8").digest();

// Jetons acceptés, sans les espaces ou retours à la ligne collés avec la
// valeur dans l'interface d'hébergement (sinon toute requête échoue en 401)
export function getAcceptedAdminServiceTokens(env = process.env) {
  return [env.ADMIN_SERVICE_TOKEN, env.ADMIN_SERVICE_TOKEN_ALT]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_TOKEN_LENGTH);
}

export function isAcceptedAdminServiceToken(provided, env = process.env) {
  if (typeof provided !== "string" || provided.trim() === "") return false;
  const providedDigest = digest(provided.trim());
  let match = false;
  for (const token of getAcceptedAdminServiceTokens(env)) {
    match = crypto.timingSafeEqual(providedDigest, digest(token)) || match;
  }
  return match;
}

export function requireAdminServiceToken(req, res, next) {
  if (getAcceptedAdminServiceTokens().length === 0) {
    logger.warn("[ADMIN-SERVICE] ADMIN_SERVICE_TOKEN non configurée");
    return res.status(503).json({ error: "Service admin non configuré" });
  }

  const header = req.headers?.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!isAcceptedAdminServiceToken(provided)) {
    logger.warn(`[ADMIN-SERVICE] Jeton refusé (${req.method} ${req.path})`);
    return res.status(401).json({ error: "Non autorisé" });
  }

  const adminEmail = String(req.headers?.["x-admin-email"] || "")
    .trim()
    .toLowerCase();
  if (!EMAIL_PATTERN.test(adminEmail)) {
    return res.status(400).json({ error: "Admin non identifié" });
  }

  req.adminEmail = adminEmail;
  next();
}
