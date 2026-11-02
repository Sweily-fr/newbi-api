import { getActiveOrganizationCached } from "../middlewares/org-cache.js";
import logger from "./logger.js";

/**
 * Souscription d'un membre à un espace (kanban, documents partagés) :
 * l'appartenance est vérifiée à l'ouverture, puis avant chaque événement.
 * Un membre retiré de l'espace ne reçoit plus rien : la souscription se
 * termine. L'appartenance est lue par le cache des espaces (60 s au plus).
 *
 * @param {AsyncIterator} iterator itérateur du canal de l'espace
 * @param {{ user: Object, workspaceId: string }} options
 */
export function endWhenMemberRemoved(iterator, { user, workspaceId }) {
  const userId = user?._id?.toString() || (user?.id ? String(user.id) : null);
  let ended = false;

  const finish = async () => {
    ended = true;
    if (typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch (error) {
        logger.warn(
          `[Souscription] Fermeture impossible : ${error?.message || error}`,
        );
      }
    }
    return { value: undefined, done: true };
  };

  const stillMember = async () => {
    if (!userId || !workspaceId) return false;
    try {
      return Boolean(
        await getActiveOrganizationCached(userId, String(workspaceId)),
      );
    } catch (error) {
      // Base injoignable : l'appartenance vérifiée à l'ouverture vaut encore,
      // l'événement est transmis
      logger.warn(
        `[Souscription] Appartenance non vérifiée : ${error?.message || error}`,
      );
      return null;
    }
  };

  const wrapped = {
    async next() {
      if (!ended) {
        const result = await iterator.next();
        if (result.done) {
          ended = true;
          return result;
        }
        if ((await stillMember()) === false) return finish();
        return result;
      }
      return { value: undefined, done: true };
    },
    return(value) {
      ended = true;
      return typeof iterator.return === "function"
        ? iterator.return(value)
        : Promise.resolve({ value, done: true });
    },
    throw(error) {
      ended = true;
      return typeof iterator.throw === "function"
        ? iterator.throw(error)
        : Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return wrapped;
}
