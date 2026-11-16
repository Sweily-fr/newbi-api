/**
 * Envoi des campagnes e-mail par Resend : mode d'envoi, expéditeur, lots.
 *
 * Mode (EMAIL_CAMPAIGN_SEND_MODE) :
 *   live        envoi réel (défaut en production) ;
 *   simulation  aucun appel à Resend, statuts et compteurs avancent comme
 *               en vrai (destinataires SIMULATED) ;
 *   restricted  (défaut hors production) envoi réel seulement aux adresses
 *               et domaines de EMAIL_CAMPAIGN_DEV_RECIPIENTS
 *               (ex. « dylan@x.fr,@sweily.fr »), simulé pour les autres.
 * Les e-mails de test suivent la même règle.
 *
 * Expéditeur : « Nom affiché <EMAIL_CAMPAIGN_FROM_EMAIL> » (repli
 * RESEND_FROM_EMAIL), jamais l'adresse du client (DMARC échouerait), et
 * l'adresse de l'entreprise en réponse. En-têtes de désinscription en un
 * clic (RFC 8058) sur chaque e-mail.
 *
 * Lots de 100 au plus (`resend.batch.send`, validation permissive : une
 * adresse refusée n'empêche pas les autres), avec une clé d'idempotence par
 * lot : un lot rejoué après un arrêt brutal n'est pas envoyé deux fois.
 */
import { Resend } from "resend";
import { singleLine } from "./design.js";

export const BATCH_SIZE = 100;
// Un appel toutes les 1,2 s au plus : la limite de débit de Resend est
// partagée avec les e-mails de documents
export const BATCH_INTERVAL_MS = 1200;
export const DEFAULT_MAX_PER_MINUTE = 600;

export const SEND_MODES = ["LIVE", "SIMULATION", "RESTRICTED"];

export function campaignSendMode(env = process.env) {
  const value = String(env.EMAIL_CAMPAIGN_SEND_MODE || "")
    .trim()
    .toLowerCase();
  if (value === "live") return "LIVE";
  if (value === "simulation") return "SIMULATION";
  if (value === "restricted") return "RESTRICTED";
  return env.NODE_ENV === "production" ? "LIVE" : "RESTRICTED";
}

/** Adresses et domaines (« @domaine ») qui reçoivent vraiment, hors live. */
export function devRecipients(env = process.env) {
  const emails = new Set();
  const domains = new Set();
  for (const entry of String(env.EMAIL_CAMPAIGN_DEV_RECIPIENTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)) {
    if (entry.startsWith("@")) domains.add(entry.slice(1));
    else emails.add(entry);
  }
  return { emails, domains };
}

/** L'adresse reçoit-elle un vrai e-mail dans ce mode ? */
export function isRealSendAllowed(
  email,
  mode = campaignSendMode(),
  env = process.env,
) {
  if (mode === "LIVE") return true;
  if (mode !== "RESTRICTED") return false;
  const address = String(email || "").toLowerCase();
  const { emails, domains } = devRecipients(env);
  return emails.has(address) || domains.has(address.split("@")[1] || "");
}

export function campaignSenderEmail(env = process.env) {
  return (
    String(
      env.EMAIL_CAMPAIGN_FROM_EMAIL ||
        env.RESEND_FROM_EMAIL ||
        "no-reply@newbi.fr",
    )
      .trim()
      .toLowerCase() || "no-reply@newbi.fr"
  );
}

export const senderDomainOf = (email) =>
  String(email || "")
    .split("@")[1]
    ?.toLowerCase() || "";

export function maxPerMinute(env = process.env) {
  const value = Number.parseInt(env.EMAIL_CAMPAIGN_MAX_PER_MINUTE, 10);
  return Number.isFinite(value) && value > 0
    ? Math.min(value, 6000)
    : DEFAULT_MAX_PER_MINUTE;
}

/**
 * Nom affiché d'un en-tête From : sans guillemets, chevrons ni séparateurs
 * d'adresses (une virgule ferait lire deux adresses).
 */
