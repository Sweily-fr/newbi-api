/**
 * Envoi des prospections (cron chaque minute, instance 0) : pour chaque
 * boîte ACTIVE ayant des destinataires en attente dans une prospection en
 * cours, au plus un message par passage et par adresse d'envoi :
 *
 *   1. dans la plage (jour, heure de Paris, jamais un jour férié),
 *      `nextSendAfter` passé, envoyés aujourd'hui par l'adresse (toutes ses
 *      connexions, réels + simulés + peut-être partis) sous la limite
 *      effective (montée progressive), verrou `lockedUntil` posé de façon
 *      atomique ;
 *   2. plus ancien destinataire en attente, à tour de rôle entre les
 *      prospections de la boîte ; re-vérifié juste avant l'envoi : fiche
 *      supprimée, bloquée ou passée en particulier, adresse dans la liste
 *      d'exclusion, adresse prospectée depuis moins de 30 jours → SKIPPED
 *      avec son motif ;
 *   3. jeton obtenu (renouvelé si besoin : une panne du renouvellement est
 *      une erreur de la BOÎTE, jamais du destinataire), adresse réservée de
 *      façon atomique pour l'espace (contacts.js : deux boîtes ne peuvent
 *      pas écrire à la même adresse), puis envoi depuis la boîte (ou
 *      simulation selon le mode d'envoi des campagnes), SENT ou SIMULATED,
 *      prochain envoi de l'adresse dans 3 à 8 minutes ;
 *   4. erreurs : jeton refusé → boîte EXPIRED (e-mail au membre, une
 *      fois) ; quota du fournisseur → reprise au début de la plage du
 *      lendemain ; refus propre au compte → boîte en pause ; adresse
 *      refusée → FAILED ; erreur passagère → nouvel essai, 3 au plus, puis
 *      FAILED ; envoi incertain (le message a pu partir) → FAILED sans
 *      nouvel essai, compté comme envoyé ; trois FAILED de suite → boîte
 *      en pause ;
 *   5. prospection sans plus rien en attente → COMPLETED.
 *
 * Garde-fous : propriétaire de la boîte toujours membre de l'espace (sinon
 * boîte déconnectée) et avec le droit d'envoyer (sinon prospections en
 * pause), abonnement actif, prospection ouverte à l'espace.
 */
