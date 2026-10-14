/**
 * Relances automatiques de l'essai gratuit, pilotées depuis newbi-admin
 * (page Relances, via /api/admin-service/trial-nudges).
 *
 *   - welcome      : bienvenue au début de l'essai (fin d'onboarding), vérifiée
 *                    toutes les 10 minutes pour partir vite
 *   - inactive_d7  : J+7 après le début de l'essai, si l'espace est inactif
 *                    depuis `inactivityDays` jours (3 par défaut)
 *   - feedback_d14 : J+14, à tous les essais, demande de suggestions
 *   - inactive_d30 : à l'expiration de l'essai, si l'espace est inactif ;
 *                    envoyée par trialCleanupCron À LA PLACE de l'e-mail
 *                    standard de fin d'essai (jamais deux e-mails le même jour)
 *
 * Réglages (collection trial_nudge_settings, document « global ») :
 *   - mode « off » (défaut) : rien ne part ;
 *   - « simulation » : le journal se remplit comme si on envoyait, sans envoi ;
 *   - « live » : envoi réel.
 *
 * Garde-fous :
 *   - une relance par organisation et par étape, garantie par l'index unique
 *     du journal (trial_nudge_log), écrit AVANT l'envoi ;
 *   - rattrapage limité à SEND_WINDOW_DAYS : à l'activation, les essais
 *     anciens ne reçoivent rien ;
 *   - exclus : abonnés, clients d'un cabinet gestionnaire, e-mails non
 *     vérifiés, comptes internes, désinscrits ;
 *   - lien de désinscription signé dans chaque e-mail (+ en-têtes
 *     List-Unsubscribe pour le désabonnement en un clic des messageries).
 *
 * « Activité » d'un espace : la dernière activité connue de n'importe lequel
 * de ses membres (user_device_log.lastSeenAt, écrit à chaque requête
 * authentifiée, et session.updatedAt de Better Auth), au plus tôt le début
 * de l'essai.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import { Resend } from "resend";
import logger from "../utils/logger.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../middlewares/rbac.js";
import {
  NUDGE_STEPS,
  TRIAL_NUDGE_REPLY_TO,
  buildTrialNudgeEmail,
} from "../utils/trialNudgeEmails.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const SETTINGS_COLLECTION = "trial_nudge_settings";
export const LOG_COLLECTION = "trial_nudge_log";
export const OPTOUT_COLLECTION = "trial_nudge_optout";
const SETTINGS_ID = "global";

export const NUDGE_MODES = ["off", "simulation", "live"];
export const INACTIVITY_DAYS_MIN = 2;
export const INACTIVITY_DAYS_MAX = 7;
export const DEFAULT_SETTINGS = { mode: "off", inactivityDays: 3 };

// Relances planifiées, comptées depuis le début de l'essai
export const SCHEDULED_STEPS = {
  welcome: { dayOffset: 0, requiresInactivity: false },
  inactive_d7: { dayOffset: 7, requiresInactivity: true },
  feedback_d14: { dayOffset: 14, requiresInactivity: false },
};
// Relance de fin d'essai, déclenchée par l'expiration (trialCleanupCron)
export const END_STEP = "inactive_d30";

// Une relance manquée (cron arrêté, mode coupé) part encore pendant ce délai
export const SEND_WINDOW_DAYS = 2;

const INTERNAL_DOMAINS = ["sweily.fr", "newbi.fr", "newbi.sweily.fr"];

const HEX_ID = /^[a-f\d]{24}$/i;

export class TrialNudgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function getDb(db) {
  const database = db || mongoose.connection?.db;
  if (!database) throw new Error("MongoDB non prête");
  return database;
}

// Un même id peut être stocké en ObjectId ou en String selon la collection
function idVariants(ids) {
  const out = [];
  for (const id of ids) {
    const value = String(id);
    out.push(value);
    if (HEX_ID.test(value)) out.push(new mongoose.Types.ObjectId(value));
  }
  return out;
}

const toDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const maxDate = (...dates) =>
  dates.filter(Boolean).reduce((a, b) => (!a || b > a ? b : a), null);

// ─── Réglages ──────────────────────────────────────────────────────────────

function normalizeSettings(doc) {
  const days = Number(doc?.inactivityDays);
  return {
    mode: NUDGE_MODES.includes(doc?.mode) ? doc.mode : DEFAULT_SETTINGS.mode,
    inactivityDays:
      Number.isInteger(days) &&
      days >= INACTIVITY_DAYS_MIN &&
      days <= INACTIVITY_DAYS_MAX
        ? days
        : DEFAULT_SETTINGS.inactivityDays,
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy || null,
  };
}

export async function getTrialNudgeSettings(db) {
  const doc = await getDb(db)
    .collection(SETTINGS_COLLECTION)
    .findOne({ _id: SETTINGS_ID });
  return normalizeSettings(doc);
}

/**
 * @param {{ mode?: string, inactivityDays?: number|string }} patch
 * @param {string} adminEmail
 */
