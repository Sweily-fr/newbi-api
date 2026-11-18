/**
 * Campagnes e-mail : vérification avant envoi, lancement, machine à états,
 * envoi par lots (cron) et e-mails de test.
 *
 *   DRAFT ──► SCHEDULED ──► SENDING ◄──► PAUSED
 *     ▲          │             │            │
 *     └──────────┘             ├──► SENT    └──► CANCELED
 *   (déprogrammée,             └──► CANCELED
 *    envoi programmé impossible)
 *
 * Lancement : audience résolue et figée (un destinataire par adresse),
 * quota contrôlé avant ET après la création des destinataires (deux
 * lancements simultanés ne le dépassent pas), liens et identité figés.
 * Une campagne programmée qui ne peut pas partir à l'heure dite repasse en
 * brouillon avec la raison dans `pausedReason`.
 *
 * Envoi (cron, toutes les minutes, instance 0) : campagnes servies à tour de
 * rôle, lots de 100 au plus espacés de 1,2 s, plafond global par minute
 * (EMAIL_CAMPAIGN_MAX_PER_MINUTE). Verrou par campagne (`lockedUntil`) et
 * par destinataire (`lockedAt`, levé au bout de 10 minutes) : un arrêt en
 * plein envoi reprend sans doublon (clé d'idempotence du lot). La campagne
 * passe en SENT quand plus aucun destinataire n'attend.
 */
import crypto from "crypto";
import EmailCampaign from "../../models/EmailCampaign.js";
import EmailCampaignRecipient from "../../models/EmailCampaignRecipient.js";
import { checkSubscriptionActive } from "../../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import logger from "../../utils/logger.js";
import { isValidEmail } from "../../utils/validators.js";
import { notifyError } from "../errorAlertService.js";
import { ensureIcons } from "../signatureAssets.js";
import { resolveAudience } from "./audience.js";
import { singleLine } from "./design.js";
import {
  SENDING_UNAVAILABLE_MESSAGE,
  buildDeliverability,
  checkSenderDomain,
  firstErrorTitle,
  quotaExceededMessage,
} from "./deliverability.js";
import { loadWorkspaceIdentity } from "./identity.js";
import { CAMPAIGN_VARIABLES, EXAMPLE_VARIABLES } from "./personalize.js";
import { getCampaignQuota } from "./quota.js";
import { renderCampaignEmail, socialIconSpecs } from "./render.js";
import {
  BATCH_INTERVAL_MS,
  BATCH_SIZE,
  buildEmailPayload,
  campaignSendMode,
  isRealSendAllowed,
  maxPerMinute,
  newbiSenderEmail,
  sendBatch,
} from "./sender.js";
import {
  authenticationOf,
  checkNewbiSendingDomain,
  resolveCampaignSender,
} from "./sendingDomains.js";
import {
  clickUrlBuilder,
  openPixelUrlFor,
  testUnsubscribeUrlFor,
  unsubscribeUrlFor,
} from "./tracking.js";

export const MAX_ATTEMPTS = 3;
const STALE_RECIPIENT_LOCK_MS = 10 * 60 * 1000;
const CAMPAIGN_LOCK_MS = 2 * 60 * 1000;
const LAUNCH_LOCK_MS = 10 * 60 * 1000;
const INSERT_CHUNK = 1000;
const QUOTA_RETRY_MS = 30 * 60 * 1000;
const RATE_LIMIT_RETRY_MS = 15 * 1000;
const SERVICE_RETRY_MS = 60 * 1000;
// Identifiant fictif du rendu d'exemple (poids du HTML avec suivi)
const SAMPLE_RECIPIENT_ID = "000000000000000000000000";

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const conflictError = () =>
  new AppError(
    "La campagne a changé entre-temps : rechargez la page puis réessayez.",
    ERROR_CODES.VALIDATION_ERROR,
  );

/** Icônes des réseaux sociaux du contenu, générées sur R2 (sans bloquer). */
function prepareSocialIcons(design) {
  const specs = socialIconSpecs(design);
  if (!specs.length) return Promise.resolve();
  return ensureIcons(specs).catch((error) =>
    logger.warn(`[campagnes] icônes non préparées : ${error.message}`),
  );
}

// ─── Réglages et vérification ─────────────────────────────────────────────

