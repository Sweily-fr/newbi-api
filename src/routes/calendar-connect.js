import express from 'express';
import { betterAuthJWTMiddleware } from '../middlewares/better-auth-jwt.js';
import CalendarConnection from '../models/CalendarConnection.js';
import { getCalendarProvider } from '../services/calendar/CalendarProviderFactory.js';
import { syncConnection } from '../services/calendar/CalendarSyncService.js';
import { translateGoogleError } from '../services/calendar/providers/GoogleCalendarProvider.js';
import { translateMicrosoftError } from '../services/calendar/providers/MicrosoftCalendarProvider.js';
import logger from '../utils/logger.js';

const router = express.Router();

// ============================================
// GOOGLE CALENDAR OAuth
// ============================================

/**
 * GET /calendar-connect/google/authorize
 * Generates Google OAuth URL and redirects
 */
router.get('/google/authorize', async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const provider = getCalendarProvider('google');

    // State contains userId + timestamp to identify user on callback
    const state = Buffer.from(JSON.stringify({
      userId: user._id.toString(),
      issuedAt: Date.now()
    })).toString('base64');

    const authUrl = provider.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error('Erreur génération URL Google Calendar:', error);
    res.status(500).json({ error: 'Erreur lors de la génération de l\'URL d\'autorisation Google', details: translateGoogleError(error) });
  }
});

/**
 * GET /calendar-connect/google/callback
 * Handles Google OAuth callback
 */
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.error('Google OAuth error:', oauthError);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(oauthError)}`);
    }

    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=missing_params`);
    }

    // Decode state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=invalid_state`);
    }

    // Validate state expiration (15 minutes max)
    if (!stateData.issuedAt || Date.now() - stateData.issuedAt > 15 * 60 * 1000) {
      logger.warn(`[Google OAuth] State expiré pour userId ${stateData.userId}`);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=state_expired`);
    }

    // Validate authenticated user matches state
    let callbackUser;
    try {
      callbackUser = await betterAuthJWTMiddleware(req);
    } catch { /* pas de JWT dans le callback, on continue avec le state */ }

    if (callbackUser && callbackUser._id.toString() !== stateData.userId) {
      logger.error(`[Google OAuth] userId mismatch: state=${stateData.userId}, jwt=${callbackUser._id}`);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=user_mismatch`);
    }

    const provider = getCalendarProvider('google');

    // Exchange code for tokens
    const tokens = await provider.exchangeCode(code);

    // Get user info
    const userInfo = await provider.getUserInfo(tokens.accessToken);

    // Check if connection already exists
    let connection = await CalendarConnection.findOne({
      userId: stateData.userId,
      provider: 'google'
    });

    if (connection) {
      // Update existing connection
      connection.accessToken = tokens.accessToken;
      connection.refreshToken = tokens.refreshToken;
      connection.tokenExpiresAt = tokens.expiresAt;
      connection.accountEmail = userInfo.email;
      connection.accountName = userInfo.name;
      connection.status = 'active';
      connection.lastSyncError = null;
      await connection.save();
    } else {
      // Create new connection
      connection = await CalendarConnection.create({
        userId: stateData.userId,
        provider: 'google',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        accountEmail: userInfo.email,
        accountName: userInfo.name,
        status: 'active'
      });
    }

    // Auto-fetch available calendars and select primary
    try {
      const calendars = await provider.listCalendars(connection);
      connection.selectedCalendars = calendars.map(cal => ({
        calendarId: cal.calendarId,
        name: cal.name,
        color: cal.color,
        enabled: cal.isPrimary || false
      }));
      await connection.save();

      // Trigger initial sync
      await syncConnection(connection._id);
    } catch (syncError) {
      logger.warn('Initial calendar sync failed (will retry later):', syncError.message);
    }

    logger.info(`Google Calendar connected for user ${stateData.userId}`);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_connected=google`);
  } catch (error) {
    logger.error('Google Calendar callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(translateGoogleError(error))}`);
  }
});

// ============================================
// MICROSOFT CALENDAR OAuth
// ============================================

/**
 * GET /calendar-connect/microsoft/authorize
 * Generates Microsoft OAuth URL
 */
router.get('/microsoft/authorize', async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const provider = getCalendarProvider('microsoft');

    const state = Buffer.from(JSON.stringify({
      userId: user._id.toString(),
      issuedAt: Date.now()
    })).toString('base64');

    const authUrl = await provider.getAuthUrl(state);
    res.json({ authUrl });
  } catch (error) {
    logger.error('Erreur génération URL Microsoft Calendar:', error);
    res.status(500).json({ error: 'Erreur lors de la génération de l\'URL d\'autorisation Microsoft', details: translateMicrosoftError(error) });
  }
});

/**
 * GET /calendar-connect/microsoft/callback
 * Handles Microsoft OAuth callback
 */
router.get('/microsoft/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.error('Microsoft OAuth error:', oauthError);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(oauthError)}`);
    }

    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=missing_params`);
    }

    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=invalid_state`);
    }

    // Validate state expiration (15 minutes max)
    if (!stateData.issuedAt || Date.now() - stateData.issuedAt > 15 * 60 * 1000) {
      logger.warn(`[Microsoft OAuth] State expiré pour userId ${stateData.userId}`);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=state_expired`);
    }

    // Validate authenticated user matches state
    let callbackUser;
    try {
      callbackUser = await betterAuthJWTMiddleware(req);
    } catch { /* pas de JWT dans le callback, on continue avec le state */ }

    if (callbackUser && callbackUser._id.toString() !== stateData.userId) {
      logger.error(`[Microsoft OAuth] userId mismatch: state=${stateData.userId}, jwt=${callbackUser._id}`);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=user_mismatch`);
    }

    const provider = getCalendarProvider('microsoft');
    const tokens = await provider.exchangeCode(code);
    const userInfo = await provider.getUserInfo(tokens.accessToken);

    let connection = await CalendarConnection.findOne({
      userId: stateData.userId,
      provider: 'microsoft'
    });

    if (connection) {
      connection.accessToken = tokens.accessToken;
      connection.refreshToken = tokens.refreshToken;
      connection.tokenExpiresAt = tokens.expiresAt;
      connection.accountEmail = userInfo.email;
      connection.accountName = userInfo.name;
      connection.status = 'active';
      connection.lastSyncError = null;
      await connection.save();
    } else {
      connection = await CalendarConnection.create({
        userId: stateData.userId,
        provider: 'microsoft',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        accountEmail: userInfo.email,
        accountName: userInfo.name,
        status: 'active'
      });
    }

    try {
      const calendars = await provider.listCalendars(connection);
      connection.selectedCalendars = calendars.map(cal => ({
        calendarId: cal.calendarId,
        name: cal.name,
        color: cal.color,
        enabled: cal.isPrimary || false
      }));
      await connection.save();
      await syncConnection(connection._id);
    } catch (syncError) {
      logger.warn('Initial Microsoft calendar sync failed:', syncError.message);
    }

    logger.info(`Microsoft Calendar connected for user ${stateData.userId}`);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_connected=microsoft`);
  } catch (error) {
    logger.error('Microsoft Calendar callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/calendar?calendar_error=${encodeURIComponent(translateMicrosoftError(error))}`);
  }
});

export default router;
