/**
 * Réglages de la prospection lus dans l'environnement.
 *
 *   PROSPECTING_GOOGLE_CLIENT_ID / _SECRET        projet Google dédié (scope
 *                                                 gmail.send), AUCUN repli
 *                                                 sur le client du calendrier
 *   PROSPECTING_MICROSOFT_CLIENT_ID / _SECRET     appli Microsoft (Mail.Send),
 *                                                 repli sur
 *                                                 MICROSOFT_CALENDAR_CLIENT_ID
 *                                                 / _SECRET
 *   PROSPECTING_MAX_DAILY_PER_MAILBOX             plafond d'e-mails par jour et
 *                                                 par boîte (défaut 50)
 *
 * Un fournisseur sans identifiants : bouton de connexion désactivé sur le
 * site (`providers.google|microsoft = false`) et autorisation refusée.
 */
import {
  DEFAULT_DAILY_LIMIT,
  MIN_DAILY_LIMIT,
} from "../../models/MailboxConnection.js";

export const DEFAULT_MAX_DAILY_PER_MAILBOX = 50;
// Plafond absolu, même si la variable demande plus (réputation de la boîte)
const ABSOLUTE_MAX_DAILY = 500;

const clean = (value) => (typeof value === "string" ? value.trim() : "");

export function googleCredentials(env = process.env) {
  return {
    clientId: clean(env.PROSPECTING_GOOGLE_CLIENT_ID),
    clientSecret: clean(env.PROSPECTING_GOOGLE_CLIENT_SECRET),
  };
}

export function microsoftCredentials(env = process.env) {
  return {
    clientId:
      clean(env.PROSPECTING_MICROSOFT_CLIENT_ID) ||
      clean(env.MICROSOFT_CALENDAR_CLIENT_ID),
    clientSecret:
      clean(env.PROSPECTING_MICROSOFT_CLIENT_SECRET) ||
      clean(env.MICROSOFT_CALENDAR_CLIENT_SECRET),
  };
}

const configured = ({ clientId, clientSecret }) =>
  Boolean(clientId && clientSecret);

/** Fournisseurs utilisables : { google, microsoft }. */
export function availableProviders(env = process.env) {
  return {
    google: configured(googleCredentials(env)),
    microsoft: configured(microsoftCredentials(env)),
  };
}

/** GOOGLE | MICROSOFT → identifiants présents ? */
export function isProviderConfigured(provider, env = process.env) {
  const providers = availableProviders(env);
  return provider === "GOOGLE" ? providers.google : providers.microsoft;
}

/** Plafond d'e-mails par jour et par boîte. */
export function maxDailyLimit(env = process.env) {
  const value = Number.parseInt(env.PROSPECTING_MAX_DAILY_PER_MAILBOX, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_DAILY_PER_MAILBOX;
  }
  return Math.min(ABSOLUTE_MAX_DAILY, Math.max(MIN_DAILY_LIMIT, value));
}

/** Limite conseillée et proposée par défaut (30, bornée au plafond). */
export function defaultDailyLimit(env = process.env) {
  return Math.min(DEFAULT_DAILY_LIMIT, maxDailyLimit(env));
}

/** Limite d'une boîte bornée à [5, plafond]. */
export function clampDailyLimit(value, env = process.env) {
  const number = Number(value);
  const limit = Number.isFinite(number)
    ? Math.round(number)
    : defaultDailyLimit(env);
  return Math.min(maxDailyLimit(env), Math.max(MIN_DAILY_LIMIT, limit));
}

/** Adresse publique de l'API (retours OAuth). */
export function apiPublicUrl(env = process.env) {
  return (env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(
    /\/+$/,
    "",
  );
}

/** Page Prospection du site (retour OAuth, e-mails au membre). */
export function prospectingPageUrl(env = process.env) {
  return `${(env.FRONTEND_URL || "https://www.newbi.fr").replace(/\/+$/, "")}/dashboard/outils/prospection`;
}
