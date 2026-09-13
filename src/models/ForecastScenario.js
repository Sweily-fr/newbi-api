import mongoose from "mongoose";

const forecastScenarioSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, "Le nom du scénario est requis"],
      trim: true,
      maxlength: 60,
    },
    incomeMultiplier: {
      type: Number,
      required: true,
      default: 1.0,
      min: [0, "Le multiplicateur doit être positif"],
      max: [5, "Le multiplicateur ne peut pas dépasser 5"],
    },
    expenseMultiplier: {
      type: Number,
      required: true,
      default: 1.0,
      min: [0, "Le multiplicateur doit être positif"],
      max: [5, "Le multiplicateur ne peut pas dépasser 5"],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // ─── Calque du scénario sur les données de Base ───
    // Un scénario ne copie pas les données : il enregistre seulement ce qui
    // diffère de Base. Rien de ce qui est fait dans un scénario ne modifie
    // Base ni les autres scénarios (cf. utils/forecastScenarioOverlay.js).
    //
    // Récurrences détectées masquées (isMuted=true) ou réactivées
    // (isMuted=false) dans ce scénario uniquement.
    recurrenceOverrides: {
      type: [
        {
          _id: false,
          recurrenceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "DetectedRecurrence",
            required: true,
          },
          isMuted: { type: Boolean, required: true },
        },
      ],
      default: [],
    },
    // Saisies manuelles de Base masquées dans ce scénario.
    hiddenManualEntryIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId }],
      default: [],
    },
    // Occurrences (un mois d'une prévision récurrente) supprimées dans ce
    // scénario uniquement. kind: MANUAL | DETECTED, month: YYYY-MM.
    excludedOccurrences: {
      type: [
        {
          _id: false,
          kind: { type: String, enum: ["MANUAL", "DETECTED"], required: true },
          entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
          month: { type: String, required: true },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

forecastScenarioSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

const ForecastScenario = mongoose.model(
  "ForecastScenario",
  forecastScenarioSchema,
);
export default ForecastScenario;
