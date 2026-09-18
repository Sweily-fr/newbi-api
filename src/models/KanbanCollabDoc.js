import mongoose from "mongoose";

// Document Yjs d'un champ collaboratif de tâche kanban (description).
// `state` = état Yjs encodé (Y.encodeStateAsUpdate), `htmlHash` = empreinte du
// HTML dérivé au dernier enregistrement : si `task.description` ne correspond
// plus (modification hors collab, ex. app mobile), le document est reconstruit
// depuis le HTML à l'ouverture suivante.
const kanbanCollabDocSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    field: { type: String, required: true, default: "description" },
    state: { type: Buffer, required: true },
    htmlHash: { type: String, required: true },
    lastEditedBy: { type: String },
  },
  { timestamps: true, collection: "kanban_collab_docs" },
);

export default mongoose.model("KanbanCollabDoc", kanbanCollabDocSchema);
