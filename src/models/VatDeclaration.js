import mongoose from "mongoose";

/**
 * Déclaration de TVA confirmée par l'espace : l'utilisateur a reporté les
 * montants sur impots.gouv.fr puis l'a indiqué dans Newbi. Newbi ne transmet
 * rien à l'administration. Les montants sont figés au moment de la
 * confirmation : ils restent ceux qui ont été déclarés, même si une facture
 * de la période change ensuite.
 */
const vatDeclarationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    // « 2026-10 », « 2026-T4 » ou « CA12-2026-12-31 »
    periodKey: { type: String, required: true },
    form: { type: String, enum: ["CA3", "CA12"], required: true },
    periodStart: { type: String, required: true },
    periodEnd: { type: String, required: true },
    vatMode: { type: String, required: true },
    totals: { type: mongoose.Schema.Types.Mixed, required: true },
    sections: { type: mongoose.Schema.Types.Mixed, required: true },
    adjustments: { type: mongoose.Schema.Types.Mixed, default: {} },
    isNil: { type: Boolean, default: false },
    // Crédit reporté sur la déclaration suivante (ligne 27)
    creditToCarry: { type: Number, default: 0 },
    declaredBy: { type: String, required: true },
    declaredByName: { type: String, default: "" },
    declaredAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "vat_declarations" },
);

vatDeclarationSchema.index({ workspaceId: 1, periodKey: 1 }, { unique: true });
vatDeclarationSchema.index({ workspaceId: 1, periodEnd: -1 });

export default mongoose.models.VatDeclaration ||
  mongoose.model("VatDeclaration", vatDeclarationSchema);
