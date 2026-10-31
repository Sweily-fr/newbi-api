/**
 * Type réel d'un fichier, établi d'après ses premiers octets.
 *
 * Le nom et le type annoncés par le client (ou enregistrés dans R2 d'après
 * l'extension) ne disent rien du contenu : un fichier nommé « facture.svg »
 * peut être annoncé en application/pdf. Les routes qui servent un fichier
 * d'utilisateur et les envois de justificatifs se fient à ce type-ci.
 */

const ISO_BMFF_BRANDS = {
  heic: { mime: "image/heic", ext: ".heic" },
  heix: { mime: "image/heic", ext: ".heic" },
  hevc: { mime: "image/heic", ext: ".heic" },
  hevx: { mime: "image/heic", ext: ".heic" },
  heim: { mime: "image/heic", ext: ".heic" },
  heis: { mime: "image/heic", ext: ".heic" },
  mif1: { mime: "image/heif", ext: ".heif" },
  msf1: { mime: "image/heif", ext: ".heif" },
  avif: { mime: "image/avif", ext: ".avif" },
  avis: { mime: "image/avif", ext: ".avif" },
};

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{ mime: string, ext: string } | null} null si le contenu n'est
 *   ni un PDF ni une image matricielle reconnue (SVG, HTML, XML, texte…)
 */
export function detectFileType(input) {
  if (!input || !input.length) return null;
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const ascii = (start, end) => buffer.subarray(start, end).toString("latin1");

  // PDF : la signature peut suivre quelques octets parasites (tolérance des
  // lecteurs PDF, déjà appliquée par documentAnnex)
  if (buffer.subarray(0, 1024).indexOf("%PDF-") !== -1) {
    return { mime: "application/pdf", ext: ".pdf" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: ".png" };
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  const gif = ascii(0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") {
    return { mime: "image/gif", ext: ".gif" };
  }
  if (
    buffer.length >= 12 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: ".webp" };
  }
  if (buffer.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ISO_BMFF_BRANDS[ascii(8, 12)];
    if (brand) return brand;
  }
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x2a &&
      buffer[3] === 0x00) ||
      (buffer[0] === 0x4d &&
        buffer[1] === 0x4d &&
        buffer[2] === 0x00 &&
        buffer[3] === 0x2a))
  ) {
    return { mime: "image/tiff", ext: ".tiff" };
  }
  return null;
}

// Formats que le navigateur peut afficher sans rien exécuter
export const INLINE_FILE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// Formats en plus, servis en ligne par l'aperçu des documents partagés
// (lecteurs audio et vidéo, texte brut) : aucun ne s'exécute dans la page.
export const SHARED_PREVIEW_EXTRA_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/aac",
  "text/plain",
]);

/**
 * En-têtes d'un fichier d'utilisateur servi pour l'aperçu, d'après un type
 * déjà établi.
 *
 * Seuls les types de la liste blanche sont servis en ligne. Tout le reste
 * part en téléchargement (application/octet-stream). Les réponses autres que
 * PDF portent une CSP sandbox : rien ne s'y exécute, même ouvertes
 * directement dans un onglet. Le PDF n'en a pas : la visionneuse intégrée de
 * Chrome refuse un document sandboxé, et un PDF ne s'exécute jamais sur
 * l'origine qui le sert.
 *
 * @param {object} params
 * @param {string|null} params.contentType type établi (sans paramètres)
 * @param {string} params.filename nom affiché au téléchargement
 * @param {string} [params.frameAncestors] origines autorisées à l'intégrer
 * @param {Set<string>} [params.extraInlineTypes] types en ligne en plus
 * @returns {Record<string, string>}
 */
export function filePreviewHeaders({
  contentType,
  filename,
  frameAncestors,
  extraInlineTypes,
}) {
  const type = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const inline =
    INLINE_FILE_TYPES.has(type) || Boolean(extraInlineTypes?.has(type));
  let servedType = inline ? type : "application/octet-stream";
  if (servedType === "text/plain") servedType = "text/plain; charset=utf-8";

  const rawName = String(filename || "fichier");
  // Le header n'accepte que du Latin-1 : repli ASCII + variante UTF-8
  // (RFC 5987)
  const asciiName =
    rawName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "") || "fichier";

  const ancestors = frameAncestors ? `frame-ancestors ${frameAncestors}` : "";
  const policy =
    servedType === "application/pdf"
      ? ancestors
      : [
          "sandbox",
          "default-src 'none'",
          "img-src 'self' data:",
          "media-src 'self'",
          "style-src 'unsafe-inline'",
          ancestors,
        ]
          .filter(Boolean)
          .join("; ");

  const headers = {
    "Content-Type": servedType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`,
    "X-Content-Type-Options": "nosniff",
  };
  if (policy) headers["Content-Security-Policy"] = policy;
  return headers;
}

/**
 * En-têtes d'un fichier d'utilisateur dont le contenu est en mémoire : le
 * type servi est celui des premiers octets, jamais le type annoncé.
 *
 * @param {object} params
 * @param {Buffer} params.buffer contenu du fichier
 * @param {string} params.filename nom affiché au téléchargement
 * @param {string} [params.frameAncestors] origines autorisées à l'intégrer
 * @returns {Record<string, string>}
 */
export function safeFileHeaders({ buffer, filename, frameAncestors }) {
  return filePreviewHeaders({
    contentType: detectFileType(buffer)?.mime || null,
    filename,
    frameAncestors,
  });
}

/**
 * Nom donné au fichier stocké : extension du type réel, à la place de celle
 * choisie par le client (le type R2 est déduit de l'extension).
 *
 * @param {string} filename nom d'origine
 * @param {string} ext extension établie (« .pdf », « .png »…)
 */
export function storedFileName(filename, ext) {
  const base = String(filename || "fichier").replace(/\.[^./\\]*$/, "");
  return `${base || "fichier"}${ext}`;
}
