import mongoose from "mongoose";

/**
 * Accès d'un membre aux événements du calendrier d'un espace.
 *
 * Un événement privé n'appartient qu'à son auteur ; une échéance de facture
 * ou un avoir (client et montant dans le titre) ne se voit qu'avec « Voir »
 * sur la page du document. Les mêmes règles valent pour lire, modifier,
 * supprimer et envoyer un événement vers un agenda externe.
 */

// Événements créés depuis un document : visibles seulement avec « Voir »
// sur la page du document
export const DOCUMENT_EVENT_MODULES = {
  INVOICE_DUE: "invoices",
  CREDIT_NOTE_CREATED: "creditNotes",
};

export function hiddenDocumentEventTypes(permissions) {
  return Object.entries(DOCUMENT_EVENT_MODULES)
    .filter(([, moduleKey]) => !permissions?.hasPermission?.(moduleKey, "view"))
    .map(([type]) => type);
}

/**
 * Filtre Mongo d'un événement de l'espace que ce membre a le droit de voir :
 * événement de l'espace, ou événement privé dont il est l'auteur, hors types
 * cachés par son rôle. Un événement hors de ce filtre est « introuvable ».
 */
export function accessibleEventFilter({
  id,
  workspaceId,
  userId,
  permissions,
}) {
  const filter = {
    _id: id,
    workspaceId,
    $or: [
      { visibility: { $in: ["workspace", null] } },
      { visibility: "private", userId },
    ],
  };
  const hidden = hiddenDocumentEventTypes(permissions);
  if (hidden.length > 0) filter.type = { $nin: hidden };
  return filter;
}

const toObjectIdOrNull = (value) => {
  try {
    return mongoose.Types.ObjectId.isValid(value)
      ? new mongoose.Types.ObjectId(String(value))
      : null;
  } catch {
    return null;
  }
};

/**
 * Identifiants (chaînes) des utilisateurs membres de l'espace, dans l'ordre
 * reçu, sans doublon : les autres ids sont écartés (collection `member` de
 * Better Auth).
 */
export async function keepWorkspaceMemberIds(userIds, workspaceId) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const orgId = toObjectIdOrNull(workspaceId);
  const objectIds = ids.map(toObjectIdOrNull).filter(Boolean);
  if (!orgId || objectIds.length === 0) return [];
  const members = await mongoose.connection.db
    .collection("member")
    .find(
      { organizationId: orgId, userId: { $in: objectIds } },
      { projection: { userId: 1 } },
    )
    .toArray();
  const memberIds = new Set(members.map((m) => String(m.userId)));
  return ids.filter((id) => memberIds.has(id));
}
