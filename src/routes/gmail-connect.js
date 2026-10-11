import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import GmailConnection from "../models/GmailConnection.js";
import GmailOAuthProvider, {
  translateGmailError,
} from "../services/gmail/GmailOAuthProvider.js";
import { scanGmailConnection } from "../services/gmail/GmailScannerService.js";
import logger from "../utils/logger.js";
import { requireWorkspaceActionPermission } from "../middlewares/require-workspace-membership.js";
import { userHasWorkspaceAction } from "../utils/workspace-membership.js";
import {
  consumeSignedStateOnce,
  createSignedState,
  verifySignedState,
} from "../utils/signedOAuthState.js";

// 🔐 State OAuth signé (HMAC, secret serveur), lié à l'utilisateur et à
// l'espace, valable 10 minutes et à usage unique : voir signedOAuthState.js
export const GMAIL_STATE_PURPOSE = "gmail-connect";
export const GMAIL_STATE_TTL_MS = 10 * 60 * 1000;
const usedStateKey = (nonce) => `gmail-connect:state-used:${nonce}`;

const router = express.Router();

// GET /gmail-connect/authorize — generate OAuth URL
// Membre de l'espace (en-tête x-organization-id) avec le droit « Ajouter »
// des factures d'achat : la boîte connectée crée des factures dans l'espace
router.get(
  "/authorize",
  requireWorkspaceActionPermission("purchaseInvoices", "create"),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      // Espace validé par requireWorkspaceActionPermission
      const organizationId = req.workspaceId || null;
      if (!organizationId) {
        return res.status(400).json({
          error: "Organization ID manquant (header x-organization-id)",
        });
      }

      const scanPeriodMonths = parseInt(req.query.scanPeriodMonths) || 3;

      const provider = new GmailOAuthProvider();
      const state = createSignedState(
        GMAIL_STATE_PURPOSE,
        {
          userId: (user._id || user.id).toString(),
          workspaceId: String(organizationId),
          scanPeriodMonths: Math.min(Math.max(scanPeriodMonths, 1), 12),
        },
        GMAIL_STATE_TTL_MS,
      );

      const authUrl = provider.getAuthUrl(state);
      res.json({ authUrl });
    } catch (error) {
      logger.error("Erreur génération URL Gmail OAuth:", error);
      res.status(500).json({
        error: "Erreur lors de la génération de l'URL d'autorisation Gmail",
        details: translateGmailError(error),
      });
    }
  },
);

