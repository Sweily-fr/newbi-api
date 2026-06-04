/**
 * Modèle pour les tags des documents partagés
 *
 * Registre de tags par workspace : permet de mémoriser les tags posés sur les
 * documents pour les re-proposer (autocomplétion) sur d'autres documents, et de
 * les gérer globalement (renommage / changement de couleur / suppression
 * propagés sur tous les documents).
 *
 * Le nom et la couleur sont les seules données persistées ici ; le nombre
 * d'utilisations (usageCount) est calculé à la lecture par agrégation sur les
 * documents pour éviter toute dérive de compteur.
 */

import mongoose from "mongoose";

// Palette par défaut (alignée sur les couleurs des dossiers, cf.
// DEFAULT_SHARED_FOLDERS côté frontend)
export const SHARED_TAG_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // rose
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#10b981", // emerald
  "#ef4444", // red
];

/**
 * Choisit une couleur de palette de façon déterministe à partir du nom du tag,
 * pour qu'un même tag retombe toujours sur la même couleur par défaut.
 */
export function getDefaultTagColor(name = "") {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return SHARED_TAG_COLORS[hash % SHARED_TAG_COLORS.length];
}

const SharedTagSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // Couleur par défaut statique : la couleur "intelligente" (déterministe par
    // nom) est calculée explicitement dans le code via getDefaultTagColor().
    // Un default fonction référençant `this.name` casse sur les upserts
    // (this n'est pas un document → lecture de `name` sur null).
    color: {
      type: String,
      default: SHARED_TAG_COLORS[0],
    },
  },
  {
    timestamps: true,
  },
);

// Un tag = un nom unique par workspace
SharedTagSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

const SharedTag = mongoose.model("SharedTag", SharedTagSchema);

export default SharedTag;
