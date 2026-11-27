import mongoose from "mongoose";

/**
 * Crédit bancaire (transaction synchronisée par Bridge) déjà utilisé pour
 * régler un paiement par virement : transfert, rendez-vous ou inscription.
 * L'index unique garantit qu'un même crédit ne règle jamais deux choses,
 * même si deux synchronisations tournent en même temps.
 */
const bankCreditClaimSchema = new mongoose.Schema(
  {
    workspaceId: { type: String, required: true },
    // Identifiant de la transaction chez le prestataire bancaire
    transactionId: { type: String, required: true },
    // file_transfer | appointment_booking | event_registration
    targetKind: { type: String, required: true },
    targetId: { type: String, required: true },
    reference: { type: String, default: null },
  },
  { timestamps: true, collection: "bank_credit_claims" },
);

bankCreditClaimSchema.index(
  { workspaceId: 1, transactionId: 1 },
  { unique: true },
);

export default mongoose.models.BankCreditClaim ||
  mongoose.model("BankCreditClaim", bankCreditClaimSchema);
