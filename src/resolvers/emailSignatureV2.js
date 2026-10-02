/**
 * Resolvers des signatures de mail v2.
 *
 * Périmètre : une signature appartient à un utilisateur dans un espace de
 * travail (createdBy + workspaceId). Le HTML est toujours produit par
 * services/signatureRenderer ; ces resolvers ne font que stocker les
 * données, garantir les icônes sur R2 et traiter les images.
 */

import EmailSignatureV2 from "../models/EmailSignatureV2.js";
import EmailSignatureTemplateV2 from "../models/EmailSignatureTemplateV2.js";
import {
  requireDelete,
  requireRead,
  requireWrite,
} from "../middlewares/rbac.js";
import {
  createAlreadyExistsError,
  createInternalServerError,
  createNotFoundError,
  createValidationError,
} from "../utils/errors.js";
import logger from "../utils/logger.js";
import { sendSignatureTestEmail } from "../utils/mailer.js";
import {
  listTemplates,
  normalizeSignature,
  renderSignature,
  requiredIcons,
  SAMPLE_SIGNATURE,
  templatePreset,
} from "../services/signatureRenderer/index.js";
import {
  FONT_FAMILIES,
  FONT_LABELS,
  GMAIL_MAX_CHARS,
  SOCIAL_NETWORKS,
  GALLERY_TEMPLATE_IDS,
} from "../services/signatureRenderer/constants.js";
import {
  deleteSignatureImages,
  ensureIcons,
  ensureSamplePhoto,
  importSignatureImage,
  storeSignatureImage,
} from "../services/signatureAssets.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  isWorkspaceMember,
  listWorkspaceMembers,
  memberSignatureProfile,
} from "../services/signatureProfile.js";

/** Un e-mail de test au plus toutes les 20 secondes par utilisateur. */
const TEST_COOLDOWN_MS = 20_000;
const lastTestSent = new Map();

const scope = (ctx) => ({
  createdBy: ctx.user.id,
  workspaceId: ctx.workspaceId,
});

/** Modèles enregistrés : visibles de tout l'espace. */
const templateScope = (ctx) => ({ workspaceId: ctx.workspaceId });

/** Rôles qui peuvent retirer les modèles de toute l'équipe (membre parti…). */
const TEMPLATE_MANAGER_ROLES = ["owner", "admin"];

/**
 * Suppression d'un modèle enregistré : par son auteur, ou par le
 * propriétaire et les administrateurs de l'espace, si leur rôle permet de
 * supprimer des signatures. Le rôle n'est connu que des resolvers racine
 * (contexte enrichi par withRBAC) : le droit y est calculé, puis porté par
 * chaque modèle (canDelete).
 */
const canDeleteTemplate = (t, ctx) =>
  Boolean(ctx.permissions?.canDelete("signatures")) &&
  (String(t.createdBy) === String(ctx.user?.id) ||
    TEMPLATE_MANAGER_ROLES.includes(ctx.userRole));

const plain = (value) =>
  value && typeof value.toObject === "function"
    ? value.toObject()
    : value
      ? JSON.parse(JSON.stringify(value))
      : {};

/**
 * Photo de la personne de la signature : importée et recadrée comme un
 * envoi, ou retirée si la personne n'en a pas. Un échec d'import ne bloque
 * jamais l'enregistrement (la signature reste utilisable sans photo).
 */
async function setPersonPhoto(doc, url, ctx) {
  if (!url) {
    if (!doc.images?.photo) return;
    try {
      await cloudflareService.deleteSignatureFolder(
        String(ctx.user.id),
        String(doc._id),
        "imgProfil",
      );
    } catch (error) {
      logger.warn(
        `[signatures v2] suppression photo ignorée : ${error.message}`,
      );
    }
    doc.images.photo = null;
    doc.markModified("images");
    await doc.save();
    return;
  }
  try {
    doc.images.photo = await importSignatureImage({
      url,
      kind: "PHOTO",
      userId: ctx.user.id,
      signatureId: doc._id,
      options: { size: doc.style?.photoSize || 84 },
    });
    doc.markModified("images");
    await doc.save();
  } catch (error) {
    logger.warn(
      `[signatures v2] photo de profil non importée : ${error.message}`,
    );
  }
}

