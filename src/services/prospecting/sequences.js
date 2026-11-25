/**
 * Prospections : vérification, lancement, machine à états, marquages,
 * aperçu et e-mail de test.
 *
 *   DRAFT ──► ACTIVE ◄──► PAUSED
 *               │            │
 *               ├──► COMPLETED (plus rien en attente)
 *               └──► CANCELED ◄┘ (destinataires restants SKIPPED)
 *
 * Seul le propriétaire de la boîte d'envoi lance, met en pause, reprend ou
 * arrête une prospection qui part de sa boîte (le droit « send » est
 * contrôlé par les resolvers).
 *
 * Lancement : brouillon, boîte ACTIVE du membre, consentement, vérification
 * sans erreur ; destinataires créés (audience et variables figées), identité
 * de l'expéditeur et signature figées (`snapshot`), consentement tracé. Le
 * cron (sending.js) ne sert que les prospections ACTIVE : les destinataires
 * sont créés avant le passage en ACTIVE, et effacés si le lancement échoue.
 */
import Client from "../../models/Client.js";
import EmailSignatureV2 from "../../models/EmailSignatureV2.js";
import EmailSuppression from "../../models/EmailSuppression.js";
import MailboxConnection from "../../models/MailboxConnection.js";
import ProspectingRecipient from "../../models/ProspectingRecipient.js";
import ProspectingSequence, {
  EMPTY_SEQUENCE_STATS,
} from "../../models/ProspectingSequence.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import logger from "../../utils/logger.js";
import { isValidEmail } from "../../utils/validators.js";
import { normalizeEmail } from "../emailCampaigns/audience.js";
import { loadWorkspaceIdentity } from "../emailCampaigns/identity.js";
import {
  campaignSendMode,
  isRealSendAllowed,
} from "../emailCampaigns/sender.js";
import {
  prospectingDataUrlFor,
  prospectingTestUnsubscribeUrlFor,
} from "../emailCampaigns/tracking.js";
import { ensureIcons } from "../signatureAssets.js";
import { workspaceCountry } from "../signatureProfile.js";
import {
  phoneRegion,
  renderSignature,
  requiredIcons,
} from "../signatureRenderer/index.js";
import { resolveProspectingAudience } from "./audience.js";
import {
  countSentToday,
  isPersonalAddress,
  markMailboxExpired,
} from "./mailboxes.js";
import { userDisplayName } from "./people.js";
import { isMailProviderError } from "./providers/index.js";
import { renderProspectingMessage } from "./render.js";
import { effectiveDailyLimit, estimateSchedule } from "./schedule.js";
import { buildMessageMime, sendFromMailbox } from "./sending.js";
import { completeSequenceIfDone, refreshSequenceStats } from "./stats.js";
import { unsubscribeProspectingRecipient } from "./unsubscribe.js";
import { buildVerificationChecks, firstErrorTitle } from "./verification.js";
import {
  PROSPECTING_EXAMPLE_VARIABLES,
  PROSPECT_CLIENT_FIELDS,
  prospectVariables,
} from "./variables.js";

const LAUNCH_LOCK_MS = 10 * 60 * 1000;
const INSERT_CHUNK = 1000;
export const MAX_TEST_ADDRESSES = 5;

const validation = (message, details = null) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR, details);
const forbidden = (message) => new AppError(message, ERROR_CODES.FORBIDDEN);
const conflict = () =>
  validation(
    "La prospection a changé entre-temps : rechargez la page puis réessayez.",
  );

export const OWNER_ONLY_MESSAGE =
  "Seul le propriétaire de la boîte d'envoi peut lancer, mettre en pause, reprendre ou arrêter cette prospection.";

/** Le membre est-il le propriétaire de la boîte ? */
export const isMailboxOwner = (mailbox, userId) =>
  Boolean(mailbox && userId && String(mailbox.userId) === String(userId));

