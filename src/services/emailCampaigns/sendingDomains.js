/**
 * Domaines d'envoi des campagnes e-mail (« Connecter mon domaine », comme
 * l'authentification de domaine de Brevo) et choix de l'expéditeur.
 *
 * Connexion : l'espace saisit une adresse de son domaine. Le domaine est
 * d'abord réservé en base (un domaine par espace, un espace par domaine :
 * deux connexions simultanées ne le déclarent pas deux fois), puis déclaré
 * chez Resend (région eu-west-1, suivi Resend coupé : les campagnes ont le
 * leur). Les lignes DNS sont gardées telles que Resend les donne, avec la
 * zone où les ajouter et l'hébergeur DNS reconnu.
 *
 * Vérification : à la demande (au plus une fois toutes les 20 s par espace)
 * et par le cron des campagnes toutes les 10 minutes (domaines en attente)
 * ou une fois par jour (domaines validés). Au bout de 7 jours sans
 * validation, le domaine est retiré de Resend et passe en EXPIRED.
 *
 * Expéditeur (resolveCampaignSender) : adresse du domaine connecté s'il est
 * VERIFIED, sinon adresse Newbi de l'espace (jamais de blocage).
 *
 * Aucun domaine inconnu de la base n'est repris ni supprimé chez Resend :
 * le compte Resend peut être partagé entre plusieurs environnements.
 */
import EmailCampaign from "../../models/EmailCampaign.js";
import EmailSendingDomain, {
  SENDING_DOMAIN_STATUSES,
} from "../../models/EmailSendingDomain.js";
import { recordAttempt } from "../../utils/attemptLimiter.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { isValidEmail } from "../../utils/validators.js";
import { notifyError } from "../errorAlertService.js";
import { checkSenderDomain, organizationalDomain } from "./deliverability.js";
import { detectDnsProvider } from "./dnsProvider.js";
import { loadWorkspaceIdentity } from "./identity.js";
import {
  campaignFromDomain,
  cleanDomain,
  newbiSenderEmail,
  resendClient,
  senderDomainOf,
} from "./sender.js";

export const SENDING_DOMAIN_REGION = "eu-west-1";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const SENDING_DOMAIN_TTL_MS = 7 * DAY_MS;
export const VERIFY_INTERVAL_MS = 20 * 1000;
export const CONNECT_ATTEMPTS_PER_DAY = 10;
// Cron toutes les 10 minutes : marge pour ne pas sauter un passage
export const PENDING_REFRESH_MS = 9 * MINUTE_MS;
export const VERIFIED_REFRESH_MS = 23 * HOUR_MS;
// Nouvelle demande de vérification par le cron (domaine jamais vérifié ou
// en échec) : l'utilisateur a pu ajouter les lignes sans cliquer
export const AUTO_VERIFY_INTERVAL_MS = HOUR_MS;
// Appels à Resend par passage du cron, ~1 par seconde : la limite de débit
// est partagée avec les envois
export const MAX_CALLS_PER_PASS = 20;
export const CALL_INTERVAL_MS = 1000;
const ABANDONED_RESERVATION_MS = HOUR_MS;
const STALE_RESERVATION_MS = 2 * MINUTE_MS;
const RESEND_TIMEOUT_MS = 15 * 1000;
const NEWBI_STATUS_CACHE_MS = 10 * MINUTE_MS;
const NEWBI_STATUS_RETRY_MS = MINUTE_MS;
const ALERT_COOLDOWN_SECONDS = 60 * 60;

export const SENDING_DOMAIN_ERRORS = Object.freeze({
  INVALID_SENDER_EMAIL: "INVALID_SENDER_EMAIL",
  FREE_EMAIL_PROVIDER: "FREE_EMAIL_PROVIDER",
  RESERVED_DOMAIN: "RESERVED_DOMAIN",
  DOMAIN_ALREADY_CONNECTED: "DOMAIN_ALREADY_CONNECTED",
  SENDING_DOMAIN_EXISTS: "SENDING_DOMAIN_EXISTS",
  SENDING_DOMAIN_IN_USE: "SENDING_DOMAIN_IN_USE",
  SENDING_DOMAIN_UNAVAILABLE: "SENDING_DOMAIN_UNAVAILABLE",
});

const E = SENDING_DOMAIN_ERRORS;

const invalidSender = (
  message = "Saisissez une adresse e-mail valide, par exemple contact@votre-entreprise.fr.",
) => new AppError(message, E.INVALID_SENDER_EMAIL);
const noDomain = () =>
  new AppError(
    "Aucun domaine n'est connecté à cet espace.",
    ERROR_CODES.NOT_FOUND,
  );
