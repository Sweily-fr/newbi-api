import mongoose from "mongoose";
import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Verrou court partagé entre les processus de l'API (PM2 en cluster) : une
 * seule opération à la fois pour une même clé, par exemple les avoirs d'une
 * facture. Sans lui, deux avoirs créés au même instant lisaient le même
 * montant restant et dépassaient ensemble le montant de la facture.
 *
 * Le verrou est un document de la collection `document_locks` (_id = clé),
 * posé par une insertion (refusée tant qu'un autre le tient) et retiré à la
 * fin. Il expire de lui-même après `ttlMs` si le processus qui le tenait
 * s'arrête : le suivant le reprend.
 */

const COLLECTION = "document_locks";
const WAIT_STEP_MS = 25;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exécute `fn` en tenant le verrou `key`. Attend au plus `waitMs` qu'un
 * autre appel le libère, puis refuse avec un message.
 * @param {string} key - clé du verrou (ex. "creditNotes:<id facture>")
 * @param {Function} fn - opération à exécuter seule
 * @param {{ ttlMs?: number, waitMs?: number }} [options]
 */
export async function withDocumentLock(
  key,
  fn,
  { ttlMs = 30_000, waitMs = 15_000 } = {},
) {
  const locks = mongoose.connection.collection(COLLECTION);
  const owner = new mongoose.Types.ObjectId().toString();
  const deadline = Date.now() + waitMs;

  for (;;) {
    const now = new Date();
    try {
      // Absent : inséré (upsert). Expiré : repris. Tenu : l'insertion de
      // la même clé échoue (E11000).
      await locks.updateOne(
        { _id: key, expiresAt: { $lte: now } },
        { $set: { owner, expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: true },
      );
      break;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (Date.now() >= deadline) {
        throw new AppError(
          "Une autre opération est en cours sur ce document. Réessayez dans un instant.",
          ERROR_CODES.RESOURCE_LOCKED,
          { reason: "DOCUMENT_BUSY" },
        );
      }
      await sleep(WAIT_STEP_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await locks.deleteOne({ _id: key, owner }).catch(() => {});
  }
}
