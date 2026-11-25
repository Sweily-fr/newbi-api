/**
 * Resolvers des campagnes e-mail (Communication > Campagnes e-mail).
 *
 * Périmètre : les campagnes appartiennent à l'espace (communes à tous ses
 * membres) ; chaque requête filtre sur l'espace validé par les droits
 * (ctx.workspaceId) : une campagne d'un autre espace est introuvable.
 * Droits du module « emailCampaigns » : voir (lectures), créer, modifier
 * (brouillon, images, liste d'exclusion), supprimer, envoyer et programmer
 * (envoi, test, pause, reprise, annulation).
 * Les routes publiques (désinscription, suivi) sont dans
 * routes/emailCampaigns.js, l'envoi dans services/emailCampaigns/.
 */
import mongoose from "mongoose";
import Client from "../models/Client.js";
import EmailCampaign, { EMPTY_STATS } from "../models/EmailCampaign.js";
import EmailCampaignRecipient from "../models/EmailCampaignRecipient.js";
import EmailSuppression from "../models/EmailSuppression.js";
import EmailTrackingConsent from "../models/EmailTrackingConsent.js";
import {
  checkSubscriptionActive,
  requireWorkspaceAction,
} from "../middlewares/rbac.js";
import cloudflareService from "../services/cloudflareService.js";
import { splitName } from "../services/signatureProfile.js";
import {
  ImageInputError,
  MAX_IMAGE_BYTES,
  processImage,
} from "../services/signatureAssets.js";
import {
  assertStorageAvailable,
  recordStoredFile,
} from "../services/storage/storageService.js";
import {
  normalizeEmail,
  resolveAudience,
  workspaceListIds,
} from "../services/emailCampaigns/audience.js";
import {
  campaignSettings,
  cancelCampaign,
  evaluateDeliverability,
  pauseCampaign,
  requestSend,
  resumeCampaign,
  sendCampaignTest,
  unscheduleCampaign,
} from "../services/emailCampaigns/campaignService.js";
import {
  DesignInputError,
  normalizeDesign,
  singleLine,
} from "../services/emailCampaigns/design.js";
import { upsertSuppression } from "../services/emailCampaigns/events.js";
import { loadWorkspaceIdentity } from "../services/emailCampaigns/identity.js";
import {
  EXAMPLE_VARIABLES,
  contactVariables,
} from "../services/emailCampaigns/personalize.js";
import { parseHttpUrl } from "../services/emailCampaigns/html.js";
import { renderCampaignEmail } from "../services/emailCampaigns/render.js";
import { aggregateLinkStats } from "../services/emailCampaigns/retention.js";
import { resolveCampaignSender } from "../services/emailCampaigns/sendingDomains.js";
import {
  campaignTrackingNotice,
  recipientTracked,
  tracksClicks,
  tracksOpens,
} from "../services/emailCampaigns/tracking.js";
import {
  MAX_GRANT_EMAILS,
  grantBySender,
  grantedEmailSet,
  refuseBySender,
  removeSenderConsent,
} from "../services/emailCampaigns/trackingConsent.js";
import {
  DEFAULT_TEMPLATE_KEY,
  isTemplateKey,
  listTemplates,
  templateDesign,
} from "../services/emailCampaigns/templates.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import { boundedPage } from "../utils/pageBounds.js";
import { buildSearchRegex } from "../utils/searchRegex.js";
import { isValidEmail } from "../utils/validators.js";

const MODULE = "emailCampaigns";
const NAME_MAX = 120;
const SUBJECT_MAX = 200;
const PREHEADER_MAX = 250;
const FROM_NAME_MAX = 60;
const URL_MAX = 500;
const MAX_TEST_ADDRESSES = 5;
// E-mails de test : envois hors quota, limités par espace
const TEST_SENDS_PER_HOUR = 20;
const SCHEDULE_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const SCHEDULE_PAST_TOLERANCE_MS = 5 * 60 * 1000;
const SCHEDULE_NOW_THRESHOLD_MS = 60 * 1000;

const can = (actions) => requireWorkspaceAction(MODULE, actions);

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const scope = (ctx) => ({ workspaceId: toObjectId(ctx.workspaceId) });
const has = (input, key) => input[key] !== undefined && input[key] !== null;