/**
 * Réglages de l'espace pour l'éditeur : adresse d'envoi réelle (domaine
 * connecté validé, sinon adresse Newbi), domaine connecté, quota, variables.
 */
export async function campaignSettings(
  workspaceId,
  { canManageSendingDomain = false } = {},
) {
  const [identity, quota] = await Promise.all([
    loadWorkspaceIdentity(workspaceId),
    getCampaignQuota(workspaceId),
  ]);
  const sender = await resolveCampaignSender(workspaceId, { identity });
  return {
    senderEmail: sender.email,
    newbiSenderEmail: sender.newbiEmail,
    sendingDomain: sender.sendingDomain,
    canManageSendingDomain: Boolean(canManageSendingDomain),
    defaultFromName: singleLine(identity.companyName, 60),
    defaultReplyTo: identity.defaultReplyTo,
    companyAddress: identity.companyAddress,
    sendMode: campaignSendMode(),
    quota: {
      plan: quota.plan,
      monthlyLimit: quota.monthlyLimit,
      usedThisMonth: quota.usedThisMonth,
      remaining: quota.remaining,
    },
    variables: CAMPAIGN_VARIABLES.map((variable) => ({ ...variable })),
  };
}

/**
 * Adresse d'envoi d'une campagne pour la vérification avant envoi : domaine
 * du client validé (DKIM et SPF d'après Resend, DMARC lu dans le DNS), ou
 * adresse Newbi (domaine Newbi validé chez Resend ; sans objet en mode
 * simulation, où rien ne part).
 */
export async function inspectCampaignSender(workspaceId, { identity } = {}) {
  const sender = await resolveCampaignSender(workspaceId, { identity });
  if (sender.custom) {
    const dns = await checkSenderDomain(sender.sendingDomain.domain);
    return {
      ...sender,
      available: true,
      auth: { ...authenticationOf(sender.sendingDomain), dmarc: dns.dmarc },
    };
  }
  if (campaignSendMode() === "SIMULATION") {
    return { ...sender, available: true };
  }
  const newbi = await checkNewbiSendingDomain();
  return { ...sender, available: newbi.available };
}

/** Vérification avant envoi d'une campagne (voir deliverability.js). */
export async function evaluateDeliverability(campaign, { identity } = {}) {
  const workspaceId = campaign.workspaceId;
  const [resolvedIdentity, audience, quota] = await Promise.all([
    identity || loadWorkspaceIdentity(workspaceId),
    resolveAudience(workspaceId, campaign.audience),
    getCampaignQuota(workspaceId),
  ]);
  const sender = await inspectCampaignSender(workspaceId, {
    identity: resolvedIdentity,
  });
  const sample = renderCampaignEmail({
    design: campaign.design,
    subject: campaign.subject,
    preheader: campaign.preheader,
    vars: EXAMPLE_VARIABLES,
    identity: resolvedIdentity,
    unsubscribeUrl: unsubscribeUrlFor(SAMPLE_RECIPIENT_ID),
    trackClick:
      campaign.trackClicks !== false
        ? clickUrlBuilder(SAMPLE_RECIPIENT_ID)
        : null,
    openPixelUrl:
      campaign.trackOpens !== false
        ? openPixelUrlFor(SAMPLE_RECIPIENT_ID)
        : null,
  });
  const replyTo = singleLine(campaign.replyTo);
  return buildDeliverability({
    campaign,
    sender,
    replyToValid: !replyTo || isValidEmail(replyTo),
    companyAddress: resolvedIdentity.companyAddress,
    audienceCount: audience.counts,
    quota,
    htmlBytes: Buffer.byteLength(sample.html, "utf8"),
  });
}

// ─── Lancement ─────────────────────────────────────────────────────────────

async function insertRecipients(campaign, recipients) {
  for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
    const chunk = recipients.slice(i, i + INSERT_CHUNK).map((recipient) => ({
      workspaceId: campaign.workspaceId,
      campaignId: campaign._id,
      clientId: recipient.clientId,
      email: recipient.email,
      name: recipient.name,
      vars: recipient.vars,
      status: "PENDING",
    }));
    try {
      await EmailCampaignRecipient.insertMany(chunk, { ordered: false });
    } catch (error) {
      // Destinataires déjà créés (lancement repris) : ignorés
      const duplicatesOnly =
        error?.code === 11000 ||
        (Array.isArray(error?.writeErrors) &&
          error.writeErrors.every((item) => item?.code === 11000));
      if (!duplicatesOnly) throw error;
    }
  }
}

