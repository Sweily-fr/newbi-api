/**
 * Envoi des prospections (cron chaque minute, instance 0) : pour chaque
 * boîte ACTIVE ayant des destinataires en attente dans une prospection en
 * cours, au plus un message par passage :
 *
 *   1. dans la plage (jour, heure de Paris, jamais un jour férié),
 *      `nextSendAfter` passé, envoyés aujourd'hui (réels + simulés) sous la
 *      limite effective (montée progressive), verrou `lockedUntil` posé de
 *      façon atomique ;
 *   2. plus ancien destinataire en attente, à tour de rôle entre les
 *      prospections de la boîte ; re-vérifié juste avant l'envoi : adresse
 *      dans la liste d'exclusion → SKIPPED (« désinscrit »), prospectée par
 *      l'espace depuis moins de 30 jours → SKIPPED (« déjà prospecté ») ;
 *   3. envoi depuis la boîte (ou simulation selon le mode d'envoi des
 *      campagnes), SENT ou SIMULATED, prochain envoi dans 3 à 8 minutes ;
 *   4. erreurs : jeton refusé → boîte EXPIRED (e-mail au membre, une
 *      fois) ; quota du fournisseur → reprise au début de la plage du
 *      lendemain ; adresse refusée → FAILED ; erreur passagère → nouvel
 *      essai, 3 au plus, puis FAILED ;
 *   5. prospection sans plus rien en attente → COMPLETED.
 *
 * Garde-fous : le propriétaire de la boîte doit toujours avoir le droit
 * d'envoyer (sinon ses prospections passent en pause), l'abonnement de
 * l'espace doit être actif et la prospection ouverte à l'espace.
 */
import { checkSubscriptionActive } from "../../middlewares/rbac.js";
import EmailSuppression from "../../models/EmailSuppression.js";
import MailboxConnection from "../../models/MailboxConnection.js";
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import ProspectingSequence from "../../models/ProspectingSequence.js";
import { AppError } from "../../utils/errors.js";
import { isFeatureEnabled } from "../../utils/featureAccess.js";
import logger from "../../utils/logger.js";
import { userHasWorkspaceAction } from "../../utils/workspace-membership.js";
import {
  campaignSendMode,
  isRealSendAllowed,
} from "../emailCampaigns/sender.js";
import {
  prospectingDataUrlFor,
  prospectingUnsubscribeUrlFor,
} from "../emailCampaigns/tracking.js";
import { recentContactSince } from "./audience.js";
import {
  MAILBOX_PAUSE_REASONS,
  countSentToday,
  ensureAccessToken,
  markMailboxExpired,
  pauseMailboxSequences,
} from "./mailboxes.js";
import { buildMimeMessage } from "./mime.js";
import {
  isMailProviderError,
  mailProvider,
  MailProviderError,
} from "./providers/index.js";
import { renderProspectingMessage } from "./render.js";
import {
  effectiveDailyLimit,
  isWithinSendWindow,
  nextWindowStart,
  randomSpacingMs,
} from "./schedule.js";
import { completeSequenceIfDone, refreshSequenceStats } from "./stats.js";

export const MAX_ATTEMPTS = 3;
const MAILBOX_LOCK_MS = 2 * 60 * 1000;
const STALE_RECIPIENT_LOCK_MS = 10 * 60 * 1000;
const TEMPORARY_RETRY_MS = 5 * 60 * 1000;
const SUBSCRIPTION_RETRY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Destinataires écartés à la re-vérification avant un envoi, par passage
const MAX_SKIPS_PER_PASS = 25;
const CONCURRENCY = 4;

export const SKIPPED_REASONS = Object.freeze({
  suppressed: "désinscrit",
  recent: "déjà prospecté",
  canceled: "prospection arrêtée",
  doNotContact: "ne plus contacter",
});

// ─── Message d'un destinataire ────────────────────────────────────────────

/** Message rendu pour un destinataire : { subject, html, text, unsubscribeUrl }. */
export function renderRecipientMessage(sequence, recipient) {
  const snapshot = sequence.snapshot || {};
  const unsubscribeUrl = prospectingUnsubscribeUrlFor(recipient._id);
  const rendered = renderProspectingMessage({
    subject: sequence.subject,
    body: sequence.body,
    vars: recipient.vars || {},
    identity: {
      companyName: snapshot.companyName,
      companyAddress: snapshot.companyAddress,
    },
    signatureHtml: snapshot.signatureHtml || "",
    signatureText: snapshot.signatureText || "",
    isGeneratedProspect: Boolean(recipient.isGeneratedProspect),
    unsubscribeUrl,
    dataPageUrl:
      snapshot.dataPageUrl || prospectingDataUrlFor(sequence.workspaceId),
  });
  return { ...rendered, unsubscribeUrl };
}