const validation = (message, details = null) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR, details);
const notFound = (message = "Campagne introuvable.") =>
  new AppError(message, ERROR_CODES.NOT_FOUND);

/** Campagne de l'espace (non supprimée), sinon NOT_FOUND. */
async function findCampaign(ctx, id, { lean = false } = {}) {
  if (!isObjectIdString(id)) throw notFound();
  const query = EmailCampaign.findOne({
    _id: toObjectId(id),
    ...scope(ctx),
    deletedAt: null,
  });
  const campaign = lean ? await query.lean() : await query;
  if (!campaign) throw notFound();
  return campaign;
}

/** Contact de l'espace (aperçu et test personnalisés). */
async function contactVariablesOf(ctx, clientId) {
  if (!clientId) return EXAMPLE_VARIABLES;
  if (!isObjectIdString(clientId)) throw notFound("Contact introuvable.");
  const client = await Client.findOne({
    _id: toObjectId(clientId),
    ...scope(ctx),
  })
    .select(
      "type name firstName lastName email address.city contacts.firstName contacts.lastName contacts.isPrimary",
    )
    .lean();
  if (!client) throw notFound("Contact introuvable.");
  return contactVariables(client);
}

/** Nom affiché de l'utilisateur (champs Better Auth de la collection brute). */
async function userDisplayName(user) {
  let raw = null;
  try {
    raw = await mongoose.connection.db
      .collection("user")
      .findOne(
        { _id: toObjectId(user._id) },
        { projection: { name: 1, lastName: 1, email: 1 } },
      );
  } catch {
    raw = null;
  }
  const { firstName, lastName } = splitName(
    raw?.name ?? user?.name,
    raw?.lastName ?? user?.lastName,
  );
  return (
    [firstName, lastName].filter(Boolean).join(" ") ||
    raw?.email ||
    user?.email ||
    null
  );
}

/** Texte d'une ligne saisi : contrôles retirés, longueur bornée. */
function lineInput(value, max, label) {
  const text = typeof value === "string" ? value : "";
  // Saisi tel quel (sauvegarde automatique) : seuls les retours à la ligne
  // et caractères de contrôle deviennent des espaces
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
  if (!name) throw validation("Donnez un nom à la campagne.");
  if (name.length > NAME_MAX) {
    throw validation(
      `Le nom de la campagne ne doit pas dépasser ${NAME_MAX} caractères.`,
    );
  }
  return name;
}

function designInput(value) {
  try {
    return normalizeDesign(value);
  } catch (error) {
    if (error instanceof DesignInputError) throw validation(error.message);
    throw error;
  }
}

