import express from "express";
import crypto from "crypto";
import logger from "../utils/logger.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";

const router = express.Router();

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
router.get("/authorize", async (req, res) => {
  try {
    const { organizationId } = req.query;

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

    // Générer un state unique pour la sécurité CSRF
    const state = crypto.randomBytes(32).toString("hex");

    // Stocker le state temporairement (associé à l'organisation)
    // En production, utiliser Redis ou une base de données
    global.superpdpOAuthStates = global.superpdpOAuthStates || new Map();
    global.superpdpOAuthStates.set(state, {
      organizationId,
      createdAt: Date.now(),
    });

    // Nettoyer les states expirés (plus de 10 minutes)
    const TEN_MINUTES = 10 * 60 * 1000;
    for (const [key, value] of global.superpdpOAuthStates.entries()) {
      if (Date.now() - value.createdAt > TEN_MINUTES) {
        global.superpdpOAuthStates.delete(key);
      }
    }

    // Construire l'URL de redirection (callback)
    const redirectUri = `${process.env.API_URL || "http://localhost:4000"}/api/superpdp/callback`;

    // Construire l'URL d'autorisation OAuth2
    const authUrl = new URL(SUPERPDP_OAUTH_CONFIG.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("state", state);
    // Scopes: laisser vide selon la documentation SuperPDP

    logger.info(
      `🔗 URL d'autorisation SuperPDP générée pour org ${organizationId}`
    );

    res.json({
      success: true,
      authorizationUrl: authUrl.toString(),
      state,
    });
  } catch (error) {
    logger.error(
      "Erreur lors de la génération de l'URL d'autorisation:",
      error
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
        `${frontendUrl}/dashboard/parametres/facturation-electronique?error=${encodeURIComponent(error_description || error)}`
      );
    }

    if (!code || !state) {
      return res.status(400).json({
        success: false,
        error: "Code ou state manquant",
      });
    }

    // Vérifier le state (protection CSRF)
    global.superpdpOAuthStates = global.superpdpOAuthStates || new Map();
    const stateData = global.superpdpOAuthStates.get(state);

    if (!stateData) {
      logger.error("State OAuth2 invalide ou expiré");
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(
        `${frontendUrl}/dashboard/parametres/facturation-electronique?error=${encodeURIComponent("Session expirée, veuillez réessayer")}`
      );
    }

    const { organizationId } = stateData;
    global.superpdpOAuthStates.delete(state); // Supprimer le state utilisé

    // Récupérer les credentials
    const clientId = process.env.SUPERPDP_CLIENT_ID;
    const clientSecret = process.env.SUPERPDP_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("Credentials SuperPDP non configurés");
    }

    // Construire l'URL de redirection (doit être identique à celle utilisée pour l'autorisation)
    const redirectUri = `${process.env.API_URL || "http://localhost:4000"}/api/superpdp/callback`;

    // Échanger le code contre des tokens
    logger.info(
      `🔄 Échange du code OAuth2 pour l'organisation ${organizationId}`
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
        `Erreur échange token SuperPDP: ${tokenResponse.status} - ${errorText}`
      );
      throw new Error(`Erreur échange token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    logger.info(
      `✅ Tokens OAuth2 obtenus pour l'organisation ${organizationId}`
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
      `✅ Facturation électronique activée pour l'organisation ${organizationId}`
    );

    // Rediriger vers le frontend avec succès
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(
      `${frontendUrl}/dashboard?openSettings=true&settingsTab=e-invoicing&success=true&message=${encodeURIComponent("Connexion à SuperPDP réussie !")}`
    );
  } catch (error) {
    logger.error("Erreur lors du callback OAuth2:", error);
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(
      `${frontendUrl}/dashboard?openSettings=true&settingsTab=e-invoicing&error=${encodeURIComponent(error.message)}`
    );
  }
});

/**
 * POST /api/superpdp/disconnect
 * Déconnecter le compte SuperPDP d'une organisation
 */
router.post("/disconnect", async (req, res) => {
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
      `🔌 Compte SuperPDP déconnecté pour l'organisation ${organizationId}`
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
router.get("/status", async (req, res) => {
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
