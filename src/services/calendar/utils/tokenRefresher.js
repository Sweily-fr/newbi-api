import { google } from 'googleapis';
import { ConfidentialClientApplication } from '@azure/msal-node';
import logger from '../../../utils/logger.js';

/**
 * Refresh Google OAuth tokens
 */
export async function refreshGoogleToken(connection) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    );

    oauth2Client.setCredentials({
      refresh_token: connection.getDecryptedRefreshToken()
    });

    const { credentials } = await oauth2Client.refreshAccessToken();

    await connection.updateTokens(
      credentials.access_token,
      credentials.refresh_token || null,
      credentials.expiry_date ? new Date(credentials.expiry_date) : null
    );

    logger.info(`Google token refreshed for connection ${connection._id}`);
    return credentials.access_token;
  } catch (error) {
    logger.error(`Failed to refresh Google token for connection ${connection._id}:`, error.message);
    connection.status = 'expired';
    connection.lastSyncError = 'Token expiré. Veuillez reconnecter votre calendrier Google.';
    await connection.save();
    throw error;
  }
}

/**
 * Refresh Microsoft OAuth tokens
 */
export async function refreshMicrosoftToken(connection) {
  try {
    const msalConfig = {
      auth: {
        clientId: process.env.MICROSOFT_CALENDAR_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CALENDAR_CLIENT_SECRET,
        authority: 'https://login.microsoftonline.com/common'
      }
    };

    const cca = new ConfidentialClientApplication(msalConfig);

    const result = await cca.acquireTokenByRefreshToken({
      refreshToken: connection.getDecryptedRefreshToken(),
      scopes: ['https://graph.microsoft.com/Calendars.ReadWrite']
    });

    const expiresAt = result.expiresOn ? new Date(result.expiresOn) : new Date(Date.now() + 3600 * 1000);

    await connection.updateTokens(
      result.accessToken,
      null, // Microsoft doesn't always return a new refresh token
      expiresAt
    );

    logger.info(`Microsoft token refreshed for connection ${connection._id}`);
    return result.accessToken;
  } catch (error) {
    logger.error(`Failed to refresh Microsoft token for connection ${connection._id}:`, error.message);
    connection.status = 'expired';
    connection.lastSyncError = 'Token expiré. Veuillez reconnecter votre calendrier Outlook.';
    await connection.save();
    throw error;
  }
}

/**
 * Ensure a valid access token is available for the given connection
 */
export async function ensureValidToken(connection) {
  if (connection.provider === 'apple') {
    // Apple uses CalDAV with username/password, no token refresh needed
    return null;
  }

  if (!connection.isTokenExpired()) {
    return connection.getDecryptedAccessToken();
  }

  if (connection.provider === 'google') {
    return refreshGoogleToken(connection);
  }

  if (connection.provider === 'microsoft') {
    return refreshMicrosoftToken(connection);
  }

  throw new Error(`Unknown provider: ${connection.provider}`);
}
