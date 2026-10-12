import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import CalendarConnection from "../models/CalendarConnection.js";
import { getCalendarProvider } from "../services/calendar/CalendarProviderFactory.js";
import { syncConnection } from "../services/calendar/CalendarSyncService.js";
import { registerWebhookForConnection } from "../services/calendar/CalendarWebhookService.js";
import { translateGoogleError } from "../services/calendar/providers/GoogleCalendarProvider.js";
import { translateMicrosoftError } from "../services/calendar/providers/MicrosoftCalendarProvider.js";
import { requireWorkspaceActionPermission } from "../middlewares/require-workspace-membership.js";
import { userHasWorkspaceAction } from "../utils/workspace-membership.js";
import {
  consumeSignedStateOnce,
  createSignedState,
  verifySignedState,
} from "../utils/signedOAuthState.js";
import logger from "../utils/logger.js";

const router = express.Router();

// 🔐 State OAuth signé (HMAC, secret serveur), lié à l'utilisateur, à
// l'espace et au fournisseur, valable 10 minutes et à usage unique : voir
// signedOAuthState.js. L'ancien state (JSON en base64, sans signature) se
// fabriquait avec l'utilisateur et l'espace d'un autre : en terminant le
// parcours avec son propre compte Google ou Microsoft, on remplaçait
// l'agenda connecté de la victime par le sien (événements de la victime
// envoyés vers cet agenda, événements de l'attaquant importés chez elle).
export const CALENDAR_STATE_TTL_MS = 10 * 60 * 1000;
export const calendarStatePurpose = (provider) =>
  `calendar-connect:${provider}`;
const usedStateKey = (nonce) => `calendar-connect:state-used:${nonce}`;

function createCalendarState(provider, user, workspaceId) {
  return createSignedState(
    calendarStatePurpose(provider),
    { userId: user._id.toString(), workspaceId: String(workspaceId) },
    CALENDAR_STATE_TTL_MS,
  );
}

// Connecter un agenda externe : droit « Modifier » du calendrier dans
// l'espace actif (en-tête x-workspace-id transmis par le proxy du site),
// comme les autres réglages des calendriers externes (connectAppleCalendar…)
const requireCalendarEdit = requireWorkspaceActionPermission(
  "calendar",
  "edit",
);

/**
 * Retour OAuth : l'espace vérifié à l'autorisation voyage dans le state ; le
 * droit est contrôlé de nouveau (rôle changé entre-temps, state sans espace).
 */
async function stateAllowsCalendarEdit(stateData) {
  if (!stateData?.userId || !stateData?.workspaceId) return false;
  return userHasWorkspaceAction(
    String(stateData.userId),
    String(stateData.workspaceId),
    "calendar",
    "edit",
  );
}

/**
 * Contrôles du retour OAuth, avant tout échange de code : state signé par
 * /authorize pour ce fournisseur (un state fabriqué ou modifié est refusé),
 * non expiré, jamais utilisé (Redis partagé entre instances, au mieux si
 * indisponible), même utilisateur que la session éventuelle, et droit
 * « Modifier » du calendrier toujours présent dans l'espace d'origine.
 * Renvoie { stateData } ou { error } (code transmis au site).
 */
async function checkCalendarCallback(provider, state, req) {
  const label = provider === "google" ? "Google" : "Microsoft";

  const verified = verifySignedState(calendarStatePurpose(provider), state);
  if (!verified.ok) {
    if (verified.reason === "expired") {
      logger.warn(`[${label} OAuth] State expiré`);
      return { error: "state_expired" };
    }
    logger.warn(
      `[${label} OAuth] State invalide (signature absente ou incorrecte)`,
    );
    return { error: "invalid_state" };
  }
  const stateData = verified.data;

  // Usage unique, atomique (Redis partagé entre instances ; sans Redis,
  // refus : voir consumeSignedStateOnce)
  const consumed =
    typeof stateData.nonce === "string" && stateData.nonce
      ? await consumeSignedStateOnce(
          usedStateKey(stateData.nonce),
          CALENDAR_STATE_TTL_MS,
        )
      : "used";
  if (consumed !== "ok") {
    logger.warn(
      `[${label} OAuth] State refusé (${consumed}) pour userId ${stateData.userId}`,
    );
    return {
      error:
        consumed === "unavailable"
          ? encodeURIComponent(
              "Service momentanément indisponible, veuillez réessayer",
            )
          : "invalid_state",
    };
  }

  // Validate authenticated user matches state
  let callbackUser;
  try {
    callbackUser = await betterAuthJWTMiddleware(req);
  } catch {
    /* pas de JWT dans le callback, on continue avec le state */
  }

  if (callbackUser && callbackUser._id.toString() !== stateData.userId) {
    logger.error(
      `[${label} OAuth] userId mismatch: state=${stateData.userId}, jwt=${callbackUser._id}`,
    );
    return { error: "user_mismatch" };
  }

  // Droit « Modifier » du calendrier toujours exigé dans l'espace d'origine
  if (!(await stateAllowsCalendarEdit(stateData))) {
    logger.warn(
      `[${label} OAuth] droit calendar.edit refusé pour userId ${stateData.userId} (espace ${stateData.workspaceId || "absent"})`,
    );
    return { error: "forbidden" };
  }

  return { stateData };
}

// ============================================
// GOOGLE CALENDAR OAuth
// ============================================

/**
 * GET /calendar-connect/google/authorize
 * Generates Google OAuth URL and redirects
 */