export async function updateTrialNudgeSettings(patch = {}, adminEmail, db) {
  const $set = {};
  if (patch.mode !== undefined) {
    if (!NUDGE_MODES.includes(patch.mode)) {
      throw new TrialNudgeError("Mode inconnu.");
    }
    $set.mode = patch.mode;
  }
  if (patch.inactivityDays !== undefined) {
    const days = Number(patch.inactivityDays);
    if (
      !Number.isInteger(days) ||
      days < INACTIVITY_DAYS_MIN ||
      days > INACTIVITY_DAYS_MAX
    ) {
      throw new TrialNudgeError(
        `Le seuil d'inactivité doit être compris entre ${INACTIVITY_DAYS_MIN} et ${INACTIVITY_DAYS_MAX} jours.`,
      );
    }
    $set.inactivityDays = days;
  }
  if (Object.keys($set).length === 0) {
    throw new TrialNudgeError("Aucune modification.");
  }

  const database = getDb(db);
  await database.collection(SETTINGS_COLLECTION).updateOne(
    { _id: SETTINGS_ID },
    {
      $set: { ...$set, updatedAt: new Date(), updatedBy: adminEmail || null },
    },
    { upsert: true },
  );
  logger.info(
    `[TrialNudge] réglages modifiés par ${adminEmail} : ${JSON.stringify($set)}`,
  );
  return getTrialNudgeSettings(database);
}

// ─── Index ─────────────────────────────────────────────────────────────────

let indexesEnsured = false;
async function ensureIndexes(db) {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await Promise.all([
      // Le verrou anti-doublon : une relance par organisation, par étape et
      // par mode (la simulation ne consomme pas l'envoi réel)
      db
        .collection(LOG_COLLECTION)
        .createIndex({ orgId: 1, step: 1, simulated: 1 }, { unique: true }),
      db.collection(LOG_COLLECTION).createIndex({ createdAt: -1 }),
      db
        .collection(LOG_COLLECTION)
        .createIndex({ resendId: 1 }, { sparse: true }),
      db
        .collection(OPTOUT_COLLECTION)
        .createIndex({ userId: 1 }, { unique: true }),
      db.collection(OPTOUT_COLLECTION).createIndex({ email: 1 }),
    ]);
  } catch (error) {
    // Sans l'index unique, l'anti-doublon ne tient plus : on retentera
    indexesEnsured = false;
    throw error;
  }
}

// ─── Désinscription ────────────────────────────────────────────────────────

function unsubscribeSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les liens de désinscription",
    );
  }
  return secret;
}

