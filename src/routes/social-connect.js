import express from "express";
import { completeConnect } from "../services/social/socialPublishingService.js";
import logger from "../utils/logger.js";

/**
 * Retour du navigateur après la connexion d'un compte de réseau social chez
 * Zernio (GET /social-connect/callback?state=…). Publique : l'utilisateur et
 * l'espace sont ceux du jeton à usage unique créé par connectSocialAccount
 * (droit « Applications et banques » revérifié), jamais lus ailleurs.
 *
 * Succès : `${FRONTEND_URL}${returnTo}?social_connected=<réseau>`.
 * Échec : `${FRONTEND_URL}${returnTo}?social_error=<code>&social_platform=<réseau>`.
 */
const router = express.Router();

router.get("/callback", async (req, res) => {
  try {
    const redirectUrl = await completeConnect(req.query || {});
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error("[SocialConnect] Erreur au retour OAuth:", error);
    const frontend = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    res.redirect(
      `${frontend}/dashboard/outils/kanban?social_error=connection_failed`,
    );
  }
});

export default router;
