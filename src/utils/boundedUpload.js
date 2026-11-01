/**
 * Lecture d'un fichier envoyé (graphql-upload) avec une taille maximale :
 * la lecture s'arrête dès que la limite est dépassée, sans garder le reste
 * du fichier en mémoire.
 */

/** Taille maximale d'un justificatif (factures d'achat, transactions, OCR). */
export const MAX_RECEIPT_FILE_BYTES = 10 * 1024 * 1024;

/** Nombre maximal de justificatifs envoyés en une fois. */
export const MAX_RECEIPT_FILES = 20;

/**
 * @param {() => import("stream").Readable} createReadStream
 * @param {number} maxBytes
 * @returns {Promise<{ buffer: Buffer|null, size: number, tooLarge: boolean }>}
 */
export async function readUploadBounded(createReadStream, maxBytes) {
  const stream = createReadStream();
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      return { buffer: null, size, tooLarge: true };
    }
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), size, tooLarge: false };
}