function unsubscribeSignature(userId) {
  return crypto
    .createHmac("sha256", unsubscribeSecret())
    .update(`trial-nudge-unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
}

/** Jeton `<userId>.<signature>`, sans expiration (un lien de désinscription doit marcher pour toujours). */
export function createUnsubscribeToken(userId) {
  const id = String(userId);
  return `${id}.${unsubscribeSignature(id)}`;
}

/** @returns {string|null} l'id utilisateur si le jeton est authentique */
export function verifyUnsubscribeToken(token) {
  if (typeof token !== "string") return null;
  const [userId, signature] = token.split(".");
  if (!userId || !HEX_ID.test(userId) || !signature) return null;
  try {
    const expected = Buffer.from(unsubscribeSignature(userId));
    const provided = Buffer.from(signature);
    return expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided)
      ? userId
      : null;
  } catch {
    return null;
  }
}

function apiBaseUrl() {
  return (
    process.env.BACKEND_URL ||
    process.env.API_URL ||
    "https://api.newbi.fr"
  ).replace(/\/+$/, "");
}

export function unsubscribeUrlFor(userId) {
  return `${apiBaseUrl()}/api/trial-nudges/unsubscribe?t=${createUnsubscribeToken(userId)}`;
}

/**
 * Désinscrit un utilisateur des relances d'essai (idempotent).
 * @param {string} userId
 * @param {{ source?: string }} options
 */
export async function unsubscribeFromTrialNudges(userId, { source } = {}, db) {
  const database = getDb(db);
  await ensureIndexes(database);
  const user = HEX_ID.test(String(userId))
    ? await database
        .collection("user")
        .findOne(
          { _id: new mongoose.Types.ObjectId(String(userId)) },
          { projection: { email: 1 } },
        )
    : null;
  await database.collection(OPTOUT_COLLECTION).updateOne(
    { userId: String(userId) },
    {
      $setOnInsert: {
        userId: String(userId),
        email: user?.email ? String(user.email).toLowerCase() : null,
        source: source || "link",
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
  logger.info(`[TrialNudge] désinscription de ${userId} (${source || "link"})`);
}

// ─── Lecture des espaces en essai ──────────────────────────────────────────

const ORG_PROJECTION = {
  name: 1,
  companyName: 1,
  trialStartDate: 1,
  trialEndDate: 1,
  isTrialActive: 1,
  stripeTrialActive: 1,
  trialEndedEmailSentAt: 1,
  createdAt: 1,
};

function trialOrgsQuery() {
  return { isTrialActive: true, stripeTrialActive: { $ne: true } };
}

const isOwnerRole = (role) =>
  String(role || "")
    .split(",")
    .map((r) => r.trim())
    .includes("owner");

const firstNameOf = (user) => {
  const fromProfile = user?.profile?.firstName;
  if (fromProfile) return String(fromProfile).trim();
  return (
    String(user?.name || "")
      .trim()
      .split(/\s+/)[0] || ""
  );
};

const isInternalEmail = (email) => {
  const domain =
    String(email || "")
      .toLowerCase()
      .split("@")[1] || "";
  return INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
};

/**
 * Charge tout ce qu'il faut pour décider des relances d'un lot d'espaces :
 * propriétaire, dernière activité, abonnement, cabinet, désinscription et
 * relances déjà faites. Une requête par collection, pas une par espace.
 */
async function loadContexts(db, orgs, { simulated }) {
  if (orgs.length === 0) return [];
  const orgIds = orgs.map((o) => String(o._id));

  const members = await db
    .collection("member")
    .find(
      { organizationId: { $in: idVariants(orgIds) } },
      { projection: { organizationId: 1, userId: 1, role: 1 } },
    )
    .toArray();
  const userIds = [...new Set(members.map((m) => String(m.userId)))];

  const [users, devices, sessions, subs, managed, optouts, logs] =
    await Promise.all([
      db
        .collection("user")
        .find(
          {
            _id: {
              $in: idVariants(userIds).filter((v) => typeof v !== "string"),
            },
          },
          {
            projection: {
              email: 1,
              name: 1,
              emailVerified: 1,
              "profile.firstName": 1,
            },
          },
        )
        .toArray(),
      db
        .collection("user_device_log")
        .aggregate([
          { $match: { userId: { $in: idVariants(userIds) } } },
          { $group: { _id: "$userId", at: { $max: "$lastSeenAt" } } },
        ])
        .toArray(),
      db
        .collection("session")
        .aggregate([
          { $match: { userId: { $in: idVariants(userIds) } } },
          { $group: { _id: "$userId", at: { $max: "$updatedAt" } } },
        ])
        .toArray(),
      db
        .collection("subscription")
        .find(
          { referenceId: { $in: orgIds } },
          { projection: { referenceId: 1, status: 1, periodEnd: 1 } },
        )
        .toArray(),
      db
        .collection("managedclients")
        .find(
          { organizationId: { $in: idVariants(orgIds) }, status: "active" },
          { projection: { organizationId: 1 } },
        )
        .toArray(),
      db
        .collection(OPTOUT_COLLECTION)
        .find({ userId: { $in: userIds } }, { projection: { userId: 1 } })
        .toArray(),
      db
        .collection(LOG_COLLECTION)
        .find(
          { orgId: { $in: idVariants(orgIds) }, simulated },
          { projection: { orgId: 1, step: 1 } },
        )
        .toArray(),
    ]);

  const usersById = new Map(users.map((u) => [String(u._id), u]));
  const activityByUser = new Map();
  for (const { _id, at } of [...devices, ...sessions]) {
    const date = toDate(at);
    const key = String(_id);
    activityByUser.set(key, maxDate(activityByUser.get(key), date));
  }
  const now = Date.now();
  const paidOrgs = new Set(
    subs
      .filter(
        (s) =>
          ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status) ||
          (s.status === "canceled" &&
            toDate(s.periodEnd) &&
            toDate(s.periodEnd).getTime() > now),
      )
      .map((s) => String(s.referenceId)),
  );
  const managedOrgs = new Set(managed.map((m) => String(m.organizationId)));
  const optedOut = new Set(optouts.map((o) => String(o.userId)));
  const sentSteps = new Set(logs.map((l) => `${l.orgId}:${l.step}`));

  return orgs.map((org) => {
    const orgId = String(org._id);
    const orgMembers = members.filter(
      (m) => String(m.organizationId) === orgId,
    );
    const ownerMember = orgMembers.find((m) => isOwnerRole(m.role));
    const owner = ownerMember
      ? usersById.get(String(ownerMember.userId))
      : null;
    const trialStart = toDate(org.trialStartDate);
    const lastActivityAt = maxDate(
      trialStart,
      ...orgMembers.map((m) => activityByUser.get(String(m.userId))),
    );
    return {
      org,
      orgId,
      orgName: org.companyName || org.name || "",
      trialStart,
      trialEnd: toDate(org.trialEndDate),
      owner: owner
        ? {
            userId: String(owner._id),
            email: owner.email ? String(owner.email).toLowerCase() : null,
            firstName: firstNameOf(owner),
            emailVerified: owner.emailVerified === true,
          }
        : null,
      lastActivityAt,
      subscribed: paidOrgs.has(orgId),
      managed: managedOrgs.has(orgId),
      optedOut: owner ? optedOut.has(String(owner._id)) : false,
      sentSteps,
    };
  });
}

/**
 * Raison d'exclusion d'une relance pour un espace, ou null s'il est éligible
 * (hors condition de date, vérifiée par l'appelant).
 */
export function exclusionReason(ctx, step, { now, inactivityDays }) {
  if (!ctx.owner?.email) return "no_owner";
  if (!ctx.owner.emailVerified) return "unverified";
  if (isInternalEmail(ctx.owner.email)) return "internal";
  if (ctx.optedOut) return "optout";
  if (ctx.subscribed) return "subscribed";
  if (ctx.managed) return "managed";
  if (ctx.sentSteps.has(`${ctx.orgId}:${step}`)) return "already_sent";
  const requiresInactivity =
    step === END_STEP || SCHEDULED_STEPS[step]?.requiresInactivity;
  if (requiresInactivity && isActive(ctx, { now, inactivityDays })) {
    return "active";
  }
  return null;
}

function isActive(ctx, { now, inactivityDays }) {
  if (!ctx.lastActivityAt) return false;
  return ctx.lastActivityAt.getTime() > now.getTime() - inactivityDays * DAY_MS;
}

function dueDateOf(ctx, step) {
  if (step === END_STEP) return ctx.trialEnd;
  if (!ctx.trialStart) return null;
  return new Date(
    ctx.trialStart.getTime() + SCHEDULED_STEPS[step].dayOffset * DAY_MS,
  );
}

const inSendWindow = (due, now) =>
  Boolean(due) &&
  due.getTime() <= now.getTime() &&
  now.getTime() < due.getTime() + SEND_WINDOW_DAYS * DAY_MS;

// ─── Envoi ─────────────────────────────────────────────────────────────────

let resendClient = null;
function resend() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY non configurée");
  }
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

async function sendNudgeEmail({ to, subject, html, step, unsubscribeUrl }) {
  const from = process.env.RESEND_FROM_EMAIL || "no-reply@newbi.fr";
  const { data, error } = await resend().emails.send({
    from: `Newbi <${from}>`,
    to: [to],
    replyTo: TRIAL_NUDGE_REPLY_TO,
    subject,
    html,
    headers: unsubscribeUrl
      ? {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : undefined,
    tags: [
      { name: "category", value: "trial_nudge" },
      { name: "step", value: step },
    ],
  });
  if (error) throw new Error(`Resend : ${error.message}`);
  return data?.id || null;
}

const daysUntil = (date, now) =>
  date ? Math.ceil((date.getTime() - now.getTime()) / DAY_MS) : undefined;

/**
 * Journalise puis envoie (ou simule) une relance. Le journal est écrit AVANT
 * l'envoi : l'index unique empêche tout second envoi, même si deux exécutions
 * se chevauchent ou si le processus s'arrête au milieu.
 *
 * @returns {Promise<"sent"|"simulated"|"failed"|"duplicate">}
 */
async function deliver(db, ctx, step, { now, simulated }) {
  await ensureIndexes(db);
  const entry = {
    orgId: ctx.org._id,
    orgName: ctx.orgName,
    userId: ctx.owner.userId,
    email: ctx.owner.email,
    step,
    simulated,
    status: simulated ? "simulated" : "pending",
    createdAt: now,
    lastActivityAt: ctx.lastActivityAt,
    trialStartDate: ctx.trialStart,
    trialEndDate: ctx.trialEnd,
  };
  let logId;
  try {
    ({ insertedId: logId } = await db
      .collection(LOG_COLLECTION)
      .insertOne(entry));
  } catch (error) {
    if (error?.code === 11000) return "duplicate";
    throw error;
  }
  ctx.sentSteps.add(`${ctx.orgId}:${step}`);
  if (simulated) return "simulated";

  try {
    const unsubscribeUrl = unsubscribeUrlFor(ctx.owner.userId);
    const { subject, html } = buildTrialNudgeEmail(step, {
      firstName: ctx.owner.firstName,
      orgName: ctx.orgName,
      daysRemaining: daysUntil(ctx.trialEnd, now),
      trialEndDate: ctx.trialEnd,
      unsubscribeUrl,
    });
    const resendId = await sendNudgeEmail({
      to: ctx.owner.email,
      subject,
      html,
      step,
      unsubscribeUrl,
    });
    await db
      .collection(LOG_COLLECTION)
      .updateOne(
        { _id: logId },
        { $set: { status: "sent", sentAt: new Date(), resendId } },
      );
    logger.info(
      `[TrialNudge] ${step} envoyée à ${ctx.owner.email} (org ${ctx.orgId})`,
    );
    return "sent";
  } catch (error) {
    // Pas de nouvel essai automatique : mieux vaut une relance perdue qu'un
    // doublon. L'échec est visible dans l'admin.
    await db
      .collection(LOG_COLLECTION)
      .updateOne(
        { _id: logId },
        {
          $set: {
            status: "failed",
            error: String(error.message).slice(0, 500),
          },
        },
      )
      .catch(() => {});
    logger.error(
      `[TrialNudge] ${step} en échec pour l'org ${ctx.orgId} : ${error.message}`,
    );
    return "failed";
  }
}

