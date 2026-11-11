import mongoose from "mongoose";

/**
 * Où en est la génération de prospects d'un espace pour une combinaison de
 * critères. Chaque page de résultats coûte un crédit : relancer avec les
 * mêmes critères reprend à la page suivante au lieu de repayer des pages
 * dont les entreprises sont déjà dans les contacts.
 *
 * - nextPage : prochaine page à lire (retour à la page 1 après la dernière).
 * - pending : entreprises déjà lues et payées mais pas encore utilisées (la
 *   page en contenait plus que demandé, ou la vérification au registre n'a
 *   pas répondu) : utilisées en premier la fois suivante, sans crédit.
 *
 * Oubliée après 30 jours sans génération (les résultats ont pu changer).
 */
const prospectSearchCursorSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Empreinte des critères (activités, zones ou rayon, taille, dates au mois, contact)
    key: {
      type: String,
      required: true,
    },
    nextPage: {
      type: Number,
      default: 1,
      min: 1,
    },
    totalPages: {
      type: Number,
      default: null,
    },
    pending: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

prospectSearchCursorSchema.index(
  { workspaceId: 1, key: 1 },
  { unique: true, name: "prospect_cursor_per_workspace_criteria" },
);
prospectSearchCursorSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600, name: "prospect_cursor_ttl" },
);

export default mongoose.model(
  "ProspectSearchCursor",
  prospectSearchCursorSchema,
);
