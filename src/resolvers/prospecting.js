/**
 * Resolvers de la prospection (Communication > Prospection).
 *
 * Périmètre : prospections communes à l'espace, chacune partant de la boîte
 * d'envoi (Gmail, Outlook) de son auteur ; chaque requête filtre sur
 * l'espace validé par les droits (ctx.workspaceId). Droits du module
 * « prospecting » : voir (lectures), créer (boîte, brouillon), modifier
 * (brouillon, réglages de sa boîte, marquages), supprimer, envoyer
 * (lancer, pause, reprise, arrêt, test). Seul le propriétaire de la boîte
 * lance, met en pause, reprend, arrête ou teste une prospection qui part
 * de sa boîte, et règle ou déconnecte sa boîte.
 *
 * Routes publiques (désinscription, « Vos données ») : routes/prospecting.js ;
 * connexion des boîtes : routes/mailbox-connect.js ; envoi :
 * services/prospecting/sending.js (cron).
 */
import mongoose from "mongoose";
import {
  checkSubscriptionActive,
  requireWorkspaceAction,
} from "../middlewares/rbac.js";
import EmailSignatureV2 from "../models/EmailSignatureV2.js";
import MailboxConnection from "../models/MailboxConnection.js";
import ProspectingRecipient, {
  PROSPECTING_RECIPIENT_STATUSES,
} from "../models/ProspectingRecipient.js";
import ProspectingSequence, {
  EMPTY_SEQUENCE_STATS,
} from "../models/ProspectingSequence.js";
import { workspaceListIds } from "../services/emailCampaigns/audience.js";
import { singleLine } from "../services/emailCampaigns/design.js";
import { prospectingDataUrlFor } from "../services/emailCampaigns/tracking.js";
import { resolveProspectingAudience } from "../services/prospecting/audience.js";
import {
  availableProviders,
  clampDailyLimit,
  defaultDailyLimit,
  maxDailyLimit,
} from "../services/prospecting/config.js";
import {
  countSentToday,
  disconnectMailbox,
  isPersonalAddress,
} from "../services/prospecting/mailboxes.js";
import { userDisplayName } from "../services/prospecting/people.js";
import {
  BODY_MAX_LENGTH,
  SUBJECT_MAX_LENGTH,
  sanitizeProspectingBody,
} from "../services/prospecting/render.js";
import { effectiveDailyLimit } from "../services/prospecting/schedule.js";
import {
  cancelSequence,
  estimateForMailbox,
  evaluateSequence,
  isMailboxOwner,
  launchSequence,
  markRecipient,
  pauseSequence,
  previewSequence,
  previewVariables,
  resumeSequence,
  sendTestMessage,
} from "../services/prospecting/sequences.js";
import { PROSPECTING_VARIABLES } from "../services/prospecting/variables.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import { buildSearchRegex } from "../utils/searchRegex.js";

const MODULE = "prospecting";
const NAME_MAX = 120;
const DEFAULT_NAME = "Nouvelle prospection";
// E-mails de test : limités par espace
const TEST_SENDS_PER_HOUR = 20;
const RECIPIENTS_DEFAULT_LIMIT = 50;
const RECIPIENTS_MAX_LIMIT = 200;
const HISTORY_LIMIT = 100;

const can = (actions) => requireWorkspaceAction(MODULE, actions);

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const scope = (ctx) => ({ workspaceId: toObjectId(ctx.workspaceId) });
const has = (input, key) => input[key] !== undefined && input[key] !== null;
const iso = (value) => (value ? new Date(value).toISOString() : null);
const asObject = (value) =>
  typeof value?.toObject === "function" ? value.toObject() : value || {};

const validation = (message, details = null) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR, details);
const notFound = (message) => new AppError(message, ERROR_CODES.NOT_FOUND);
const forbidden = (message) => new AppError(message, ERROR_CODES.FORBIDDEN);

/** Prospection de l'espace (non supprimée), sinon NOT_FOUND. */
async function findSequence(ctx, id, { lean = true } = {}) {
  const missing = () => notFound("Prospection introuvable.");
  if (!isObjectIdString(id)) throw missing();
  const query = ProspectingSequence.findOne({
    _id: toObjectId(id),
    ...scope(ctx),
    deletedAt: null,
  });
  const sequence = lean ? await query.lean() : await query;
  if (!sequence) throw missing();
  return sequence;
}