const unavailable = (message) =>
  new AppError(message, E.SENDING_DOMAIN_UNAVAILABLE);

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Adresse saisie ───────────────────────────────────────────────────────

/** Adresse d'envoi saisie : { email, local, domain }, sinon INVALID_SENDER_EMAIL. */
export function parseSenderEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !isValidEmail(email)) {
    throw invalidSender();
  }
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = cleanDomain(email.slice(at + 1));
  if (!local || local.length > 64 || !domain) throw invalidSender();
  return { email: `${local}@${domain}`, local, domain };
}

/** Messageries gratuites ou de fournisseurs d'accès : domaine introuvable chez eux. */
export const FREE_EMAIL_DOMAINS = Object.freeze([
  "gmail.com",
  "googlemail.com",
  "ymail.com",
  "rocketmail.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "aol.fr",
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "neuf.fr",
  "laposte.net",
  "bbox.fr",
  "numericable.fr",
  "club-internet.fr",
  "aliceadsl.fr",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "mail.ru",
  "zoho.com",
  "zohomail.com",
  "tutanota.com",
  "tuta.io",
  "mail.com",
  "web.de",
  "t-online.de",
  "libero.it",
]);

// Familles déclinées par pays : yahoo.fr, hotmail.co.uk, gmx.de...
const FREE_EMAIL_FAMILIES = [
  "yahoo",
  "hotmail",
  "outlook",
  "live",
  "gmx",
  "yandex",
];
const SECOND_LEVEL = ["co", "com", "net", "org", "ne", "or"];

export function isFreeEmailDomain(value) {
  const domain = cleanDomain(value);
  if (!domain) return false;
  if (FREE_EMAIL_DOMAINS.includes(domain)) return true;
  const [first, ...rest] = domain.split(".");
  if (!FREE_EMAIL_FAMILIES.includes(first)) return false;
  if (rest.length === 1) return /^[a-z]{2,}$/.test(rest[0]);
  return (
    rest.length === 2 &&
    SECOND_LEVEL.includes(rest[0]) &&
    /^[a-z]{2,}$/.test(rest[1])
  );
}

/** Domaines de Newbi (et leurs sous-domaines) : jamais connectables. */
export function reservedDomains(env = process.env) {
  return [...new Set(["newbi.fr", "sweily.fr", campaignFromDomain(env)])];
}

export function isReservedDomain(value, env = process.env) {
  const domain = cleanDomain(value);
  if (!domain) return false;
  return reservedDomains(env).some(
    (root) => domain === root || domain.endsWith(`.${root}`),
  );
}

export function assertConnectableDomain(domain, env = process.env) {
  if (isReservedDomain(domain, env)) {
    throw new AppError(
      "Ce domaine appartient à Newbi : utilisez une adresse de votre propre domaine.",
      E.RESERVED_DOMAIN,
    );
  }
  if (isFreeEmailDomain(domain)) {
    throw new AppError(
      "Pas besoin de connecter une adresse Gmail, Orange, Outlook ou Yahoo : vos campagnes partent déjà de l'adresse Newbi de votre espace, avec le nom de votre entreprise, et les réponses arrivent sur votre adresse. Connecter un domaine sert seulement à envoyer depuis une adresse à votre nom de domaine (ex. contact@votre-entreprise.fr).",
      E.FREE_EMAIL_PROVIDER,
    );
  }
}

// ─── Lignes DNS ────────────────────────────────────────────────────────────

const RESEND_STATUSES = SENDING_DOMAIN_STATUSES.filter((s) => s !== "EXPIRED");

/** Statut Resend en majuscules (inconnu : PENDING, absent : NOT_STARTED). */
export function toDomainStatus(value) {
  const status = String(value || "")
    .trim()
    .toUpperCase();
  if (!status) return "NOT_STARTED";
  return RESEND_STATUSES.includes(status) ? status : "PENDING";
}

/** Lignes DNS telles que Resend les donne, statut en majuscules. */
export function normalizeRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record && typeof record === "object")
    .map((record) => {
      const priority = Number(record.priority);
      return {
        record: String(record.record || "").trim(),
        type: String(record.type || "")
          .trim()
          .toUpperCase(),
        name: String(record.name || "").trim(),
        value: String(record.value ?? "").trim(),
        priority:
          record.priority !== null &&
          record.priority !== undefined &&
          record.priority !== "" &&
          Number.isInteger(priority)
            ? priority
            : null,
        status: String(record.status || "not_started")
          .trim()
          .toUpperCase(),
        ttl:
          record.ttl === null || record.ttl === undefined
            ? null
            : String(record.ttl),
      };
    })
    .filter((record) => record.type);
}

