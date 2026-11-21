/**
 * PayPal (API Orders v2) pour les transferts payants.
 *
 * Les commandes sont créées avec l'application PayPal de Newbi
 * (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) en désignant le compte PayPal du
 * vendeur comme bénéficiaire (`payee.email_address`) : l'argent arrive
 * directement chez lui et les frais PayPal sont prélevés sur son compte.
 * Newbi n'encaisse rien et ne détient aucun identifiant du vendeur.
 *
 * Le paiement est capturé par l'API (retour du payeur, ou visite suivante de
 * la page du transfert) : aucun webhook PayPal n'est nécessaire pour
 * débloquer le transfert.
 *
 * PAYPAL_MODE = « live » pour la production ; toute autre valeur (ou
 * absente) utilise le bac à sable.
 */

const PAYPAL_TIMEOUT_MS = 15_000;

// Identifiants de commande et de capture PayPal : lettres et chiffres
const PAYPAL_ID = /^[A-Za-z0-9-]{5,64}$/;

export class PaypalApiError extends Error {
  constructor(message, { status = null, issue = null, details = null } = {}) {
    super(message);
    this.name = "PaypalApiError";
    this.status = status;
    this.issue = issue;
    this.details = details;
  }
}

export function isPaypalConfigured(env = process.env) {
  return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}

export function paypalApiBase(env = process.env) {
  return env.PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function isPaypalId(value) {
  return typeof value === "string" && PAYPAL_ID.test(value);
}

/** Montant au format attendu par PayPal (« 25.00 »). */
export function formatPaypalAmount(amount) {
  return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

async function callPaypal(path, { method = "GET", body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAYPAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${paypalApiBase()}${path}`, {
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
      const issue =
        data?.details?.[0]?.issue || data?.name || data?.error || null;
      throw new PaypalApiError(
        data?.message ||
          data?.error_description ||
          `Erreur PayPal (${response.status})`,
        { status: response.status, issue, details: data?.details || null },
      );
    }
    return data;
  } catch (error) {
    if (error instanceof PaypalApiError) throw error;
    throw new PaypalApiError(
      error?.name === "AbortError"
        ? "PayPal ne répond pas"
        : `PayPal injoignable : ${error?.message || error}`,
      { issue: "NETWORK" },
    );
  } finally {
    clearTimeout(timer);
  }
}

// Jeton d'accès de l'application Newbi, réutilisé jusqu'à son expiration
let cachedToken = null;

/** Oublie le jeton en cache (tests, changement de clés). */
export function resetPaypalTokenCache() {
  cachedToken = null;
}

export async function getPaypalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) {
    throw new PaypalApiError("PayPal n'est pas configuré", {
      status: 503,
      issue: "NOT_CONFIGURED",
    });
  }
  const key = `${paypalApiBase()}|${clientId}`;
  if (
    cachedToken &&
    cachedToken.key === key &&
    cachedToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedToken.value;
  }
  const data = await callPaypal("/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!data?.access_token) {
    throw new PaypalApiError("Jeton PayPal absent de la réponse", {
      issue: "NO_TOKEN",
    });
  }
  cachedToken = {
    key,
    value: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 300) * 1000,
  };
  return cachedToken.value;
}

async function authorizedCall(path, options = {}) {
  const token = await getPaypalAccessToken();
  return callPaypal(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

/**
 * Crée la commande : le vendeur (payeeEmail) reçoit l'argent.
 * @returns {Promise<{id: string, status: string, approveUrl: string|null}>}
 */
export async function createPaypalOrder({
  amount,
  currency,
  payeeEmail,
  description,
  customId,
  brandName,
  returnUrl,
  cancelUrl,
  requestId,
}) {
  const order = await authorizedCall("/v2/checkout/orders", {
    method: "POST",
    headers: {
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: customId,
          custom_id: customId,
          description: description
            ? String(description).slice(0, 127)
            : undefined,
          amount: {
            currency_code: String(currency).toUpperCase(),
            value: formatPaypalAmount(amount),
          },
          payee: { email_address: payeeEmail },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: brandName ? String(brandName).slice(0, 127) : undefined,
            locale: "fr-FR",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }),
  });
  const approveUrl =
    order?.links?.find((link) => link.rel === "payer-action")?.href ||
    order?.links?.find((link) => link.rel === "approve")?.href ||
    null;
  return { id: order?.id, status: order?.status, approveUrl };
}

export async function getPaypalOrder(orderId) {
  if (!isPaypalId(orderId)) {
    throw new PaypalApiError("Commande PayPal invalide", {
      issue: "INVALID_ID",
    });
  }
  return authorizedCall(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/**
 * Capture une commande approuvée par le payeur. Une commande déjà capturée
 * (double retour, visite suivante) est relue plutôt que refusée.
 */
export async function capturePaypalOrder(orderId) {
  if (!isPaypalId(orderId)) {
    throw new PaypalApiError("Commande PayPal invalide", {
      issue: "INVALID_ID",
    });
  }
  try {
    return await authorizedCall(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: "POST",
        headers: {
          "PayPal-Request-Id": `capture-${orderId}`,
          Prefer: "return=representation",
        },
        body: "{}",
      },
    );
  } catch (error) {
    if (
      error instanceof PaypalApiError &&
      error.issue === "ORDER_ALREADY_CAPTURED"
    ) {
      return getPaypalOrder(orderId);
    }
    throw error;
  }
}

export async function getPaypalCapture(captureId) {
  if (!isPaypalId(captureId)) {
    throw new PaypalApiError("Paiement PayPal invalide", {
      issue: "INVALID_ID",
    });
  }
  return authorizedCall(
    `/v2/payments/captures/${encodeURIComponent(captureId)}`,
  );
}

/** Ce qui compte d'une commande : capture, bénéficiaire, payeur, montant. */
export function summarizePaypalOrder(order) {
  const unit = order?.purchase_units?.[0] || {};
  const capture = unit?.payments?.captures?.[0] || null;
  const amountSource = capture?.amount || unit?.amount || {};
  const amount = Number(amountSource.value);
  return {
    orderId: order?.id || null,
    orderStatus: order?.status || null,
    customId: unit?.custom_id || capture?.custom_id || null,
    payeeEmail: unit?.payee?.email_address
      ? String(unit.payee.email_address).toLowerCase()
      : null,
    payerEmail:
      order?.payer?.email_address ||
      order?.payment_source?.paypal?.email_address ||
      null,
    captureId: capture?.id || null,
    captureStatus: capture?.status || null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: amountSource.currency_code || null,
  };
}
