import mongoose from "mongoose";

/**
 * Espace de stockage utilisé par un espace (organisation) : cache du calcul
 * fait à partir des fichiers rattachés à l'espace. Nouvelle collection,
 * calculée par l'application (aucune donnée existante n'est modifiée).
 *
 * - `totalBytes`, `byCategory`, `byUser` : résultat du dernier recalcul
 *   complet, ajusté ensuite à chaque envoi et suppression ;
 * - `stale` : une suppression dont la taille est inconnue a eu lieu, le
 *   prochain passage refait le calcul complet ;
 * - `packs` : packs de stockage actifs, écrits par le site quand il modifie
 *   l'abonnement Stripe (source : l'abonnement Stripe) ;
 * - `alertLevel` : dernier seuil notifié (0, 80, 100).
 */
const workspaceStorageUsageSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true, unique: true, index: true },
    totalBytes: { type: Number, default: 0 },
    byCategory: { type: mongoose.Schema.Types.Mixed, default: {} },
    byUser: { type: mongoose.Schema.Types.Mixed, default: {} },
    fileCount: { type: Number, default: 0 },
    // Objets dont la taille n'a pas pu être lue (R2 injoignable)
    unknownSizeCount: { type: Number, default: 0 },
    computedAt: { type: Date, default: null },
    // Calcul complet en cours sur une instance (verrou avec échéance)
    computingUntil: { type: Date, default: null },
    stale: { type: Boolean, default: false },
    // Version du calcul : un changement de version force un recalcul
    version: { type: Number, default: 0 },
    alertLevel: { type: Number, default: 0 },
    packs: {
      quantity: { type: Number, default: 0 },
      interval: { type: String, default: null },
      updatedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, collection: "workspace_storage_usage", minimize: false },
);

export default mongoose.models.WorkspaceStorageUsage ||
  mongoose.model("WorkspaceStorageUsage", workspaceStorageUsageSchema);
