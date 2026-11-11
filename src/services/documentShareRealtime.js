/**
 * Temps réel de la page d'un visiteur (accès client des documents partagés),
 * comme la page publique d'un tableau kanban : la page reste ouverte et se
 * met à jour quand un document arrive, part ou change de dossier, ou quand
 * le propriétaire modifie l'accès.
 *
 * Le flux ne transporte aucun contenu : seulement « quelque chose a changé »
 * (CHANGED) ou « votre accès est fermé » (CLOSED). La page relit alors son
 * contenu par la route publique, qui applique les droits du visiteur.
 */
import { getPubSub } from "../config/redis.js";
import logger from "../utils/logger.js";

// Canal des documents partagés de l'espace, suivi aussi par les membres
// (publishSharedDocsChanged, resolvers/sharedDocument.js)
const SHARED_DOCUMENTS_CHANGED = "SHARED_DOCUMENTS_CHANGED";
// Modifications d'un accès par son propriétaire (dossiers, visiteurs, état)
const DOCUMENT_SHARE_CHANGED = "DOCUMENT_SHARE_CHANGED";

/** Canaux suivis par la page d'un visiteur. */
export const visitorChannels = (share) => [
  `${SHARED_DOCUMENTS_CHANGED}_${share.workspaceId}`,
  `${DOCUMENT_SHARE_CHANGED}_${share._id}`,
];

/** Le propriétaire a modifié l'accès : les pages ouvertes se relisent. */
export function publishDocumentShareChanged(shareId) {
  if (!shareId) return;
  try {
    getPubSub()
      .publish(`${DOCUMENT_SHARE_CHANGED}_${shareId}`, {
        shareId: String(shareId),
      })
      .catch(() => {});
  } catch {
    // PubSub indisponible : le temps réel est facultatif
  }
}

/**
 * Événements d'un visiteur. Avant chaque envoi, l'accès est relu : s'il
 * n'est plus permis (lien désactivé, expiré, dossiers fermés, visiteur
 * retiré, mot de passe changé), un dernier CLOSED part et le flux s'arrête.
 *
 * @param {AsyncIterator} iterator itérateur PubSub des canaux du visiteur
 * @param {() => Promise<boolean>} isAllowed
 */
export function visitorChangeStream(iterator, isAllowed) {
  let ended = false;
  const close = async () => {
    ended = true;
    try {
      await iterator.return?.();
    } catch (error) {
      logger.warn(`[Accès client] Fermeture du flux : ${error.message}`);
    }
  };

  return {
    async next() {
      if (ended) return { done: true, value: undefined };
      const result = await iterator.next();
      if (result.done) {
        ended = true;
        return result;
      }
      let allowed = true;
      try {
        allowed = await isAllowed();
      } catch (error) {
        // Base injoignable : rien n'est transmis d'autre qu'un signal, la
        // page relit par la route publique qui refera le contrôle
        logger.warn(`[Accès client] Contrôle du flux : ${error.message}`);
      }
      if (!allowed) {
        await close();
        return { done: false, value: { type: "CLOSED" } };
      }
      return { done: false, value: { type: "CHANGED" } };
    },
    async return(value) {
      await close();
      return { done: true, value };
    },
    async throw(error) {
      await close();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