/**
 * Zone DNS où ajouter les lignes. Resend donne les noms relatifs à la zone :
 * pour envoi.newbi.fr, la ligne DKIM s'appelle resend._domainkey.envoi, la
 * zone est donc newbi.fr ; pour un domaine principal (resend._domainkey),
 * c'est le domaine lui-même.
 */
export function dnsZoneOf(domain, records) {
  const host = cleanDomain(domain) || String(domain || "").toLowerCase();
  const dkim = (Array.isArray(records) ? records : []).find((record) =>
    /^resend\._domainkey(\.|$)/i.test(String(record?.name || "").trim()),
  );
  if (!dkim) return organizationalDomain(host);
  const relative = String(dkim.name)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^resend\._domainkey\.?/, "");
  if (!relative) return host;
  if (host.startsWith(`${relative}.`)) return host.slice(relative.length + 1);
  // Noms complets (ou forme inattendue) : domaine organisationnel
  return organizationalDomain(host);
}

/** Nom complet d'une ligne : nom relatif + zone (certains hébergeurs le demandent). */
export function recordFqdn(name, zone) {
  const label = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const base = String(zone || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!label || label === "@") return base;
  if (!base || label === base || label.endsWith(`.${base}`)) return label;
  return `${label}.${base}`;
}

/** DKIM et SPF d'un domaine d'après les statuts Resend de ses lignes. */
export function authenticationOf(sendingDomain) {
  const records = sendingDomain?.records || [];
  const verified = (kind) => {
    const group = records.filter(
      (record) => String(record.record).toUpperCase() === kind,
    );
    return (
      group.length > 0 &&
      group.every(
        (record) => String(record.status).toUpperCase() === "VERIFIED",
      )
    );
  };
  return { dkim: verified("DKIM"), spf: verified("SPF") };
}

// ─── Resend ────────────────────────────────────────────────────────────────

