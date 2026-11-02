/**
 * Origines autorisées à appeler l'API depuis un navigateur (CORS, avec
 * cookies).
 *
 * - les adresses du site, de l'espace partenaire et de l'API, et localhost ;
 * - Apollo Studio hors production ou introspection ouverte ;
 * - hors production seulement : les tunnels de
 *   développement (sous-domaines ngrok et trycloudflare.com, reconnus par
 *   leur suffixe exact, sans liste qui grossit à chaque origine vue).
 */

const PRODUCTION_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001", // Espace partenaire
  "http://localhost:4000",
  "https://www.newbi.fr",
  "https://newbi.fr",
  "https://api.newbi.fr",
  "https://newbi-v2.vercel.app",
  "https://newbi-v2-git-develop-sofianemtimet6-2653s-projects.vercel.app",
  "https://staging-api.newbi.fr",
];

// Apollo Studio a besoin de l'introspection, fermée en production
const APOLLO_STUDIO = "https://studio.apollographql.com";

const TUNNEL_SUFFIXES = [
  ".ngrok-free.app",
  ".ngrok-free.dev",
  ".ngrok.app",
  ".ngrok.dev",
  ".ngrok.io",
  ".trycloudflare.com",
];

function isDevelopmentTunnel(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.origin !== origin) return false;
  const host = url.hostname.toLowerCase();
  return TUNNEL_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
}

/**
 * @param {{ nodeEnv?: string, introspection?: boolean, frontendUrl?: string, partnerFrontendUrl?: string }} env
 * @returns {(origin: string | undefined) => boolean}
 */
export function createOriginChecker({
  nodeEnv = process.env.NODE_ENV,
  introspection = process.env.ENABLE_GRAPHQL_INTROSPECTION === "true",
  frontendUrl = process.env.FRONTEND_URL,
  partnerFrontendUrl = process.env.PARTNER_FRONTEND_URL,
} = {}) {
  const production = nodeEnv === "production";
  const allowed = new Set(
    [
      ...PRODUCTION_ORIGINS,
      ...(!production || introspection ? [APOLLO_STUDIO] : []),
      frontendUrl,
      partnerFrontendUrl,
    ].filter(Boolean),
  );
  return (origin) => {
    // Sans en-tête Origin : appel hors navigateur (application mobile,
    // serveur), CORS ne s'applique pas
    if (!origin) return true;
    if (allowed.has(origin)) return true;
    return !production && isDevelopmentTunnel(origin);
  };
}
