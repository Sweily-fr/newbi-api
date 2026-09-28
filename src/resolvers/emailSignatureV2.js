/**
 * Resolvers des signatures de mail v2.
 *
 * Périmètre : une signature appartient à un utilisateur dans un espace de
 * travail (createdBy + workspaceId). Le HTML est toujours produit par
 * services/signatureRenderer ; ces resolvers ne font que stocker les
 * données, garantir les icônes sur R2 et traiter les images.
 */

import EmailSignatureV2 from "../models/EmailSignatureV2.js";
import {
  requireDelete,
  requireRead,
  requireWrite,
} from "../middlewares/rbac.js";
import {
  createAlreadyExistsError,
  createNotFoundError,
  createValidationError,
} from "../utils/errors.js";
import logger from "../utils/logger.js";
import {
  listTemplates,
  normalizeSignature,
  renderSignature,
  requiredIcons,
  SAMPLE_SIGNATURE,
} from "../services/signatureRenderer/index.js";
import {
  FONT_FAMILIES,
  FONT_LABELS,
  GMAIL_MAX_CHARS,
  SOCIAL_NETWORKS,
} from "../services/signatureRenderer/constants.js";
import {
  deleteSignatureImages,
  ensureIcons,
  storeSignatureImage,
} from "../services/signatureAssets.js";
import cloudflareService from "../services/cloudflareService.js";

const scope = (ctx) => ({
  createdBy: ctx.user.id,
  workspaceId: ctx.workspaceId,
});

const plain = (value) =>
  value && typeof value.toObject === "function"
    ? value.toObject()
    : value
      ? JSON.parse(JSON.stringify(value))
      : {};

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

const emailSignatureV2Resolvers = {
  EmailSignatureV2: {
    id: (doc) => String(doc._id ?? doc.id),
    images: (doc) => ({
      photo: doc.images?.photo || null,
      logo: doc.images?.logo || null,
      banner: doc.images?.banner || null,
    }),
    social: (doc) => doc.social || [],
    render: async (doc) => {
      const data = plain(doc);
      await ensureIconsSoon(data);
      return renderSignature(data);
    },
  },

  Query: {
    emailSignaturesV2: requireRead("signatures")(async (_, __, ctx) =>
      EmailSignatureV2.find(scope(ctx)).sort({ isDefault: -1, updatedAt: -1 }),
    ),

    emailSignatureV2: requireRead("signatures")(async (_, { id }, ctx) =>
      EmailSignatureV2.findOne({ _id: id, ...scope(ctx) }),
    ),

    signatureCatalogV2: requireRead("signatures")(async () => ({
      templates: listTemplates(),
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
        return renderSignature(data);
      },
    ),

    renderSignatureTemplateV2: requireRead("signatures")(
      async (_, { templateId, style }) => {
        const data = { ...SAMPLE_SIGNATURE, templateId, style: style || {} };
        await ensureIconsSoon(data);
        return renderSignature(data);
      },
    ),
  },

  Mutation: {
    createEmailSignatureV2: requireWrite("signatures")(
      async (_, { input }, ctx) => {
        const name = await availableName(input?.name, ctx);
        const isFirst = !(await EmailSignatureV2.exists(scope(ctx)));
        const normalized = mergeInput(
          { images: { photo: null, logo: null, banner: null } },
          input || {},
        );
        const doc = new EmailSignatureV2({
          name,
          isDefault: isFirst,
          ...scope(ctx),
        });
        applyNormalized(doc, normalized);
        await doc.save();
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