router.get("/google/authorize", requireCalendarEdit, async (req, res) => {
  try {
    // Utilisateur et espace validés par requireCalendarEdit
    const user = req.user;

    const provider = getCalendarProvider("google");

    // State signé : utilisateur et espace retrouvés au retour
    const state = createCalendarState("google", user, req.workspaceId);

    const authUrl = provider.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error("Erreur génération URL Google Calendar:", error);
    res.status(500).json({
      error: "Erreur lors de la génération de l'URL d'autorisation Google",
      details: translateGoogleError(error),
    });
  }
});

/**
 * GET /calendar-connect/google/callback
 * Handles Google OAuth callback
 */
router.get("/google/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.error("Google OAuth error:", oauthError);
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(oauthError)}`,
      );
    }

    if (!code || !state) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=missing_params`,
      );
    }

    const { stateData, error: stateError } = await checkCalendarCallback(
      "google",
      state,
      req,
    );
    if (stateError) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${stateError}`,
      );
    }

    const provider = getCalendarProvider("google");

    // Exchange code for tokens
    const tokens = await provider.exchangeCode(code);

    // Get user info
    const userInfo = await provider.getUserInfo(tokens.accessToken);

    // Check if connection already exists
    let connection = await CalendarConnection.findOne({
      userId: stateData.userId,
      provider: "google",
    });

    if (connection) {
      // Update existing connection
      connection.accessToken = tokens.accessToken;
      connection.refreshToken = tokens.refreshToken;
      connection.tokenExpiresAt = tokens.expiresAt;
      connection.accountEmail = userInfo.email;
      connection.accountName = userInfo.name;
      connection.status = "active";
      connection.lastSyncError = null;
      await connection.save();
    } else {
      // Create new connection
      connection = await CalendarConnection.create({
        userId: stateData.userId,
        provider: "google",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        accountEmail: userInfo.email,
        accountName: userInfo.name,
        status: "active",
      });
    }

    // Auto-fetch available calendars and select primary
    try {
      const calendars = await provider.listCalendars(connection);
      connection.selectedCalendars = calendars.map((cal) => ({
        calendarId: cal.calendarId,
        name: cal.name,
        color: cal.color,
        enabled: cal.isPrimary || false,
      }));
      await connection.save();

      // Trigger initial sync
      await syncConnection(connection._id);
    } catch (syncError) {
      logger.warn(
        "Initial calendar sync failed (will retry later):",
        syncError.message,
      );
    }

    // Register webhook for real-time sync (fire-and-forget)
    registerWebhookForConnection(connection._id).catch((err) =>
      logger.warn(
        `[Google OAuth] Webhook registration failed for connection ${connection._id}:`,
        err.message,
      ),
    );

    logger.info(`Google Calendar connected for user ${stateData.userId}`);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_connected=google`,
    );
  } catch (error) {
    logger.error("Google Calendar callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(translateGoogleError(error))}`,
    );
  }
});

// ============================================
// MICROSOFT CALENDAR OAuth
// ============================================

/**
 * GET /calendar-connect/microsoft/authorize
 * Generates Microsoft OAuth URL
 */
router.get("/microsoft/authorize", requireCalendarEdit, async (req, res) => {
  try {
    // Utilisateur et espace validés par requireCalendarEdit
    const user = req.user;

    const provider = getCalendarProvider("microsoft");

    // State signé : utilisateur et espace retrouvés au retour
    const state = createCalendarState("microsoft", user, req.workspaceId);

    const authUrl = await provider.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error("Erreur génération URL Microsoft Calendar:", error);
    res.status(500).json({
      error: "Erreur lors de la génération de l'URL d'autorisation Microsoft",
      details: translateMicrosoftError(error),
    });
  }
});

/**
 * GET /calendar-connect/microsoft/callback
 * Handles Microsoft OAuth callback
 */
router.get("/microsoft/callback", async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.error("Microsoft OAuth error:", oauthError);
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(oauthError)}`,
      );
    }

    if (!code || !state) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=missing_params`,
      );
    }

    const { stateData, error: stateError } = await checkCalendarCallback(
      "microsoft",
      state,
      req,
    );
    if (stateError) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${stateError}`,
      );
    }

    const provider = getCalendarProvider("microsoft");
    const tokens = await provider.exchangeCode(code);
    const userInfo = await provider.getUserInfo(tokens.accessToken);

    let connection = await CalendarConnection.findOne({
      userId: stateData.userId,
      provider: "microsoft",
    });

    if (connection) {
      connection.accessToken = tokens.accessToken;
      connection.refreshToken = tokens.refreshToken;
      connection.tokenExpiresAt = tokens.expiresAt;
      connection.accountEmail = userInfo.email;
      connection.accountName = userInfo.name;
      connection.status = "active";
      connection.lastSyncError = null;
      await connection.save();
    } else {
      connection = await CalendarConnection.create({
        userId: stateData.userId,
        provider: "microsoft",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        accountEmail: userInfo.email,
        accountName: userInfo.name,
        status: "active",
      });
    }

    try {
      const calendars = await provider.listCalendars(connection);
      connection.selectedCalendars = calendars.map((cal) => ({
        calendarId: cal.calendarId,
        name: cal.name,
        color: cal.color,
        enabled: cal.isPrimary || false,
      }));
      await connection.save();
      await syncConnection(connection._id);
    } catch (syncError) {
      logger.warn("Initial Microsoft calendar sync failed:", syncError.message);
    }

    // Register webhook for real-time sync (fire-and-forget)
    registerWebhookForConnection(connection._id).catch((err) =>
      logger.warn(
        `[Microsoft OAuth] Webhook registration failed for connection ${connection._id}:`,
        err.message,
      ),
    );

    logger.info(`Microsoft Calendar connected for user ${stateData.userId}`);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_connected=microsoft`,
    );
  } catch (error) {
    logger.error("Microsoft Calendar callback error:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(translateMicrosoftError(error))}`,
    );
  }
});

export default router;