import mongoose from "mongoose";
import { checkSubscriptionActive } from "../../middlewares/rbac.js";
import Client from "../../models/Client.js";
import EmailSuppression from "../../models/EmailSuppression.js";
import MailboxConnection from "../../models/MailboxConnection.js";
import ProspectingContact from "../../models/ProspectingContact.js";
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import ProspectingSequence from "../../models/ProspectingSequence.js";
import { AppError } from "../../utils/errors.js";
import { isFeatureEnabled } from "../../utils/featureAccess.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import {
  userBelongsToWorkspace,
  userHasWorkspaceAction,
} from "../../utils/workspace-membership.js";
import {
  campaignSendMode,
  isRealSendAllowed,
} from "../emailCampaigns/sender.js";
import {
  prospectingDataUrlFor,
  prospectingUnsubscribeUrlFor,
} from "../emailCampaigns/tracking.js";
import { recentContactSince } from "./audience.js";
import { releaseContact, reserveContact } from "./contacts.js";
import {
  MAILBOX_PAUSE_REASONS,
  countSentToday,
  delayAddress,
  disconnectMailbox,
  ensureAccessToken,
  markMailboxExpired,
  pauseMailbox,
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
export const MAX_CONSECUTIVE_FAILURES = 3;
const MAILBOX_LOCK_MS = 2 * 60 * 1000;
const STALE_RECIPIENT_LOCK_MS = 10 * 60 * 1000;
const TEMPORARY_RETRY_MS = 5 * 60 * 1000;
const TOKEN_RETRY_MS = 10 * 60 * 1000;
const SUBSCRIPTION_RETRY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Destinataires écartés à la re-vérification avant un envoi, par passage
const MAX_SKIPS_PER_PASS = 25;
const CONCURRENCY = 4;
// Recherche des boîtes dont le propriétaire a quitté l'espace
const ORPHAN_SWEEP_MS = 10 * 60 * 1000;

export const SKIPPED_REASONS = Object.freeze({
  suppressed: "désinscrit",
  recent: "déjà prospecté",
  canceled: "prospection arrêtée",
  doNotContact: "ne plus contacter",
  contactDeleted: "contact supprimé",
  contactBlocked: "contact bloqué",
  individual: "particulier",
});

export const UNCERTAIN_MESSAGE =
  "Envoi incertain : le message a pu partir, vérifiez dans les messages envoyés de votre boîte. Il ne sera pas renvoyé.";
export const INTERRUPTED_MESSAGE =
  "Envoi interrompu : vérifiez dans les messages envoyés de votre boîte s'il est parti. Il ne sera pas renvoyé.";

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
 * Envoie un message depuis la boîte (e-mails de test). Jeton refusé à
 * l'envoi : renouvelé une fois puis nouvel essai. Lève MailProviderError.
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

async function skipRecipient(recipient, sequenceId, reason, now) {
  await ProspectingRecipient.updateOne(
    { _id: recipient._id, status: "PENDING" },
    {
      $set: {
        status: "SKIPPED",
        skippedReason: reason,
        lockedAt: null,
        sendStartedAt: null,
      },
    },
  );
  await afterRecipientChange(sequenceId, now);
}

/**
 * Re-vérification juste avant l'envoi : motif d'exclusion, ou null. La
 * fiche du contact doit toujours exister, ne pas être bloquée et rester
 * une entreprise.
 */
async function exclusionReason(recipient, now) {
  if (recipient.clientId) {
    const client = await Client.findOne({
      _id: recipient.clientId,
      workspaceId: recipient.workspaceId,
    })
      .select("type isBlocked")
      .lean();
    if (!client) return SKIPPED_REASONS.contactDeleted;
    if (client.isBlocked) return SKIPPED_REASONS.contactBlocked;
    if (client.type === "INDIVIDUAL") return SKIPPED_REASONS.individual;
  }
  const suppressed = await EmailSuppression.exists({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
  });
  if (suppressed) return SKIPPED_REASONS.suppressed;
  const since = recentContactSince(now);
  const [recentSend, reserved] = await Promise.all([
    ProspectingRecipient.exists({
      workspaceId: recipient.workspaceId,
      email: recipient.email,
      _id: { $ne: recipient._id },
      sentAt: { $gte: since },
      simulated: { $ne: true },
    }),
    ProspectingContact.exists({
      workspaceId: recipient.workspaceId,
      email: recipient.email,
      lastSentAt: { $gte: since },
      recipientId: { $ne: recipient._id },
    }),
  ]);
  return recentSend || reserved ? SKIPPED_REASONS.recent : null;
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

/**
 * Envoi interrompu (arrêt du processus) : réservation levée si l'appel au
 * fournisseur n'avait pas commencé ; sinon FAILED, jamais renvoyé, et
 * compté comme envoyé (`sentAt`) pour la limite du jour, l'espacement et
 * la règle des 30 jours.
 */
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
      await ProspectingRecipient.updateOne(
        { _id: recipient._id, status: "PENDING" },
        {
          $set: {
            status: "FAILED",
            error: INTERRUPTED_MESSAGE,
            sentAt: recipient.sendStartedAt,
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
    { $set: { lastError: null, consecutiveFailures: 0 } },
  );
  await delayAddress(mailbox, new Date(now.getTime() + randomSpacingMs()));
  await ProspectingSequence.updateOne(
    { _id: sequence._id },
    { $set: { lastSendAt: now } },
  );
  await afterRecipientChange(sequence._id, now);
}

/**
 * Destinataire en échec : trois de suite sur la boîte la mettent en pause
 * (un problème de compte se cache souvent derrière des refus en série).
 */
async function countFailure(mailbox, message) {
  const updated = await MailboxConnection.findOneAndUpdate(
    { _id: mailbox._id },
    {
      $inc: { consecutiveFailures: 1 },
      $set: { lastError: String(message).slice(0, 500) },
    },
    { new: true },
  ).lean();
  if ((updated?.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) {
    await pauseMailbox(mailbox, {
      kind: "ACCOUNT",
      reason: MAILBOX_PAUSE_REASONS.failures,
      lastError: message,
    });
    return true;
  }
  return false;
}

/**
 * Le jeton n'a pas pu être obtenu : erreur de la boîte, le destinataire
 * attend sans consommer d'essai. Refus (invalid_grant, invalid_client…) :
 * boîte EXPIRED et membre prévenu une fois ; panne : nouvel essai plus tard.
 */
async function recordTokenFailure({ mailbox, recipient, error, now }) {
  const message = String(error?.message || "Erreur inconnue").slice(0, 500);
  await releaseRecipient(recipient._id);
  if (isMailProviderError(error) && error.kind === "AUTH") {
    await markMailboxExpired(mailbox, message, now);
    return "expired";
  }
  await MailboxConnection.updateOne(
    { _id: mailbox._id },
    { $set: { lastError: message } },
  );
  await delayAddress(mailbox, new Date(now.getTime() + TOKEN_RETRY_MS));
  logger.warn(
    `[prospection] jeton de la boîte ${mailbox._id} non renouvelé : ${message}`,
  );
  return "tokenRetry";
}

/** Erreur d'envoi classée (voir providers/errors.js). */
async function recordFailure({
  mailbox,
  sequence,
  recipient,
  error,
  reservation,
  now,
}) {
  const kind = isMailProviderError(error) ? error.kind : "TEMPORARY";
  const message = String(error?.message || "Erreur inconnue").slice(0, 500);
  // Message peut-être parti : jamais renvoyé, compté comme envoyé,
  // l'adresse reste réservée
  if (kind === "UNCERTAIN") {
    await ProspectingRecipient.updateOne(
      { _id: recipient._id, status: "PENDING" },
      {
        $set: {
          status: "FAILED",
          error: UNCERTAIN_MESSAGE,
          sentAt: now,
          lockedAt: null,
          sendStartedAt: null,
        },
        $inc: { attempts: 1 },
      },
    );
    await afterRecipientChange(sequence._id, now);
    await delayAddress(mailbox, new Date(now.getTime() + randomSpacingMs()));
    logger.warn(
      `[prospection] envoi incertain à ${recipient._id} (boîte ${mailbox._id}) : ${message}`,
    );
    await countFailure(mailbox, message);
    return "uncertain";
  }
  // Le message n'est pas parti : l'adresse est libérée
  if (reservation?.reserved) {
    await releaseContact({
      workspaceId: recipient.workspaceId,
      email: recipient.email,
      recipientId: recipient._id,
      previous: reservation.previous,
    });
  }
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
      { $set: { lastError: message } },
    );
    await delayAddress(mailbox, resume);
    logger.warn(
      `[prospection] limite du fournisseur atteinte pour la boîte ${mailbox._id} : reprise le ${resume.toISOString()}`,
    );
    return "quota";
  }
  if (kind === "ACCOUNT") {
    await releaseRecipient(recipient._id);
    await pauseMailbox(mailbox, {
      kind: "ACCOUNT",
      reason: MAILBOX_PAUSE_REASONS.account,
      lastError: message,
    });
    return "accountError";
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
  await delayAddress(
    mailbox,
    new Date(
      now.getTime() +
        (kind === "TEMPORARY" ? TEMPORARY_RETRY_MS : randomSpacingMs()),
    ),
  );
  logger.warn(
    `[prospection] envoi à ${recipient._id} en échec (${kind}, essai ${attempts}) : ${message}`,
  );
  if (definitive && (await countFailure(mailbox, message))) {
    return "failuresPaused";
  }
  if (!definitive) {
    await MailboxConnection.updateOne(
      { _id: mailbox._id },
      { $set: { lastError: message } },
    );
  }
  return definitive ? "failed" : "retry";
}

/**
 * Envoie (ou simule) le message d'un destinataire réservé. « skipped » :
 * adresse prise entre-temps par une autre boîte de l'espace.
 */
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
  if (!real) {
    await recordSuccess({ mailbox, sequence, recipient, real, now });
    return "simulated";
  }

  let mime;
  try {
    mime = buildMessageMime({
      mailbox,
      senderName: current.snapshot?.senderName,
      to: recipient.email,
      rendered: renderRecipientMessage(sequence, recipient),
      now,
    });
  } catch (error) {
    return recordFailure({ mailbox, sequence, recipient, error, now });
  }

  // Jeton d'abord : sa panne ne compte jamais contre le destinataire
  const provider = mailProvider(mailbox.provider);
  let accessToken;
  try {
    accessToken = await ensureAccessToken(mailbox, { now });
  } catch (error) {
    return recordTokenFailure({ mailbox, recipient, error, now });
  }

  // Adresse réservée pour l'espace, de façon atomique
  const reservation = await reserveContact({
    workspaceId: recipient.workspaceId,
    email: recipient.email,
    sequenceId: sequence._id,
    recipientId: recipient._id,
    now,
  });
  if (!reservation.reserved) {
    await skipRecipient(recipient, sequence._id, SKIPPED_REASONS.recent, now);
    return "skipped";
  }

  await ProspectingRecipient.updateOne(
    { _id: recipient._id, status: "PENDING" },
    { $set: { sendStartedAt: now } },
  );
  const failure = (error) =>
    recordFailure({ mailbox, sequence, recipient, error, reservation, now });
  let result;
  try {
    result = await provider.sendMessage({ accessToken, mime });
  } catch (error) {
    if (!isMailProviderError(error) || error.kind !== "AUTH") {
      return failure(error);
    }
    // Jeton refusé à l'envoi (rien n'est parti) : renouvelé une fois
    try {
      accessToken = await ensureAccessToken(mailbox, { now, force: true });
    } catch (refreshError) {
      await releaseContact({
        workspaceId: recipient.workspaceId,
        email: recipient.email,
        recipientId: recipient._id,
        previous: reservation.previous,
      });
      return recordTokenFailure({
        mailbox,
        recipient,
        error: refreshError,
        now,
      });
    }
    try {
      result = await provider.sendMessage({ accessToken, mime });
    } catch (retryError) {
      return failure(retryError);
    }
  }
  await recordSuccess({ mailbox, sequence, recipient, result, real, now });
  return "sent";
}

// ─── Une boîte ─────────────────────────────────────────────────────────────

async function sendNext(mailbox, now) {
  const workspaceId = String(mailbox.workspaceId);
  if (!(await userBelongsToWorkspace(String(mailbox.userId), workspaceId))) {
    await disconnectMailbox(mailbox, {
      reason: MAILBOX_PAUSE_REASONS.ownerLeft,
    });
    return "ownerLeft";
  }
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
    if (reason) {
      await skipRecipient(next.recipient, next.sequence._id, reason, now);
      continue;
    }
    const outcome = await deliver({ mailbox, ...next, now });
    if (outcome !== "skipped") return outcome;
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
  const sentToday = await countSentToday(mailbox, now);
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

let lastOrphanSweepAt = 0;

/**
 * Boîtes dont le propriétaire ne fait plus partie de l'espace : déconnectées
 * (jetons effacés, prospections en cours en pause), même sans prospection
 * en cours. Une seule lecture des adhésions pour toutes les boîtes.
 */
export async function disconnectOrphanMailboxes() {
  const mailboxes = await MailboxConnection.find({
    status: { $ne: "DISCONNECTED" },
  }).lean();
  if (!mailboxes.length) return 0;
  const pairs = mailboxes
    .map((m) => ({
      organizationId: toObjectIdOrNull(String(m.workspaceId)),
      userId: toObjectIdOrNull(String(m.userId)),
    }))
    .filter((p) => p.organizationId && p.userId);
  if (!pairs.length) return 0;
  const members = await mongoose.connection.db
    .collection("member")
    .find({ $or: pairs }, { projection: { organizationId: 1, userId: 1 } })
    .toArray();
  const present = new Set(
    members.map((m) => `${m.organizationId}:${m.userId}`),
  );
  let disconnected = 0;
  for (const mailbox of mailboxes) {
    if (present.has(`${mailbox.workspaceId}:${mailbox.userId}`)) continue;
    await disconnectMailbox(mailbox, {
      reason: MAILBOX_PAUSE_REASONS.ownerLeft,
    });
    disconnected += 1;
    logger.warn(
      `[prospection] boîte ${mailbox._id} déconnectée : propriétaire parti de l'espace ${mailbox.workspaceId}`,
    );
  }
  return disconnected;
}

/**
 * Un passage du cron. Les boîtes d'une même adresse (plusieurs membres ou
 * espaces) sont servies l'une après l'autre : au plus un envoi par adresse
 * et par passage.
 */
export async function runProspectingTick({
  now = () => new Date(),
  sweepOrphans = false,
} = {}) {
  const at = now();
  const totals = {};
  if (sweepOrphans || at.getTime() - lastOrphanSweepAt >= ORPHAN_SWEEP_MS) {
    lastOrphanSweepAt = at.getTime();
    try {
      const count = await disconnectOrphanMailboxes();
      if (count) totals.ownerLeft = count;
    } catch (error) {
      logger.error(
        `[prospection] recherche des boîtes orphelines : ${error.message}`,
      );
    }
  }
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
  const byAddress = new Map();
  for (const mailbox of mailboxes) {
    const key = mailbox.accountEmail || String(mailbox._id);
    if (!byAddress.has(key)) byAddress.set(key, []);
    byAddress.get(key).push(mailbox);
  }
  await eachLimited([...byAddress.values()], CONCURRENCY, async (group) => {
    for (const mailbox of group) {
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
      // Un envoi par adresse et par passage
      if (["sent", "simulated", "uncertain"].includes(outcome)) break;
    }
  });
  if (
    totals.sent ||
    totals.simulated ||
    totals.failed ||
    totals.expired ||
    totals.uncertain
  ) {
    logger.info(`[prospection] passage : ${JSON.stringify(totals)}`);
  }
  return totals;
}

/** Tests : la prochaine passe cherche de nouveau les boîtes orphelines. */
export function resetOrphanSweep() {
  lastOrphanSweepAt = 0;
}

export { MailProviderError };
