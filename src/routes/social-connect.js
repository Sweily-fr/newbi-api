import express from "express";
import { completeConnect } from "../services/social/socialPublishingService.js";
import { completeDirectConnect } from "../services/social/socialDirectConnect.js";
import {
  META_CALLBACK_SOURCES,
  dataDeletionStatusPage,
  handleDataDeletion,
  handleDeauthorize,
} from "../services/social/socialMetaCallbacks.js";
import { connectorByKey } from "../services/social/socialProviders.js";
import logger from "../utils/logger.js";

/**
 * Retours du navigateur après la connexion d'un compte de réseau social.
 * Publiques : l'utilisateur et l'espace sont ceux du jeton à usage unique
 * créé par connectSocialAccount (droit « Applications et banques »
 * revérifié), jamais lus ailleurs.
 *
 * - GET /social-connect/callback?state=… : connexion chez Zernio ;
 * - GET /social-connect/<connecteur>/callback?code=…&state=… : connexion
 *   par notre propre appli (facebook, instagram, instagram_facebook,
 *   linkedin, tiktok, tiktok_business, twitter ; liste fermée), adresse à
 *   déclarer chez le réseau (TikTok Business : avec le « / » final, accepté
 *   aussi).
 *
 * Succès : `${FRONTEND_URL}${returnTo}?social_connected=<réseau>`.
 * Échec : `${FRONTEND_URL}${returnTo}?social_error=<code>&social_platform=<réseau>`.
 *
 * Rappels de Meta (serveur à serveur, signed_request vérifié) :
 * - POST /social-connect/<meta|instagram|instagram_facebook>/deauthorize ;
 * - POST /social-connect/<meta|instagram|instagram_facebook>/data-deletion ;
 * - GET /social-connect/meta/data-deletion/<code> : page de suivi.
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

// Corps des rappels de Meta (formulaire signed_request=…)
const metaCallbackBody = express.urlencoded({ extended: false, limit: "20kb" });

const metaCallback = (handler) => async (req, res) => {
  try {
    const result = await handler(req.body?.signed_request);
    if (!result.body) return res.status(result.status).end();
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error("[SocialConnect] Erreur dans un rappel Meta:", error);
    return res.status(500).end();
  }
};

META_CALLBACK_SOURCES.forEach((source) => {
  router.post(
    `/${source}/deauthorize`,
    metaCallbackBody,
    metaCallback((signedRequest) => handleDeauthorize(source, signedRequest)),
  );
  router.post(
    `/${source}/data-deletion`,
    metaCallbackBody,
    metaCallback((signedRequest) => handleDataDeletion(source, signedRequest)),
  );
});

router.get("/meta/data-deletion/:code", async (req, res) => {
  try {
    const page = await dataDeletionStatusPage(req.params.code);
    if (!page) return res.status(404).end();
    return res.type("html").send(page);
  } catch (error) {
    logger.error("[SocialConnect] Page de suivi de suppression:", error);
    return res.status(500).end();
  }
});

// « / » final accepté (adresse déclarée chez TikTok Business)
router.get("/:key/callback", async (req, res) => {
  const { key } = req.params;
  if (!connectorByKey(key)) return res.status(404).end();
  try {
    const redirectUrl = await completeDirectConnect(key, req.query || {});
    return res.redirect(redirectUrl);
  } catch (error) {
    logger.error(`[SocialConnect] Erreur au retour OAuth ${key}:`, error);
    return res.redirect(fallbackRedirect());
  }
});

export default router;