async function ownedMailbox(sequence, userId, message = OWNER_ONLY_MESSAGE) {
  const mailbox = await MailboxConnection.findById(sequence.mailboxId);
  if (!isMailboxOwner(mailbox, userId)) throw forbidden(message);
  return mailbox;
}

// ─── Signature ─────────────────────────────────────────────────────────────

/**
 * Signature Newbi de la prospection (une signature du propriétaire de la
 * boîte), rendue comme dans l'éditeur : { html, text }, vides sans
 * signature. `ensure` : icônes générées sur R2 avant l'envoi.
 */
export async function renderSequenceSignature(
  sequence,
  ownerId,
  { ensure = false } = {},
) {
  if (!sequence?.signatureId || !ownerId) return { html: "", text: "" };
  const doc = await EmailSignatureV2.findOne({
    _id: sequence.signatureId,
    workspaceId: sequence.workspaceId,
    createdBy: ownerId,
  }).lean();
  if (!doc) return { html: "", text: "" };
  const data = JSON.parse(JSON.stringify(doc));
  try {
    if (ensure) await ensureIcons(requiredIcons(data));
  } catch (error) {
    logger.warn(`[prospection] icônes de signature : ${error.message}`);
  }
  let region = "";
  try {
    region = phoneRegion(await workspaceCountry(String(sequence.workspaceId)));
  } catch {
    region = "";
  }
  try {
    const { html, text } = renderSignature(data, { region });
    return { html: html || "", text: text || "" };
  } catch (error) {
    logger.warn(`[prospection] signature non rendue : ${error.message}`);
    return { html: "", text: "" };
  }
}

// ─── Vérification ──────────────────────────────────────────────────────────

/**
 * Envois à faire par la boîte avant la fin de `count` nouveaux envois : ses
 * prospections en cours sont servies à tour de rôle, chacune « coûte »
 * au plus autant d'envois que la nouvelle.
 */
async function sharedSendCount(mailboxId, count, excludeSequenceId = null) {
  const active = await ProspectingSequence.find({
    mailboxId,
    status: "ACTIVE",
    deletedAt: null,
    ...(excludeSequenceId ? { _id: { $ne: excludeSequenceId } } : {}),
  })
    .select("stats.pending")
    .lean();
  return (
    count +
    active.reduce(
      (sum, sequence) => sum + Math.min(sequence.stats?.pending || 0, count),
      0,
    )
  );
}

/** Fin prévue au rythme de la boîte : { days, endDate } ou null. */
export async function estimateForMailbox(
  mailbox,
  count,
  { excludeSequenceId = null, now = new Date() } = {},
) {
  if (!mailbox || mailbox.status !== "ACTIVE" || !(count > 0)) return null;
  const [total, sentToday] = await Promise.all([
    sharedSendCount(mailbox._id, count, excludeSequenceId),
    countSentToday(mailbox._id, now),
  ]);
  return estimateSchedule({ mailbox, count: total, sentToday, now });
}

/**
 * Vérification d'une prospection : { canSend, checks, audience,
 * estimatedDays, estimatedEndDate }.
 */
export async function evaluateSequence(
  sequence,
  { now = new Date(), mailbox: knownMailbox, identity: knownIdentity } = {},
) {
  const [mailbox, identity, audience] = await Promise.all([
    knownMailbox !== undefined
      ? knownMailbox
      : MailboxConnection.findById(sequence.mailboxId).lean(),
    knownIdentity || loadWorkspaceIdentity(sequence.workspaceId),
    resolveProspectingAudience(sequence.workspaceId, sequence.audience, {
      now,
    }),
  ]);
  const estimate = await estimateForMailbox(mailbox, audience.counts.sendable, {
    excludeSequenceId: sequence._id,
    now,
  });
  const { canSend, checks } = buildVerificationChecks({
    sequence,
    mailbox,
    isPersonal: mailbox ? isPersonalAddress(mailbox.accountEmail) : false,
    identity,
    audienceCount: audience.counts,
    estimate,
    effectiveLimit: mailbox ? effectiveDailyLimit(mailbox, now) : 0,
  });
  return {
    canSend,
    checks,
    audience: audience.counts,
    estimatedDays: estimate?.days ?? null,
    estimatedEndDate: estimate?.endDate ?? null,
  };
}