/** Message MIME prêt à partir de la boîte. */
export function buildMessageMime({
  mailbox,
  senderName,
  to,
  rendered,
  now = new Date(),
}) {
  return buildMimeMessage({
    fromName: senderName || mailbox.accountName || "",
    fromEmail: mailbox.accountEmail,
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: {
      "List-Unsubscribe": `<${rendered.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    date: now,
  });
}

/**
 * Envoie un message depuis la boîte. Jeton refusé à l'envoi : renouvelé une
 * fois puis nouvel essai (horloges décalées, jeton révoqué) ; un second
 * refus remonte (AUTH). Lève MailProviderError.
 */
export async function sendFromMailbox(mailbox, mime, now = new Date()) {
  const provider = mailProvider(mailbox.provider);
  let accessToken = await ensureAccessToken(mailbox, { now });
  try {
    return await provider.sendMessage({ accessToken, mime });
  } catch (error) {
    if (!isMailProviderError(error) || error.kind !== "AUTH") throw error;
    accessToken = await ensureAccessToken(mailbox, { now, force: true });
    return provider.sendMessage({ accessToken, mime });
  }
}

// ─── Un envoi ──────────────────────────────────────────────────────────────

const releaseRecipient = (recipientId, set = {}, inc = {}) =>
  ProspectingRecipient.updateOne(
    { _id: recipientId, status: "PENDING" },
    {
      $set: { lockedAt: null, sendStartedAt: null, ...set },
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    },
  );

async function afterRecipientChange(sequenceId, now) {
  await refreshSequenceStats(sequenceId);
  await completeSequenceIfDone(sequenceId, now);
}

/** Re-vérification juste avant l'envoi : motif d'exclusion, ou null. */
async function exclusionReason(recipient, now) {
  const suppressed = await EmailSuppression.exists({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
  });
  if (suppressed) return SKIPPED_REASONS.suppressed;
  const recent = await ProspectingRecipient.exists({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
    _id: { $ne: recipient._id },
    sentAt: { $gte: recentContactSince(now) },
    simulated: { $ne: true },
  });
  return recent ? SKIPPED_REASONS.recent : null;
}

/**
 * Prochain destinataire de la boîte, à tour de rôle entre ses prospections
 * en cours (celle servie le moins récemment d'abord), réservé (`lockedAt`).
 */
async function pickNextRecipient(mailbox, now) {
  const sequences = await ProspectingSequence.find({
    mailboxId: mailbox._id,
    status: "ACTIVE",
    deletedAt: null,
  })
    .sort({ lastSendAt: 1, _id: 1 })
    .lean();
  for (const sequence of sequences) {
    const recipient = await ProspectingRecipient.findOneAndUpdate(
      { sequenceId: sequence._id, status: "PENDING", lockedAt: null },
      { $set: { lockedAt: now } },
      { sort: { _id: 1 }, new: true },
    ).lean();
    if (recipient) return { sequence, recipient };
    await completeSequenceIfDone(sequence._id, now);
  }
  return null;
}

/** Envoi interrompu (arrêt du processus) : réservations levées ou FAILED. */
async function releaseStaleRecipients(mailboxId, now) {
  const limit = new Date(now.getTime() - STALE_RECIPIENT_LOCK_MS);
  const stale = await ProspectingRecipient.find({
    mailboxId,
    status: "PENDING",
    lockedAt: { $ne: null, $lt: limit },
  })
    .select("_id sequenceId sendStartedAt")
    .lean();
  for (const recipient of stale) {
    if (recipient.sendStartedAt) {
      // Le message est peut-être parti : jamais renvoyé
      await ProspectingRecipient.updateOne(
        { _id: recipient._id, status: "PENDING" },
        {
          $set: {
            status: "FAILED",
            error:
              "Envoi interrompu : vérifiez dans les messages envoyés de votre boîte s'il est parti.",
            lockedAt: null,
          },
        },
      );
      await afterRecipientChange(recipient.sequenceId, now);
    } else {
      await releaseRecipient(recipient._id);
    }
  }
}

async function recordSuccess({
  mailbox,
  sequence,
  recipient,
  result,
  real,
  now,
}) {
  // Le message est parti : son statut l'emporte (même arrêté entre-temps)
  await ProspectingRecipient.updateOne(
    { _id: recipient._id },
    {
      $set: {
        status: real ? "SENT" : "SIMULATED",
        simulated: !real,
        sentAt: now,
        providerMessageId: result?.providerMessageId || null,
        threadId: result?.threadId || null,
        lockedAt: null,
        sendStartedAt: null,
        skippedReason: null,
        error: null,
      },
      $inc: { attempts: 1 },
    },
  );
  await MailboxConnection.updateOne(
    { _id: mailbox._id },
    {
      $set: {
        nextSendAfter: new Date(now.getTime() + randomSpacingMs()),
        lastError: null,
      },
    },
  );
  await ProspectingSequence.updateOne(
    { _id: sequence._id },
    { $set: { lastSendAt: now } },
  );
  await afterRecipientChange(sequence._id, now);
}

/** Erreur d'envoi classée (voir providers/errors.js). */
async function recordFailure({ mailbox, sequence, recipient, error, now }) {
  const kind = isMailProviderError(error) ? error.kind : "TEMPORARY";
  const message = String(error?.message || "Erreur inconnue").slice(0, 500);
  if (kind === "AUTH") {
    await releaseRecipient(recipient._id);
    await markMailboxExpired(mailbox, message, now);
    return "expired";
  }
  if (kind === "QUOTA") {
    await releaseRecipient(recipient._id);
    const resume =
      nextWindowStart(mailbox.sendWindow, now) ||
      new Date(now.getTime() + DAY_MS);
    await MailboxConnection.updateOne(
      { _id: mailbox._id },
      { $set: { nextSendAfter: resume, lastError: message } },
    );
    logger.warn(
      `[prospection] limite du fournisseur atteinte pour la boîte ${mailbox._id} : reprise le ${resume.toISOString()}`,
    );
    return "quota";
  }
  const attempts = (recipient.attempts || 0) + 1;
  const definitive =
    kind === "RECIPIENT" || kind === "PERMANENT" || attempts >= MAX_ATTEMPTS;
  if (definitive) {
    await ProspectingRecipient.updateOne(
      { _id: recipient._id, status: "PENDING" },
      {
        $set: {
          status: "FAILED",
          error:
            kind === "TEMPORARY"
              ? `Envoi impossible après ${MAX_ATTEMPTS} essais : ${message}`
              : message,
          lockedAt: null,
          sendStartedAt: null,
        },
        $inc: { attempts: 1 },
      },
    );
    await afterRecipientChange(sequence._id, now);
  } else {
    await releaseRecipient(recipient._id, { error: message }, { attempts: 1 });
  }
  await MailboxConnection.updateOne(
    { _id: mailbox._id },
    {
      $set: {
        nextSendAfter: new Date(
          now.getTime() +
            (kind === "TEMPORARY" ? TEMPORARY_RETRY_MS : randomSpacingMs()),
        ),
        lastError: message,
      },
    },
  );
  logger.warn(
    `[prospection] envoi à ${recipient._id} en échec (${kind}, essai ${attempts}) : ${message}`,
  );
  return definitive ? "failed" : "retry";
}

/** Envoie (ou simule) le message d'un destinataire réservé. */
async function deliver({ mailbox, sequence, recipient, now }) {
  // Pause, arrêt ou boîte changée entre-temps : rien ne part
  const current = await ProspectingSequence.findById(sequence._id)
    .select("status snapshot")
    .lean();
  if (current?.status !== "ACTIVE") {
    await releaseRecipient(recipient._id);
    return "paused";
  }
  const senderEmail = current.snapshot?.senderEmail;
  if (senderEmail && senderEmail !== mailbox.accountEmail) {
    await releaseRecipient(recipient._id);
    await pauseMailboxSequences(mailbox._id, MAILBOX_PAUSE_REASONS.changed);
    return "paused";
  }
  const real = isRealSendAllowed(recipient.email, campaignSendMode());
  let result = null;
  try {
    if (real) {
      const rendered = renderRecipientMessage(sequence, recipient);
      const mime = buildMessageMime({
        mailbox,
        senderName: current.snapshot?.senderName,
        to: recipient.email,
        rendered,
        now,
      });
      await ProspectingRecipient.updateOne(
        { _id: recipient._id, status: "PENDING" },
        { $set: { sendStartedAt: now } },
      );
      result = await sendFromMailbox(mailbox, mime, now);
    }
  } catch (error) {
    return recordFailure({ mailbox, sequence, recipient, error, now });
  }
  await recordSuccess({ mailbox, sequence, recipient, result, real, now });
  return real ? "sent" : "simulated";
}

// ─── Une boîte ─────────────────────────────────────────────────────────────

async function sendNext(mailbox, now) {
  const workspaceId = String(mailbox.workspaceId);
  const allowed = await userHasWorkspaceAction(
    String(mailbox.userId),
    workspaceId,
    "prospecting",
    "send",
  );
  if (!allowed) {
    await pauseMailboxSequences(mailbox._id, MAILBOX_PAUSE_REASONS.rights);
    return "noRights";
  }
  try {
    await checkSubscriptionActive({ workspaceId });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await MailboxConnection.updateOne(
      { _id: mailbox._id },
      {
        $set: {
          nextSendAfter: new Date(now.getTime() + SUBSCRIPTION_RETRY_MS),
        },
      },
    );
    return "subscription";
  }
  await releaseStaleRecipients(mailbox._id, now);
  for (let skips = 0; skips < MAX_SKIPS_PER_PASS; skips += 1) {
    const next = await pickNextRecipient(mailbox, now);
    if (!next) return "idle";
    const reason = await exclusionReason(next.recipient, now);
    if (!reason) return deliver({ mailbox, ...next, now });
    await ProspectingRecipient.updateOne(
      { _id: next.recipient._id, status: "PENDING" },
      { $set: { status: "SKIPPED", skippedReason: reason, lockedAt: null } },
    );
    await afterRecipientChange(next.sequence._id, now);
  }
  return "skipped";
}

/**
 * Un passage pour une boîte : au plus un message envoyé (ou simulé).
 * @returns {Promise<string>} issue (sent, simulated, idle, outsideWindow…)
 */
export async function processMailbox(mailbox, { now = new Date() } = {}) {
  if (!isWithinSendWindow(mailbox.sendWindow, now)) return "outsideWindow";
  if (!isFeatureEnabled("prospecting", String(mailbox.workspaceId))) {
    return "featureClosed";
  }
  const sentToday = await countSentToday(mailbox._id, now);
  if (sentToday >= effectiveDailyLimit(mailbox, now)) return "dailyLimit";
  const lockedUntil = new Date(now.getTime() + MAILBOX_LOCK_MS);
  const locked = await MailboxConnection.findOneAndUpdate(
    {
      _id: mailbox._id,
      status: "ACTIVE",
      $and: [
        { $or: [{ nextSendAfter: null }, { nextSendAfter: { $lte: now } }] },
        { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      ],
    },
    { $set: { lockedUntil } },
    { new: true },
  ).lean();
  if (!locked) return "busy";
  try {
    return await sendNext(locked, now);
  } finally {
    await MailboxConnection.updateOne(
      { _id: mailbox._id, lockedUntil },
      { $set: { lockedUntil: null } },
    );
  }
}

/** Exécute `run` sur chaque élément, `limit` à la fois. */
async function eachLimited(items, limit, run) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await run(item);
      }
    },
  );
  await Promise.all(workers);
}

/** Un passage du cron : chaque boîte qui a un envoi dû. */
export async function runProspectingTick({ now = () => new Date() } = {}) {
  const at = now();
  const totals = {};
  const sequences = await ProspectingSequence.find({
    status: "ACTIVE",
    deletedAt: null,
  })
    .select("mailboxId")
    .lean();
  const mailboxIds = [...new Set(sequences.map((s) => String(s.mailboxId)))];
  if (!mailboxIds.length) return totals;
  const mailboxes = await MailboxConnection.find({
    _id: { $in: mailboxIds },
    status: "ACTIVE",
    $and: [
      { $or: [{ nextSendAfter: null }, { nextSendAfter: { $lte: at } }] },
      { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: at } }] },
    ],
  }).lean();
  await eachLimited(mailboxes, CONCURRENCY, async (mailbox) => {
    let outcome;
    try {
      outcome = await processMailbox(mailbox, { now: now() });
    } catch (error) {
      outcome = "error";
      logger.error(
        `[prospection] boîte ${mailbox._id} en échec : ${error.message}`,
      );
    }
    totals[outcome] = (totals[outcome] || 0) + 1;
  });
  if (totals.sent || totals.simulated || totals.failed || totals.expired) {
    logger.info(`[prospection] passage : ${JSON.stringify(totals)}`);
  }
  return totals;
}

export { MailProviderError };
