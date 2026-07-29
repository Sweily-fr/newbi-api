/**
 * Garde anti-SSRF pour les téléchargements côté serveur.
 *
 * Les URL de documents fournies par le client (import de factures/justificatifs)
 * sont téléchargées par le serveur (VPS) pour l'OCR. Sans validation, un
 * attaquant pouvait pointer vers http://169.254.169.254/ (métadonnées cloud),
 * http://localhost, ou une IP interne, et exfiltrer la réponse via l'OCR.
 *
 * Politique : uniquement http(s), blocage des IP privées / link-local / loopback
 * et des hôtes de métadonnées, et — si des domaines R2 sont configurés en env —
 * restriction à ces hôtes (+ domaines R2 génériques Cloudflare).
 */

// Variables d'env qui portent une URL publique de bucket R2 (source légitime).
const R2_URL_ENV_VARS = [
  "R2_API_URL",
  "R2_PUBLIC_URL",
  "USER_IMAGE_URL",
  "OCR_URL",
  "SIGNATURE_URL",
  "PROFILE_IMAGE_URL",
  "COMPANY_IMAGE_URL",
  "IMPORTED_INVOICES_URL",
  "RECEIPTS_URL",
  "SHARED_DOCUMENTS_URL",
  "KANBAN_URL",
];

const GENERIC_R2_SUFFIXES = [".r2.cloudflarestorage.com", ".r2.dev"];

let _allowedHosts = null;
function getAllowedHosts() {
  if (_allowedHosts) return _allowedHosts;
  const hosts = new Set();
  for (const name of R2_URL_ENV_VARS) {
    const val = process.env[name];
    if (!val) continue;
    try {
      hosts.add(new URL(val).hostname.toLowerCase());
    } catch {
      // valeur d'env non-URL : ignorée
    }
  }
  _allowedHosts = hosts;
  return _allowedHosts;
}

function isPrivateIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + métadonnées cloud
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Valide une URL de téléchargement. Lève une Error si l'URL est jugée dangereuse.
 * @param {string} rawUrl
 * @returns {URL} l'URL parsée si autorisée
 */
export function assertSafeDownloadUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("URL de téléchargement invalide");
  }

  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("Schéma d'URL non autorisé");
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "metadata"
  ) {
    throw new Error("Hôte de téléchargement non autorisé");
  }

  if (
    isPrivateIpv4(host) ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("fd") ||
    host.startsWith("fe80") ||
    host.startsWith("fc")
  ) {
    throw new Error("Hôte de téléchargement non autorisé (adresse privée)");
  }

  const allowed = getAllowedHosts();
  if (allowed.size > 0) {
    const ok =
      allowed.has(host) ||
      [...allowed].some((h) => host === h || host.endsWith("." + h)) ||
      GENERIC_R2_SUFFIXES.some((s) => host.endsWith(s));
    if (!ok) {
      throw new Error("Hôte de téléchargement non autorisé");
    }
  }

  return u;
}