/** Boîte de l'espace, sinon NOT_FOUND. */
async function findMailbox(ctx, id) {
  const missing = () => notFound("Boîte d'envoi introuvable.");
  if (!isObjectIdString(id)) throw missing();
  const mailbox = await MailboxConnection.findOne({
    _id: toObjectId(id),
    ...scope(ctx),
  }).lean();
  if (!mailbox) throw missing();
  return mailbox;
}

/** Boîte du membre connecté dans l'espace (déconnectée : null). */
const myMailbox = (ctx) =>
  MailboxConnection.findOne({
    ...scope(ctx),
    userId: ctx.user._id,
    status: { $ne: "DISCONNECTED" },
  }).lean();

// ─── Vues (forme GraphQL, calculée avec les droits de la requête) ─────────

/**
 * Vues d'une requête : boîtes, envois du jour et noms gardés le temps de la
 * requête (une liste de prospections ne relit chaque boîte qu'une fois).
 */
function viewsFor(ctx) {
  const userId = String(ctx.user._id);
  const now = new Date();
  const canSendRight = Boolean(
    ctx.permissions?.hasPermission?.(MODULE, "send"),
  );
  const caches = { mailbox: new Map(), sent: new Map(), owner: new Map() };
  // Promesse gardée (une requête Mongoose ne s'exécute qu'une fois)
  const cached = (map, key, load) => {
    if (!map.has(key)) map.set(key, Promise.resolve(load()));
    return map.get(key);
  };
  const mailboxById = (id) =>
    cached(caches.mailbox, String(id), () =>
      MailboxConnection.findOne({ _id: id, ...scope(ctx) }).lean(),
    );

  async function mailboxView(mailbox) {
    const [sentToday, ownerName] = await Promise.all([
      cached(caches.sent, String(mailbox._id), () =>
        countSentToday(mailbox._id, now),
      ),
      cached(caches.owner, String(mailbox.userId), () =>
        userDisplayName(mailbox.userId),
      ),
    ]);
    const window = mailbox.sendWindow || {};
    return {
      id: String(mailbox._id),
      provider: mailbox.provider,
      accountEmail: mailbox.accountEmail,
      accountName: mailbox.accountName || null,
      isPersonalAddress: isPersonalAddress(mailbox.accountEmail),
      status: mailbox.status,
      pausedReason: mailbox.pausedReason || null,
      dailyLimit: clampDailyLimit(mailbox.dailyLimit),
      effectiveDailyLimit: effectiveDailyLimit(mailbox, now),
      sentToday,
      sendWindow: {
        days: Array.isArray(window.days) ? [...window.days] : [],
        startHour: Number(window.startHour) || 0,
        endHour: Number(window.endHour) || 0,
      },
      signatureId: mailbox.signatureId ? String(mailbox.signatureId) : null,
      connectedAt: iso(mailbox.connectedAt || mailbox.createdAt),
      isMine: String(mailbox.userId) === userId,
      ownerName: ownerName || null,
    };
  }

  async function sequenceView(sequence) {
    const mailbox = sequence.mailboxId
      ? await mailboxById(sequence.mailboxId)
      : null;
    const stats = { ...EMPTY_SEQUENCE_STATS, ...asObject(sequence.stats) };
    let estimatedEndDate = null;
    if (
      sequence.status === "ACTIVE" &&
      mailbox?.status === "ACTIVE" &&
      stats.pending > 0
    ) {
      const estimate = await estimateForMailbox(mailbox, stats.pending, {
        excludeSequenceId: sequence._id,
        now,
      });
      estimatedEndDate = estimate?.endDate ?? null;
    }
    return {
      id: String(sequence._id),
      name: sequence.name || "",
      status: sequence.status,
      pauseKind: sequence.pauseKind || null,
      pausedReason: sequence.pausedReason || null,
      mailbox: mailbox ? await mailboxView(mailbox) : null,
      audience: {
        mode: sequence.audience?.mode === "ALL" ? "ALL" : "LISTS",
        listIds: (sequence.audience?.listIds || []).map(String),
        excludeListIds: (sequence.audience?.excludeListIds || []).map(String),
      },
      subject: sequence.subject || "",
      body: sequence.body || "",
      signatureId: sequence.signatureId ? String(sequence.signatureId) : null,
      stats,
      estimatedEndDate,
      consentAt: iso(sequence.consentAt),
      startedAt: iso(sequence.startedAt),
      completedAt: iso(sequence.completedAt),
      createdAt: iso(sequence.createdAt) || now.toISOString(),
      updatedAt:
        iso(sequence.updatedAt) || iso(sequence.createdAt) || now.toISOString(),
      createdByName: sequence.createdByName || null,
      canSend: canSendRight && isMailboxOwner(mailbox, userId),
    };
  }

  return { mailboxView, sequenceView };
}

