import express from "express";
import crypto from "crypto";
import logger from "../utils/logger.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import { cacheGet, cacheSet, cacheDel } from "../config/redis.js";

const router = express.Router();

// Préfixe Redis pour les states OAuth (TTL 10 min) — multi-instance safe.
const OAUTH_STATE_PREFIX = "superpdp:oauth:";
const OAUTH_STATE_TTL = 10 * 60; // secondes

/**
 * Garde d'authentification serveur-à-serveur : ces routes sont appelées par les
 * route handlers Next.js qui ont DÉJÀ authentifié la session utilisateur et vérifié
 * l'appartenance à l'organisation. On exige donc le secret interne partagé.
 */
function requireInternalSecret(req, res, next) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    logger.error(
      "[superpdp-oauth] INTERNAL_API_SECRET non défini — routes OAuth non sécurisées, accès refusé",
    );
    return res
      .status(500)
      .json({ success: false, error: "Configuration serveur manquante" });
  }
  if (req.headers["x-internal-secret"] !== expected) {
    return res.status(401).json({ success: false, error: "Non autorisé" });
  }
  next();
}

// Configuration OAuth2 SuperPDP
const SUPERPDP_OAUTH_CONFIG = {
  authorizationEndpoint: "https://api.superpdp.tech/oauth2/authorize",
  tokenEndpoint: "https://api.superpdp.tech/oauth2/token",
  // Le client_id et client_secret sont récupérés depuis les variables d'environnement
  // car ils sont fournis par SuperPDP lors de la création de l'application
};

/**
 * GET /api/superpdp/authorize
 * Génère l'URL d'autorisation OAuth2 pour rediriger l'utilisateur vers SuperPDP
 */