async function writeHeartbeat(db, summary, startedAt, key) {
  try {
    await db.collection("_health").updateOne(
      { key },
      {
        $set: {
          key,
          lastRunAt: startedAt,
          lastRunDurationMs: Date.now() - startedAt.getTime(),
          lastSummary: summary,
        },
        $inc: { runCount: 1 },
      },
      { upsert: true },
    );
  } catch (error) {
    logger.warn(`[TrialNudge] heartbeat non écrit : ${error.message}`);
  }
}

/**
 * Passage des relances planifiées (`steps`, toutes par défaut) dont la date
 * est atteinte, dans la fenêtre de rattrapage. Le cron quotidien les passe
 * toutes ; celui de la bienvenue ne passe que `welcome`, toutes les 10 min.
 * La relance de fin d'essai part avec l'expiration, voir
 * sendTrialEndNudgeIfInactive.
 */
export async function runTrialNudges({
  now = new Date(),
  db,
  steps = Object.keys(SCHEDULED_STEPS),
} = {}) {
  if (!isAppTrialEnabled()) return { skipped: true, reason: "flag-off" };
  const database = getDb(db);
  const settings = await getTrialNudgeSettings(database);
  if (settings.mode === "off") return { skipped: true, reason: "mode-off" };
  const simulated = settings.mode === "simulation";
  const startedAt = new Date();

  const orgs = await database
    .collection("organization")
    .find(trialOrgsQuery(), { projection: ORG_PROJECTION })
    .toArray();

  // Ne charger le contexte que des espaces qui ont une relance à faire
  const due = [];
  for (const org of orgs) {
    const start = toDate(org.trialStartDate);
    if (!start) continue;
    for (const step of steps) {
      const { dayOffset } = SCHEDULED_STEPS[step];
      if (inSendWindow(new Date(start.getTime() + dayOffset * DAY_MS), now)) {
        due.push({ org, step });
      }
    }
  }

  const summary = {
    mode: settings.mode,
    due: due.length,
    sent: 0,
    simulated: 0,
    failed: 0,
    excluded: {},
  };
  const contexts = await loadContexts(
    database,
    [...new Map(due.map(({ org }) => [String(org._id), org])).values()],
    { simulated },
  );
  const contextById = new Map(contexts.map((c) => [c.orgId, c]));

  for (const { org, step } of due) {
    const ctx = contextById.get(String(org._id));
    const reason = exclusionReason(ctx, step, {
      now,
      inactivityDays: settings.inactivityDays,
    });
    if (reason) {
      summary.excluded[reason] = (summary.excluded[reason] || 0) + 1;
      continue;
    }
    const outcome = await deliver(database, ctx, step, { now, simulated });
    if (outcome === "sent") summary.sent++;
    else if (outcome === "simulated") summary.simulated++;
    else if (outcome === "failed") summary.failed++;
  }

  // Le passage de la bienvenue tourne toutes les 10 min : pas de log quand
  // il n'y a rien à faire
  if (due.length > 0) {
    logger.info(
      `[TrialNudge] passage ${steps.join("+")} : ${JSON.stringify(summary)}`,
    );
  }
  const heartbeatKey =
    steps.length === 1 ? `trialNudgeCron:${steps[0]}` : "trialNudgeCron";
  await writeHeartbeat(database, summary, startedAt, heartbeatKey);
  return summary;
}