/** Personne choisie : soi-même par défaut, sinon un membre de l'espace. */
async function resolvePerson(memberUserId, ctx) {
  const userId = memberUserId ? String(memberUserId) : String(ctx.user.id);
  if (
    userId !== String(ctx.user.id) &&
    !(await isWorkspaceMember(userId, ctx.workspaceId))
  ) {
    throw createValidationError(
      "Cette personne ne fait pas partie de l'espace",
    );
  }
  return {
    userId,
    profile: await memberSignatureProfile(userId, ctx.workspaceId),
  };
}

/**
 * Référence au modèle d'équipe appliqué : un identifiant de modèle, sinon
 * null (modèle intégré). Le modèle peut avoir été supprimé depuis :
 * l'éditeur revient alors au modèle intégré.
 */
const savedTemplateRef = (value) =>
  /^[0-9a-f]{24}$/i.test(String(value ?? "")) ? String(value) : null;

/** Garde les valeurs renseignées d'un groupe (identity, contact…). */
const filled = (obj) =>
  Object.fromEntries(
    Object.entries(obj || {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    ),
  );

async function findOwned(id, ctx) {
  const doc = await EmailSignatureV2.findOne({ _id: id, ...scope(ctx) });
  if (!doc) throw createNotFoundError("Signature");
  return doc;
}

/** Nom disponible : « Ma signature », puis « Ma signature 2 », etc. */
async function availableName(base, ctx, excludeId = null) {
  const trimmed =
    (base || "Ma signature").trim().slice(0, 120) || "Ma signature";
  const filter = { ...scope(ctx) };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = new Set(
    (await EmailSignatureV2.find(filter).select("name").lean()).map(
      (d) => d.name,
    ),
  );
  if (!existing.has(trimmed)) return trimmed;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${trimmed} ${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${trimmed} ${Date.now()}`;
}

async function assertNameFree(name, ctx, excludeId = null) {
  const filter = { ...scope(ctx), name };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await EmailSignatureV2.exists(filter)) {
    throw createAlreadyExistsError("signature", "nom", name);
  }
}

/**
 * Fusionne l'entrée dans les données existantes puis normalise, de sorte
 * que le document stocké respecte toujours les listes de valeurs du modèle.
 */
function mergeInput(current, input) {
  const merged = { ...current };
  for (const key of [
    "identity",
    "contact",
    "cta",
    "banner",
    "disclaimer",
    "style",
  ]) {
    if (input[key]) {
      const provided = Object.fromEntries(
        Object.entries(input[key]).filter(
          ([, v]) => v !== undefined && v !== null,
        ),
      );
      merged[key] = { ...(current[key] || {}), ...provided };
    }
  }
  if (input.social) merged.social = input.social;
  if (input.templateId) merged.templateId = input.templateId;
  const normalized = normalizeSignature(merged);
  // Les images ne viennent jamais de l'entrée : elles sont gérées par upload.
  normalized.images = current.images || {
    photo: null,
    logo: null,
    banner: null,
  };
  return normalized;
}

function applyNormalized(doc, normalized) {
  doc.templateId = normalized.templateId;
  doc.identity = normalized.identity;
  doc.contact = normalized.contact;
  doc.social = normalized.social;
  doc.cta = normalized.cta;
  doc.banner = normalized.banner;
  doc.disclaimer = normalized.disclaimer;
  doc.style = normalized.style;
}

/**
 * Garantit les icônes sur R2 sans bloquer l'aperçu : au-delà de 3 s, le HTML
 * part quand même (les URL sont déterministes, l'icône arrivera ensuite).
 */
async function ensureIconsSoon(data) {
  const specs = requiredIcons(data);
  if (specs.length === 0) return;
  const work = ensureIcons(specs).catch((error) =>
    logger.warn(`[signatures v2] ensureIcons : ${error.message}`),
  );
  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/**
 * Rendu propre (à copier) + rendu d'aperçu, dont chaque élément porte
 * l'identifiant du champ qui le pilote, pour l'éditeur.
 */
function withPreview(data) {
  const result = renderSignature(data);
  return {
    ...result,
    previewHtml: renderSignature(data, { markers: true }).html,
  };
}

async function readUpload(file) {
  const { createReadStream, filename, mimetype } = await file;
  if (!mimetype || !mimetype.startsWith("image/")) {
    throw createValidationError(
      "Le fichier doit être une image (JPG, PNG ou WebP)",
    );
  }
  const chunks = [];
  for await (const chunk of createReadStream()) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), filename };
}

/**
 * Réglages de départ complets d'un modèle, emplacements compris : choisir
 * un modèle remet chaque élément à sa place dans ce modèle.
 */
function templateDefaults(t) {
  const st = normalizeSignature({
    templateId: t.id,
    style: t.preset,
    images: { photo: { url: "https://exemple.invalid/photo.jpg" } },
  }).style;
  return {
    ...t.preset,
    slots: st.slots,
    visualSide: st.visualSide,
    visualFill: st.visualFill,
    headerPhoto: st.headerPhoto,
    headerFill: st.headerFill,
  };
}

const emailSignatureV2Resolvers = {
  // Mongoose retire les objets vides : on garantit la présence du champ
  SignatureStyleV2: {
    elements: (st) => st?.elements || {},
    rules: (st) => st?.rules || {},
    dividerSpace: (st) => st?.dividerSpace || {},
  },

  SignatureSavedTemplateV2: {
    id: (t) => String(t._id ?? t.id),
    // Style tel que le générateur le comprend aujourd'hui (réglage apparu
    // depuis l'enregistrement : valeur du modèle de base)
    style: (t) =>
      normalizeSignature({ templateId: t.templateId, style: t.style }).style,
    mine: (t, _, ctx) => String(t.createdBy) === String(ctx.user?.id),
    // Calculé par la requête ou la mutation (rôle de l'utilisateur)
    canDelete: (t) => Boolean(t.canDelete),
  },

  EmailSignatureV2: {
    id: (doc) => String(doc._id ?? doc.id),
    images: (doc) => ({
      photo: doc.images?.photo || null,
      logo: doc.images?.logo || null,
      banner: doc.images?.banner || null,
    }),
    social: (doc) => doc.social || [],
    // Style effectif : réglages absents = valeurs du modèle, pour que
    // l'éditeur affiche la mise en page réellement rendue
    style: (doc) => normalizeSignature(plain(doc)).style,
    render: async (doc) => {
      const data = plain(doc);
      await ensureIconsSoon(data);
      return withPreview(data);
    },
  },

  Query: {
    emailSignaturesV2: requireRead("signatures")(async (_, __, ctx) =>
      EmailSignatureV2.find(scope(ctx)).sort({ isDefault: -1, updatedAt: -1 }),
    ),

    emailSignatureV2: requireRead("signatures")(async (_, { id }, ctx) =>
      EmailSignatureV2.findOne({ _id: id, ...scope(ctx) }),
    ),

    emailSignatureTemplatesV2: requireRead("signatures")(async (_, __, ctx) => {
      const templates = await EmailSignatureTemplateV2.find(templateScope(ctx))
        .sort({ updatedAt: -1 })
        .lean();
      return templates.map((t) => ({
        ...t,
        canDelete: canDeleteTemplate(t, ctx),
      }));
    }),

    signatureMembersV2: requireRead("signatures")(async (_, __, ctx) => {
      const members = await listWorkspaceMembers(ctx.workspaceId);
      return members.map((m) => ({
        ...m,
        isMe: m.userId === String(ctx.user.id),
      }));
    }),

    signatureCatalogV2: requireRead("signatures")(async () => ({
      templates: listTemplates().map((t) => ({
        ...t,
        defaults: templateDefaults(t),
        inGallery: GALLERY_TEMPLATE_IDS.includes(t.id),
      })),
      networks: Object.entries(SOCIAL_NETWORKS).map(([id, n]) => ({
        id,
        label: n.label,
        brandColor: `#${n.hex.toLowerCase()}`,
        host: n.host,
      })),
      fonts: Object.entries(FONT_FAMILIES).map(([id, stack]) => ({
        id,
        label: FONT_LABELS[id] || id,
        stack,
      })),
      gmailMaxChars: GMAIL_MAX_CHARS,
    })),

    renderEmailSignatureV2: requireRead("signatures")(
      async (_, { input, id }, ctx) => {
        let current = { images: { photo: null, logo: null, banner: null } };
        if (id) current = plain(await findOwned(id, ctx));
        const data = mergeInput(current, input || {});
        await ensureIconsSoon(data);
        return withPreview(data);
      },
    ),

    renderSignatureTemplateV2: requireRead("signatures")(
      async (_, { templateId, style, id }, ctx) => {
        await ensureSamplePhoto();
        // Vignette = le modèle tel qu'il s'appliquera : sa mise en page, ses
        // finitions et sa palette s'il en a une (Newbi), sinon les couleurs
        // principales de l'utilisateur
        const colors = Object.fromEntries(
          Object.entries(style || {}).filter(
            ([k, v]) =>
              ["primaryColor", "textColor", "mutedColor"].includes(k) &&
              v !== null &&
              v !== undefined,
          ),
        );
        // Vos propres informations dès que la signature a un nom : on
        // choisit un modèle en voyant ce qu'il donne pour soi. Le bandeau et
        // la mention, identiques d'un modèle à l'autre, sont laissés de côté.
        let content = SAMPLE_SIGNATURE;
        if (id) {
          const own = plain(await findOwned(id, ctx));
          if (own.identity?.firstName || own.identity?.lastName) {
            content = {
              identity: own.identity,
              contact: own.contact,
              social: own.social,
              images: own.images,
              cta: own.cta,
              banner: { enabled: false },
              disclaimer: { enabled: false },
            };
          }
        }
        const data = {
          ...content,
          templateId,
          style: { ...colors, ...templatePreset(templateId) },
        };
        await ensureIconsSoon(data);
        const result = renderSignature(data);
        return { ...result, previewHtml: result.html };
      },
    ),
  },

  Mutation: {
    sendEmailSignatureV2Test: requireRead("signatures")(
      async (_, { id }, ctx) => {
        const email = ctx.user?.email;
        if (!email) {
          throw createValidationError(
            "Aucune adresse e-mail n'est associée à votre compte.",
          );
        }
        const userId = String(ctx.user.id);
        if (Date.now() - (lastTestSent.get(userId) || 0) < TEST_COOLDOWN_MS) {
          throw createValidationError(
            "Un e-mail de test vient d'être envoyé : patientez quelques secondes.",
          );
        }
        const data = plain(await findOwned(id, ctx));
        // Les icônes doivent exister avant l'envoi (générées à la demande)
        const specs = requiredIcons(data);
        if (specs.length > 0) {
          await ensureIcons(specs).catch((error) =>
            logger.warn(`[signatures v2] ensureIcons : ${error.message}`),
          );
        }
        const { html, text } = renderSignature(data);
        if (!html) {
          throw createValidationError(
            "La signature est vide : ajoutez au moins votre nom.",
          );
        }
        lastTestSent.set(userId, Date.now());
        const sent = await sendSignatureTestEmail(email, {
          signatureHtml: html,
          signatureText: text,
          signatureName: data.name || "Ma signature",
        });
        if (!sent) {
          lastTestSent.delete(userId);
          throw createInternalServerError(
            "L'e-mail de test n'a pas pu être envoyé. Réessayez dans un instant.",
          );
        }
        return email;
      },
    ),

    createEmailSignatureV2: requireWrite("signatures")(
      async (_, { input, memberUserId }, ctx) => {
        const name = await availableName(input?.name, ctx);
        const isFirst = !(await EmailSignatureV2.exists(scope(ctx)));
        // Pré-remplie avec le profil de la personne (soi-même par défaut) et
        // l'entreprise de l'espace ; ce que l'entrée précise l'emporte.
        const person = await resolvePerson(memberUserId, ctx);
        const { person: own, company } = person.profile;
        // Une nouvelle signature démarre avec la typographie de son modèle,
        // le premier de la galerie sauf choix contraire
        const templateId = input?.templateId || GALLERY_TEMPLATE_IDS[0];
        const preset = templatePreset(templateId);
        const normalized = mergeInput(
          { images: { photo: null, logo: null, banner: null } },
          {
            ...(input || {}),
            templateId,
            identity: {
              ...filled(company.identity),
              ...filled(own.identity),
              ...filled(input?.identity),
            },
            contact: {
              ...filled(company.contact),
              ...filled(own.contact),
              ...filled(input?.contact),
            },
            style: { ...preset, ...(input?.style || {}) },
          },
        );
        const doc = new EmailSignatureV2({
          name,
          isDefault: isFirst,
          memberUserId: person.userId,
          savedTemplateId: savedTemplateRef(input?.savedTemplateId),
          ...scope(ctx),
        });
        applyNormalized(doc, normalized);
        await doc.save();
        await setPersonPhoto(doc, person.profile.photoUrl, ctx);
        return doc;
      },
    ),

    applyMemberToEmailSignatureV2: requireWrite("signatures")(
      async (_, { id, memberUserId }, ctx) => {
        const doc = await findOwned(id, ctx);
        const person = await resolvePerson(memberUserId, ctx);
        const { person: own, company } = person.profile;
        const current = plain(doc);
        // Ce qui est propre à la personne est remplacé (même vide, pour ne
        // pas garder le portable de la précédente) ; l'entreprise ne
        // complète que les champs vides.
        const normalized = mergeInput(current, {
          identity: {
            ...filled(company.identity),
            ...filled(current.identity),
            ...own.identity,
          },
          contact: {
            ...filled(company.contact),
            ...filled(current.contact),
            ...own.contact,
          },
        });
        applyNormalized(doc, normalized);
        doc.memberUserId = person.userId;
        await doc.save();
        await setPersonPhoto(doc, person.profile.photoUrl, ctx);
        return doc;
      },
    ),

    updateEmailSignatureV2: requireWrite("signatures")(
      async (_, { id, input }, ctx) => {
        const doc = await findOwned(id, ctx);
        if (input?.name !== undefined) {
          const name = String(input.name || "").trim();
          if (!name)
            throw createValidationError("Le nom de la signature est requis");
          if (name !== doc.name) {
            await assertNameFree(name, ctx, doc._id);
            doc.name = name;
          }
        }
        applyNormalized(doc, mergeInput(plain(doc), input || {}));
        // Modèle d'équipe appliqué : hors du style, que la normalisation ne
        // connaît pas, il est recopié à part
        if (input?.savedTemplateId !== undefined) {
          doc.savedTemplateId = savedTemplateRef(input.savedTemplateId);
        }
        await doc.save();
        return doc;
      },
    ),

    deleteEmailSignatureV2: requireDelete("signatures")(
      async (_, { id }, ctx) => {
        const doc = await findOwned(id, ctx);
        const wasDefault = doc.isDefault;
        await doc.deleteOne();
        await deleteSignatureImages(ctx.user.id, doc._id);
        if (wasDefault) {
          const next = await EmailSignatureV2.findOne(scope(ctx)).sort({
            updatedAt: -1,
          });
          if (next) {
            next.isDefault = true;
            await next.save();
          }
        }
        return true;
      },
    ),

    saveEmailSignatureTemplateV2: requireWrite("signatures")(
      async (_, { input }, ctx) => {
        const name = String(input?.name ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 60);
        if (!name) throw createValidationError("Donnez un nom au modèle.");
        // Style validé par le générateur, comme celui d'une signature
        const { templateId, style } = normalizeSignature({
          templateId: input.templateId,
          style: input.style,
        });
        // Un de vos modèles du même nom est remplacé
        const saved = await EmailSignatureTemplateV2.findOneAndUpdate(
          { ...templateScope(ctx), createdBy: ctx.user.id, name },
          { $set: { templateId, style } },
          { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
        );
        return { ...saved, canDelete: canDeleteTemplate(saved, ctx) };
      },
    ),

    deleteEmailSignatureTemplateV2: requireDelete("signatures")(
      async (_, { id }, ctx) => {
        // Le sien, ou n'importe lequel de l'espace pour le propriétaire et
        // les administrateurs : mêmes règles que canDelete
        const filter = { _id: id, ...templateScope(ctx) };
        if (!TEMPLATE_MANAGER_ROLES.includes(ctx.userRole)) {
          filter.createdBy = ctx.user.id;
        }
        const { deletedCount } =
          await EmailSignatureTemplateV2.deleteOne(filter);
        if (!deletedCount) throw createNotFoundError("Modèle");
        // Les signatures qui l'avaient appliqué gardent leur mise en forme ;
        // seule leur référence revient au modèle intégré (sans les faire
        // remonter dans les listes triées par date de modification)
        await EmailSignatureV2.updateMany(
          { workspaceId: ctx.workspaceId, savedTemplateId: String(id) },
          { $set: { savedTemplateId: null } },
          { timestamps: false },
        );
        return true;
      },
    ),

    duplicateEmailSignatureV2: requireWrite("signatures")(
      async (_, { id }, ctx) => {
        const source = await findOwned(id, ctx);
        const data = plain(source);
        const copy = new EmailSignatureV2({
          ...data,
          _id: undefined,
          id: undefined,
          createdAt: undefined,
          updatedAt: undefined,
          isDefault: false,
          migratedFrom: null,
          name: await availableName(`${source.name} (copie)`, ctx),
        });
        // Les images sont copiées sous l'identifiant de la copie, sinon la
        // suppression de l'original les ferait disparaître de la copie.
        for (const kind of ["photo", "logo", "banner"]) {
          const image = data.images?.[kind];
          if (!image?.key) continue;
          try {
            const copied = await cloudflareService.copySignatureImage(
              image.key,
              String(ctx.user.id),
              String(copy._id),
            );
            if (copied?.url)
              copy.images[kind] = {
                ...image,
                url: copied.url,
                key: copied.key,
              };
          } catch (error) {
            logger.warn(
              `[signatures v2] copie d'image ${kind} ignorée : ${error.message}`,
            );
          }
        }
        await copy.save();
        return copy;
      },
    ),

    setDefaultEmailSignatureV2: requireWrite("signatures")(
      async (_, { id }, ctx) => {
        const doc = await findOwned(id, ctx);
        await EmailSignatureV2.updateMany(
          { ...scope(ctx), _id: { $ne: doc._id }, isDefault: true },
          { $set: { isDefault: false } },
        );
        doc.isDefault = true;
        await doc.save();
        return doc;
      },
    ),

    uploadEmailSignatureV2Image: requireWrite("signatures")(
      async (_, { id, kind, file }, ctx) => {
        const doc = await findOwned(id, ctx);
        const { buffer } = await readUpload(file);
        let stored;
        try {
          stored = await storeSignatureImage({
            buffer,
            kind,
            userId: ctx.user.id,
            signatureId: doc._id,
            options:
              kind === "PHOTO" ? { size: doc.style?.photoSize || 84 } : {},
          });
        } catch (error) {
          throw createValidationError(error.message || "Image illisible");
        }
        doc.images[kind.toLowerCase()] = stored;
        doc.markModified("images");
        await doc.save();
        return doc;
      },
    ),

    removeEmailSignatureV2Image: requireWrite("signatures")(
      async (_, { id, kind }, ctx) => {
        const doc = await findOwned(id, ctx);
        const field = kind.toLowerCase();
        if (doc.images?.[field]) {
          const type = {
            PHOTO: "imgProfil",
            LOGO: "logoReseau",
            BANNER: "banner",
          }[kind];
          try {
            await cloudflareService.deleteSignatureFolder(
              String(ctx.user.id),
              String(doc._id),
              type,
            );
          } catch (error) {
            logger.warn(
              `[signatures v2] suppression ${kind} ignorée : ${error.message}`,
            );
          }
          doc.images[field] = null;
          doc.markModified("images");
          await doc.save();
        }
        return doc;
      },
    ),
  },
};

export default emailSignatureV2Resolvers;