// ─── Lancement ─────────────────────────────────────────────────────────────

async function insertRecipients(sequence, recipients) {
  for (let i = 0; i < recipients.length; i += INSERT_CHUNK) {
    const chunk = recipients.slice(i, i + INSERT_CHUNK).map((recipient) => ({
      workspaceId: sequence.workspaceId,
      sequenceId: sequence._id,
      mailboxId: sequence.mailboxId,
      clientId: recipient.clientId,
      email: recipient.email,
      name: recipient.name,
      company: recipient.company,
      vars: recipient.vars,
      isGeneratedProspect: recipient.isGeneratedProspect,
      status: "PENDING",
    }));
    try {
      await ProspectingRecipient.insertMany(chunk, { ordered: false });
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
 * Lance un brouillon : `consent` doit valoir true (vérifié par le
 * resolver), seul le propriétaire de la boîte (ACTIVE) le peut, la
 * vérification doit être sans erreur.
 */
export async function launchSequence(
  sequence,
  { userId, now = new Date() } = {},
) {
  if (sequence.status !== "DRAFT") {
    throw validation("Seul un brouillon peut être lancé.");
  }
  const mailbox = await ownedMailbox(sequence, userId);
  const identity = await loadWorkspaceIdentity(sequence.workspaceId);
  const report = await evaluateSequence(sequence, {
    now,
    mailbox: mailbox.toObject(),
    identity,
  });
  if (!report.canSend) {
    throw validation(
      firstErrorTitle(report.checks) || "La prospection ne peut pas partir.",
      { checks: report.checks.filter((c) => c.level === "ERROR") },
    );
  }
  const locked = await ProspectingSequence.findOneAndUpdate(
    {
      _id: sequence._id,
      status: "DRAFT",
      deletedAt: null,
      $or: [{ launchLockedUntil: null }, { launchLockedUntil: { $lte: now } }],
    },
    { $set: { launchLockedUntil: new Date(now.getTime() + LAUNCH_LOCK_MS) } },
    { new: true },
  );
  if (!locked) throw conflict();
  try {
    const [signature, ownerName, audience] = await Promise.all([
      renderSequenceSignature(locked, mailbox.userId, { ensure: true }),
      userDisplayName(mailbox.userId),
      resolveProspectingAudience(locked.workspaceId, locked.audience, {
        withRecipients: true,
        now,
      }),
    ]);
    if (!audience.recipients.length) {
      throw validation(
        "Aucun destinataire : choisissez des listes d'entreprises dont l'adresse e-mail est valide.",
      );
    }
    await insertRecipients(locked, audience.recipients);
    const stats = await refreshSequenceStats(locked._id);
    const launched = await ProspectingSequence.findOneAndUpdate(
      { _id: locked._id, status: "DRAFT" },
      {
        $set: {
          status: "ACTIVE",
          startedAt: now,
          completedAt: null,
          pauseKind: null,
          pausedReason: null,
          consentAt: now,
          consentBy: userId,
          launchLockedUntil: null,
          lastSendAt: null,
          stats,
          snapshot: {
            senderEmail: mailbox.accountEmail,
            senderName:
              mailbox.accountName || ownerName || identity.companyName,
            companyName: identity.companyName,
            companyAddress: identity.companyAddress,
            dataPageUrl: prospectingDataUrlFor(locked.workspaceId),
            signatureHtml: signature.html,
            signatureText: signature.text,
          },
        },
      },
      { new: true },
    );
    if (!launched) throw conflict();
    logger.info(
      `[prospection] prospection ${locked._id} lancée par ${userId} : ${stats.recipients} destinataire(s), mode ${campaignSendMode()}`,
    );
    return launched;
  } catch (error) {
    await ProspectingRecipient.deleteMany({ sequenceId: locked._id });
    await ProspectingSequence.updateOne(
      { _id: locked._id, status: "DRAFT" },
      { $set: { launchLockedUntil: null, stats: { ...EMPTY_SEQUENCE_STATS } } },
    );
    throw error;
  }
}

// ─── Transitions ───────────────────────────────────────────────────────────

export async function pauseSequence(sequence, { userId } = {}) {
  await ownedMailbox(sequence, userId);
  const updated = await ProspectingSequence.findOneAndUpdate(
    { _id: sequence._id, status: "ACTIVE" },
    {
      $set: {
        status: "PAUSED",
        pauseKind: "MANUAL",
        pausedReason: "Prospection mise en pause.",
      },
    },
    { new: true },
  );
  if (!updated) {
    throw validation("Seule une prospection en cours peut être mise en pause.");
  }
  return updated;
}

/**
 * Reprise : la boîte doit être connectée ; suspendue par le coupe-circuit,
 * elle est réactivée (reprise à la main, voir unsubscribe.js). L'adresse
 * d'envoi figée suit la boîte actuelle (une autre adresse a pu être
 * connectée pendant la pause).
 */
export async function resumeSequence(
  sequence,
  { userId, now = new Date() } = {},
) {
  if (sequence.status !== "PAUSED") {
    throw validation("Seule une prospection en pause peut reprendre.");
  }
  const mailbox = await ownedMailbox(sequence, userId);
  if (["EXPIRED", "DISCONNECTED"].includes(mailbox.status)) {
    throw validation(
      "Reconnectez votre boîte d'envoi avant de reprendre la prospection.",
    );
  }
  if (mailbox.status === "PAUSED") {
    await MailboxConnection.updateOne(
      { _id: mailbox._id, status: "PAUSED" },
      { $set: { status: "ACTIVE", pauseKind: null, pausedReason: null } },
    );
    logger.info(
      `[prospection] boîte ${mailbox._id} réactivée par ${userId} (reprise de ${sequence._id})`,
    );
  }
  const updated = await ProspectingSequence.findOneAndUpdate(
    { _id: sequence._id, status: "PAUSED" },
    {
      $set: {
        status: "ACTIVE",
        pauseKind: null,
        pausedReason: null,
        "snapshot.senderEmail": mailbox.accountEmail,
        ...(mailbox.accountName
          ? { "snapshot.senderName": mailbox.accountName }
          : {}),
      },
    },
    { new: true },
  );
  if (!updated) throw conflict();
  if (await completeSequenceIfDone(updated._id, now)) {
    return ProspectingSequence.findById(updated._id);
  }
  return updated;
}

/** Arrêt : CANCELED, destinataires en attente SKIPPED. */
export async function cancelSequence(
  sequence,
  { userId, now = new Date() } = {},
) {
  await ownedMailbox(sequence, userId);
  const updated = await ProspectingSequence.findOneAndUpdate(
    { _id: sequence._id, status: { $in: ["ACTIVE", "PAUSED"] } },
    { $set: { status: "CANCELED", completedAt: now } },
    { new: true },
  );
  if (!updated) {
    throw validation(
      "Seule une prospection en cours ou en pause peut être arrêtée.",
    );
  }
  await ProspectingRecipient.updateMany(
    { sequenceId: sequence._id, status: "PENDING", sendStartedAt: null },
    {
      $set: {
        status: "SKIPPED",
        skippedReason: "prospection arrêtée",
        lockedAt: null,
      },
    },
  );
  updated.stats = await refreshSequenceStats(sequence._id);
  return updated;
}

// ─── Marquages ─────────────────────────────────────────────────────────────

/**
 * « A répondu » (message parti seulement ; date du dernier contact posée
 * sur la fiche du contact) ou « Ne plus contacter » (désinscription :
 * adresse dans la liste d'exclusion de l'espace).
 */
export async function markRecipient(
  recipient,
  action,
  { userId = null, now = new Date() } = {},
) {
  if (action === "REPLIED") {
    if (recipient.status !== "REPLIED") {
      const updated = await ProspectingRecipient.findOneAndUpdate(
        { _id: recipient._id, status: { $in: ["SENT", "SIMULATED"] } },
        { $set: { status: "REPLIED", repliedAt: now } },
        { new: true },
      );
      if (!updated) {
        throw validation(
          "Seul un destinataire à qui le message est parti peut être marqué « A répondu ».",
        );
      }
      if (recipient.clientId) {
        await Client.updateOne(
          { _id: recipient.clientId, workspaceId: recipient.workspaceId },
          { $set: { "prospect.lastContactAt": now } },
        );
      }
      await refreshSequenceStats(recipient.sequenceId);
    }
  } else if (action === "DO_NOT_CONTACT") {
    await unsubscribeProspectingRecipient(recipient._id, {
      source: "prospecting-reply",
      skippedReason: "ne plus contacter",
      createdBy: userId,
      now,
    });
  } else {
    throw validation("Action inconnue.");
  }
  return ProspectingRecipient.findById(recipient._id).lean();
}

// ─── Aperçu et test ────────────────────────────────────────────────────────

/** Variables d'un contact de l'espace (aperçu, test) ou d'exemple. */
export async function previewVariables(workspaceId, clientId) {
  if (!clientId) {
    return { vars: PROSPECTING_EXAMPLE_VARIABLES, isGeneratedProspect: false };
  }
  const client = await Client.findOne({ _id: clientId, workspaceId })
    .select(PROSPECT_CLIENT_FIELDS)
    .lean();
  if (!client) return null;
  return {
    vars: prospectVariables(client),
    isGeneratedProspect: Boolean(client.prospect?.provider),
  };
}

/**
 * Aperçu d'une prospection (brouillon en cours d'édition : objet et
 * message fournis) : { subject, html, text }. Lien de désinscription sans
 * effet (jeton de test).
 */
export async function previewSequence(
  sequence,
  { subject, body, vars, isGeneratedProspect = false } = {},
) {
  const launched = Boolean(sequence.snapshot?.companyName);
  const [identity, signature] = await Promise.all([
    launched ? sequence.snapshot : loadWorkspaceIdentity(sequence.workspaceId),
    launched
      ? {
          html: sequence.snapshot.signatureHtml || "",
          text: sequence.snapshot.signatureText || "",
        }
      : MailboxConnection.findById(sequence.mailboxId)
          .select("userId")
          .lean()
          .then((mailbox) =>
            renderSequenceSignature(sequence, mailbox?.userId),
          ),
  ]);
  return renderProspectingMessage({
    subject: subject ?? sequence.subject,
    body: body ?? sequence.body,
    vars: vars || PROSPECTING_EXAMPLE_VARIABLES,
    identity,
    signatureHtml: signature.html,
    signatureText: signature.text,
    isGeneratedProspect,
    unsubscribeUrl: prospectingTestUnsubscribeUrlFor(sequence._id),
    dataPageUrl: prospectingDataUrlFor(sequence.workspaceId),
  });
}

/** Erreur du fournisseur pendant un test → message pour le membre. */
async function testError(error, mailbox, address) {
  const kind = isMailProviderError(error) ? error.kind : "TEMPORARY";
  if (kind === "AUTH") {
    await markMailboxExpired(mailbox, error.message);
    return validation(
      "Votre boîte d'envoi doit être reconnectée : l'accès a expiré ou a été retiré.",
    );
  }
  if (kind === "QUOTA") {
    return validation(
      "Votre messagerie refuse de nouveaux envois pour le moment (limite atteinte). Réessayez plus tard.",
    );
  }
  if (kind === "RECIPIENT" || kind === "PERMANENT") {
    return validation(`Envoi refusé par votre messagerie pour ${address}.`);
  }
  logger.warn(`[prospection] e-mail de test non envoyé : ${error.message}`);
  return new AppError(
    "L'e-mail de test n'a pas pu partir. Réessayez dans un instant.",
    ERROR_CODES.INTERNAL_ERROR,
  );
}

/**
 * E-mail de test du brouillon depuis la boîte de la prospection (son
 * propriétaire seulement), à 1 à 5 adresses (défaut : celle de la boîte),
 * objet préfixé « [Test] », variables du premier destinataire ou
 * d'exemple. Même règle de mode d'envoi que les prospections.
 * @returns {Promise<string[]>} adresses servies (envoyées ou simulées)
 */
export async function sendTestMessage(
  sequence,
  { userId, emails = null, now = new Date() } = {},
) {
  const mailbox = await ownedMailbox(
    sequence,
    userId,
    "Seul le propriétaire de la boîte d'envoi peut envoyer un test depuis celle-ci.",
  );
  if (!["ACTIVE", "PAUSED"].includes(mailbox.status)) {
    throw validation(
      "Reconnectez votre boîte d'envoi avant d'envoyer un e-mail de test.",
    );
  }
  const addresses = [
    ...new Set(
      (emails?.length ? emails : [mailbox.accountEmail]).map((email) =>
        normalizeEmail(email),
      ),
    ),
  ].filter(Boolean);
  if (!addresses.length || addresses.length > MAX_TEST_ADDRESSES) {
    throw validation(`Indiquez de 1 à ${MAX_TEST_ADDRESSES} adresses e-mail.`);
  }
  const invalid = addresses.find((email) => !isValidEmail(email));
  if (invalid) throw validation(`Adresse e-mail invalide : ${invalid}`);
  const rejected = await EmailSuppression.findOne({
    workspaceId: sequence.workspaceId,
    email: { $in: addresses },
    reason: { $in: ["BOUNCED", "COMPLAINED"] },
  })
    .select("email")
    .lean();
  if (rejected) {
    throw validation(
      `Envoi impossible à ${rejected.email} : cette adresse a été rejetée ou a signalé vos e-mails comme indésirables.`,
    );
  }
  const { recipients } = await resolveProspectingAudience(
    sequence.workspaceId,
    sequence.audience,
    { withRecipients: true, now },
  );
  const first = recipients[0];
  const [identity, signature] = await Promise.all([
    loadWorkspaceIdentity(sequence.workspaceId),
    renderSequenceSignature(sequence, mailbox.userId, { ensure: true }),
  ]);
  const rendered = renderProspectingMessage({
    subject: sequence.subject,
    body: sequence.body,
    vars: first?.vars || PROSPECTING_EXAMPLE_VARIABLES,
    identity,
    signatureHtml: signature.html,
    signatureText: signature.text,
    isGeneratedProspect: Boolean(first?.isGeneratedProspect),
    unsubscribeUrl: prospectingTestUnsubscribeUrlFor(sequence._id),
    dataPageUrl: prospectingDataUrlFor(sequence.workspaceId),
  });
  const message = {
    ...rendered,
    subject: `[Test] ${rendered.subject || "(sans objet)"}`,
    unsubscribeUrl: prospectingTestUnsubscribeUrlFor(sequence._id),
  };
  const mode = campaignSendMode();
  const senderName =
    mailbox.accountName ||
    (await userDisplayName(mailbox.userId)) ||
    identity.companyName;
  const served = [];
  for (const address of addresses) {
    if (isRealSendAllowed(address, mode)) {
      const mime = buildMessageMime({
        mailbox,
        senderName,
        to: address,
        rendered: message,
        now,
      });
      try {
        await sendFromMailbox(mailbox, mime, now);
      } catch (error) {
        throw await testError(error, mailbox, address);
      }
    }
    served.push(address);
  }
  return served;
}
