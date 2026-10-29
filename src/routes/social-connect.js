import express from "express";
import { completeConnect } from "../services/social/socialPublishingService.js";
import { completeDirectConnect } from "../services/social/socialDirectConnect.js";
import { isSupportedPlatform } from "../services/social/socialPostRules.js";
import logger from "../utils/logger.js";

/**
 * Retours du navigateur après la connexion d'un compte de réseau social.
 * Publiques : l'utilisateur et l'espace sont ceux du jeton à usage unique
 * créé par connectSocialAccount (droit « Applications et banques »
 * revérifié), jamais lus ailleurs.
 *
 * - GET /social-connect/callback?state=… : connexion chez Zernio ;
 * - GET /social-connect/<réseau>/callback?code=…&state=… : connexion par
 *   notre propre appli (facebook, instagram, linkedin, tiktok, twitter),
 *   adresse à déclarer chez le réseau.
 *
 * Succès : `${FRONTEND_URL}${returnTo}?social_connected=<réseau>`.
 * Échec : `${FRONTEND_URL}${returnTo}?social_error=<code>&social_platform=<réseau>`.
 */
const router = express.Router();

const fallbackRedirect = () => {
  const frontend = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return `${frontend}/dashboard/outils/kanban?social_error=connection_failed`;
};

router.get("/callback", async (req, res) => {
  try {
    const redirectUrl = await completeConnect(req.query || {});
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error("[SocialConnect] Erreur au retour OAuth:", error);
    res.redirect(fallbackRedirect());
  }
});

router.get("/:platform/callback", async (req, res) => {
  const { platform } = req.params;
  if (!isSupportedPlatform(platform)) return res.status(404).end();
  try {
    const redirectUrl = await completeDirectConnect(platform, req.query || {});
    return res.redirect(redirectUrl);
  } catch (error) {
    logger.error(`[SocialConnect] Erreur au retour OAuth ${platform}:`, error);
    return res.redirect(fallbackRedirect());
  }
});

export default router;
