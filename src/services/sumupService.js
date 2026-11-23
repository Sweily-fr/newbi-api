/**
 * SumUp pour les transferts payants.
 *
 * Le client connecte son compte marchand SumUp par OAuth (« Connecter mon
 * compte SumUp ») ; chaque paiement est ensuite un checkout créé sur SON
 * compte, payé sur la page de paiement hébergée par SumUp : l'argent arrive
 * directement chez lui et SumUp y prélève ses frais habituels. Newbi
 * n'encaisse rien et ne paie rien.
 *
 * Application OAuth de Newbi : SUMUP_CLIENT_ID / SUMUP_CLIENT_SECRET, avec
 * le scope « payments » accordé par SumUp. Adresse de retour :
 * <API>/sumup/callback (SUMUP_REDIRECT_URI pour la changer). Les jetons sont
 * chiffrés en base (DATA_ENCRYPTION_KEY).
 *
 * Le paiement est vérifié en relisant le checkout auprès de SumUp (retour du
 * payeur, notification de SumUp, visite suivante) : les notifications de
 * SumUp ne sont pas signées, elles ne servent qu'à déclencher cette relecture.
 */
import SumupMerchantAccount from "../models/SumupMerchantAccount.js";
import { decrypt, encrypt } from "../utils/encryption.js";
import logger from "../utils/logger.js";
import { apiPublicUrl } from "./stripeConnectService.js";

export const SUMUP_API_BASE = "https://api.sumup.com";
export const SUMUP_AUTHORIZE_URL = "https://api.sumup.com/authorize";
export const SUMUP_TOKEN_URL = "https://api.sumup.com/token";
// payments : créer et relire les paiements ; user.profile_readonly : code
// marchand, nom et devise du compte
export const SUMUP_SCOPES = Object.freeze([
  "payments",
  "user.profile_readonly",
]);

const SUMUP_TIMEOUT_MS = 15_000;
// Jeton d'accès renouvelé un peu avant son expiration
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;
// Identifiant d'un checkout SumUp (UUID)
const CHECKOUT_ID = /^[A-Za-z0-9-]{8,64}$/;

export class SumupApiError extends Error {
  constructor(message, { status = null, code = null, details = null } = {}) {
    super(message);
    this.name = "SumupApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isSumupConfigured(env = process.env) {
  return Boolean(
    env.SUMUP_CLIENT_ID && env.SUMUP_CLIENT_SECRET && env.DATA_ENCRYPTION_KEY,
  );
}

export function sumupRedirectUri(env = process.env) {
  return env.SUMUP_REDIRECT_URI || `${apiPublicUrl(env)}/sumup/callback`;
}

/**
 * Adresse où SumUp prévient d'un changement d'état d'un paiement : seulement
 * si l'API est joignable en https (en local, la vérification au retour et à
 * la visite suffit).
 */
export function sumupWebhookUrl(env = process.env) {
  const base = apiPublicUrl(env);
  return base.startsWith("https://") ? `${base}/webhook/sumup` : null;
}

export function isSumupCheckoutId(value) {
  return typeof value === "string" && CHECKOUT_ID.test(value);
}

/** Montant au format attendu par SumUp (nombre à deux décimales). */
export function formatSumupAmount(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

/** Page SumUp où le client autorise Newbi. */
export function buildSumupOAuthUrl({ state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SUMUP_CLIENT_ID,
    redirect_uri: sumupRedirectUri(),
    scope: SUMUP_SCOPES.join(" "),
    state,
  });
  return `${SUMUP_AUTHORIZE_URL}?${params.toString()}`;
}

async function callSumup(url, { method = "GET", headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMUP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const first = Array.isArray(data) ? data[0] : data;
      throw new SumupApiError(
        first?.message ||
          first?.error_description ||
          first?.detail ||
          first?.title ||
          `Erreur SumUp (${response.status})`,
        {
          status: response.status,
          code: first?.error_code || first?.error || null,
          details: data,
        },
      );
    }
    return data;
  } catch (error) {
    if (error instanceof SumupApiError) throw error;
    throw new SumupApiError(
      error?.name === "AbortError"
        ? "SumUp ne répond pas"
        : `SumUp injoignable : ${error?.message || error}`,
      { code: "NETWORK" },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requestToken(fields) {
  return callSumup(SUMUP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SUMUP_CLIENT_ID || "",
      client_secret: process.env.SUMUP_CLIENT_SECRET || "",
      ...fields,
    }).toString(),
  });
}

/** Code d'autorisation du retour OAuth échangé contre les jetons. */
export function exchangeSumupOAuthCode(code) {
  return requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: sumupRedirectUri(),
  });
}

