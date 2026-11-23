/**
 * Fichiers qu'un client peut déposer par son accès (documents partagés).
 *
 * Le visiteur n'a pas de compte : le type annoncé par son navigateur n'est
 * pas cru. Le type retenu vient de l'extension, et le contenu doit lui
 * correspondre (premiers octets). Mêmes familles que l'envoi d'un membre :
 * PDF, images, Word, Excel, CSV, texte et vidéos.
 */
import { detectFileType } from "./fileSignature.js";

const MB = 1024 * 1024;
export const CLIENT_UPLOAD_MAX_BYTES = 50 * MB;
export const CLIENT_VIDEO_MAX_BYTES = 100 * MB;
const NAME_MAX_LENGTH = 200;

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
// Premiers atomes d'une vidéo MP4 ou QuickTime
const ISO_MEDIA_ATOMS = new Set([
  "ftyp",
  "moov",
  "mdat",
  "wide",
  "free",
  "skip",
]);

const startsWith = (bytes) => (buffer) =>
  buffer.length >= bytes.length && bytes.every((byte, i) => buffer[i] === byte);
const detectedAs =
  (...mimes) =>
  (buffer) =>
    mimes.includes(detectFileType(buffer)?.mime);
const isIsoMedia = (buffer) =>
  buffer.length >= 8 && ISO_MEDIA_ATOMS.has(buffer.toString("latin1", 4, 8));
const isAvi = (buffer) =>
  buffer.length >= 12 &&
  buffer.toString("latin1", 0, 4) === "RIFF" &&
  buffer.toString("latin1", 8, 12) === "AVI ";
// Texte : aucun octet nul au début (un exécutable ou une archive en a)
const isText = (buffer) => !buffer.subarray(0, 8192).includes(0);

const image = (mime, ...accepted) => ({
  mime,
  check: detectedAs(mime, ...accepted),
});
const video = (mime, check) => ({ mime, check, video: true });

const TYPES = {
  pdf: { mime: "application/pdf", check: detectedAs("application/pdf") },
  png: image("image/png"),
  jpg: image("image/jpeg"),
  jpeg: image("image/jpeg"),
  gif: image("image/gif"),
  webp: image("image/webp"),
  heic: image("image/heic", "image/heif"),
  heif: image("image/heif", "image/heic"),
  doc: { mime: "application/msword", check: startsWith(OLE) },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    check: startsWith(ZIP),
  },
  xls: { mime: "application/vnd.ms-excel", check: startsWith(OLE) },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    check: startsWith(ZIP),
  },
  csv: { mime: "text/csv", check: isText },
  txt: { mime: "text/plain", check: isText },
  mp4: video("video/mp4", isIsoMedia),
  mov: video("video/quicktime", isIsoMedia),
  webm: video("video/webm", startsWith(EBML)),
  mkv: video("video/x-matroska", startsWith(EBML)),
  avi: video("video/x-msvideo", isAvi),
};

export const CLIENT_UPLOAD_EXTENSIONS = Object.keys(TYPES);

const extensionOf = (filename) =>
  /\.([a-z0-9]+)$/i.exec(String(filename || ""))?.[1]?.toLowerCase() || "";

/**
 * Nom du fichier reçu, rendu sûr : Multer lit le nom en Latin-1, un nom
 * accentué envoyé en UTF-8 est donc relu ; ni chemin, ni caractère de
 * contrôle, longueur bornée (extension gardée).
 */
