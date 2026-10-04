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
  companyLogoKey,
  ensureIcons,
  ensureRoundPhoto,
  ensureSamplePhoto,
  ImageInputError,
  importCompanyLogo,
  importSignatureImage,
  roundPhotoUrl,
  storeSignatureImage,
} from "../services/signatureAssets.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  isWorkspaceMember,
  listWorkspaceMembers,
  memberSignatureProfile,
  photoImportUrls,
  workspaceLogoUrl,
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

const plain = (value) =>
  value && typeof value.toObject === "function"
    ? value.toObject()
    : value
      ? JSON.parse(JSON.stringify(value))
      : {};

/**
 * Photo de profil importée et recadrée comme un envoi : en grand d'abord
 * (photo Google en 512 px), puis à son adresse d'origine. null si aucune
 * ne répond : la signature reste utilisable sans photo.
 */
async function importPersonPhoto(doc, url, ctx) {
  for (const candidate of photoImportUrls(url)) {
    try {
      return await importSignatureImage({
        url: candidate,
        kind: "PHOTO",
        userId: ctx.user.id,
        signatureId: doc._id,
      });
    } catch (error) {
      logger.warn(
        `[signatures v2] photo de profil non importée : ${error.message}`,
      );
    }
  }
  return null;
}

/**
 * Logo de l'entreprise (celui des factures) repris dans une nouvelle
 * signature. null si l'entreprise n'en a pas ou s'il ne peut pas être
 * repris : la case reste vide, comme avant.
 */
async function importWorkspaceLogo(doc, url, ctx) {
  if (!url) return null;
  try {
    return await importCompanyLogo({
      url,
      userId: ctx.user.id,
      signatureId: doc._id,
    });
  } catch (error) {
    logger.warn(
      `[signatures v2] logo de l'entreprise non repris : ${error.message}`,
    );
    return null;
  }
}

/**
 * Photo de la personne de la signature : importée, ou retirée si la
 * personne n'en a pas ou si l'import échoue (jamais le visage de la
 * personne précédente). Un échec ne bloque jamais l'enregistrement.
 * Retirée, la photo reste en ligne pour les e-mails déjà envoyés.
 */