function refreshSumupToken(refreshToken) {
  return requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/** Le jeton couvre-t-il la création de paiements ? */
export function tokenAllowsPayments(token) {
  // Réponse sans liste de scopes : SumUp a accordé ceux demandés
  if (!token?.scope) return true;
  return String(token.scope)
    .split(/[\s,]+/)
    .includes("payments");
}

async function authorizedCall(accessToken, path, options = {}) {
  return callSumup(`${SUMUP_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
}

/**
 * Compte marchand du jeton : code marchand, nom, e-mail et devise.
 * @returns {Promise<{merchantCode: string|null, businessName: string|null, email: string|null, currency: string|null}>}
 */
export async function fetchSumupMerchantProfile(accessToken) {
  const me = await authorizedCall(accessToken, "/v0.1/me");
  const merchant = me?.merchant_profile || {};
  return {
    merchantCode: merchant.merchant_code || null,
    businessName:
      merchant.doing_business_as?.business_name ||
      merchant.company_name ||
      null,
    email: me?.account?.username || null,
    currency:
      merchant.default_currency ||
      merchant.currency ||
      me?.app_settings?.currency ||
      null,
  };
}

// ---------------------------------------------------------------------------
// Compte connecté : enregistrement et jetons
// ---------------------------------------------------------------------------

const expiryFromToken = (token) =>
  new Date(Date.now() + (Number(token?.expires_in) || 3600) * 1000);

/**
 * Rattache le compte marchand à l'espace (retour OAuth). Un même compte
 * SumUp ne peut servir qu'un espace.
 * @returns {Promise<{ok: true, account: object}|{ok: false, error: string}>}
 */
export async function saveSumupConnection({
  organizationId,
  userId,
  token,
  profile,
}) {
  if (!profile?.merchantCode) return { ok: false, error: "no_merchant" };
  const elsewhere = await SumupMerchantAccount.findOne({
    merchantCode: profile.merchantCode,
    organizationId: { $ne: String(organizationId) },
  }).lean();
  if (elsewhere) return { ok: false, error: "already_connected" };

  const account = await SumupMerchantAccount.findOneAndUpdate(
    { organizationId: String(organizationId) },
    {
      $set: {
        merchantCode: profile.merchantCode,
        businessName: profile.businessName || undefined,
        email: profile.email || undefined,
        currency: profile.currency || undefined,
        accessToken: encrypt(token.access_token),
        accessTokenExpiresAt: expiryFromToken(token),
        refreshToken: token.refresh_token
          ? encrypt(token.refresh_token)
          : undefined,
        scope: token.scope || SUMUP_SCOPES.join(" "),
        status: "active",
        connectedBy: userId || undefined,
        connectedAt: new Date(),
      },
      $setOnInsert: { organizationId: String(organizationId) },
    },
    { upsert: true, new: true },
  );
  return { ok: true, account };
}

// Renouvellements en cours dans ce processus : un seul appel à SumUp par
// compte, même si plusieurs paiements le demandent en même temps
const refreshing = new Map();

async function renewAccessToken(account) {
  const storedRefresh = account.refreshToken;
  if (!storedRefresh) {
    await markReconnect(account._id, storedRefresh);
    throw new SumupApiError("Connexion SumUp à renouveler", {
      code: "RECONNECT",
    });
  }
  try {
    const token = await refreshSumupToken(decrypt(storedRefresh));
    if (!token?.access_token) {
      throw new SumupApiError("Jeton SumUp absent de la réponse", {
        code: "NO_TOKEN",
      });
    }
    // Écrit seulement si personne n'a renouvelé entre-temps (autre instance)
    await SumupMerchantAccount.updateOne(
      { _id: account._id, refreshToken: storedRefresh },
      {
        $set: {
          accessToken: encrypt(token.access_token),
          accessTokenExpiresAt: expiryFromToken(token),
          ...(token.refresh_token
            ? { refreshToken: encrypt(token.refresh_token) }
            : {}),
          status: "active",
        },
      },
    );
    return token.access_token;
  } catch (error) {
    if (
      error instanceof SumupApiError &&
      (error.code === "invalid_grant" || error.status === 401)
    ) {
      // Une autre instance a pu renouveler avec ce même jeton juste avant
      const latest = await SumupMerchantAccount.findById(account._id).lean();
      if (
        latest &&
        latest.refreshToken !== storedRefresh &&
        latest.accessToken &&
        new Date(latest.accessTokenExpiresAt).getTime() > Date.now()
      ) {
        return decrypt(latest.accessToken);
      }
      await markReconnect(account._id, storedRefresh);
      throw new SumupApiError("Connexion SumUp à renouveler", {
        code: "RECONNECT",
        status: error.status,
      });
    }
    throw error;
  }
}

async function markReconnect(accountId, storedRefresh) {
  await SumupMerchantAccount.updateOne(
    {
      _id: accountId,
      ...(storedRefresh ? { refreshToken: storedRefresh } : {}),
    },
    { $set: { status: "reconnect" } },
  );
  logger.warn(
    `[sumup] Compte ${accountId} : accès refusé par SumUp, reconnexion nécessaire`,
  );
}

/** Jeton d'accès valide du compte (renouvelé au besoin). */
export async function getSumupAccessToken(account) {
  if (!account) {
    throw new SumupApiError("Aucun compte SumUp", { code: "NO_ACCOUNT" });
  }
  if (account.status === "reconnect") {
    throw new SumupApiError("Connexion SumUp à renouveler", {
      code: "RECONNECT",
    });
  }
  const expiresAt = account.accessTokenExpiresAt
    ? new Date(account.accessTokenExpiresAt).getTime()
    : 0;
  if (account.accessToken && expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return decrypt(account.accessToken);
  }
  const key = String(account._id);
  if (!refreshing.has(key)) {
    refreshing.set(
      key,
      renewAccessToken(account).finally(() => refreshing.delete(key)),
    );
  }
  return refreshing.get(key);
}

/** Appel au nom du compte connecté, jeton renouvelé une fois si refusé. */
async function callAsMerchant(account, path, options = {}) {
  const accessToken = await getSumupAccessToken(account);
  try {
    return await authorizedCall(accessToken, path, options);
  } catch (error) {
    if (!(error instanceof SumupApiError) || error.status !== 401) throw error;
    // Jeton refusé avant son expiration annoncée : renouvelé, un seul essai
    const fresh = await renewAccessToken(
      (await SumupMerchantAccount.findById(account._id)) || account,
    );
    return authorizedCall(fresh, path, options);
  }
}

// ---------------------------------------------------------------------------
// Paiements (checkouts)
// ---------------------------------------------------------------------------

/**
 * Crée le paiement sur le compte du vendeur, avec la page de paiement
 * hébergée par SumUp.
 * @returns {Promise<{id: string, status: string, url: string|null}>}
 */
export async function createSumupCheckout(
  account,
  { reference, amount, currency, description, redirectUrl },
) {
  const webhookUrl = sumupWebhookUrl();
  const checkout = await callAsMerchant(account, "/v0.1/checkouts", {
    method: "POST",
    body: JSON.stringify({
      checkout_reference: reference,
      amount: formatSumupAmount(amount),
      currency: String(currency || "EUR").toUpperCase(),
      merchant_code: account.merchantCode,
      description: description ? String(description).slice(0, 255) : undefined,
      redirect_url: redirectUrl,
      ...(webhookUrl ? { return_url: webhookUrl } : {}),
      hosted_checkout: { enabled: true },
    }),
  });
  return {
    id: checkout?.id || null,
    status: checkout?.status || null,
    url: checkout?.hosted_checkout_url || null,
  };
}

export async function getSumupCheckout(account, checkoutId) {
  if (!isSumupCheckoutId(checkoutId)) {
    throw new SumupApiError("Paiement SumUp invalide", { code: "INVALID_ID" });
  }
  return callAsMerchant(
    account,
    `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
  );
}

/** Ferme un paiement encore ouvert (plus payable). */
export async function deactivateSumupCheckout(account, checkoutId) {
  if (!isSumupCheckoutId(checkoutId)) return false;
  await callAsMerchant(
    account,
    `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
    { method: "DELETE" },
  );
  return true;
}

/** Rembourse une transaction (second paiement d'un transfert déjà payé). */
export async function refundSumupTransaction(account, transactionId) {
  await callAsMerchant(
    account,
    `/v0.1/me/refund/${encodeURIComponent(transactionId)}`,
    { method: "POST", body: "{}" },
  );
  return true;
}

/** Ce qui compte d'un checkout : état, référence, marchand, montant. */
export function summarizeSumupCheckout(checkout) {
  const transactions = Array.isArray(checkout?.transactions)
    ? checkout.transactions
    : [];
  const successful =
    transactions.find((t) => t?.status === "SUCCESSFUL") ||
    transactions[0] ||
    null;
  const amount = Number(checkout?.amount);
  return {
    id: checkout?.id || null,
    status: checkout?.status ? String(checkout.status).toUpperCase() : null,
    reference: checkout?.checkout_reference || null,
    merchantCode: checkout?.merchant_code || null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: checkout?.currency
      ? String(checkout.currency).toUpperCase()
      : null,
    transactionId: successful?.id || checkout?.transaction_id || null,
    transactionCode:
      successful?.transaction_code || checkout?.transaction_code || null,
  };
}
