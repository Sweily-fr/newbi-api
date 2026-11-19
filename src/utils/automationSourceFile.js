/**
 * Justificatif copié par une automatisation des documents partagés (facture
 * d'achat, transaction) : le premier fichier joint qui se télécharge.
 *
 * Avant, seul le premier fichier joint était lu. Quand il avait disparu du
 * stockage (404) alors qu'un autre justificatif existait, la copie échouait.
 * Signalé le 19/11/2026 sur une facture d'achat à deux justificatifs.
 *
 * Fichier à part (pas dans documentAutomationService) : plusieurs tests
 * remplacent ce service par un objet partiel, un nouvel export y casserait
 * leurs imports.
 */
import axios from "axios";

const NO_SOURCE_FILE = "NO_SOURCE_FILE";

/**
 * Le document n'a aucun fichier joint : rien à copier. Ce n'est pas un échec
 * de l'automatisation, le lancement le compte « sans fichier joint ».
 */
export class NoSourceFileError extends Error {
  constructor(message = "Aucun fichier joint") {
    super(message);
    this.name = "NoSourceFileError";
    this.code = NO_SOURCE_FILE;
  }
}

export function isNoSourceFileError(error) {
  return error?.code === NO_SOURCE_FILE;
}

/**
 * Fichiers joints d'un document, dans leur ordre d'ajout.
 * @param {string} documentType
 * @param {object} doc document chargé (objet complet ou lean)
 * @returns {object[]}
 */
export function sourceFilesOf(documentType, doc) {
  if (!doc) return [];
  if (documentType === "transaction") return doc.receiptFiles || [];
  if (documentType === "purchaseInvoice") return doc.files || [];
  if (documentType === "importedInvoice" || documentType === "importedQuote")
    return doc.file ? [doc.file] : [];
  return [];
}

/**
 * Télécharge le premier fichier lisible, dans l'ordre. Un fichier introuvable
 * ou vide passe au suivant.
 * @param {object[]} files fichiers joints (chacun avec `url`)
 * @param {{ emptyMessage?: string, get?: Function }} [options]
 *   emptyMessage : message de NoSourceFileError quand aucun fichier n'a d'URL
 * @returns {Promise<{ file: object, buffer: Buffer }>}
 */
export async function downloadFirstAvailableFile(
  files,
  { emptyMessage, get = axios.get } = {},
) {
  const candidates = (files || []).filter((file) => file?.url);
  if (candidates.length === 0) throw new NoSourceFileError(emptyMessage);

  let lastError = null;
  for (const file of candidates) {
    try {
      const response = await get(file.url, {
        responseType: "arraybuffer",
        timeout: 30000,
      });
      const buffer = Buffer.from(response.data);
      if (buffer.length > 0) return { file, buffer };
      lastError = new Error("Le fichier source est vide");
    } catch (error) {
      lastError = error;
    }
  }

  const status = lastError?.response?.status;
  if (status === 404 || status === 403) {
    throw new Error(
      candidates.length > 1
        ? "Aucun des fichiers joints n'est disponible dans le stockage"
        : "Le fichier joint n'est plus disponible dans le stockage",
    );
  }
  if (lastError?.response || lastError?.code) {
    throw new Error(`Erreur récupération fichier: ${lastError.message}`);
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Tous les justificatifs d'un document (demande du 19/11/2026)
//
// Une facture d'achat ou une transaction peut porter plusieurs justificatifs.
// La copie principale (premier justificatif lisible) reste gérée par le
// journal des automatisations ; les autres justificatifs DIFFÉRENTS sont
// copiés à côté, dans le même dossier. Un même PDF déposé plusieurs fois
// (même nom, même taille) n'est copié qu'une fois.
// ---------------------------------------------------------------------------

/** Types dont les justificatifs sont des fichiers déposés (pas un PDF généré) */
export const MULTI_FILE_TYPES = ["purchaseInvoice", "transaction"];

const baseName = (value) =>
  String(value || "")
    .split(/[\\/]/)
    .pop()
    .trim()
    .toLowerCase();

/**
 * Empreinte d'un justificatif : nom d'origine + taille. Deux dépôts du même
 * PDF ont la même empreinte ; sans taille connue, l'URL distingue le fichier.
 * @param {object} file fichier joint (files[] ou receiptFiles[])
 * @returns {string}
 */
export function fileSignature(file) {
  const name = baseName(
    file?.originalFilename || file?.originalFileName || file?.filename,
  );
  const size = file?.size ?? file?.fileSize;
  if (name && size !== undefined && size !== null) return `${name}|${size}`;
  return `url|${file?.url || ""}`;
}

/** Empreinte reconstituée d'une copie ancienne (sans empreinte enregistrée) */
function copySignature(copy) {
  return `${baseName(copy?.originalName || copy?.name)}|${copy?.fileSize}`;
}

/**
 * Justificatifs différents d'un document, dans leur ordre d'ajout.
 * @param {object[]} files
 * @returns {object[]}
 */
export function distinctSourceFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files || []) {
    if (!file?.url) continue;
    const signature = fileSignature(file);
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(file);
  }
  return out;
}

/**
 * Justificatifs à copier en plus de ce qui est déjà dans le dossier.
 *
 * - Copie marquée de son empreinte : le justificatif correspondant est
 *   couvert ; partie à la corbeille, elle est restaurée (comme la copie
 *   principale à la relance).
 * - Copie plus ancienne, sans empreinte : elle couvre le justificatif de même
 *   nom et de même taille, sinon le premier justificatif non couvert (c'était
 *   le seul copié jusque-là).
 * - Aucune copie de ce document dans le dossier : rien, la copie principale
 *   s'en charge d'abord.
 *
 * @param {object[]} files justificatifs différents (distinctSourceFiles)
 * @param {object[]} copies copies du document dans le dossier
 *   ({ _id, name, originalName, fileSize, sourceFileSignature, trashedAt })
 * @returns {{ toCopy: object[], restore: Array }} restore : ids de copies
 */
export function planExtraCopies(files, copies) {
  const live = (copies || []).filter((copy) => !copy.trashedAt);
  if (live.length === 0 || (files || []).length === 0) {
    return { toCopy: [], restore: [] };
  }
  const wanted = new Set(files.map(fileSignature));
  const covered = new Set();

  for (const copy of live) {
    if (copy.sourceFileSignature) covered.add(copy.sourceFileSignature);
  }
  const unmatched = [];
  for (const copy of live) {
    if (copy.sourceFileSignature) continue;
    const signature = copySignature(copy);
    if (wanted.has(signature) && !covered.has(signature)) {
      covered.add(signature);
    } else {
      unmatched.push(copy);
    }
  }
  for (let i = 0; i < unmatched.length; i += 1) {
    const next = files.find((file) => !covered.has(fileSignature(file)));
    if (!next) break;
    covered.add(fileSignature(next));
  }

  const restore = [];
  for (const copy of copies || []) {
    const signature = copy.sourceFileSignature;
    if (!copy.trashedAt || !signature || covered.has(signature)) continue;
    if (!wanted.has(signature)) continue;
    covered.add(signature);
    restore.push(copy._id);
  }

  return {
    toCopy: files.filter((file) => !covered.has(fileSignature(file))),
    restore,
  };
}
