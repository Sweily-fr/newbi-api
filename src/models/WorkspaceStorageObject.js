import mongoose from "mongoose";

/**
 * Registre des fichiers envoyés vers R2 depuis la mise en place du compteur
 * de stockage, et tailles lues sur R2 (HEAD) pour les fichiers anciens dont
 * la base ne garde pas la taille. Nouvelle collection : sert de mémoire des
 * tailles pour le recalcul, sans toucher aux documents existants.
 */
const workspaceStorageObjectSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    workspaceId: { type: String, index: true, default: null },
    bucket: { type: String, default: null },
    size: { type: Number, default: 0 },
    category: { type: String, default: null },
    uploadedBy: { type: String, default: null },
    // "upload" : enregistré à l'envoi ; "head" : taille lue sur R2
    source: { type: String, default: "upload" },
  },
  { timestamps: true, collection: "workspace_storage_objects" },
);

export default mongoose.models.WorkspaceStorageObject ||
  mongoose.model("WorkspaceStorageObject", workspaceStorageObjectSchema);