async function setPersonPhoto(doc, url, ctx) {
  const photo = url ? await importPersonPhoto(doc, url, ctx) : null;
  if (!photo && !doc.images?.photo) return;
  doc.images.photo = photo;
  // La photo seule : une autre image envoyée entre-temps reste en base
  doc.markModified("images.photo");
  await doc.save();
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
 * Photo ronde (ou arrondie) déjà détourée pour le HTML à copier : Outlook
 * bureau ignore border-radius, et Gmail retire au collage le VML prévu pour
 * lui. Attente bornée comme pour les icônes (`waitMs`, Infinity pour
 * l'e-mail de test) ; tant que la variante n'existe pas, le rendu garde
 * l'arrondi CSS et le VML. Renvoie l'option `roundPhoto` du rendu.
 */
async function roundPhotoSoon(data, waitMs = 3000) {
  const photo = data.images?.photo;
  if (!photo?.key) return null;
  // Forme, taille et contour réellement rendus (le modèle peut les borner)
  const specs = new Map();
  renderSignature(data, {
    roundPhoto: (spec) => {
      specs.set(JSON.stringify(spec), spec);
      return null;
    },
  });
  if (specs.size === 0) return null;
  const work = Promise.all(
    [...specs.values()].map((spec) => ensureRoundPhoto(photo, spec)),
  );
  await (Number.isFinite(waitMs)
    ? Promise.race([
        work,
        new Promise((resolve) => setTimeout(resolve, waitMs)),
      ])
    : work);
  return (spec) => roundPhotoUrl(photo, spec);
}

/**
 * Rendu propre (à copier) + rendu d'aperçu, dont chaque élément porte
 * l'identifiant du champ qui le pilote, pour l'éditeur.
 */
function withPreview(data, roundPhoto = null) {
  const result = renderSignature(data, { roundPhoto });
  return {
    ...result,
    previewHtml: renderSignature(data, { markers: true }).html,
  };
}

/**
 * Rendu de secours d'une signature dont le rendu a échoué : vide, avec un
 * avertissement, et les dimensions par défaut des traits.
 */
function failedRender() {
  return {
    html: "",
    previewHtml: "",
    text: "",
    chars: 0,
    warnings: [
      "L'aperçu de cette signature n'a pas pu être affiché. Réessayez dans un instant.",
    ],
    elements: {},
    lines: {
      accentLength: 40,
      accentThickness: 3,
      dividerThickness: 1,
      frameThickness: 1,
      photoMax: 160,
      iconMax: 40,
    },
  };
}

async function readUpload(file) {
  const { createReadStream, filename, mimetype } = await file;
  // Photo HEIC sans type reconnu par le système (navigateur sous Windows) :
  // envoyée en application/octet-stream, c'est son contenu qui décide
  const heic = /\.hei[cf]$/i.test(filename || "");
  if (!heic && (!mimetype || !mimetype.startsWith("image/"))) {
    throw createValidationError(
      "Le fichier doit être une image (JPG, PNG ou WebP)",
    );
  }
  const chunks = [];
  for await (const chunk of createReadStream()) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), filename, mimetype };
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
    // Champ non nul : une exception remonterait jusqu'à la liste entière,
    // qui s'afficherait vide. Une signature en échec garde un rendu vide.
    render: async (doc) => {
      try {
        const data = plain(doc);
        const [, roundPhoto] = await Promise.all([
          ensureIconsSoon(data),
          roundPhotoSoon(data),
        ]);
        return withPreview(data, roundPhoto);
      } catch (error) {
        logger.error(
          `[signatures v2] rendu impossible (${String(doc._id ?? doc.id)}) : ${error.message}`,
        );
        return failedRender();
      }
    },
  },

  Query: {
    emailSignaturesV2: requireRead("signatures")(async (_, __, ctx) =>
      EmailSignatureV2.find(scope(ctx)).sort({ isDefault: -1, updatedAt: -1 }),
    ),

    emailSignatureV2: requireRead("signatures")(async (_, { id }, ctx) =>
      EmailSignatureV2.findOne({ _id: id, ...scope(ctx) }),
    ),

    emailSignatureTemplatesV2: requireRead("signatures")(async (_, __, ctx) =>
      EmailSignatureTemplateV2.find(templateScope(ctx))
        .sort({ updatedAt: -1 })
        .lean(),
    ),

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
        // Sert aussi au bouton Copier : la photo détourée y est attendue
        const [, roundPhoto] = await Promise.all([
          ensureIconsSoon(data),
          roundPhotoSoon(data),
        ]);
        return withPreview(data, roundPhoto);
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
        // Les icônes et la photo détourée doivent exister avant l'envoi
        // (générées à la demande) : l'e-mail montre ce que verront les
        // destinataires, Outlook bureau compris
        const specs = requiredIcons(data);
        const [, roundPhoto] = await Promise.all([
          specs.length > 0
            ? ensureIcons(specs).catch((error) =>
                logger.warn(`[signatures v2] ensureIcons : ${error.message}`),
              )
            : null,
          roundPhotoSoon(data, Infinity),
        ]);
        const { html, text } = renderSignature(data, { roundPhoto });
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
          ...scope(ctx),
        });
        applyNormalized(doc, normalized);
        await doc.save();
        // Photo de la personne et logo de l'entreprise (celui des factures),
        // importés en parallèle (5 s au plus chacun) puis enregistrés en une
        // fois ; un échec laisse simplement la case vide
        const [photo, logo] = await Promise.all([
          person.profile.photoUrl
            ? importPersonPhoto(doc, person.profile.photoUrl, ctx)
            : null,
          importWorkspaceLogo(doc, person.profile.logoUrl, ctx),
        ]);
        if (photo || logo) {
          if (photo) doc.images.photo = photo;
          if (logo) doc.images.logo = logo;
          doc.markModified("images");
          await doc.save();
        }
        return doc;
      },
    ),

    // « Utiliser le logo de l'entreprise » : relu côté serveur dans
    // l'espace, jamais une adresse envoyée par le navigateur
    applyCompanyLogoToEmailSignatureV2: requireWrite("signatures")(
      async (_, { id }, ctx) => {
        const doc = await findOwned(id, ctx);
        const url = await workspaceLogoUrl(ctx.workspaceId);
        if (!url) {
          throw createValidationError(
            "Aucun logo d'entreprise : ajoutez-le dans Paramètres, Générale.",
          );
        }
        if (!companyLogoKey(url)) {
          throw createValidationError(
            "Le logo de l'entreprise ne peut pas être repris : envoyez-le depuis votre ordinateur.",
          );
        }
        let logo;
        try {
          logo = await importCompanyLogo({
            url,
            userId: ctx.user.id,
            signatureId: doc._id,
          });
        } catch (error) {
          if (error instanceof ImageInputError) {
            logger.warn(
              `[signatures v2] logo de l'entreprise refusé : ${error.message}${
                error.cause?.message ? ` [${error.cause.message}]` : ""
              }`,
            );
            throw createValidationError(error.message);
          }
          logger.error(
            `[signatures v2] logo de l'entreprise non repris : ${error.message}`,
          );
          throw createInternalServerError(
            "Le logo de l'entreprise n'a pas pu être repris. Réessayez dans un instant.",
          );
        }
        doc.images.logo = logo;
        // Le logo seul : le document a été lu avant la reprise (plusieurs
        // secondes), une autre image envoyée entre-temps reste en base
        doc.markModified("images.logo");
        await doc.save();
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
        await doc.save();
        return doc;
      },
    ),

    // Les images restent en ligne : la signature, si elle est installée dans
    // une messagerie, continue de s'afficher (comme les e-mails envoyés).
    // Elles partent avec le compte.
    deleteEmailSignatureV2: requireDelete("signatures")(
      async (_, { id }, ctx) => {
        const doc = await findOwned(id, ctx);
        const wasDefault = doc.isDefault;
        await doc.deleteOne();
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
        return EmailSignatureTemplateV2.findOneAndUpdate(
          { ...templateScope(ctx), createdBy: ctx.user.id, name },
          { $set: { templateId, style } },
          { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
        );
      },
    ),

    deleteEmailSignatureTemplateV2: requireDelete("signatures")(
      async (_, { id }, ctx) => {
        const { deletedCount } = await EmailSignatureTemplateV2.deleteOne({
          _id: id,
          ...templateScope(ctx),
          createdBy: ctx.user.id,
        });
        if (!deletedCount) throw createNotFoundError("Modèle");
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
        const { buffer, filename, mimetype } = await readUpload(file);
        let stored;
        try {
          stored = await storeSignatureImage({
            buffer,
            kind,
            userId: ctx.user.id,
            signatureId: doc._id,
          });
        } catch (error) {
          const upload = `${kind}, ${mimetype || "type inconnu"}, « ${filename || "sans nom"} », ${buffer.length} octets`;
          // Image refusée : message pour l'utilisateur, détail en journal
          if (error instanceof ImageInputError) {
            logger.warn(
              `[signatures v2] image refusée (${upload}) : ${error.message}${
                error.cause?.message ? ` [${error.cause.message}]` : ""
              }`,
            );
            throw createValidationError(error.message);
          }
          // Panne de stockage (R2, réseau) : un incident, pas un refus
          logger.error(
            `[signatures v2] image non enregistrée (${upload}) : ${error.message}`,
          );
          throw createInternalServerError(
            "L'image n'a pas pu être enregistrée. Réessayez dans un instant.",
          );
        }
        doc.images[kind.toLowerCase()] = stored;
        // Cette image seule : le document a été lu avant l'envoi (plusieurs
        // secondes), une autre image envoyée entre-temps ne doit pas être
        // remise à son ancienne valeur
        doc.markModified(`images.${kind.toLowerCase()}`);
        await doc.save();
        return doc;
      },
    ),

    // Image détachée de la signature, fichier gardé : la signature déjà
    // installée et les e-mails déjà envoyés continuent de l'afficher
    removeEmailSignatureV2Image: requireWrite("signatures")(
      async (_, { id, kind }, ctx) => {
        const doc = await findOwned(id, ctx);
        const field = kind.toLowerCase();
        if (doc.images?.[field]) {
          doc.images[field] = null;
          doc.markModified(`images.${field}`);
          await doc.save();
        }
        return doc;
      },
    ),
  },
};

export default emailSignatureV2Resolvers;