async function audienceInput(ctx, audience) {
  const mode = audience.mode === "LISTS" ? "LISTS" : "ALL";
  const listIds = [...new Set((audience.listIds || []).map(String))];
  const excludeListIds = [
    ...new Set((audience.excludeListIds || []).map(String)),
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

/** Champs d'un brouillon à enregistrer, contrôlés. */
async function campaignChanges(input, ctx) {
  const changes = {};
  if (has(input, "name")) changes.name = nameInput(input.name);
  if (input.subject !== undefined) {
    changes.subject = lineInput(input.subject ?? "", SUBJECT_MAX, "L'objet");
  }
  if (input.preheader !== undefined) {
    changes.preheader = lineInput(
      input.preheader ?? "",
      PREHEADER_MAX,
      "Le texte d'aperçu",
    );
  }
  if (input.fromName !== undefined) {
    changes.fromName = lineInput(
      input.fromName ?? "",
      FROM_NAME_MAX,
      "Le nom de l'expéditeur",
    );
  }
  if (input.replyTo !== undefined) {
    const replyTo = normalizeEmail(input.replyTo ?? "");
    if (replyTo && !isValidEmail(replyTo)) {
      throw validation(
        "L'adresse de réponse n'est pas une adresse e-mail valide.",
      );
    }
    changes.replyTo = replyTo;
  }
  if (has(input, "design")) changes.design = designInput(input.design);
  if (has(input, "audience")) {
    changes.audience = await audienceInput(ctx, input.audience);
  }
  if (has(input, "trackOpens")) changes.trackOpens = Boolean(input.trackOpens);
  if (has(input, "trackClicks")) {
    changes.trackClicks = Boolean(input.trackClicks);
  }
  if (input.privacyPolicyUrl !== undefined) {
    changes.privacyPolicyUrl = privacyPolicyUrlInput(input.privacyPolicyUrl);
  }
  return changes;
}

/** Lien vers la politique de confidentialité de l'expéditeur (vide permis). */
function privacyPolicyUrlInput(value) {
  const raw = singleLine(value ?? "");
  if (!raw) return "";
  const url = raw.length <= URL_MAX ? parseHttpUrl(raw) : null;
  if (!url) {
    throw validation(
      "Le lien vers la politique de confidentialité doit être une adresse web (https://…).",
    );
  }
  return url.href;
}

/** Image envoyée par l'éditeur, lue avec une limite de taille. */
async function readImageUpload(file) {
  const upload = await file;
  const { createReadStream, filename, mimetype } = upload || {};
  if (typeof createReadStream !== "function") {
    throw validation("Aucune image reçue.");
  }
  // Photo HEIC sans type reconnu (navigateur sous Windows) : son contenu décide
  const heic = /\.hei[cf]$/i.test(filename || "");
  if (!heic && !String(mimetype || "").startsWith("image/")) {
    throw validation("Le fichier doit être une image (JPG, PNG ou WebP).");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream()) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      throw validation("Image trop volumineuse (10 Mo maximum).");
    }
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), filename, mimetype };
}

function scheduledDate(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw validation("Date d'envoi invalide.");
  if (date.getTime() < now - SCHEDULE_PAST_TOLERANCE_MS) {
    throw validation("La date d'envoi programmée est déjà passée.");
  }
  if (date.getTime() > now + SCHEDULE_MAX_MS) {
    throw validation("Programmez l'envoi dans les douze prochains mois.");
  }
  // Date toute proche : envoi immédiat
  return date.getTime() > now + SCHEDULE_NOW_THRESHOLD_MS ? date : null;
}

const RECIPIENT_FILTERS = {
  ALL: {},
  OPENED: { openedAt: { $ne: null } },
  CLICKED: { clickedAt: { $ne: null } },
  // Seulement les destinataires suivis : sans accord, une ouverture n'est
  // jamais connue
  NOT_OPENED: {
    openedAt: null,
    status: { $in: ["SENT", "DELIVERED", "SIMULATED"] },
    trackingAllowed: { $ne: false },
    trackingExpired: { $ne: true },
  },
  BOUNCED: { bouncedAt: { $ne: null } },
  UNSUBSCRIBED: { unsubscribedAt: { $ne: null } },
  FAILED: { status: "FAILED" },
};

const asObject = (value) =>
  typeof value?.toObject === "function" ? value.toObject() : value || {};

// Adresse d'envoi des campagnes pas encore lancées : calculée une fois par
// requête GraphQL et par espace (une liste de campagnes n'en relit qu'une)
const senderByRequest = new WeakMap();

function plannedSenderEmail(ctx, workspaceId) {
  const resolve = async () => (await resolveCampaignSender(workspaceId)).email;
  if (!ctx || typeof ctx !== "object") return resolve();
  let byWorkspace = senderByRequest.get(ctx);
  if (!byWorkspace) {
    byWorkspace = new Map();
    senderByRequest.set(ctx, byWorkspace);
  }
  const key = String(workspaceId);
  if (!byWorkspace.has(key)) byWorkspace.set(key, resolve());
  return byWorkspace.get(key);
}