/** Destinataire (forme GraphQL). Écarté : son motif tient lieu d'erreur. */
export function recipientView(recipient) {
  return {
    id: String(recipient._id),
    clientId: recipient.clientId ? String(recipient.clientId) : null,
    email: recipient.email,
    name: recipient.name || recipient.company || recipient.email,
    company: recipient.company || null,
    status: recipient.status,
    sentAt: iso(recipient.sentAt),
    repliedAt: iso(recipient.repliedAt),
    bouncedAt: iso(recipient.bouncedAt),
    unsubscribedAt: iso(recipient.unsubscribedAt),
    error:
      recipient.error ||
      (recipient.status === "SKIPPED" ? recipient.skippedReason || null : null),
  };
}

// ─── Saisies ───────────────────────────────────────────────────────────────

/** Texte d'une ligne saisi tel quel (contrôles retirés), longueur bornée. */
function lineInput(value, max, label) {
  const text = typeof value === "string" ? value : "";
  const cleaned = [...text]
    .map((char) => (char.codePointAt(0) < 32 ? " " : char))
    .join("");
  if (cleaned.length > max) {
    throw validation(`${label} ne doit pas dépasser ${max} caractères.`);
  }
  return cleaned;
}

function nameInput(value) {
  const name = singleLine(value);
  if (!name) throw validation("Donnez un nom à la prospection.");
  if (name.length > NAME_MAX) {
    throw validation(
      `Le nom de la prospection ne doit pas dépasser ${NAME_MAX} caractères.`,
    );
  }
  return name;
}

function bodyInput(value) {
  const raw = typeof value === "string" ? value : "";
  if (raw.length > BODY_MAX_LENGTH) {
    throw validation(
      "Le message est trop long : raccourcissez-le (20 000 caractères au plus).",
    );
  }
  return sanitizeProspectingBody(raw);
}

async function audienceInput(ctx, audience) {
  const mode = audience?.mode === "ALL" ? "ALL" : "LISTS";
  const listIds = [...new Set((audience?.listIds || []).map(String))];
  const excludeListIds = [
    ...new Set((audience?.excludeListIds || []).map(String)),
  ];
  if (![...listIds, ...excludeListIds].every(isObjectIdString)) {
    throw validation("Liste de contacts introuvable.");
  }
  const { missing } = await workspaceListIds(ctx.workspaceId, [
    ...listIds,
    ...excludeListIds,
  ]);
  if (missing.length) throw validation("Liste de contacts introuvable.");
  return {
    mode,
    listIds: listIds.map(toObjectId),
    excludeListIds: excludeListIds.map(toObjectId),
  };
}

/** Signature Newbi du propriétaire de la boîte (null : aucune). */
async function signatureInput(ctx, value, ownerId) {
  if (value === null || value === "") return null;
  const missing = () => validation("Signature introuvable.");
  if (!isObjectIdString(String(value))) throw missing();
  const signature = await EmailSignatureV2.exists({
    _id: toObjectId(value),
    ...scope(ctx),
    createdBy: ownerId,
  });
  if (!signature) throw missing();
  return toObjectId(value);
}

async function sequenceChanges(input, ctx, ownerId) {
  const changes = {};
  if (has(input, "name")) changes.name = nameInput(input.name);
  if (input.subject !== undefined) {
    changes.subject = lineInput(
      input.subject ?? "",
      SUBJECT_MAX_LENGTH,
      "L'objet",
    );
  }
  if (input.body !== undefined) changes.body = bodyInput(input.body);
  if (has(input, "audience")) {
    changes.audience = await audienceInput(ctx, input.audience);
  }
  if (input.signatureId !== undefined) {
    changes.signatureId = await signatureInput(ctx, input.signatureId, ownerId);
  }
  return changes;
}

