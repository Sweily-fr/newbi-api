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
