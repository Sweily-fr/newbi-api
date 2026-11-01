import { userHasWorkspaceAction } from "./workspace-membership.js";

/**
 * Documents liés renvoyés par les champs d'un devis, d'un bon de commande ou
 * d'un bon de livraison (factures, devis d'origine, bons créés depuis le
 * devis) : chacun suit « Voir » de sa propre page, comme les requêtes de
 * cette page. Un rôle limité aux bons de livraison ne lit ainsi ni les prix
 * du devis d'origine ni les factures.
 *
 * Les résolveurs de champ reçoivent le contexte de la requête (pas celui
 * enrichi par le RBAC) : le droit est relu une fois par page et par requête,
 * puis gardé dans ce contexte.
 *
 * @param {object} context - contexte GraphQL (utilisateur connecté)
 * @param {string|object} workspaceId - espace du document parent
 * @param {string} moduleKey - page du document lié (invoices, quotes…)
 * @returns {Promise<boolean>}
 */
export function canViewLinkedPage(context, workspaceId, moduleKey) {
  const userId = context?.user?._id ?? context?.user?.id;
  if (!userId || !workspaceId) return Promise.resolve(false);
  if (!context.linkedPageAccess) context.linkedPageAccess = new Map();
  const key = `${String(workspaceId)}:${moduleKey}`;
  if (!context.linkedPageAccess.has(key)) {
    context.linkedPageAccess.set(
      key,
      userHasWorkspaceAction(String(userId), String(workspaceId), moduleKey, "view"),
    );
  }
  return context.linkedPageAccess.get(key);
}