router.get("/authorize", requireInternalSecret, async (req, res) => {
  try {
    const { organizationId, login_hint: loginHint } = req.query;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: "organizationId est requis",
      });
    }

    // Récupérer le client_id depuis les variables d'environnement ou l'organisation
    const clientId = process.env.SUPERPDP_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({
        success: false,
        error: "SUPERPDP_CLIENT_ID non configuré",
      });
    }

    // Générer un state unique (CSRF) et le stocker dans Redis (multi-instance safe)
    const state = crypto.randomBytes(32).toString("hex");
    await cacheSet(
      `${OAUTH_STATE_PREFIX}${state}`,
      { organizationId },
      OAUTH_STATE_TTL,
    );

    // Construire l'URL de redirection (callback)
    const redirectUri = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/superpdp/callback`;

    // Construire l'URL d'autorisation OAuth2
    const authUrl = new URL(SUPERPDP_OAUTH_CONFIG.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    // Scopes: laisser vide selon la documentation SuperPDP

    // Pré-remplissage (best-effort) du formulaire SuperPDP : email + SIREN de l'org
    if (loginHint) {
      authUrl.searchParams.set("login_hint", loginHint);
    }
    try {
      const organization =
        await EInvoicingSettingsService.getOrganizationById(organizationId);
      const rawNumber =
        organization?.siret ||
        organization?.siren ||
        organization?.companyInfo?.siret ||
        "";
      const siren = String(rawNumber).replace(/\s/g, "").substring(0, 9);
      if (siren && siren.length === 9) {
        authUrl.searchParams.set("superpdp_company_number", siren);
        authUrl.searchParams.set("superpdp_company_number_scheme", "fr_siren");
      }
    } catch (prefillError) {
      logger.debug(
        `[superpdp-oauth] prefill SIREN ignoré: ${prefillError.message}`,
      );
    }

    logger.info(
      `🔗 URL d'autorisation SuperPDP générée pour org ${organizationId}`,
    );

    res.json({
      success: true,
      authorizationUrl: authUrl.toString(),
      state,
    });
  } catch (error) {
    logger.error(
      "Erreur lors de la génération de l'URL d'autorisation:",
      error,
    );
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/superpdp/callback
 * Callback OAuth2 - reçoit le code d'autorisation et l'échange contre des tokens
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    // Gérer les erreurs OAuth2
    if (error) {
      logger.error(`Erreur OAuth2 SuperPDP: ${error} - ${error_description}`);
      // Rediriger vers le frontend avec l'erreur
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(
        `${frontendUrl}/dashboard/parametres/facturation-electronique?error=${encodeURIComponent(error_description || error)}`,
      );
    }

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        error: "Code ou state manquant",
      });
    }

    // Vérifier le state (protection CSRF) depuis Redis
    const stateData = await cacheGet(`${OAUTH_STATE_PREFIX}${state}`);

    if (!stateData) {
      logger.error("State OAuth2 invalide ou expiré");
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(
        `${frontendUrl}/dashboard/parametres/facturation-electronique?error=${encodeURIComponent("Session expirée, veuillez réessayer")}`,
      );
    }

    const { organizationId } = stateData;
    await cacheDel(`${OAUTH_STATE_PREFIX}${state}`); // Supprimer le state utilisé

    // Récupérer les credentials
    const clientId = process.env.SUPERPDP_CLIENT_ID;
    const clientSecret = process.env.SUPERPDP_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("Credentials SuperPDP non configurés");
    }

    // Construire l'URL de redirection (doit être identique à celle utilisée pour l'autorisation)
    const redirectUri = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/api/superpdp/callback`;

    // Échanger le code contre des tokens
    logger.info(
      `🔄 Échange du code OAuth2 pour l'organisation ${organizationId}`,
    );

    const tokenResponse = await fetch(SUPERPDP_OAUTH_CONFIG.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error(
        `Erreur échange token SuperPDP: ${tokenResponse.status} - ${errorText}`,
      );
      throw new Error(`Erreur échange token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    logger.info(
      `✅ Tokens OAuth2 obtenus pour l'organisation ${organizationId}`,
    );

    // Stocker les tokens dans l'organisation
    await EInvoicingSettingsService.storeSuperPdpTokens(organizationId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresIn: tokenData.expires_in,
      tokenType: tokenData.token_type,
    });

    // Activer la facturation électronique
    await EInvoicingSettingsService.enableEInvoicing(organizationId, {
      environment: process.env.SUPERPDP_ENVIRONMENT || "sandbox",
    });

    logger.info(
      `✅ Facturation électronique activée pour l'organisation ${organizationId}`,
    );

    // Rediriger vers le frontend avec succès
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(
      `${frontendUrl}/dashboard?openSettings=true&settingsTab=e-invoicing&success=true&message=${encodeURIComponent("Connexion à SuperPDP réussie !")}`,
    );
  } catch (error) {
    logger.error("Erreur lors du callback OAuth2:", error);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(
      `${frontendUrl}/dashboard?openSettings=true&settingsTab=e-invoicing&error=${encodeURIComponent(error.message)}`,
    );
  }
});

/**
 * POST /api/superpdp/disconnect
 * Déconnecter le compte SuperPDP d'une organisation
 */
router.post("/disconnect", requireInternalSecret, async (req, res) => {
  try {
    const { organizationId } = req.body;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: "organizationId est requis",
      });
    }

    // Supprimer les tokens et désactiver la facturation électronique
    await EInvoicingSettingsService.removeSuperPdpTokens(organizationId);
    await EInvoicingSettingsService.disableEInvoicing(organizationId);

    logger.info(
      `🔌 Compte SuperPDP déconnecté pour l'organisation ${organizationId}`,
    );

    res.json({
      success: true,
      message: "Compte SuperPDP déconnecté",
    });
  } catch (error) {
    logger.error("Erreur lors de la déconnexion SuperPDP:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/superpdp/status
 * Vérifier le statut de connexion SuperPDP pour une organisation
 */
router.get("/status", requireInternalSecret, async (req, res) => {
  try {
    const { organizationId } = req.query;

    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: "organizationId est requis",
      });
    }

    const settings =
      await EInvoicingSettingsService.getEInvoicingSettings(organizationId);

    res.json({
      success: true,
      connected: settings?.eInvoicingEnabled || false,
      hasTokens: !!settings?.superPdpAccessToken,
      environment: settings?.superPdpEnvironment || "sandbox",
      activatedAt: settings?.eInvoicingActivatedAt,
    });
  } catch (error) {
    logger.error("Erreur lors de la vérification du statut SuperPDP:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