/** Appel au SDK Resend : { data, error }, jamais d'exception. */
async function callResend(operation, label) {
  const resend = resendClient();
  if (!resend) {
    return {
      data: null,
      error: {
        name: "missing_api_key",
        message: "Clé Resend des campagnes non configurée",
      },
    };
  }
  let timer;
  try {
    const response = await Promise.race([
      operation(resend),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`délai dépassé (${label})`)),
          RESEND_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (response?.error) {
      return {
        data: null,
        error: {
          name: String(response.error.name || "unknown_error"),
          message: String(response.error.message || "Erreur de Resend"),
          statusCode: response.error.statusCode ?? null,
        },
      };
    }
    return { data: response?.data ?? null, error: null };
  } catch (error) {
    return {
      data: null,
      error: {
        name: "network_error",
        message: error?.message || "Erreur réseau",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

const isNotFound = (error) =>
  error?.name === "not_found" || Number(error?.statusCode) === 404;

const describeError = (error) =>
  error ? `${error.name} : ${error.message}` : "réponse inattendue";

function alertUnavailable(action, error, { workspaceId, domain }) {
  void notifyError({
    source: "campagnes-domaines",
    message: `Domaine d'envoi : ${action} impossible chez Resend (${error?.name || "erreur"})`,
    context: {
      Espace: workspaceId ? String(workspaceId) : undefined,
      Domaine: domain,
      Erreur: describeError(error),
    },
    cooldownSeconds: ALERT_COOLDOWN_SECONDS,
  });
}

/** Tous les domaines du compte Resend (pages de 100). */
async function listResendDomains() {
  const domains = [];
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const options = after ? { limit: 100, after } : { limit: 100 };
    const result = await callResend(
      (resend) => resend.domains.list(options),
      "domains.list",
    );
    if (result.error) return { domains: null, error: result.error };
    const items = Array.isArray(result.data?.data) ? result.data.data : [];
    domains.push(...items);
    if (!result.data?.has_more || !items.length) break;
    after = items[items.length - 1].id;
  }
  return { domains, error: null };
}

// ─── Lecture ───────────────────────────────────────────────────────────────

/**
 * Domaine connecté de l'espace (EXPIRED compris), ou null. Une réservation
 * en cours de déclaration chez Resend n'est pas encore un domaine connecté.
 */
export async function getSendingDomain(workspaceId) {
  const id = toObjectIdOrNull(String(workspaceId));
  if (!id) return null;
  const domain = await EmailSendingDomain.findOne({ workspaceId: id }).lean();
  if (!domain) return null;
  if (!domain.resendDomainId && domain.status !== "EXPIRED") return null;
  return domain;
}

/**
 * Mise à jour d'après la réponse de Resend (GET /domains/:id ou création).
 * Validé : plus de retrait automatique.
 */
function resendStateUpdate(current, data, now) {
  const status = toDomainStatus(data?.status);
  const set = { status, lastCheckedAt: now };
  if (data?.id) set.resendDomainId = String(data.id);
  if (data?.region) set.region = String(data.region);
  if (Array.isArray(data?.records)) {
    set.records = normalizeRecords(data.records);
    set.zone = dnsZoneOf(current.domain, set.records);
  }
  if (status === "VERIFIED") {
    set.expiresAt = null;
    if (current.status !== "VERIFIED" || !current.verifiedAt) {
      set.verifiedAt = now;
    }
  }
  return set;
}

async function applyResendState(current, data, { now }) {
  const set = resendStateUpdate(current, data, now);
  if (!current.dnsProvider) {
    set.dnsProvider = await detectDnsProvider(set.zone || current.zone);
  }
  const updated = await EmailSendingDomain.findOneAndUpdate(
    { _id: current._id, status: { $ne: "EXPIRED" } },
    { $set: set },
    { new: true },
  ).lean();
  if (updated && set.status !== current.status) {
    logger.info(
      `[campagnes] domaine d'envoi ${current.domain} (${current.workspaceId}) : ${current.status} → ${set.status}`,
    );
  }
  return updated || current;
}

/** Domaine disparu de Resend : retiré, les campagnes repartent de Newbi. */
async function markGone(current, now) {
  void notifyError({
    source: "campagnes-domaines",
    message: "Domaine d'envoi connu de Newbi mais introuvable chez Resend",
    context: {
      Espace: String(current.workspaceId),
      Domaine: current.domain,
      "Identifiant Resend": current.resendDomainId,
    },
    cooldownSeconds: ALERT_COOLDOWN_SECONDS,
  });
  return EmailSendingDomain.findOneAndUpdate(
    { _id: current._id },
    {
      $set: {
        status: "EXPIRED",
        records: [],
        resendDomainId: null,
        lastCheckedAt: now,
        expiresAt: null,
      },
    },
    { new: true },
  ).lean();
}

// ─── Connexion, vérification, modification, déconnexion ───────────────────

/**
 * Connecte le domaine de `fromEmail` à l'espace.
 * Refus : INVALID_SENDER_EMAIL, FREE_EMAIL_PROVIDER, RESERVED_DOMAIN,
 * SENDING_DOMAIN_EXISTS, DOMAIN_ALREADY_CONNECTED (sans dire à quel
 * espace), SENDING_DOMAIN_UNAVAILABLE (Resend en panne ou plafond de
 * domaines atteint : l'équipe est prévenue).
 */
export async function connectSendingDomain({
  workspaceId,
  fromEmail,
  userId = null,
  now = new Date(),
}) {
  const sender = parseSenderEmail(fromEmail);
  assertConnectableDomain(sender.domain);
  const wsId = toObjectIdOrNull(String(workspaceId));
  if (!wsId) throw noDomain();

  const [current, taken] = await Promise.all([
    EmailSendingDomain.findOne({ workspaceId: wsId })
      .select("status resendDomainId createdAt")
      .lean(),
    EmailSendingDomain.findOne({ domain: sender.domain })
      .select("workspaceId status resendDomainId createdAt")
      .lean(),
  ]);
  const staleReservation = (doc) =>
    doc &&
    !doc.resendDomainId &&
    doc.status !== "EXPIRED" &&
    now.getTime() - new Date(doc.createdAt).getTime() > STALE_RESERVATION_MS;
  if (current && current.status !== "EXPIRED" && !staleReservation(current)) {
    throw new AppError(
      "Un domaine est déjà connecté à cet espace : déconnectez-le avant d'en connecter un autre.",
      E.SENDING_DOMAIN_EXISTS,
    );
  }
  if (
    taken &&
    taken.status !== "EXPIRED" &&
    !staleReservation(taken) &&
    String(taken.workspaceId) !== String(wsId)
  ) {
    throw new AppError(
      "Ce domaine est déjà connecté à un autre espace Newbi. Si c'est le vôtre, déconnectez-le de cet espace, ou contactez le support.",
      E.DOMAIN_ALREADY_CONNECTED,
    );
  }

  // Chaque connexion déclare un domaine chez Resend : nombre limité par jour
  const attempts = await recordAttempt(
    `email-sending-domain:connect:${wsId}`,
    DAY_MS / 1000,
  );
  if (attempts > CONNECT_ATTEMPTS_PER_DAY) {
    throw new AppError(
      "Trop de connexions de domaine aujourd'hui : réessayez demain.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  // Domaines retirés (plus rien chez Resend) et réservations abandonnées
  // (arrêt pendant une déclaration) : place nette
  await EmailSendingDomain.deleteMany({
    $or: [
      { status: "EXPIRED", workspaceId: wsId },
      { status: "EXPIRED", domain: sender.domain },
      ...[current, taken]
        .filter(staleReservation)
        .map((doc) => ({ _id: doc._id, resendDomainId: null })),
    ],
  });

  let reserved;
  try {
    reserved = await EmailSendingDomain.create({
      workspaceId: wsId,
      domain: sender.domain,
      fromEmail: sender.email,
      status: "NOT_STARTED",
      region: SENDING_DOMAIN_REGION,
      expiresAt: new Date(now.getTime() + SENDING_DOMAIN_TTL_MS),
      createdBy: userId,
    });
  } catch (error) {
    if (error?.code === 11000) {
      if (error.keyPattern?.domain || /domain_1/.test(String(error.message))) {
        throw new AppError(
          "Ce domaine est déjà connecté à un autre espace Newbi. Si c'est le vôtre, déconnectez-le de cet espace, ou contactez le support.",
          E.DOMAIN_ALREADY_CONNECTED,
        );
      }
      throw new AppError(
        "Un domaine est déjà connecté à cet espace : déconnectez-le avant d'en connecter un autre.",
        E.SENDING_DOMAIN_EXISTS,
      );
    }
    throw error;
  }

  const created = await callResend(
    (resend) =>
      resend.domains.create({
        name: sender.domain,
        region: SENDING_DOMAIN_REGION,
        openTracking: false,
        clickTracking: false,
      }),
    "domains.create",
  );
  if (!created.data?.id) {
    await EmailSendingDomain.deleteOne({
      _id: reserved._id,
      resendDomainId: null,
    });
    logger.error(
      `[campagnes] domaine ${sender.domain} non déclaré chez Resend (${wsId}) : ${describeError(created.error)}`,
    );
    alertUnavailable("connexion", created.error, {
      workspaceId: wsId,
      domain: sender.domain,
    });
    throw unavailable(
      "Impossible de connecter un domaine pour le moment. Notre équipe a été prévenue.",
    );
  }

  const set = resendStateUpdate(reserved.toObject(), created.data, now);
  set.dnsProvider = await detectDnsProvider(set.zone);
  const connected = await EmailSendingDomain.findOneAndUpdate(
    { _id: reserved._id, resendDomainId: null },
    { $set: set },
    { new: true },
  ).lean();
  if (!connected) {
    // Réservation retirée pendant la déclaration (déconnexion simultanée)
    await callResend(
      (resend) => resend.domains.remove(created.data.id),
      "domains.remove",
    );
    throw new AppError(
      "La connexion du domaine a été annulée entre-temps : réessayez.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  logger.info(
    `[campagnes] domaine d'envoi ${sender.domain} connecté par l'espace ${wsId} (${connected.status})`,
  );
  return connected;
}

/**
 * Demande à Resend de vérifier les lignes DNS, puis relit le domaine. Au
 * plus une fois toutes les 20 s par espace : sinon, l'état connu.
 */
export async function verifySendingDomain(
  workspaceId,
  { now = new Date() } = {},
) {
  const domain = await getSendingDomain(workspaceId);
  if (!domain) throw noDomain();
  if (domain.status === "EXPIRED") {
    throw new AppError(
      "Ce domaine a été retiré faute de validation : connectez-le de nouveau.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  const claimed = await EmailSendingDomain.findOneAndUpdate(
    {
      _id: domain._id,
      status: { $ne: "EXPIRED" },
      $or: [
        { verifyRequestedAt: null },
        {
          verifyRequestedAt: {
            $lte: new Date(now.getTime() - VERIFY_INTERVAL_MS),
          },
        },
      ],
    },
    { $set: { verifyRequestedAt: now } },
    { new: true },
  ).lean();
  if (!claimed) return domain;

  const verify = await callResend(
    (resend) => resend.domains.verify(domain.resendDomainId),
    "domains.verify",
  );
  if (verify.error && isNotFound(verify.error)) return markGone(domain, now);
  if (verify.error) {
    logger.warn(
      `[campagnes] vérification du domaine ${domain.domain} non lancée : ${describeError(verify.error)}`,
    );
  }
  const fresh = await callResend(
    (resend) => resend.domains.get(domain.resendDomainId),
    "domains.get",
  );
  if (fresh.error || !fresh.data) {
    if (isNotFound(fresh.error)) return markGone(domain, now);
    alertUnavailable("vérification", fresh.error, {
      workspaceId: domain.workspaceId,
      domain: domain.domain,
    });
    throw unavailable(
      "Impossible de vérifier le domaine pour le moment. Notre équipe a été prévenue.",
    );
  }
  return applyResendState(claimed, fresh.data, { now });
}

/** Nouvelle adresse d'envoi, sur le même domaine seulement. */
export async function updateSendingDomainSender(workspaceId, fromEmail) {
  const sender = parseSenderEmail(fromEmail);
  const domain = await getSendingDomain(workspaceId);
  if (!domain || domain.status === "EXPIRED") throw noDomain();
  if (sender.domain !== domain.domain) {
    throw invalidSender(
      `Utilisez une adresse en @${domain.domain}. Pour changer de domaine, déconnectez celui-ci puis connectez le nouveau.`,
    );
  }
  const updated = await EmailSendingDomain.findOneAndUpdate(
    { _id: domain._id, workspaceId: domain.workspaceId, domain: domain.domain },
    { $set: { fromEmail: sender.email } },
    { new: true },
  ).lean();
  if (!updated) throw noDomain();
  return updated;
}

/**
 * Le domaine sert-il à une campagne de l'espace ? Envoi en cours ou en
 * pause (reprise possible) avec une adresse figée sur ce domaine, ou
 * campagne programmée qui partira de ce domaine (validé).
 */
export async function isSendingDomainInUse(sendingDomain) {
  const address = new RegExp(`@${escapeRegex(sendingDomain.domain)}$`);
  const filter = {
    workspaceId: sendingDomain.workspaceId,
    deletedAt: null,
    $or: [
      { status: "SENDING", "snapshot.senderEmail": address },
      {
        status: "PAUSED",
        pauseKind: { $ne: "REPUTATION" },
        "snapshot.senderEmail": address,
      },
      ...(sendingDomain.status === "VERIFIED" ? [{ status: "SCHEDULED" }] : []),
    ],
  };
  return Boolean(await EmailCampaign.exists(filter));
}

/** Retire le domaine (Resend puis base). Sans domaine : rien à faire. */
export async function disconnectSendingDomain(workspaceId) {
  const id = toObjectIdOrNull(String(workspaceId));
  if (!id) return true;
  const domain = await EmailSendingDomain.findOne({ workspaceId: id }).lean();
  if (!domain) return true;
  if (domain.status !== "EXPIRED" && domain.resendDomainId) {
    if (await isSendingDomainInUse(domain)) {
      throw new AppError(
        "Une campagne en cours d'envoi ou programmée part de ce domaine : attendez la fin de l'envoi, ou annulez ou déprogrammez la campagne, avant de déconnecter le domaine.",
        E.SENDING_DOMAIN_IN_USE,
      );
    }
    const removed = await callResend(
      (resend) => resend.domains.remove(domain.resendDomainId),
      "domains.remove",
    );
    if (removed.error && !isNotFound(removed.error)) {
      alertUnavailable("déconnexion", removed.error, {
        workspaceId: domain.workspaceId,
        domain: domain.domain,
      });
      throw unavailable(
        "Impossible de déconnecter le domaine pour le moment. Notre équipe a été prévenue.",
      );
    }
  }
  await EmailSendingDomain.deleteOne({ _id: domain._id, workspaceId: id });
  logger.info(
    `[campagnes] domaine d'envoi ${domain.domain} déconnecté de l'espace ${id}`,
  );
  return true;
}

// ─── Cron ──────────────────────────────────────────────────────────────────

/**
 * Un passage du cron (toutes les 10 minutes, instance 0) : réservations
 * abandonnées effacées, domaines expirés retirés de Resend, domaines en
 * attente relus (vérification relancée toutes les heures pour ceux qui
 * n'ont jamais été vérifiés ou ont échoué), domaines validés relus une
 * fois par jour. Au plus MAX_CALLS_PER_PASS appels à Resend, ~1 par seconde.
 */
export async function refreshSendingDomains({
  now = () => new Date(),
  sleep = defaultSleep,
  budget = MAX_CALLS_PER_PASS,
} = {}) {
  const at = now();
  const totals = { expired: 0, refreshed: 0, failed: 0, abandoned: 0 };
  let calls = 0;
  const call = async (operation, label) => {
    if (calls > 0) await sleep(CALL_INTERVAL_MS);
    calls += 1;
    return callResend(operation, label);
  };
  const ago = (ms) => new Date(at.getTime() - ms);

  const abandoned = await EmailSendingDomain.deleteMany({
    resendDomainId: null,
    status: { $ne: "EXPIRED" },
    createdAt: { $lte: ago(ABANDONED_RESERVATION_MS) },
  });
  totals.abandoned = abandoned.deletedCount || 0;

  // Retrait automatique après 7 jours sans validation (dernière lecture
  // d'abord : validé à la dernière minute, il reste)
  const expiring = await EmailSendingDomain.find({
    status: { $nin: ["VERIFIED", "EXPIRED"] },
    resendDomainId: { $ne: null },
    expiresAt: { $ne: null, $lte: at },
  })
    .sort({ expiresAt: 1 })
    .limit(budget)
    .lean();
  for (const domain of expiring) {
    if (calls + 2 > budget) break;
    const fresh = await call(
      (resend) => resend.domains.get(domain.resendDomainId),
      "domains.get",
    );
    if (fresh.data && toDomainStatus(fresh.data.status) === "VERIFIED") {
      await applyResendState(domain, fresh.data, { now: at });
      totals.refreshed += 1;
      continue;
    }
    if (fresh.error && !isNotFound(fresh.error)) {
      totals.failed += 1;
      continue;
    }
    if (!isNotFound(fresh.error)) {
      const removed = await call(
        (resend) => resend.domains.remove(domain.resendDomainId),
        "domains.remove",
      );
      if (removed.error && !isNotFound(removed.error)) {
        logger.warn(
          `[campagnes] domaine expiré ${domain.domain} non retiré de Resend : ${describeError(removed.error)}`,
        );
        totals.failed += 1;
        continue;
      }
    }
    await EmailSendingDomain.updateOne(
      { _id: domain._id, status: { $nin: ["VERIFIED", "EXPIRED"] } },
      {
        $set: {
          status: "EXPIRED",
          records: [],
          resendDomainId: null,
          lastCheckedAt: at,
        },
      },
    );
    totals.expired += 1;
    logger.info(
      `[campagnes] domaine d'envoi ${domain.domain} (${domain.workspaceId}) retiré : non validé en 7 jours`,
    );
  }

  const refresh = async (domain) => {
    const autoVerify =
      ["NOT_STARTED", "FAILED"].includes(domain.status) &&
      (!domain.verifyRequestedAt ||
        new Date(domain.verifyRequestedAt) <= ago(AUTO_VERIFY_INTERVAL_MS));
    if (autoVerify && calls + 2 <= budget) {
      const verify = await call(
        (resend) => resend.domains.verify(domain.resendDomainId),
        "domains.verify",
      );
      if (verify.error && isNotFound(verify.error)) {
        await markGone(domain, at);
        return;
      }
      await EmailSendingDomain.updateOne(
        { _id: domain._id },
        { $set: { verifyRequestedAt: at } },
      );
    }
    const fresh = await call(
      (resend) => resend.domains.get(domain.resendDomainId),
      "domains.get",
    );
    if (fresh.data) {
      await applyResendState(domain, fresh.data, { now: at });
      totals.refreshed += 1;
    } else if (isNotFound(fresh.error)) {
      await markGone(domain, at);
    } else {
      totals.failed += 1;
      logger.warn(
        `[campagnes] domaine ${domain.domain} non relu : ${describeError(fresh.error)}`,
      );
    }
  };

  const pending = await EmailSendingDomain.find({
    status: { $nin: ["VERIFIED", "EXPIRED"] },
    resendDomainId: { $ne: null },
    $or: [
      { lastCheckedAt: null },
      { lastCheckedAt: { $lte: ago(PENDING_REFRESH_MS) } },
    ],
  })
    .sort({ lastCheckedAt: 1, _id: 1 })
    .limit(budget)
    .lean();
  for (const domain of pending) {
    if (calls >= budget) break;
    await refresh(domain);
  }

  const verified = await EmailSendingDomain.find({
    status: "VERIFIED",
    resendDomainId: { $ne: null },
    $or: [
      { lastCheckedAt: null },
      { lastCheckedAt: { $lte: ago(VERIFIED_REFRESH_MS) } },
    ],
  })
    .sort({ lastCheckedAt: 1, _id: 1 })
    .limit(budget)
    .lean();
  for (const domain of verified) {
    if (calls >= budget) break;
    await refresh(domain);
  }

  if (calls || totals.abandoned) {
    logger.info(
      `[campagnes] domaines d'envoi : ${totals.refreshed} relu(s), ${totals.expired} retiré(s), ${totals.failed} en échec, ${totals.abandoned} réservation(s) abandonnée(s), ${calls} appel(s) à Resend`,
    );
  }
  return { ...totals, calls };
}

// ─── Expéditeur ────────────────────────────────────────────────────────────

/**
 * Adresse d'envoi des campagnes de l'espace : celle du domaine connecté
 * s'il est validé (VERIFIED), sinon l'adresse Newbi au nom de l'entreprise.
 *
 * @returns {Promise<{ email: string, newbiEmail: string, custom: boolean,
 *   sendingDomain: object|null, identity: object }>}
 */
export async function resolveCampaignSender(workspaceId, { identity } = {}) {
  const [resolvedIdentity, sendingDomain] = await Promise.all([
    identity || loadWorkspaceIdentity(workspaceId),
    getSendingDomain(workspaceId),
  ]);
  const newbiEmail = newbiSenderEmail(resolvedIdentity.companyName);
  const custom =
    sendingDomain?.status === "VERIFIED" &&
    isValidEmail(sendingDomain.fromEmail) &&
    senderDomainOf(sendingDomain.fromEmail) === sendingDomain.domain;
  return {
    email: custom ? sendingDomain.fromEmail : newbiEmail,
    newbiEmail,
    custom,
    sendingDomain: sendingDomain || null,
    identity: resolvedIdentity,
  };
}

// ─── Domaine d'envoi Newbi ─────────────────────────────────────────────────

let newbiDomains = null;

/** Tests : oublie la liste des domaines Resend. */
export function resetNewbiDomainCache() {
  newbiDomains = null;
}

/**
 * Statut chez Resend du domaine des adresses Newbi (liste des domaines du
 * compte, gardée 10 minutes) : VERIFIED, autre statut Resend, MISSING
 * (absent du compte) ou UNKNOWN (Resend illisible et aucune liste connue).
 */
export async function newbiSendingDomainStatus({
  now = Date.now(),
  domain = campaignFromDomain(),
} = {}) {
  if (!newbiDomains || newbiDomains.expiresAt <= now) {
    const listed = await listResendDomains();
    if (listed.domains) {
      newbiDomains = {
        byName: new Map(
          listed.domains.map((item) => [
            String(item?.name || "").toLowerCase(),
            toDomainStatus(item?.status),
          ]),
        ),
        error: null,
        expiresAt: now + NEWBI_STATUS_CACHE_MS,
      };
    } else {
      logger.warn(
        `[campagnes] liste des domaines Resend illisible : ${describeError(listed.error)}`,
      );
      // Dernière liste connue gardée ; nouvel essai dans une minute
      newbiDomains = {
        byName: newbiDomains?.byName || null,
        error: listed.error,
        expiresAt: now + NEWBI_STATUS_RETRY_MS,
      };
    }
  }
  if (!newbiDomains.byName) {
    return { domain, status: "UNKNOWN", error: newbiDomains.error };
  }
  return {
    domain,
    status: newbiDomains.byName.get(domain) || "MISSING",
    error: null,
  };
}

/**
 * Le domaine Newbi peut-il envoyer ? Sinon, alerte interne (une par heure) :
 * le client ne voit qu'un message générique. Validé, son DNS est relu pour
 * l'équipe seulement (DMARC n'est pas contrôlé par Resend) : une ligne
 * absente donne une alerte interne (une par jour), jamais un contrôle
 * montré au client.
 */
export async function checkNewbiSendingDomain({ now = Date.now() } = {}) {
  const result = await newbiSendingDomainStatus({ now });
  const available = result.status === "VERIFIED";
  if (!available) {
    void notifyError({
      source: "campagnes",
      message:
        "Domaine d'envoi Newbi non validé chez Resend : lancement des campagnes bloqué",
      context: {
        Domaine: result.domain,
        Statut: result.status,
        Erreur: result.error ? describeError(result.error) : undefined,
      },
      cooldownSeconds: ALERT_COOLDOWN_SECONDS,
    });
    return { ...result, available };
  }
  const dns = await checkSenderDomain(result.domain, { now });
  const missing = [
    dns.dkim === false && `DKIM (resend._domainkey.${dns.domain})`,
    dns.spf === false && `SPF (send.${dns.domain})`,
    dns.dmarc === false &&
      `DMARC (_dmarc.${dns.domain} ou _dmarc.${dns.organizationalDomain})`,
  ].filter(Boolean);
  if (missing.length) {
    void notifyError({
      source: "campagnes",
      message: "Domaine d'envoi Newbi : authentification DNS incomplète",
      context: { Domaine: result.domain, Absent: missing.join(", ") },
      cooldownSeconds: 24 * 60 * 60,
    });
  }
  return { ...result, available };
}