// GET /gmail-connect/callback — OAuth callback
router.get("/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.error("Gmail OAuth error:", oauthError);
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=${encodeURIComponent(oauthError)}`,
      );
    }
    if (!code || !state) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=missing_params`,
      );
    }

    // State signé par /authorize : un state fabriqué (utilisateur et espace
    // d'un autre) ou modifié est refusé avant tout échange de code
    const verified = verifySignedState(GMAIL_STATE_PURPOSE, state);
    if (!verified.ok) {
      if (verified.reason === "expired") {
        logger.warn("[Gmail OAuth] State expiré");
        return res.redirect(
          `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=state_expired`,
        );
      }
      logger.warn(
        "[Gmail OAuth] State invalide (signature absente ou incorrecte)",
      );
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=invalid_state`,
      );
    }
    const stateData = verified.data;

    // Usage unique, atomique (Redis partagé entre instances ; sans Redis,
    // refus : voir consumeSignedStateOnce)
    const consumed =
      typeof stateData.nonce === "string" && stateData.nonce
        ? await consumeSignedStateOnce(
            usedStateKey(stateData.nonce),
            GMAIL_STATE_TTL_MS,
          )
        : "used";
    if (consumed !== "ok") {
      logger.warn(
        `[Gmail OAuth] State refusé (${consumed}) pour userId ${stateData.userId}`,
      );
      const code =
        consumed === "unavailable"
          ? encodeURIComponent(
              "Service momentanément indisponible, veuillez réessayer",
            )
          : "invalid_state";
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=${code}`,
      );
    }

    // Droit toujours présent au retour (retiré entre-temps : refus)
    const stillAllowed = await userHasWorkspaceAction(
      String(stateData.userId),
      String(stateData.workspaceId),
      "purchaseInvoices",
      "create",
    );
    if (!stillAllowed) {
      logger.warn(
        `[Gmail OAuth] Droit retiré pour userId ${stateData.userId} sur l'espace ${stateData.workspaceId}`,
      );
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=${encodeURIComponent("Vous n'avez plus le droit d'ajouter des factures d'achat dans cet espace")}`,
      );
    }

    // Optional: verify JWT user matches state user
    let callbackUser;
    try {
      callbackUser = await betterAuthJWTMiddleware(req);
    } catch {
      /* pas de JWT dans le callback, on continue avec le state */
    }

    if (
      callbackUser &&
      (callbackUser._id || callbackUser.id).toString() !== stateData.userId
    ) {
      logger.error(
        `[Gmail OAuth] userId mismatch: state=${stateData.userId}, jwt=${callbackUser._id || callbackUser.id}`,
      );
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=user_mismatch`,
      );
    }

    // Exchange code for tokens
    const provider = new GmailOAuthProvider();
    const tokens = await provider.exchangeCode(code);
    const userInfo = await provider.getUserInfo(tokens.accessToken);

    // Upsert GmailConnection
    let connection = await GmailConnection.findOne({
      userId: stateData.userId,
      workspaceId: stateData.workspaceId,
    });

    if (connection) {
      connection.accessToken = tokens.accessToken;
      connection.refreshToken = tokens.refreshToken;
      connection.tokenExpiresAt = tokens.expiresAt;
      connection.accountEmail = userInfo.email;
      connection.accountName = userInfo.name;
      connection.status = "active";
      connection.isActive = true;
      connection.lastSyncError = null;
      connection.scanPeriodMonths = stateData.scanPeriodMonths || 3;
      await connection.save();
    } else {
      connection = await GmailConnection.create({
        userId: stateData.userId,
        workspaceId: stateData.workspaceId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        accountEmail: userInfo.email,
        accountName: userInfo.name,
        scanPeriodMonths: stateData.scanPeriodMonths || 3,
        status: "active",
        isActive: true,
      });
    }

    logger.info(
      `Gmail connecté pour user ${stateData.userId} (${userInfo.email})`,
    );

    // Launch initial scan async (don't await)
    scanGmailConnection(connection._id, { isInitialScan: true }).catch(
      (err) => {
        logger.error(
          `[Gmail] Scan initial échoué pour ${userInfo.email}:`,
          err.message,
        );
      },
    );

    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_connected=true`,
    );
  } catch (error) {
    logger.error("Gmail callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/outils/factures-achat?gmail_error=${encodeURIComponent(translateGmailError(error))}`,
    );
  }
});

// POST /gmail-connect/disconnect — disconnect Gmail
router.post("/disconnect", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { connectionId } = req.body;
    if (!connectionId) {
      return res.status(400).json({ error: "connectionId manquant" });
    }

    const connection = await GmailConnection.findOne({
      _id: connectionId,
      userId: user._id || user.id,
    });

    if (!connection) {
      return res.status(404).json({ error: "Connexion Gmail introuvable" });
    }

    connection.status = "disconnected";
    connection.isActive = false;
    connection.accessToken = null;
    connection.refreshToken = null;
    await connection.save();

    logger.info(
      `Gmail déconnecté pour user ${user._id || user.id} (${connection.accountEmail})`,
    );
    res.json({ success: true, message: "Gmail déconnecté" });
  } catch (error) {
    logger.error("Erreur déconnexion Gmail:", error);
    res.status(500).json({ error: "Erreur lors de la déconnexion Gmail" });
  }
});

export default router;