/**
 * Fin d'essai : appelée par trialCleanupCron au moment où il expire l'essai,
 * avant l'e-mail standard. Si l'espace est inactif et que le mode est « live »,
 * la relance part à la place de l'e-mail standard.
 *
 * @returns {Promise<boolean>} true si la relance est partie (l'e-mail
 *   standard ne doit alors pas être envoyé)
 */
export async function sendTrialEndNudgeIfInactive({
  org,
  now = new Date(),
  db,
}) {
  const database = getDb(db);
  const settings = await getTrialNudgeSettings(database);
  if (settings.mode === "off") return false;
  // Rattrapage d'un essai expiré depuis longtemps : e-mail standard
  if (!inSendWindow(toDate(org.trialEndDate), now)) return false;

  const simulated = settings.mode === "simulation";
  const [ctx] = await loadContexts(database, [org], { simulated });
  const reason = exclusionReason(ctx, END_STEP, {
    now,
    inactivityDays: settings.inactivityDays,
  });
  if (reason) return false;
  const outcome = await deliver(database, ctx, END_STEP, { now, simulated });
  return outcome === "sent";
}

/**
 * Calendrier pour l'admin : relances dues ou à venir sous `horizonDays`
 * jours, avec leur état. Une relance à venir qui dépend de l'inactivité
 * n'est que probable : l'activité est réévaluée le jour J.
 */
