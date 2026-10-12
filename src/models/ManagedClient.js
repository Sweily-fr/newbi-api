import mongoose from "mongoose";

/**
 * Lien entre un gestionnaire (AccountManager) et l'espace d'un client.
 *
 * C'est cette fiche qui dit qui paie l'abonnement du client : le client
 * lui-même (par défaut) ou le gestionnaire. Le client ne peut pas retirer
 * son gestionnaire seul : la fin du lien passe par Newbi.
 */
const managedClientSchema = new mongoose.Schema(
  {
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountManager",
      required: true,
      index: true,
    },
    // Espace du client (collection Better Auth `organization`)
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    payer: {
      type: String,
      enum: ["client", "manager"],
      default: "client",
    },
    status: {
      type: String,
      enum: ["active", "ended"],
      default: "active",
    },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    endedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// Un seul gestionnaire actif par espace client
managedClientSchema.index(
  { organizationId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);

const ManagedClient = mongoose.model("ManagedClient", managedClientSchema);

export default ManagedClient;
