import Client from "../models/Client.js";

/**
 * Résout la fiche client à jour d'un document (brouillon) en batchant via le
 * DataLoader `clientById` du contexte quand il est disponible — évite le N+1
 * lors de l'affichage d'une liste de brouillons.
 *
 * 🔐 Le DataLoader `clientById` ne filtre PAS par workspace : on vérifie donc
 * explicitement l'appartenance après chargement, afin de ne jamais renvoyer la
 * fiche client d'une autre organisation (même garantie que Client.findOne({_id, workspaceId})).
 *
 * @param {object} context - contexte GraphQL (peut contenir context.loaders.clientById)
 * @param {string} clientId
 * @param {string|object} workspaceId - workspace du document parent
 * @returns {Promise<object|null>} le document Client si autorisé, sinon null
 */
export async function loadWorkspaceClient(context, clientId, workspaceId) {
  if (!clientId || !workspaceId) return null;
  const loader = context?.loaders?.clientById;
  if (loader) {
    const client = await loader.load(clientId);
    if (client && String(client.workspaceId) === String(workspaceId)) {
      return client;
    }
    return null;
  }
  // Repli sans loader (hors requête GraphQL) : requête directe scopée.
  return Client.findOne({ _id: clientId, workspaceId });
}
