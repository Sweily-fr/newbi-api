import heicConvert from "heic-convert";
import sharp from "sharp";

/**
 * Images des produits du catalogue.
 *
 * Stockées dans le bucket public des images d'entreprise (celui des logos)
 * sous `{workspaceId}/products/`, puis recopiées sur les lignes des documents
 * (facture, devis, BC, avoir, BL) pour figurer sur l'aperçu et le PDF.
 */

export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Côté le plus long : assez pour un PDF net, léger pour les aperçus
const PRODUCT_IMAGE_MAX_SIDE = 800;
const PRODUCT_IMAGE_URL_MAX_LENGTH = 500;

const ACCEPTED_MIMETYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

const isHeicFile = (filename = "", mimetype = "") =>
  ["image/heic", "image/heif"].includes(mimetype) ||
  /\.hei[cf]$/i.test(filename);

export const isAcceptedProductImage = (filename = "", mimetype = "") =>
  ACCEPTED_MIMETYPES.includes(mimetype) ||
  /\.(jpe?g|png|webp|hei[cf])$/i.test(filename);

/**
 * Normalise l'image envoyée : orientation EXIF appliquée, redimensionnée
 * (jamais agrandie) et convertie en WebP. Les photos HEIC d'iPhone passent
 * d'abord par heic-convert, que sharp ne sait pas lire.
 */
export async function processProductImage(buffer, { filename, mimetype }) {
  let input = buffer;
  if (isHeicFile(filename, mimetype)) {
    input = Buffer.from(await heicConvert({ buffer, format: "PNG" }));
  }

  return sharp(input)
    .rotate()
    .resize(PRODUCT_IMAGE_MAX_SIDE, PRODUCT_IMAGE_MAX_SIDE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 85 })
    .toBuffer();
}

/**
 * Une URL d'image produit n'est acceptée que si elle pointe vers nos images
 * de produits sur R2 : le PDF est rendu côté serveur, on n'y charge jamais
 * une URL arbitraire. Le domaine configuré fait foi, les domaines publics R2
 * (`*.r2.dev`) restent acceptés pour qu'un changement de domaine ne fasse
 * pas perdre les images des documents existants.
 */
export function isAllowedProductImageUrl(url) {
  if (typeof url !== "string" || !url) return false;
  if (url.length > PRODUCT_IMAGE_URL_MAX_LENGTH) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (!/^\/[^/]+\/products\/[^/]+$/.test(parsed.pathname)) return false;

  const configured = process.env.COMPANY_IMAGE_URL;
  if (configured) {
    try {
      if (parsed.host === new URL(configured).host) return true;
    } catch {
      // URL configurée invalide : on retombe sur les domaines R2
    }
  }
  return parsed.hostname.endsWith(".r2.dev");
}

/**
 * Setter Mongoose : une URL non autorisée est retirée plutôt que de faire
 * échouer l'enregistrement du document entier.
 */
export const sanitizeProductImageUrl = (value) =>
  isAllowedProductImageUrl(value) ? value : undefined;

/**
 * Champ `imageUrl` partagé par le produit et les lignes de documents.
 */
export const productImageUrlField = {
  type: String,
  trim: true,
  set: sanitizeProductImageUrl,
};
