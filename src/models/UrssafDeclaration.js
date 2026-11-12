import mongoose from "mongoose";

/**
 * Déclaration de chiffre d'affaires d'un micro-entrepreneur confirmée par
 * l'espace : l'utilisateur a reporté les montants sur
 * autoentrepreneur.urssaf.fr puis l'a indiqué dans Newbi. Newbi ne transmet
 * rien à l'Urssaf. Les montants sont figés au moment de la confirmation : ils
 * restent ceux qui ont été déclarés, même si une facture de la période change
 * ensuite.
 */
const urssafDeclarationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    // « 2026-10 » ou « 2026-T4 »
    periodKey: { type: String, required: true },
    periodStart: { type: String, required: true },
    periodEnd: { type: String, required: true },
    periodLabel: { type: String, required: true },
    dueDate: { type: String, required: true },
    // Chiffre d'affaires par case du formulaire, cotisations estimées et
    // situation retenue (taux, ACRE, versement libératoire)
    totals: { type: mongoose.Schema.Types.Mixed, required: true },
    sections: { type: mongoose.Schema.Types.Mixed, required: true },
    adjustments: { type: mongoose.Schema.Types.Mixed, default: {} },
    situation: { type: mongoose.Schema.Types.Mixed, default: {} },
    isNil: { type: Boolean, default: false },
    declaredBy: { type: String, required: true },
    declaredByName: { type: String, default: "" },
    declaredAt: { type: Date, required: true },
  },
  { timestamps: true, collection: "urssaf_declarations" },
);

urssafDeclarationSchema.index(
  { workspaceId: 1, periodKey: 1 },
  { unique: true },
);
urssafDeclarationSchema.index({ workspaceId: 1, periodEnd: -1 });

export default mongoose.models.UrssafDeclaration ||
  mongoose.model("UrssafDeclaration", urssafDeclarationSchema);