export function fromHeader(name, email) {
  const display = singleLine(name, 60)
    .replace(/["<>,;:\\@]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return display ? `${display} <${email}>` : email;
}

let client = null;

/** Client Resend (null sans clé d'API). */
export function resendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

/** Tests : oublie le client (nouvelle clé, module simulé). */
export function resetResendClient() {
  client = null;
}

/** Corps d'un e-mail de campagne pour l'API Resend. */
export function buildEmailPayload({
  fromName,
  senderEmail,
  to,
  replyTo,
  subject,
  html,
  text,
  unsubscribeUrl,
  campaignId,
  entityRef,
}) {
  const payload = {
    from: fromHeader(fromName, senderEmail),
    to: [to],
    subject: singleLine(subject, 300),
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      // Gmail ne regroupe pas en conversation des e-mails de même objet
      "X-Entity-Ref-ID": String(entityRef || campaignId),
    },
    tags: [
      { name: "category", value: "email_campaign" },
      { name: "campaign_id", value: String(campaignId) },
    ],
  };
  if (replyTo) payload.replyTo = replyTo;
  return payload;
}

const TEMPORARY_ERRORS = new Set([
  "rate_limit_exceeded",
  "internal_server_error",
  "application_error",
  "concurrent_idempotent_requests",
]);
const QUOTA_ERRORS = new Set([
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
]);
const CONFIG_ERRORS = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "invalid_from_address",
  "security_error",
  "invalid_access",
  "invalid_region",
]);

/**
 * Nature d'une erreur de Resend :
 *   TEMPORARY  nouvel essai (3 au plus par destinataire) ;
 *   QUOTA      plafond du compte Resend : on attend, sans consommer d'essai ;
 *   CONFIG     configuration (clé, domaine) : campagne mise en pause ;
 *   PERMANENT  refus définitif des adresses du lot.
 */
export function classifyResendError(error) {
  const name = String(error?.name || "");
  if (CONFIG_ERRORS.has(name)) return "CONFIG";
  if (QUOTA_ERRORS.has(name)) return "QUOTA";
  if (TEMPORARY_ERRORS.has(name)) return "TEMPORARY";
  const status = Number(error?.statusCode);
  if (!Number.isFinite(status) || status === 0 || status >= 500) {
    return "TEMPORARY";
  }
  if (status === 429) return "TEMPORARY";
  if (status === 401 || status === 403) return "CONFIG";
  return "PERMANENT";
}

/**
 * Envoie un lot. Réponse alignée sur les entrées : `ids[i]` (identifiant
 * Resend) ou `errors[i]` (refus de cette adresse) ; `error` : échec du lot
 * entier, avec sa nature.
 *
 * @returns {Promise<{ ids: Array<string|null>, errors: Array<string|null>,
 *   error: { kind: string, name: string, message: string }|null }>}
 */
export async function sendBatch(payloads, { idempotencyKey } = {}) {
  const empty = () => ({
    ids: payloads.map(() => null),
    errors: payloads.map(() => null),
  });
  const resend = resendClient();
  if (!resend) {
    return {
      ...empty(),
      error: {
        kind: "CONFIG",
        name: "missing_api_key",
        message: "RESEND_API_KEY non configurée",
      },
    };
  }
  let response;
  try {
    response = await resend.batch.send(payloads, {
      batchValidation: "permissive",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    return {
      ...empty(),
      error: {
        kind: "TEMPORARY",
        name: "network_error",
        message: error?.message || "Erreur réseau",
      },
    };
  }
  if (response?.error) {
    return {
      ...empty(),
      error: {
        kind: classifyResendError(response.error),
        name: response.error.name || "unknown_error",
        message: response.error.message || "Erreur du service d'envoi",
      },
    };
  }
  const body = response?.data || {};
  const data = Array.isArray(body.data) ? body.data : [];
  const failures = new Map(
    (Array.isArray(body.errors) ? body.errors : [])
      .filter((item) => Number.isInteger(item?.index))
      .map((item) => [item.index, item.message || "Adresse refusée"]),
  );
  const result = empty();
  // Validation permissive : `data` ne contient que les e-mails acceptés,
  // dans l'ordre ; s'il en contient autant que d'entrées, il est aligné
  const aligned = data.length === payloads.length;
  let next = 0;
  for (let index = 0; index < payloads.length; index += 1) {
    if (failures.has(index)) {
      result.errors[index] = failures.get(index);
      if (aligned) next += 1;
      continue;
    }
    // Accepté (sans identifiant lisible : envoyé, mais sans suivi des
    // événements de remise)
    result.ids[index] = data[aligned ? index : next]?.id || null;
    next += 1;
  }
  return { ...result, error: null };
}