/**
 * Passe la campagne de `from` (DRAFT ou SCHEDULED) à SENDING : destinataires
 * créés, quota contrôlé, liens et identité figés. En cas d'échec, tout est
 * défait et l'erreur relancée (programmée : retour au brouillon).
 */
export async function startSending(campaign, { from, now = new Date() }) {
  const locked = await EmailCampaign.findOneAndUpdate(
    { _id: campaign._id, status: from, deletedAt: null },
    {
      $set: {
        status: "SENDING",
        startedAt: now,
        completedAt: null,
        pausedReason: null,
        pauseKind: null,
        retryAfter: null,
        lockedUntil: new Date(now.getTime() + LAUNCH_LOCK_MS),
      },
    },
    { new: true },
  );
  if (!locked) throw conflictError();

  try {
    // Liens et expéditeur figés avant tout destinataire : un arrêt brutal
    // pendant leur création laisse une campagne cohérente
    const identity = await loadWorkspaceIdentity(locked.workspaceId);
    const sender = await resolveCampaignSender(locked.workspaceId, {
      identity,
    });
    const { links } = renderCampaignEmail({
      design: locked.design,
      identity,
    });
    await EmailCampaign.updateOne(
      { _id: locked._id, status: "SENDING" },
      {
        $set: {
          links,
          sendMode: campaignSendMode(),
          snapshot: {
            senderEmail: sender.email,
            fromName: singleLine(locked.fromName, 60) || identity.companyName,
            replyTo: singleLine(locked.replyTo) || identity.defaultReplyTo,
            companyName: identity.companyName,
            companyAddress: identity.companyAddress,
          },
        },
      },
    );
    const { recipients } = await resolveAudience(
      locked.workspaceId,
      locked.audience,
      { withRecipients: true },
    );
    if (!recipients.length) {
      throw new AppError(
        "Aucun destinataire : choisissez des contacts avec une adresse e-mail valide.",
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    const before = await getCampaignQuota(locked.workspaceId, now);
    if (recipients.length > before.remaining) {
      throw new AppError(
        quotaExceededMessage(before.remaining, recipients.length),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    await insertRecipients(locked, recipients);
    // Autre lancement entre-temps : le quota du mois ne doit pas être dépassé
    const after = await getCampaignQuota(locked.workspaceId, now);
    if (after.usedThisMonth > after.monthlyLimit) {
      throw new AppError(
        quotaExceededMessage(
          after.monthlyLimit - (after.usedThisMonth - recipients.length),
          recipients.length,
        ),
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    const updated = await EmailCampaign.findOneAndUpdate(
      { _id: locked._id, status: "SENDING" },
      {
        $set: {
          "stats.recipients": recipients.length,
          lockedUntil: null,
        },
      },
      { new: true },
    );
    prepareSocialIcons(locked.design);
    logger.info(
      `[campagnes] campagne ${locked._id} lancée : ${recipients.length} destinataire(s), mode ${campaignSendMode()}`,
    );
    return updated || locked;
  } catch (error) {
    await EmailCampaignRecipient.deleteMany({ campaignId: locked._id });
    const reason =
      from === "SCHEDULED"
        ? `L'envoi programmé n'a pas pu partir : ${
            error instanceof AppError
              ? error.message
              : "erreur inattendue, réessayez."
          }`
        : null;
    await EmailCampaign.updateOne(
      { _id: locked._id },
      {
        $set: {
          status: from === "SCHEDULED" ? "DRAFT" : from,
          startedAt: null,
          lockedUntil: null,
          pausedReason: reason,
          ...(from === "SCHEDULED" ? { scheduledAt: null } : {}),
          "stats.recipients": 0,
        },
      },
    );
    throw error;
  }
}

/**
 * Lancement demandé par l'utilisateur : maintenant, ou programmé à
 * `scheduledAt`. La vérification avant envoi doit être sans erreur.
 */
export async function requestSend(
  campaign,
  { scheduledAt = null, userId = null, now = new Date() } = {},
) {
  if (campaign.status !== "DRAFT") {
    throw new AppError(
      "Seul un brouillon peut être envoyé ou programmé.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  const report = await evaluateDeliverability(campaign);
  if (!report.canSend) {
    throw new AppError(
      firstErrorTitle(report.checks) || "La campagne ne peut pas partir.",
      ERROR_CODES.VALIDATION_ERROR,
      { checks: report.checks.filter((c) => c.level === "ERROR") },
    );
  }
  if (scheduledAt) {
    const scheduled = await EmailCampaign.findOneAndUpdate(
      { _id: campaign._id, status: "DRAFT", deletedAt: null },
      {
        $set: {
          status: "SCHEDULED",
          scheduledAt,
          consentAt: now,
          consentBy: userId,
          pausedReason: null,
        },
      },
      { new: true },
    );
    if (!scheduled) throw conflictError();
    return scheduled;
  }
  await EmailCampaign.updateOne(
    { _id: campaign._id, status: "DRAFT" },
    { $set: { consentAt: now, consentBy: userId, scheduledAt: null } },
  );
  return startSending(campaign, { from: "DRAFT", now });
}

/** Lance les campagnes programmées arrivées à échéance. */
export async function launchDueScheduledCampaigns({ now = new Date() } = {}) {
  const due = await EmailCampaign.find({
    status: "SCHEDULED",
    scheduledAt: { $lte: now },
    deletedAt: null,
  })
    .sort({ scheduledAt: 1 })
    .limit(20);
  let launched = 0;
  for (const campaign of due) {
    try {
      await checkSubscriptionActive({
        workspaceId: String(campaign.workspaceId),
      });
      const report = await evaluateDeliverability(campaign);
      if (!report.canSend) {
        throw new AppError(
          firstErrorTitle(report.checks),
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      await startSending(campaign, { from: "SCHEDULED", now });
      launched += 1;
    } catch (error) {
      // startSending a déjà remis la campagne en brouillon s'il a commencé
      await EmailCampaign.updateOne(
        { _id: campaign._id, status: "SCHEDULED" },
        {
          $set: {
            status: "DRAFT",
            scheduledAt: null,
            pausedReason: `L'envoi programmé n'a pas pu partir : ${
              error instanceof AppError
                ? error.message
                : "erreur inattendue, réessayez."
            }`,
          },
        },
      );
      logger.warn(
        `[campagnes] campagne programmée ${campaign._id} non lancée : ${error.message}`,
      );
    }
  }
  return launched;
}

// ─── Transitions ───────────────────────────────────────────────────────────

const transitionError = (message) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR);

export async function unscheduleCampaign(campaign) {
  const updated = await EmailCampaign.findOneAndUpdate(
    { _id: campaign._id, status: "SCHEDULED" },
    { $set: { status: "DRAFT", scheduledAt: null, pausedReason: null } },
    { new: true },
  );
  if (!updated) {
    throw transitionError(
      "Seule une campagne programmée peut être déprogrammée.",
    );
  }
  return updated;
}

export async function pauseCampaign(campaign) {
  const updated = await EmailCampaign.findOneAndUpdate(
    { _id: campaign._id, status: "SENDING" },
    {
      $set: {
        status: "PAUSED",
        pauseKind: "MANUAL",
        pausedReason: "Envoi mis en pause.",
      },
    },
    { new: true },
  );
  if (!updated) {
    throw transitionError(
      "Seule une campagne en cours d'envoi peut être mise en pause.",
    );
  }
  return updated;
}

export async function resumeCampaign(campaign) {
  if (campaign.status === "PAUSED" && campaign.pauseKind === "REPUTATION") {
    throw transitionError(
      "Cette campagne a été suspendue pour protéger votre réputation d'expéditeur : elle ne peut pas reprendre. Vérifiez votre liste de contacts, puis créez une nouvelle campagne.",
    );
  }
  const updated = await EmailCampaign.findOneAndUpdate(
    { _id: campaign._id, status: "PAUSED", pauseKind: { $ne: "REPUTATION" } },
    {
      $set: {
        status: "SENDING",
        pauseKind: null,
        pausedReason: null,
        retryAfter: null,
      },
    },
    { new: true },
  );
  if (!updated) {
    throw transitionError("Seule une campagne en pause peut reprendre.");
  }
  return updated;
}

export async function cancelCampaign(campaign, { now = new Date() } = {}) {
  const updated = await EmailCampaign.findOneAndUpdate(
    { _id: campaign._id, status: { $in: ["SENDING", "PAUSED"] } },
    { $set: { status: "CANCELED", completedAt: now, lockedUntil: null } },
    { new: true },
  );
  if (!updated) {
    throw transitionError(
      "Seule une campagne en cours d'envoi ou en pause peut être annulée.",
    );
  }
  // Un lot déjà parti garde son résultat (il se retrouve par sa clé)
  await EmailCampaignRecipient.updateMany(
    { campaignId: campaign._id, status: "PENDING" },
    { $set: { status: "SKIPPED" } },
  );
  return updated;
}

// ─── Envoi par lots ────────────────────────────────────────────────────────

async function completeIfDone(campaignId, now) {
  const left = await EmailCampaignRecipient.countDocuments({
    campaignId,
    status: "PENDING",
  });
  if (left > 0) return false;
  const total = await EmailCampaignRecipient.countDocuments({ campaignId });
  const result = await EmailCampaign.updateOne(
    { _id: campaignId, status: "SENDING" },
    {
      $set: {
        status: "SENT",
        completedAt: now,
        lockedUntil: null,
        "stats.recipients": total,
      },
    },
  );
  if (result.modifiedCount) {
    logger.info(`[campagnes] campagne ${campaignId} terminée`);
  }
  return result.modifiedCount > 0;
}

function idempotencyKeyOf(campaignId, recipients) {
  const attempts = Math.max(...recipients.map((r) => r.attempts || 0));
  const digest = crypto
    .createHash("sha256")
    .update(recipients.map((r) => String(r._id)).join(","))
    .digest("hex")
    .slice(0, 32);
  return `campagne-${campaignId}-${digest}-${attempts}`;
}

const release = (ids, batchKey, set = {}, inc = {}) =>
  EmailCampaignRecipient.updateMany(
    { _id: { $in: ids }, batchKey },
    {
      $set: { lockedAt: null, batchKey: null, ...set },
      ...(Object.keys(inc).length ? { $inc: inc } : {}),
    },
  );

async function pauseForService(campaignId, reason) {
  await EmailCampaign.updateOne(
    { _id: campaignId, status: "SENDING" },
    {
      $set: {
        status: "PAUSED",
        pauseKind: "SERVICE",
        pausedReason: reason,
        lockedUntil: null,
      },
    },
  );
}

/** Rendu personnalisé d'un destinataire, prêt pour Resend. */
function recipientPayload(campaign, recipient, { trackLinks }) {
  const snapshot = campaign.snapshot || {};
  const unsubscribeUrl = unsubscribeUrlFor(recipient._id);
  const rendered = renderCampaignEmail({
    design: campaign.design,
    subject: campaign.subject,
    preheader: campaign.preheader,
    vars: recipient.vars || {},
    identity: {
      companyName: snapshot.companyName,
      companyAddress: snapshot.companyAddress,
    },
    unsubscribeUrl,
    trackClick: trackLinks ? clickUrlBuilder(recipient._id) : null,
    openPixelUrl:
      campaign.trackOpens !== false ? openPixelUrlFor(recipient._id) : null,
  });
  return buildEmailPayload({
    fromName: snapshot.fromName,
    senderEmail: snapshot.senderEmail || newbiSenderEmail(snapshot.companyName),
    to: recipient.email,
    replyTo: snapshot.replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    unsubscribeUrl,
    campaignId: campaign._id,
    entityRef: recipient._id,
  });
}

/**
 * Liens suivis seulement si le contenu donne exactement les liens figés au
 * lancement (sinon un clic mènerait ailleurs : on garde les adresses).
 */
function canTrackLinks(campaign) {
  if (campaign.trackClicks === false) return false;
  const { links } = renderCampaignEmail({ design: campaign.design });
  const frozen = campaign.links || [];
  const same =
    links.length === frozen.length &&
    links.every((link, index) => link === frozen[index]);
  if (!same) {
    logger.error(
      `[campagnes] liens de la campagne ${campaign._id} différents de ceux du lancement : envoi sans suivi des clics`,
    );
  }
  return same;
}

/**
 * Envoie le prochain lot d'une campagne en cours (verrouillée par l'appelant).
 * @returns {Promise<{ processed: number, realCall: boolean, sent: number,
 *   simulated: number, failed: number, retried: number }>}
 */
export async function sendNextBatch(
  campaign,
  { now = new Date(), size = BATCH_SIZE } = {},
) {
  const summary = {
    processed: 0,
    realCall: false,
    sent: 0,
    simulated: 0,
    failed: 0,
    retried: 0,
  };
  const campaignId = campaign._id;

  // Destinataires réservés par un lot interrompu (arrêt en plein envoi)
  await EmailCampaignRecipient.updateMany(
    {
      campaignId,
      status: "PENDING",
      lockedAt: {
        $ne: null,
        $lt: new Date(now.getTime() - STALE_RECIPIENT_LOCK_MS),
      },
    },
    { $set: { lockedAt: null, batchKey: null } },
  );

  const candidates = await EmailCampaignRecipient.find({
    campaignId,
    status: "PENDING",
    lockedAt: null,
  })
    .sort({ _id: 1 })
    .limit(Math.max(1, Math.min(size, BATCH_SIZE)))
    .select("_id")
    .lean();
  if (!candidates.length) {
    await completeIfDone(campaignId, now);
    return summary;
  }
  const batchKey = crypto.randomUUID();
  await EmailCampaignRecipient.updateMany(
    {
      _id: { $in: candidates.map((c) => c._id) },
      status: "PENDING",
      lockedAt: null,
    },
    { $set: { lockedAt: now, batchKey } },
  );
  const recipients = await EmailCampaignRecipient.find({ batchKey })
    .sort({ _id: 1 })
    .lean();
  if (!recipients.length) return summary;
  // Pause ou annulation pendant la préparation du lot : rien ne part
  const current = await EmailCampaign.findById(campaignId)
    .select("status")
    .lean();
  if (current?.status !== "SENDING") {
    await release(
      recipients.map((r) => r._id),
      batchKey,
    );
    return summary;
  }
  summary.processed = recipients.length;

  const mode = campaignSendMode();
  const real = recipients.filter((r) => isRealSendAllowed(r.email, mode));
  const simulated = recipients.filter((r) => !isRealSendAllowed(r.email, mode));

  if (simulated.length) {
    await release(
      simulated.map((r) => r._id),
      batchKey,
      { status: "SIMULATED", sentAt: now, error: null },
      { attempts: 1 },
    );
    summary.simulated = simulated.length;
  }

  if (real.length) {
    summary.realCall = true;
    const trackLinks = canTrackLinks(campaign);
    const payloads = real.map((recipient) =>
      recipientPayload(campaign, recipient, { trackLinks }),
    );
    const result = await sendBatch(payloads, {
      idempotencyKey: idempotencyKeyOf(campaignId, real),
    });
    const realIds = real.map((r) => r._id);

    if (!result.error) {
      const operations = real.map((recipient, index) => {
        const failure = result.errors[index];
        return {
          updateOne: {
            filter: { _id: recipient._id, batchKey },
            update: failure
              ? {
                  $set: {
                    status: "FAILED",
                    error: String(failure).slice(0, 500),
                    lockedAt: null,
                    batchKey: null,
                  },
                  $inc: { attempts: 1 },
                }
              : {
                  $set: {
                    status: "SENT",
                    sentAt: now,
                    ...(result.ids[index]
                      ? { resendId: result.ids[index] }
                      : {}),
                    error: null,
                    lockedAt: null,
                    batchKey: null,
                  },
                  $inc: { attempts: 1 },
                },
          },
        };
      });
      await EmailCampaignRecipient.bulkWrite(operations, { ordered: false });
      summary.failed = result.errors.filter(Boolean).length;
      summary.sent = real.length - summary.failed;
    } else if (result.error.kind === "TEMPORARY") {
      const exhausted = real.filter(
        (r) => (r.attempts || 0) + 1 >= MAX_ATTEMPTS,
      );
      const retry = real.filter((r) => (r.attempts || 0) + 1 < MAX_ATTEMPTS);
      if (retry.length) {
        await release(
          retry.map((r) => r._id),
          batchKey,
          {},
          { attempts: 1 },
        );
      }
      if (exhausted.length) {
        await release(
          exhausted.map((r) => r._id),
          batchKey,
          {
            status: "FAILED",
            error: `Service d'envoi indisponible après ${MAX_ATTEMPTS} essais (${result.error.name})`,
          },
          { attempts: 1 },
        );
        // Panne qui dure : le reste attend une reprise à la main plutôt
        // que d'échouer lot après lot
        await pauseForService(
          campaignId,
          "Envoi interrompu : le service d'envoi ne répond pas. Reprenez l'envoi dans quelques minutes.",
        );
      }
      const delay =
        result.error.name === "rate_limit_exceeded"
          ? RATE_LIMIT_RETRY_MS
          : SERVICE_RETRY_MS *
            Math.max(1, ...retry.map((r) => (r.attempts || 0) + 1));
      await EmailCampaign.updateOne(
        { _id: campaignId },
        { $set: { retryAfter: new Date(now.getTime() + delay) } },
      );
      summary.failed = exhausted.length;
      summary.retried = retry.length;
      logger.warn(
        `[campagnes] lot de la campagne ${campaignId} à refaire (${result.error.name}) : ${retry.length} nouvel(s) essai(s), ${exhausted.length} échec(s)`,
      );
    } else if (result.error.kind === "QUOTA") {
      await release(realIds, batchKey);
      await EmailCampaign.updateOne(
        { _id: campaignId },
        { $set: { retryAfter: new Date(now.getTime() + QUOTA_RETRY_MS) } },
      );
      summary.retried = real.length;
      logger.error(
        `[campagnes] plafond du compte Resend atteint (${result.error.name}) : campagne ${campaignId} reprise dans 30 minutes`,
      );
    } else if (result.error.kind === "CONFIG") {
      await release(realIds, batchKey);
      await pauseForService(
        campaignId,
        "Envoi interrompu : le service d'envoi refuse la configuration actuelle. Reprenez l'envoi plus tard, ou contactez le support Newbi si cela se reproduit.",
      );
      summary.retried = real.length;
      logger.error(
        `[campagnes] configuration d'envoi refusée (${result.error.name} : ${result.error.message}) : campagne ${campaignId} en pause`,
      );
      void notifyError({
        source: "campagnes",
        message: "Configuration d'envoi refusée par Resend : campagne en pause",
        context: {
          Campagne: String(campaignId),
          Expéditeur: campaign.snapshot?.senderEmail,
          Erreur: `${result.error.name} : ${result.error.message}`,
        },
        cooldownSeconds: 60 * 60,
      });
    } else {
      await release(
        realIds,
        batchKey,
        {
          status: "FAILED",
          error: String(result.error.message).slice(0, 500),
        },
        { attempts: 1 },
      );
      summary.failed = real.length;
      logger.warn(
        `[campagnes] lot refusé pour la campagne ${campaignId} (${result.error.name}) : ${result.error.message}`,
      );
    }
  }

  const inc = {
    batchCount: 1,
    ...(summary.sent ? { "stats.sent": summary.sent } : {}),
    ...(summary.simulated ? { "stats.simulated": summary.simulated } : {}),
    ...(summary.failed ? { "stats.failed": summary.failed } : {}),
  };
  await EmailCampaign.updateOne({ _id: campaignId }, { $inc: inc });
  await completeIfDone(campaignId, now);
  return summary;
}

/**
 * Sert les campagnes en cours à tour de rôle, dans la limite du plafond par
 * minute, un lot à la fois.
 */
export async function processSendingCampaigns({
  now = () => new Date(),
  sleep = defaultSleep,
  budget = maxPerMinute(),
} = {}) {
  let remaining = budget;
  const idle = [];
  const totals = {
    batches: 0,
    sent: 0,
    simulated: 0,
    failed: 0,
    retried: 0,
  };
  while (remaining > 0) {
    const at = now();
    const lockedUntil = new Date(at.getTime() + CAMPAIGN_LOCK_MS);
    const campaign = await EmailCampaign.findOneAndUpdate(
      {
        status: "SENDING",
        _id: { $nin: idle },
        $and: [
          { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: at } }] },
          { $or: [{ retryAfter: null }, { retryAfter: { $lte: at } }] },
        ],
      },
      { $set: { lockedUntil } },
      { sort: { lastBatchAt: 1, _id: 1 }, new: true },
    );
    if (!campaign) break;
    let summary = { processed: 0, realCall: false };
    try {
      summary = await sendNextBatch(campaign, {
        now: at,
        size: Math.min(BATCH_SIZE, remaining),
      });
    } catch (error) {
      logger.error(
        `[campagnes] lot de la campagne ${campaign._id} en échec : ${error.message}`,
      );
    } finally {
      await EmailCampaign.updateOne(
        { _id: campaign._id, lockedUntil },
        { $set: { lockedUntil: null, lastBatchAt: now() } },
      );
    }
    if (!summary.processed) {
      idle.push(campaign._id);
      continue;
    }
    totals.batches += 1;
    for (const key of ["sent", "simulated", "failed", "retried"]) {
      totals[key] += summary[key] || 0;
    }
    remaining -= summary.processed;
    if (summary.realCall && remaining > 0) await sleep(BATCH_INTERVAL_MS);
  }
  return totals;
}

/** Un passage du cron : programmées à lancer, puis envois en cours. */
export async function runEmailCampaignTick({
  now = () => new Date(),
  sleep = defaultSleep,
} = {}) {
  const launched = await launchDueScheduledCampaigns({ now: now() });
  const totals = await processSendingCampaigns({ now, sleep });
  if (launched || totals.batches) {
    logger.info(
      `[campagnes] passage : ${launched} lancée(s), ${totals.batches} lot(s), ${totals.sent} envoyé(s), ${totals.simulated} simulé(s), ${totals.failed} échec(s), ${totals.retried} à refaire`,
    );
  }
  return { launched, ...totals };
}

// ─── E-mails de test ───────────────────────────────────────────────────────

/**
 * Envoie la campagne à 1 à 5 adresses, objet préfixé « [Test] », liens non
 * suivis, lien de désinscription sans effet. Même règle de mode d'envoi que
 * la campagne. Ne compte pas dans le quota.
 *
 * @returns {Promise<{ success: boolean, sentTo: string[], simulated: boolean }>}
 */
export async function sendCampaignTest(campaign, emails, { vars, identity }) {
  const mode = campaignSendMode();
  const resolvedIdentity =
    identity || (await loadWorkspaceIdentity(campaign.workspaceId));
  const sender = await resolveCampaignSender(campaign.workspaceId, {
    identity: resolvedIdentity,
  });
  const unsubscribeUrl = testUnsubscribeUrlFor(campaign._id);
  const rendered = renderCampaignEmail({
    design: campaign.design,
    subject: campaign.subject,
    preheader: campaign.preheader,
    vars: vars || EXAMPLE_VARIABLES,
    identity: resolvedIdentity,
    unsubscribeUrl,
  });
  const subject = `[Test] ${rendered.subject || "(sans objet)"}`;
  const real = emails.filter((email) => isRealSendAllowed(email, mode));
  const simulated = emails.filter((email) => !isRealSendAllowed(email, mode));
  let delivered = [...simulated];

  if (real.length) {
    // Adresse Newbi : son domaine doit être validé (sinon message générique,
    // l'équipe est prévenue)
    if (!sender.custom && !(await checkNewbiSendingDomain()).available) {
      throw new AppError(
        SENDING_UNAVAILABLE_MESSAGE,
        ERROR_CODES.INTERNAL_ERROR,
      );
    }
    await prepareSocialIcons(campaign.design);
    const payloads = real.map((to) =>
      buildEmailPayload({
        fromName:
          singleLine(campaign.fromName, 60) || resolvedIdentity.companyName,
        senderEmail: sender.email,
        to,
        replyTo:
          singleLine(campaign.replyTo) || resolvedIdentity.defaultReplyTo,
        subject,
        html: rendered.html,
        text: rendered.text,
        unsubscribeUrl,
        campaignId: campaign._id,
        entityRef: `${campaign._id}-test-${crypto.randomBytes(4).toString("hex")}`,
      }),
    );
    const result = await sendBatch(payloads);
    if (result.error) {
      logger.warn(
        `[campagnes] e-mail de test de ${campaign._id} non envoyé (${result.error.name}) : ${result.error.message}`,
      );
      throw new AppError(
        "L'e-mail de test n'a pas pu partir. Réessayez dans un instant.",
        ERROR_CODES.INTERNAL_ERROR,
      );
    }
    const accepted = real.filter((_, index) => !result.errors[index]);
    if (!accepted.length) {
      throw new AppError(
        "Le service d'envoi a refusé ces adresses : vérifiez-les.",
        ERROR_CODES.VALIDATION_ERROR,
      );
    }
    delivered = [...delivered, ...accepted];
  }
  return {
    success: true,
    sentTo: emails.filter((email) => delivered.includes(email)),
    simulated: simulated.length > 0,
  };
}
