// Outils des modifications atomiques des listes d'une tâche kanban (membres
// assignés, tags, checklist). Les mutations dédiées (assignTaskMember,
// addTaskTag, updateChecklistItem…) modifient un seul élément par opération
// ($addToSet, $pull, opérateur positionnel) : deux personnes qui modifient la
// même tâche en même temps ne s'écrasent plus, là où updateTask remplace le
// tableau complet (dernier qui écrit gagne).
import mongoose from "mongoose";

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export const isObjectIdString = (value) =>
  typeof value === "string" && OBJECT_ID_PATTERN.test(value);

/**
 * Identifiant de membre normalisé (chaîne non vide) ou null.
 */
export const normalizeMemberId = (value) => {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id.length > 0 ? id : null;
};

/**
 * Tag nettoyé pour l'enregistrement (mêmes champs que TagInput).
 */
export const normalizeTag = (tag) => ({
  name: String(tag?.name || "").trim(),
  className: tag?.className || "",
  bg: tag?.bg || "",
  text: tag?.text || "",
  border: tag?.border || "",
});

// Forme stockée dans l'activité (même format que updateTask : le front
// affiche les pastilles avec ces couleurs)
export const tagActivityValue = (tag) => [
  { name: tag.name, bg: tag.bg, text: tag.text, border: tag.border },
];

/**
 * Checklist reçue en bloc (updateTask, apps en store) : conserve l'_id des
 * éléments existants pour que les modifications atomiques des autres
 * personnes (qui ciblent un élément par son id) continuent de le trouver.
 * Mongoose ignore le champ `id` envoyé par le client et régénérait tous les
 * _id à chaque enregistrement.
 *
 * 1. id connu de la tâche → conservé ;
 * 2. sinon (ancien client sans id, id temporaire « temp-… », uuid) →
 *    _id d'un élément existant de même texte pas encore repris ;
 * 3. sinon → nouvel élément (Mongoose génère l'_id).
 *
 * @param {Array<{id?: string, _id?: any, text: string, completed?: boolean}>} incoming
 * @param {Array<{_id?: any, text?: string}>} existing
 */
export const preserveChecklistIds = (incoming, existing) => {
  const existingItems = (existing || []).filter((item) => item && item._id);
  const byId = new Map(existingItems.map((item) => [String(item._id), item]));
  const used = new Set();

  const result = (incoming || []).map((item) => {
    const candidate = item?.id ?? item?._id;
    const key = candidate ? String(candidate) : null;
    const known = key && byId.has(key) && !used.has(key) ? key : null;
    if (known) used.add(known);
    return {
      knownId: known,
      text: item?.text ?? "",
      completed: Boolean(item?.completed),
    };
  });

  return result.map(({ knownId, text, completed }) => {
    if (knownId) {
      return { _id: byId.get(knownId)._id, text, completed };
    }
    const sameText = existingItems.find(
      (item) => !used.has(String(item._id)) && (item.text ?? "") === text,
    );
    if (sameText) {
      used.add(String(sameText._id));
      return { _id: sameText._id, text, completed };
    }
    return { text, completed };
  });
};

/**
 * Identifiant d'élément de checklist proposé par le client (ObjectId en
 * hexadécimal, généré localement pour un affichage immédiat). Renvoie un
 * ObjectId, ou null s'il est absent ; lève si le format est invalide.
 */
export const parseChecklistItemId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (!isObjectIdString(String(value))) {
    throw new Error("Identifiant d'élément de checklist invalide");
  }
  return new mongoose.Types.ObjectId(String(value));
};