const emailCampaignsResolvers = {
  EmailCampaign: {
    id: (campaign) => String(campaign._id || campaign.id),
    workspaceId: (campaign) => String(campaign.workspaceId),
    name: (campaign) => campaign.name || "",
    subject: (campaign) => campaign.subject || "",
    preheader: (campaign) => campaign.preheader || "",
    fromName: (campaign) => campaign.fromName || "",
    replyTo: (campaign) => campaign.replyTo || "",
    // Figée au lancement ; avant, celle qui serait utilisée maintenant
    senderEmail: (campaign, _, ctx) =>
      campaign.snapshot?.senderEmail ||
      plannedSenderEmail(ctx, campaign.workspaceId),
    // La liste ne charge pas le contenu : lu ici seulement s'il est demandé
    design: async (campaign) => {
      if (campaign.design !== undefined) {
        return campaign.design ?? normalizeDesign(null);
      }
      const doc = await EmailCampaign.findById(campaign._id)
        .select("design")
        .lean();
      return doc?.design ?? normalizeDesign(null);
    },
    audience: (campaign) => ({
      mode: campaign.audience?.mode === "LISTS" ? "LISTS" : "ALL",
      listIds: (campaign.audience?.listIds || []).map(String),
      excludeListIds: (campaign.audience?.excludeListIds || []).map(String),
    }),
    trackOpens: (campaign) => tracksOpens(campaign),
    trackClicks: (campaign) => tracksClicks(campaign),
    privacyPolicyUrl: (campaign) => campaign.privacyPolicyUrl || "",
    trackingPurgedAt: (campaign) => campaign.trackingPurgedAt || null,
    trackedRecipients: (campaign) =>
      Number.isInteger(campaign.trackedCount) ? campaign.trackedCount : null,
    pausedReason: (campaign) => campaign.pausedReason || null,
    stats: (campaign) => ({ ...EMPTY_STATS, ...asObject(campaign.stats) }),
    createdByName: (campaign) => campaign.createdByName || null,
  },

  EmailCampaignRecipient: {
    id: (recipient) => String(recipient._id || recipient.id),
    clientId: (recipient) =>
      recipient.clientId ? String(recipient.clientId) : null,
    name: (recipient) => recipient.name || null,
    openCount: (recipient) => recipient.openCount || 0,
    clickCount: (recipient) => recipient.clickCount || 0,
    tracked: (recipient) => recipientTracked(recipient),
    error: (recipient) => recipient.error || null,
  },

  EmailCampaignAudienceCount: {
    trackingGranted: (count) => count.trackingGranted || 0,
  },

  EmailSuppression: {
    id: (suppression) => String(suppression._id || suppression.id),
    campaignId: (suppression) =>
      suppression.campaignId ? String(suppression.campaignId) : null,
  },

  EmailTrackingConsent: {
    id: (consent) => String(consent._id || consent.id),
    note: (consent) => consent.note || null,
    decidedByName: (consent) => consent.decidedByName || null,
  },

  Query: {
    emailCampaigns: can("view")(
      async (_, { status, search, page, limit }, ctx) => {
        const bounds = boundedPage(page, limit, {
          defaultLimit: 20,
          maxLimit: 100,
        });
        const filter = { ...scope(ctx), deletedAt: null };
        if (status) filter.status = status;
        if (typeof search === "string" && search.trim()) {
          filter.name = buildSearchRegex(search);
        }
        const [items, total] = await Promise.all([
          EmailCampaign.find(filter)
            .select("-design -links")
            .sort({ updatedAt: -1, _id: -1 })
            .skip(bounds.skip)
            .limit(bounds.limit)
            .lean(),
          EmailCampaign.countDocuments(filter),
        ]);
        return { items, total, page: bounds.page, limit: bounds.limit };
      },
    ),

    emailCampaign: can("view")(async (_, { id }, ctx) => {
      if (!isObjectIdString(id)) return null;
      return EmailCampaign.findOne({
        _id: toObjectId(id),
        ...scope(ctx),
        deletedAt: null,
      }).lean();
    }),

    // Gestion du domaine d'envoi : droit « Envoyer et programmer »
    emailCampaignSettings: can("view")(async (_, __, ctx) =>
      campaignSettings(ctx.workspaceId, {
        canManageSendingDomain: Boolean(
          ctx.permissions?.hasPermission?.(MODULE, "send"),
        ),
      }),
    ),

    emailCampaignTemplates: can("view")(async (_, __, ctx) =>
      listTemplates(await loadWorkspaceIdentity(ctx.workspaceId)),
    ),

    emailCampaignAudienceCount: can("view")(async (_, { audience }, ctx) => {
      const { counts, recipients } = await resolveAudience(
        ctx.workspaceId,
        audience,
        { withRecipients: true },
      );
      // Destinataires qui seraient suivis (accord donné)
      const granted = await grantedEmailSet(
        toObjectId(ctx.workspaceId),
        recipients.map((recipient) => recipient.email),
      );
      return { ...counts, trackingGranted: granted.size };
    }),

    emailCampaignPreview: can("view")(
      async (_, { id, design, subject, preheader, clientId }, ctx) => {
        const campaign = await findCampaign(ctx, id, { lean: true });
        const content = designInput(design ?? campaign.design);
        const vars = await contactVariablesOf(ctx, clientId);
        const identity = campaign.snapshot?.companyName
          ? campaign.snapshot
          : await loadWorkspaceIdentity(ctx.workspaceId);
        const rendered = renderCampaignEmail({
          design: content,
          subject: subject ?? campaign.subject,
          preheader: preheader ?? campaign.preheader,
          vars,
          identity,
          trackingNotice: campaignTrackingNotice(campaign),
        });
        return {
          subject: rendered.subject,
          preheader: rendered.preheader,
          html: rendered.html,
          text: rendered.text,
        };
      },
    ),

    emailCampaignDeliverability: can("view")(async (_, { id }, ctx) =>
      evaluateDeliverability(await findCampaign(ctx, id, { lean: true })),
    ),

    emailCampaignRecipients: can("view")(
      async (_, { campaignId, filter, search, page, limit }, ctx) => {
        const campaign = await findCampaign(ctx, campaignId, { lean: true });
        const bounds = boundedPage(page, limit, {
          defaultLimit: 50,
          maxLimit: 200,
        });
        const query = {
          campaignId: campaign._id,
          workspaceId: campaign.workspaceId,
          ...(RECIPIENT_FILTERS[filter] || RECIPIENT_FILTERS.ALL),
        };
        if (typeof search === "string" && search.trim()) {
          const regex = buildSearchRegex(search);
          query.$or = [{ email: regex }, { name: regex }];
        }
        const [items, total] = await Promise.all([
          EmailCampaignRecipient.find(query)
            .select("-vars -batchKey")
            .sort({ _id: 1 })
            .skip(bounds.skip)
            .limit(bounds.limit)
            .lean(),
          EmailCampaignRecipient.countDocuments(query),
        ]);
        return { items, total, page: bounds.page, limit: bounds.limit };
      },
    ),

    emailCampaignLinkStats: can("view")(async (_, { campaignId }, ctx) => {
      const campaign = await findCampaign(ctx, campaignId, { lean: true });
      const links = campaign.links || [];
      if (!links.length) return [];
      // Suivi effacé (plus de 13 mois) : totaux gardés au moment de l'effacement
      const totals = Array.isArray(campaign.linkStats)
        ? campaign.linkStats
        : await aggregateLinkStats(campaign._id, links.length);
      return links
        .map((url, index) => ({
          url,
          index,
          clicks: totals[index]?.clicks || 0,
          uniqueClicks: totals[index]?.uniqueClicks || 0,
        }))
        .sort((a, b) => b.clicks - a.clicks || a.index - b.index)
        .map(({ url, clicks, uniqueClicks }) => ({
          url,
          clicks,
          uniqueClicks,
        }));
    }),

    emailSuppressions: can("view")(async (_, { search, page, limit }, ctx) => {
      const bounds = boundedPage(page, limit, {
        defaultLimit: 50,
        maxLimit: 200,
      });
      const filter = { ...scope(ctx) };
      if (typeof search === "string" && search.trim()) {
        filter.email = buildSearchRegex(search);
      }
      const [items, total] = await Promise.all([
        EmailSuppression.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip(bounds.skip)
          .limit(bounds.limit)
          .lean(),
        EmailSuppression.countDocuments(filter),
      ]);
      return { items, total, page: bounds.page, limit: bounds.limit };
    }),

    emailTrackingConsents: can("view")(
      async (_, { status, search, page, limit }, ctx) => {
        const bounds = boundedPage(page, limit, {
          defaultLimit: 50,
          maxLimit: 200,
        });
        const filter = { ...scope(ctx) };
        if (status === "GRANTED" || status === "REFUSED") {
          filter.status = status;
        }
        if (typeof search === "string" && search.trim()) {
          filter.email = buildSearchRegex(search);
        }
        const [items, total] = await Promise.all([
          EmailTrackingConsent.find(filter)
            .sort({ decidedAt: -1, _id: -1 })
            .skip(bounds.skip)
            .limit(bounds.limit)
            .select("-history")
            .lean(),
          EmailTrackingConsent.countDocuments(filter),
        ]);
        return { items, total, page: bounds.page, limit: bounds.limit };
      },
    ),
  },

  Mutation: {
    createEmailCampaign: can("create")(async (_, { input }, ctx) => {
      await checkSubscriptionActive(ctx);
      const name = nameInput(input?.name);
      const templateKey = input?.templateKey || DEFAULT_TEMPLATE_KEY;
      if (!isTemplateKey(templateKey)) {
        throw validation("Modèle de campagne inconnu.");
      }
      const identity = await loadWorkspaceIdentity(ctx.workspaceId);
      return EmailCampaign.create({
        ...scope(ctx),
        name,
        templateKey,
        design: normalizeDesign(templateDesign(templateKey, identity)),
        fromName: singleLine(identity.companyName, FROM_NAME_MAX),
        replyTo: identity.defaultReplyTo,
        audience: { mode: "ALL", listIds: [], excludeListIds: [] },
        createdBy: ctx.user._id,
        createdByName: await userDisplayName(ctx.user),
      });
    }),

    updateEmailCampaign: can("edit")(async (_, { id, input }, ctx) => {
      await checkSubscriptionActive(ctx);
      const current = await findCampaign(ctx, id, { lean: true });
      if (current.status !== "DRAFT") {
        throw validation(
          "Seul un brouillon peut être modifié : dupliquez la campagne pour en préparer une nouvelle.",
        );
      }
      const changes = await campaignChanges(input || {}, ctx);
      const updated = await EmailCampaign.findOneAndUpdate(
        { _id: current._id, ...scope(ctx), status: "DRAFT", deletedAt: null },
        { $set: { ...changes, pausedReason: null } },
        { new: true },
      );
      if (!updated) {
        throw validation(
          "La campagne vient de changer d'état : elle ne peut plus être modifiée.",
        );
      }
      return updated;
    }),

    duplicateEmailCampaign: can("create")(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      const source = await findCampaign(ctx, id, { lean: true });
      const suffix = " (copie)";
      return EmailCampaign.create({
        ...scope(ctx),
        name: `${source.name.slice(0, NAME_MAX - suffix.length)}${suffix}`,
        templateKey: source.templateKey,
        subject: source.subject,
        preheader: source.preheader,
        fromName: source.fromName,
        replyTo: source.replyTo,
        design: normalizeDesign(source.design),
        audience: source.audience,
        // Suivi coupé dans la copie : à réactiver, attestation comprise
        trackOpens: false,
        trackClicks: false,
        privacyPolicyUrl: source.privacyPolicyUrl || "",
        createdBy: ctx.user._id,
        createdByName: await userDisplayName(ctx.user),
      });
    }),

    deleteEmailCampaign: can("delete")(async (_, { id }, ctx) => {
      const campaign = await findCampaign(ctx, id, { lean: true });
      if (["SENDING", "PAUSED"].includes(campaign.status)) {
        throw validation(
          "Annulez l'envoi de cette campagne avant de la supprimer.",
        );
      }
      if (["DRAFT", "SCHEDULED"].includes(campaign.status)) {
        // Jamais envoyée : aucun destinataire, suppression définitive
        const result = await EmailCampaign.deleteOne({
          _id: campaign._id,
          ...scope(ctx),
          status: { $in: ["DRAFT", "SCHEDULED"] },
        });
        if (!result.deletedCount) {
          throw validation(
            "La campagne vient de partir : annulez l'envoi avant de la supprimer.",
          );
        }
        return true;
      }
      // Envoyée : masquée, ses destinataires comptent toujours dans le
      // quota et ses rejets ou plaintes alimentent la liste d'exclusion
      await EmailCampaign.updateOne(
        {
          _id: campaign._id,
          ...scope(ctx),
          status: { $in: ["SENT", "CANCELED"] },
        },
        { $set: { deletedAt: new Date() } },
      );
      return true;
    }),

    sendEmailCampaignTest: can(["send", "edit"])(
      async (_, { id, emails, clientId }, ctx) => {
        await checkSubscriptionActive(ctx);
        const campaign = await findCampaign(ctx, id, { lean: true });
        const addresses = [
          ...new Set((emails || []).map((email) => normalizeEmail(email))),
        ].filter(Boolean);
        if (!addresses.length || addresses.length > MAX_TEST_ADDRESSES) {
          throw validation(
            `Indiquez de 1 à ${MAX_TEST_ADDRESSES} adresses e-mail.`,
          );
        }
        const invalid = addresses.find((email) => !isValidEmail(email));
        if (invalid) throw validation(`Adresse e-mail invalide : ${invalid}`);
        const rejected = await EmailSuppression.findOne({
          ...scope(ctx),
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
        const vars = await contactVariablesOf(ctx, clientId);
        const count = await recordAttempt(
          `email-campaign:test:${ctx.workspaceId}`,
          3600,
        );
        if (count > TEST_SENDS_PER_HOUR) {
          throw validation(
            "Trop d'e-mails de test envoyés : réessayez dans une heure.",
          );
        }
        return sendCampaignTest(campaign, addresses, { vars });
      },
    ),

    // `trackingConsent` (attestation globale de l'étape 1) est ignoré : le
    // suivi ne concerne plus que les adresses qui l'ont accepté
    sendEmailCampaign: can("send")(
      async (_, { id, scheduledAt, consent }, ctx) => {
        await checkSubscriptionActive(ctx);
        if (consent !== true) {
          throw validation(
            "Confirmez que ces contacts sont vos clients ou ont accepté de recevoir vos e-mails.",
          );
        }
        const when = scheduledDate(scheduledAt);
        const campaign = await findCampaign(ctx, id);
        const result = await requestSend(campaign, {
          scheduledAt: when,
          userId: ctx.user._id,
        });
        logger.info(
          `[campagnes] campagne ${campaign._id} ${when ? `programmée au ${when.toISOString()}` : "lancée"} par ${ctx.user._id}`,
        );
        return result;
      },
    ),

    unscheduleEmailCampaign: can("send")(async (_, { id }, ctx) =>
      unscheduleCampaign(await findCampaign(ctx, id, { lean: true })),
    ),

    pauseEmailCampaign: can("send")(async (_, { id }, ctx) =>
      pauseCampaign(await findCampaign(ctx, id, { lean: true })),
    ),

    resumeEmailCampaign: can("send")(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      return resumeCampaign(await findCampaign(ctx, id, { lean: true }));
    }),

    cancelEmailCampaign: can("send")(async (_, { id }, ctx) =>
      cancelCampaign(await findCampaign(ctx, id, { lean: true })),
    ),

    uploadEmailCampaignImage: can(["create", "edit"])(
      async (_, { file }, ctx) => {
        await checkSubscriptionActive(ctx);
        const { buffer, filename, mimetype } = await readImageUpload(file);
        await assertStorageAvailable(ctx.workspaceId, buffer.length);
        let processed;
        try {
          processed = await processImage(buffer, "BANNER");
        } catch (error) {
          if (error instanceof ImageInputError) {
            logger.warn(
              `[campagnes] image refusée (${mimetype || "type inconnu"}, « ${filename || "sans nom"} », ${buffer.length} octets) : ${error.message}`,
            );
            throw validation(error.message);
          }
          throw error;
        }
        let stored;
        try {
          // Bucket public des images de signature : lisible par toutes les
          // messageries ; ancienne image gardée (e-mails déjà envoyés)
          stored = await cloudflareService.uploadSignatureImage(
            processed.buffer,
            `campagne-${Date.now()}.${processed.ext}`,
            String(ctx.user._id),
            `campagnes-${ctx.workspaceId}`,
            "banner",
            { keepPrevious: true },
          );
        } catch (error) {
          logger.error(
            `[campagnes] image non enregistrée (${ctx.workspaceId}) : ${error.message}`,
          );
          throw new AppError(
            "L'image n'a pas pu être enregistrée. Réessayez dans un instant.",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
        await recordStoredFile({
          workspaceId: ctx.workspaceId,
          key: stored.key,
          bucket: cloudflareService.signatureBucketName,
          size: processed.buffer.length,
          category: "branding",
          userId: ctx.user._id,
        });
        return { url: stored.url, key: stored.key };
      },
    ),

    addEmailSuppression: can("edit")(async (_, { email }, ctx) => {
      const address = normalizeEmail(email);
      if (!isValidEmail(address)) {
        throw validation("Adresse e-mail invalide.");
      }
      return upsertSuppression({
        workspaceId: toObjectId(ctx.workspaceId),
        email: address,
        reason: "MANUAL",
        source: "manual",
        createdBy: ctx.user._id,
      });
    }),

    // Rouvre l'envoi vers une adresse : abonnement actif exigé (l'ajout,
    // lui, reste possible pour tout stopper)
    removeEmailSuppression: can("edit")(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      const missing = () =>
        notFound("Adresse introuvable dans la liste d'exclusion.");
      if (!isObjectIdString(id)) throw missing();
      const suppression = await EmailSuppression.findOne({
        _id: toObjectId(id),
        ...scope(ctx),
      }).lean();
      if (!suppression) throw missing();
      if (suppression.reason !== "MANUAL") {
        throw validation(
          "Seules les adresses ajoutées à la main peuvent être retirées : une désinscription, un rejet ou une plainte restent définitifs.",
        );
      }
      await EmailSuppression.deleteOne({
        _id: suppression._id,
        ...scope(ctx),
        reason: "MANUAL",
      });
      return true;
    }),

    // Accords de suivi recueillis par l'espace : attestation obligatoire,
    // abonnement actif exigé (le suivi reprend pour ces adresses)
    grantEmailTracking: can("edit")(
      async (_, { emails, note, attestation }, ctx) => {
        await checkSubscriptionActive(ctx);
        if (attestation !== true) {
          throw validation(
            "Confirmez que ces contacts vous ont donné leur accord et que vous pouvez le prouver.",
          );
        }
        const list = Array.isArray(emails) ? emails : [];
        if (!list.length) throw validation("Ajoutez au moins une adresse.");
        if (list.length > MAX_GRANT_EMAILS) {
          throw validation(
            `${MAX_GRANT_EMAILS} adresses au plus à la fois : enregistrez-les en plusieurs fois.`,
          );
        }
        const result = await grantBySender({
          workspaceId: toObjectId(ctx.workspaceId),
          emails: list,
          note,
          userId: ctx.user._id,
          userName: await userDisplayName(ctx.user),
        });
        logger.info(
          `[campagnes] ${result.granted} accord(s) de suivi saisi(s) dans l'espace ${ctx.workspaceId} par ${ctx.user._id}`,
        );
        return result;
      },
    ),

    // Refus noté par l'espace : toujours possible, suivi effacé
    refuseEmailTracking: can("edit")(async (_, { email }, ctx) => {
      const address = normalizeEmail(email);
      if (!isValidEmail(address)) {
        throw validation("Adresse e-mail invalide.");
      }
      return refuseBySender({
        workspaceId: toObjectId(ctx.workspaceId),
        email: address,
        userId: ctx.user._id,
        userName: await userDisplayName(ctx.user),
      });
    }),

    removeEmailTrackingConsent: can("edit")(async (_, { id }, ctx) => {
      const missing = () => notFound("Accord de suivi introuvable.");
      if (!isObjectIdString(id)) throw missing();
      const outcome = await removeSenderConsent({
        workspaceId: toObjectId(ctx.workspaceId),
        id: toObjectId(id),
      });
      if (outcome === "not_found") throw missing();
      if (outcome === "contact_choice") {
        throw validation(
          "Ce choix vient du contact lui-même : lui seul peut le changer, avec le lien « Gérer mes préférences » de vos e-mails.",
        );
      }
      return true;
    }),
  },
};

export default emailCampaignsResolvers;
