import { google } from 'googleapis';
import logger from '../../utils/logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

export function translateGmailError(error) {
  const msg = error.message || '';
  const status = error.code || error.status;

  if (status === 401 || msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
    return 'Session Google expirée. Veuillez reconnecter votre compte Gmail.';
  }
  if (status === 403 || msg.includes('insufficientPermissions')) {
    return 'Permissions insuffisantes. Veuillez reconnecter votre compte Gmail et autoriser l\'accès en lecture.';
  }
  if (status === 404) {
    return 'Ressource Gmail introuvable.';
  }
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('network')) {
    return 'Impossible de joindre les serveurs Google. Vérifiez votre connexion internet.';
  }
  if (msg.includes('Rate Limit') || status === 429) {
    return 'Trop de requêtes vers Google. Réessayez dans quelques instants.';
  }
  return `Erreur Gmail : ${msg}`;
}

export default class GmailOAuthProvider {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
      `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/gmail-connect/callback`
    );
  }

  getAuthUrl(state) {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state
    });
  }

  async exchangeCode(code) {
    const response = await this.oauth2Client.getToken(code);
    const tokens = response.tokens;
    logger.info('Gmail OAuth tokens received:', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
    });
    this.oauth2Client.setCredentials(tokens);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
    };
  }

  async getUserInfo(accessToken) {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google userinfo failed: ${response.status}`);
    }
    const data = await response.json();
    return {
      email: data.email,
      name: data.name,
    };
  }

  async refreshAccessToken(connection) {
    const refreshToken = connection.getDecryptedRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauth2Client.refreshAccessToken();

    await connection.updateTokens(
      credentials.access_token,
      credentials.refresh_token || null,
      credentials.expiry_date ? new Date(credentials.expiry_date) : null
    );

    return credentials.access_token;
  }

  async ensureValidToken(connection) {
    if (connection.isTokenExpired()) {
      logger.info(`[Gmail] Token expiré pour ${connection.accountEmail}, refresh en cours...`);
      return await this.refreshAccessToken(connection);
    }
    return connection.getDecryptedAccessToken();
  }

  getGmailClient(accessToken) {
    this.oauth2Client.setCredentials({ access_token: accessToken });
    return google.gmail({ version: 'v1', auth: this.oauth2Client });
  }
}
