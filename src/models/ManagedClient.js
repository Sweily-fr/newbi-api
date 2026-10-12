import mongoose from "mongoose";

/**
 * Lien entre un gestionnaire (AccountManager) et l'espace d'un client.
 *
 * C'est cette fiche qui dit qui paie l'abonnement du client : le client
 * lui-même (par défaut) ou le gestionnaire. Le client ne peut pas retirer
 * son gestionnaire seul : la fin du lien passe par Newbi.
 *
 * Elle sert aussi d'invitation quand le cabinet invite un client qui a
 * déjà un compte (statut « pending », sans espace) : le client choisit le
 * ou les espaces confiés en acceptant. L'invitation devient la fiche du
 * premier espace ; chaque autre espace a sa fiche, avec `invitationId`.
 * Écrite par le site (NewbiV2, src/lib/managed-client-invitations.js).
 */
const managedClientSchema = new mongoose.Schema(
  {
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountManager",
      required: true,
      index: true,
    },
    // Espace du client (collection Better Auth `organization`) ; vide tant
    // qu'une invitation n'est pas acceptée
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    payer: {
      type: String,
      enum: ["client", "manager"],
      default: "client",
    },
    status: {
      type: String,
      enum: ["pending", "active", "declined", "canceled", "ended"],
      default: "active",
    },
    // Invitation d'un client existant
    invitationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    invitedEmail: { type: String, default: null },
    invitedUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    requestedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    // Preuve de l'accord du client (RGPD : accord écrit préalable)
    consent: {
      acceptedAt: Date,
      acceptedByUserId: mongoose.Schema.Types.ObjectId,
      ip: String,
      userAgent: String,
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
