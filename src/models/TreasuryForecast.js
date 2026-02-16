import mongoose from "mongoose";

const FORECAST_TYPE = {
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
};

const FORECAST_CATEGORY = {
  // Income categories
  SALES: "SALES",
  REFUNDS_RECEIVED: "REFUNDS_RECEIVED",
  OTHER_INCOME: "OTHER_INCOME",
  // Expense categories (aligned with PurchaseInvoice categories)
  RENT: "RENT",
  SUBSCRIPTIONS: "SUBSCRIPTIONS",
  OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
  SERVICES: "SERVICES",
  TRANSPORT: "TRANSPORT",
  MEALS: "MEALS",
  TELECOMMUNICATIONS: "TELECOMMUNICATIONS",
  INSURANCE: "INSURANCE",
  ENERGY: "ENERGY",
  SOFTWARE: "SOFTWARE",
  HARDWARE: "HARDWARE",
  MARKETING: "MARKETING",
  TRAINING: "TRAINING",
  MAINTENANCE: "MAINTENANCE",
  TAXES: "TAXES",
  UTILITIES: "UTILITIES",
  SALARIES: "SALARIES",
  OTHER_EXPENSE: "OTHER_EXPENSE",
};

const treasuryForecastSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    month: {
      type: String,
      required: [true, "Le mois est requis (format YYYY-MM)"],
      match: [/^\d{4}-\d{2}$/, "Le format du mois doit être YYYY-MM"],
    },
    category: {
      type: String,
      required: true,
      enum: Object.values(FORECAST_CATEGORY),
    },
    type: {
      type: String,
      required: true,
      enum: Object.values(FORECAST_TYPE),
    },
    forecastAmount: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Le montant prévisionnel doit être positif"],
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Unique compound index: one forecast per workspace + month + category
treasuryForecastSchema.index(
  { workspaceId: 1, month: 1, category: 1 },
  { unique: true }
);

treasuryForecastSchema.statics.FORECAST_TYPE = FORECAST_TYPE;
treasuryForecastSchema.statics.FORECAST_CATEGORY = FORECAST_CATEGORY;

const TreasuryForecast = mongoose.model("TreasuryForecast", treasuryForecastSchema);
export default TreasuryForecast;