export function cleanUploadedName(rawName) {
  let name = String(rawName || "");
  const asUtf8 = Buffer.from(name, "latin1").toString("utf8");
  if (!asUtf8.includes("\uFFFD") && asUtf8 !== name) name = asUtf8;
  name = name
    .split(/[/\\]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (name.length > NAME_MAX_LENGTH) {
    const ext = extensionOf(name);
    const keep = ext ? NAME_MAX_LENGTH - ext.length - 1 : NAME_MAX_LENGTH;
    name = `${name.slice(0, keep)}${ext ? `.${ext}` : ""}`;
  }
  return name || "document";
}

/**
 * Extension du fichier d'un document (sans point, en minuscules), celle
 * retenue au dépôt, sinon celle de son nom.
 */
export const documentExtension = (document) =>
  String(document?.fileExtension || "").toLowerCase() ||
  extensionOf(document?.originalName) ||
  extensionOf(document?.name);

/** `name` sans l'extension `extension` s'il la porte (casse ignorée). */
export function withoutExtension(name, extension) {
  const text = String(name ?? "");
  const suffix = extension ? `.${String(extension).toLowerCase()}` : "";
  return suffix && text.toLowerCase().endsWith(suffix)
    ? text.slice(0, -suffix.length)
    : text;
}

/**
 * Nom qu'un client donne à l'un de ses documents : ni caractère de
 * contrôle, ni séparateur de chemin (« Relevé 03/2026 » devient
 * « Relevé 03-2026 »), ni point ou espace final, longueur bornée, et
 * l'extension du fichier toujours gardée : « Relevé mars » comme
 * « Relevé mars.PDF » donnent « Relevé mars.pdf ».
 *
 * @param {string} rawName nom saisi, ou nom actuel du document
 * @param {string} extension extension du fichier (gardée)
 * @param {string} [typedExtension] extension retirée du nom s'il la porte :
 *   celle du fichier remplacé quand une nouvelle version change de format
 * @returns {string|null} null si rien ne reste du nom
 */
export function clientDocumentName(
  rawName,
  extension,
  typedExtension = extension,
) {
  const ext = String(extension || "").toLowerCase();
  const trimEnd = (value) => value.replace(/[.\s]+$/, "");
  let stem = String(rawName ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  stem = trimEnd(withoutExtension(stem, typedExtension).trim());
  const max = ext ? NAME_MAX_LENGTH - ext.length - 1 : NAME_MAX_LENGTH;
  stem = trimEnd(stem.slice(0, max)).trim();
  if (!stem) return null;
  return ext ? `${stem}.${ext}` : stem;
}

export const FOLDER_NAME_MAX_LENGTH = 120;

/**
 * Nom qu'un client donne à un dossier (nouveau dossier, dossier de son
 * ordinateur qu'il importe, renommage) : ni caractère de contrôle, ni
 * séparateur de chemin (« 2025/2026 » devient « 2025-2026 »), espaces
 * resserrés, ni point ni espace final, longueur bornée.
 *
 * @param {unknown} rawName
 * @returns {string|null} null si ce n'est pas un texte ou si rien n'en reste
 */
export function clientFolderName(rawName) {
  if (typeof rawName !== "string") return null;
  const name = rawName
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FOLDER_NAME_MAX_LENGTH)
    .replace(/[.\s]+$/, "");
  return name || null;
}

/**
 * @param {{ filename: string, buffer: Buffer }} file
 * @returns {{ ok: true, mime: string, extension: string }
 *   | { ok: false, status: number, message: string }}
 */
export function checkClientUpload({ filename, buffer }) {
  const extension = extensionOf(filename);
  const type = TYPES[extension];
  if (!type) {
    return {
      ok: false,
      status: 415,
      message:
        "Type de fichier non accepté. Formats acceptés : PDF, images, Word, Excel, CSV, texte et vidéos.",
    };
  }
  if (!buffer?.length) {
    return { ok: false, status: 400, message: "Le fichier est vide." };
  }
  const max = type.video ? CLIENT_VIDEO_MAX_BYTES : CLIENT_UPLOAD_MAX_BYTES;
  if (buffer.length > max) {
    return {
      ok: false,
      status: 413,
      message: `Fichier trop volumineux (${max / MB} Mo maximum).`,
    };
  }
  if (!type.check(buffer)) {
    return {
      ok: false,
      status: 415,
      message: "Le contenu du fichier ne correspond pas à son extension.",
    };
  }
  return { ok: true, mime: type.mime, extension };
}
