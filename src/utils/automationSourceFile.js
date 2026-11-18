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
