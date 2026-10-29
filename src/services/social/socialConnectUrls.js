/**
 * Adresses du parcours de connexion d'un compte de réseau social, communes
 * à Zernio et à nos propres applis : page de retour assainie, adresse de
 * l'API (retours OAuth), redirection finale vers le site avec
 * social_connected / social_error / social_platform.
 */

export const DEFAULT_RETURN_TO = "/dashboard/outils/kanban";
export const CONNECT_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Page de retour après la connexion : un chemin du tableau de bord
 * seulement (ni schéma, ni hôte, ni « // »).
 */
export function sanitizeReturnTo(value) {
  if (typeof value !== "string") return DEFAULT_RETURN_TO;
  const raw = value.trim();
  if (
    !raw.startsWith("/dashboard") ||
    raw.includes("//") ||
    raw.includes("\\") ||
    raw.length > 500 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(raw)
  ) {
    return DEFAULT_RETURN_TO;
  }
  try {
    const base = "https://newbi.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return DEFAULT_RETURN_TO;
    if (
      url.pathname !== "/dashboard" &&
      !url.pathname.startsWith("/dashboard/")
    ) {
      return DEFAULT_RETURN_TO;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

/**
 * Adresse publique de l'API (NEXT_PUBLIC_API_URL), base des adresses de
 * retour OAuth, comme /calendar-connect. En local pour X : 127.0.0.1, pas
 * localhost (refusé par X).
 */
export const apiPublicUrl = () =>
  (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(
    /\/+$/,
    "",
  );

/** Adresse de retour OAuth de notre appli pour un réseau. */
export const directRedirectUri = (platform) =>
  `${apiPublicUrl()}/social-connect/${platform}/callback`;

/** Code d'erreur transmis au site (lettres, chiffres, « _ »). */
export const safeCode = (value) =>
  typeof value === "string" && /^[a-z0-9_]{1,64}$/i.test(value)
    ? value
    : "connection_failed";

/** Adresse du site où renvoyer le navigateur à la fin du parcours. */
export function frontendRedirect(returnTo, params) {
  const frontend = (
    process.env.FRONTEND_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");
  const url = new URL(returnTo, `${frontend}/`);
  ["social_connected", "social_error", "social_platform"].forEach((key) =>
    url.searchParams.delete(key),
  );
  Object.entries(params).forEach(([key, value]) =>
    url.searchParams.set(key, value),
  );
  return url.toString();
}