function sendWindowInput(window) {
  const invalid = (detail) => validation(`Plage d'envoi invalide : ${detail}`);
  const days = [...new Set(Array.isArray(window?.days) ? window.days : [])];
  if (!days.length) throw invalid("choisissez au moins un jour.");
  if (!days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) {
    throw invalid("jours de 1 (lundi) à 7 (dimanche).");
  }
  const { startHour, endHour } = window;
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    startHour >= endHour
  ) {
    throw invalid("l'heure de fin doit suivre l'heure de début (0 h à 24 h).");
  }
  return { days: days.sort((a, b) => a - b), startHour, endHour };
}

function dailyLimitInput(value) {
  const max = maxDailyLimit();
  if (!Number.isInteger(value) || value < 5 || value > max) {
    throw validation(`Choisissez entre 5 et ${max} e-mails par jour.`);
  }
  return value;
}

// ─── Resolvers ─────────────────────────────────────────────────────────────

const prospectingResolvers = {
  Query: {
    prospectingSettings: can("view")(async (_, __, ctx) => {
      const views = viewsFor(ctx);
      const [mine, all] = await Promise.all([
        myMailbox(ctx),
        MailboxConnection.find({
          ...scope(ctx),
          status: { $ne: "DISCONNECTED" },
        })
          .sort({ createdAt: 1, _id: 1 })
          .lean(),
      ]);
      return {
        providers: availableProviders(),
        myMailbox: mine ? await views.mailboxView(mine) : null,
        mailboxes: await Promise.all(all.map(views.mailboxView)),
        variables: PROSPECTING_VARIABLES.map((variable) => ({ ...variable })),
        defaultDailyLimit: defaultDailyLimit(),
        maxDailyLimit: maxDailyLimit(),
        dataPageUrl: prospectingDataUrlFor(ctx.workspaceId),
      };
    }),

    prospectingSequences: can("view")(async (_, { status }, ctx) => {
      const filter = { ...scope(ctx), deletedAt: null };
      if (status) filter.status = status;
      const sequences = await ProspectingSequence.find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .lean();
      const views = viewsFor(ctx);
      return Promise.all(sequences.map(views.sequenceView));
    }),

    prospectingSequence: can("view")(async (_, { id }, ctx) => {
      if (!isObjectIdString(id)) return null;
      const sequence = await ProspectingSequence.findOne({
        _id: toObjectId(id),
        ...scope(ctx),
        deletedAt: null,
      }).lean();
      return sequence ? viewsFor(ctx).sequenceView(sequence) : null;
    }),

    prospectingAudienceCount: can("view")(async (_, { audience }, ctx) => {
      const { counts } = await resolveProspectingAudience(
        ctx.workspaceId,
        audience,
      );
      return counts;
    }),

    prospectingVerification: can("view")(async (_, { id }, ctx) =>
      evaluateSequence(await findSequence(ctx, id)),
    ),

    prospectingPreview: can("view")(
      async (_, { id, subject, body, clientId }, ctx) => {
        const sequence = await findSequence(ctx, id);
        let preview = null;
        if (clientId) {
          if (!isObjectIdString(clientId)) {
            throw notFound("Contact introuvable.");
          }
          preview = await previewVariables(
            toObjectId(ctx.workspaceId),
            toObjectId(clientId),
          );
          if (!preview) throw notFound("Contact introuvable.");
        }
        const rendered = await previewSequence(sequence, {
          subject: subject ?? undefined,
          body: body ?? undefined,
          vars: preview?.vars,
          isGeneratedProspect: Boolean(preview?.isGeneratedProspect),
        });
        return {
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        };
      },
    ),

    prospectingRecipients: can("view")(
      async (_, { id, status, search, offset, limit }, ctx) => {
        const sequence = await findSequence(ctx, id);
        const skip = Math.max(0, Number.parseInt(offset, 10) || 0);
        const size = Math.min(
          RECIPIENTS_MAX_LIMIT,
          Math.max(1, Number.parseInt(limit, 10) || RECIPIENTS_DEFAULT_LIMIT),
        );
        const query = {
          sequenceId: sequence._id,
          workspaceId: sequence.workspaceId,
        };
        if (status && PROSPECTING_RECIPIENT_STATUSES.includes(status)) {
          query.status = status;
        }
        if (typeof search === "string" && search.trim()) {
          const regex = buildSearchRegex(search);
          query.$or = [{ email: regex }, { name: regex }, { company: regex }];
        }
        const [items, total] = await Promise.all([
          ProspectingRecipient.find(query)
            .select("-vars")
            .sort({ _id: 1 })
            .skip(skip)
            .limit(size)
            .lean(),
          ProspectingRecipient.countDocuments(query),
        ]);
        return { items: items.map(recipientView), total };
      },
    ),

    clientProspectingHistory: can("view")(async (_, { clientId }, ctx) => {
      if (!isObjectIdString(clientId)) return [];
      const recipients = await ProspectingRecipient.find({
        ...scope(ctx),
        clientId: toObjectId(clientId),
        sentAt: { $ne: null },
      })
        .select("-vars")
        .sort({ sentAt: -1, _id: -1 })
        .limit(HISTORY_LIMIT)
        .lean();
      return recipients.map(recipientView);
    }),
  },

  Mutation: {
    updateProspectingMailbox: can(["create", "edit"])(
      async (_, { id, input }, ctx) => {
        await checkSubscriptionActive(ctx);
        const mailbox = await findMailbox(ctx, id);
        if (!isMailboxOwner(mailbox, ctx.user._id)) {
          throw forbidden(
            "Seul le propriétaire de la boîte d'envoi peut modifier ses réglages.",
          );
        }
        if (mailbox.status === "DISCONNECTED") {
          throw validation("Cette boîte d'envoi est déconnectée.");
        }
        const changes = {};
        if (has(input || {}, "dailyLimit")) {
          changes.dailyLimit = dailyLimitInput(input.dailyLimit);
        }
        if (has(input || {}, "sendWindow")) {
          changes.sendWindow = sendWindowInput(input.sendWindow);
        }
        if (input?.signatureId !== undefined) {
          changes.signatureId = await signatureInput(
            ctx,
            input.signatureId,
            mailbox.userId,
          );
        }
        const updated = Object.keys(changes).length
          ? await MailboxConnection.findOneAndUpdate(
              { _id: mailbox._id, ...scope(ctx) },
              { $set: changes },
              { new: true },
            ).lean()
          : mailbox;
        return viewsFor(ctx).mailboxView(updated);
      },
    ),

    // Retirer l'accès à sa propre boîte : toujours possible pour son
    // propriétaire, même sans droit d'écriture ni abonnement actif
    disconnectProspectingMailbox: can("view")(async (_, { id }, ctx) => {
      const mailbox = await findMailbox(ctx, id);
      if (!isMailboxOwner(mailbox, ctx.user._id)) {
        throw forbidden(
          "Seul le propriétaire de la boîte d'envoi peut la déconnecter.",
        );
      }
      if (mailbox.status !== "DISCONNECTED") {
        await disconnectMailbox(mailbox);
        logger.info(
          `[prospection] boîte ${mailbox._id} déconnectée par ${ctx.user._id}`,
        );
      }
      return true;
    }),

    createProspectingSequence: can("create")(async (_, { input }, ctx) => {
      await checkSubscriptionActive(ctx);
      const mailbox = await myMailbox(ctx);
      if (!mailbox) {
        throw validation(
          "Connectez d'abord votre boîte d'envoi (Gmail ou Outlook).",
        );
      }
      const changes = await sequenceChanges(
        { ...(input || {}) },
        ctx,
        mailbox.userId,
      );
      const sequence = await ProspectingSequence.create({
        ...scope(ctx),
        mailboxId: mailbox._id,
        name: DEFAULT_NAME,
        signatureId: mailbox.signatureId || null,
        ...changes,
        createdBy: ctx.user._id,
        createdByName: await userDisplayName(ctx.user._id),
      });
      return viewsFor(ctx).sequenceView(sequence.toObject());
    }),

    updateProspectingSequence: can("edit")(async (_, { id, input }, ctx) => {
      await checkSubscriptionActive(ctx);
      const current = await findSequence(ctx, id);
      if (current.status !== "DRAFT") {
        throw validation("Seul un brouillon peut être modifié.");
      }
      if (
        current.launchLockedUntil &&
        new Date(current.launchLockedUntil) > new Date()
      ) {
        throw validation(
          "La prospection est en cours de lancement : elle ne peut plus être modifiée.",
        );
      }
      const mailbox = await MailboxConnection.findById(current.mailboxId)
        .select("userId")
        .lean();
      const changes = await sequenceChanges(
        input || {},
        ctx,
        mailbox?.userId || current.createdBy,
      );
      const updated = await ProspectingSequence.findOneAndUpdate(
        {
          _id: current._id,
          ...scope(ctx),
          status: "DRAFT",
          deletedAt: null,
        },
        { $set: { ...changes, pausedReason: null } },
        { new: true },
      ).lean();
      if (!updated) {
        throw validation(
          "La prospection vient de changer d'état : elle ne peut plus être modifiée.",
        );
      }
      return viewsFor(ctx).sequenceView(updated);
    }),

    deleteProspectingSequence: can("delete")(async (_, { id }, ctx) => {
      const sequence = await findSequence(ctx, id);
      if (["ACTIVE", "PAUSED"].includes(sequence.status)) {
        throw validation("Arrêtez la prospection avant de la supprimer.");
      }
      if (sequence.status === "DRAFT") {
        const result = await ProspectingSequence.deleteOne({
          _id: sequence._id,
          ...scope(ctx),
          status: "DRAFT",
          $or: [
            { launchLockedUntil: null },
            { launchLockedUntil: { $lte: new Date() } },
          ],
        });
        if (!result.deletedCount) {
          throw validation(
            "La prospection vient d'être lancée : arrêtez-la avant de la supprimer.",
          );
        }
        await ProspectingRecipient.deleteMany({ sequenceId: sequence._id });
        return true;
      }
      // Lancée : masquée, ses envois comptent toujours (règle des 30 jours,
      // historique des contacts)
      await ProspectingSequence.updateOne(
        { _id: sequence._id, ...scope(ctx) },
        { $set: { deletedAt: new Date() } },
      );
      return true;
    }),

    sendProspectingTest: can(["send", "edit"])(
      async (_, { id, emails }, ctx) => {
        await checkSubscriptionActive(ctx);
        const sequence = await findSequence(ctx, id);
        const count = await recordAttempt(
          `prospecting:test:${ctx.workspaceId}`,
          3600,
        );
        if (count > TEST_SENDS_PER_HOUR) {
          throw validation(
            "Trop d'e-mails de test envoyés : réessayez dans une heure.",
          );
        }
        return sendTestMessage(sequence, {
          userId: ctx.user._id,
          emails: Array.isArray(emails) ? emails : null,
        });
      },
    ),

    launchProspectingSequence: can("send")(async (_, { id, consent }, ctx) => {
      await checkSubscriptionActive(ctx);
      if (consent !== true) {
        throw validation(
          "Cochez la case : vos destinataires doivent être des professionnels et votre message doit concerner leur activité.",
        );
      }
      const sequence = await findSequence(ctx, id);
      const launched = await launchSequence(sequence, {
        userId: ctx.user._id,
      });
      return viewsFor(ctx).sequenceView(asObject(launched));
    }),

    pauseProspectingSequence: can("send")(async (_, { id }, ctx) => {
      const sequence = await findSequence(ctx, id);
      const updated = await pauseSequence(sequence, { userId: ctx.user._id });
      return viewsFor(ctx).sequenceView(asObject(updated));
    }),

    resumeProspectingSequence: can("send")(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      const sequence = await findSequence(ctx, id);
      const updated = await resumeSequence(sequence, {
        userId: ctx.user._id,
      });
      return viewsFor(ctx).sequenceView(asObject(updated));
    }),

    cancelProspectingSequence: can("send")(async (_, { id }, ctx) => {
      const sequence = await findSequence(ctx, id);
      const updated = await cancelSequence(sequence, { userId: ctx.user._id });
      return viewsFor(ctx).sequenceView(asObject(updated));
    }),

    markProspectingRecipient: can(["edit", "send"])(
      async (_, { id, action }, ctx) => {
        const missing = () => notFound("Destinataire introuvable.");
        if (!isObjectIdString(id)) throw missing();
        const recipient = await ProspectingRecipient.findOne({
          _id: toObjectId(id),
          ...scope(ctx),
        }).lean();
        if (!recipient) throw missing();
        const updated = await markRecipient(recipient, action, {
          userId: ctx.user._id,
        });
        return recipientView(updated);
      },
    ),
  },
};

export default prospectingResolvers;