export async function listTrialNudgeSchedule({
  now = new Date(),
  horizonDays = 7,
  db,
} = {}) {
  const database = getDb(db);
  const settings = await getTrialNudgeSettings(database);
  const orgs = await database
    .collection("organization")
    .find(trialOrgsQuery(), { projection: ORG_PROJECTION })
    .toArray();

  const from = now.getTime() - SEND_WINDOW_DAYS * DAY_MS;
  const to = now.getTime() + horizonDays * DAY_MS;
  const simulated = settings.mode === "simulation";
  const contexts = await loadContexts(database, orgs, { simulated });

  const items = [];
  for (const ctx of contexts) {
    for (const step of [...Object.keys(SCHEDULED_STEPS), END_STEP]) {
      const due = dueDateOf(ctx, step);
      if (!due || due.getTime() < from || due.getTime() > to) continue;
      // Fin d'essai déjà traitée par le cron (e-mail standard parti)
      if (step === END_STEP && ctx.org.trialEndedEmailSentAt) continue;
      const reason = exclusionReason(ctx, step, {
        now,
        inactivityDays: settings.inactivityDays,
      });
      // L'activité d'une relance à venir n'est qu'indicative : elle sera
      // réévaluée le jour J, la relance n'est donc pas exclue pour autant
      const pending = due > now;
      const excluded = Boolean(reason) && !(pending && reason === "active");
      items.push({
        step,
        dueAt: due.toISOString(),
        orgId: ctx.orgId,
        orgName: ctx.orgName,
        ownerEmail: ctx.owner?.email || null,
        lastActivityAt: ctx.lastActivityAt?.toISOString() || null,
        status: excluded ? "excluded" : pending ? "upcoming" : "due",
        reason,
      });
    }
  }
  items.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { settings, items, now: now.toISOString() };
}

