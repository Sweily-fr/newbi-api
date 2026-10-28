import logger from "./logger.js";

/**
 * Vérification Cloudflare Turnstile côté serveur (formulaires publics :
 * guides, prise de rendez-vous). Sans TURNSTILE_SECRET_KEY (postes de dev),
 * la vérification est ignorée.
 *
 * @param {string} token - jeton remis par le widget du site
 * @param {string} [ip] - adresse du visiteur
 * @returns {Promise<boolean>}
 */
export async function verifyTurnstileToken(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Pas de clé configurée → skip la vérification (dev local)
    return true;
  }

  if (!token || typeof token !== "string") {
    return false;
  }

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    const outcome = await res.json();
    return outcome.success === true;
  } catch (err) {
    logger.error(`[Turnstile] Erreur vérification: ${err.message}`);
    return false;
  }
}