// ─── Aperçus et tests depuis l'admin ───────────────────────────────────────

const SAMPLE = {
  firstName: "Camille",
  orgName: "Atelier Martin",
  daysRemaining: 23,
};
const sampleData = () => ({
  ...SAMPLE,
  trialEndDate: new Date(Date.now() + 30 * DAY_MS),
});

function assertStep(step) {
  if (!NUDGE_STEPS.includes(step)) {
    throw new TrialNudgeError("Relance inconnue.", 404);
  }
}

export function renderTrialNudgePreview(step) {
  assertStep(step);
  return buildTrialNudgeEmail(step, { ...sampleData(), unsubscribeUrl: "#" });
}

/** Envoie une relance d'exemple à l'admin (rien n'est journalisé). */
export async function sendTrialNudgeTest({ step, to }) {
  assertStep(step);
  if (!to) throw new TrialNudgeError("Destinataire manquant.");
  // Lien de désinscription factice : la page répond « lien invalide »
  const unsubscribeUrl = `${apiBaseUrl()}/api/trial-nudges/unsubscribe?t=apercu`;
  const { subject, html } = buildTrialNudgeEmail(step, {
    ...sampleData(),
    unsubscribeUrl,
  });
  try {
    await sendNudgeEmail({
      to,
      subject: `[Test] ${subject}`,
      html,
      step,
      unsubscribeUrl,
    });
  } catch (error) {
    throw new TrialNudgeError(`Envoi impossible : ${error.message}`, 502);
  }
}

// ─── Suivi Resend (webhook) ────────────────────────────────────────────────

const EVENT_FIELDS = {
  "email.delivered": "deliveredAt",
  "email.opened": "openedAt",
  "email.clicked": "clickedAt",
  "email.bounced": "bouncedAt",
  "email.complained": "complainedAt",
};

/**
 * Note un événement Resend sur la relance correspondante (première
 * occurrence seulement). Un signalement comme indésirable désinscrit.
 * @returns {Promise<boolean>} true si l'e-mail est une relance d'essai
 */
export async function recordTrialNudgeEmailEvent(type, resendId, db) {
  const field = EVENT_FIELDS[type];
  if (!field || !resendId) return false;
  const database = getDb(db);
  const entry = await database
    .collection(LOG_COLLECTION)
    .findOne({ resendId }, { projection: { userId: 1, [field]: 1 } });
  if (!entry) return false;
  if (!entry[field]) {
    await database
      .collection(LOG_COLLECTION)
      .updateOne({ _id: entry._id }, { $set: { [field]: new Date() } });
  }
  if (type === "email.complained" && entry.userId) {
    await unsubscribeFromTrialNudges(
      entry.userId,
      { source: "complaint" },
      database,
    );
  }
  return true;
}
