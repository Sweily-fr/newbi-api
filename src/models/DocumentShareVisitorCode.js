import mongoose from "mongoose";

/**
 * Code de vérification de l'adresse d'un visiteur d'un accès client. Seule
 * l'empreinte du code est stockée. Supprimé à l'expiration (index TTL), à
 * l'usage ou après trop d'essais.
 */
const documentShareVisitorCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    shareId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DocumentShare",
      required: true,
    },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

documentShareVisitorCodeSchema.index(
  { email: 1, shareId: 1 },
  { unique: true },
);
documentShareVisitorCodeSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 },
);

export default mongoose.model(
  "DocumentShareVisitorCode",
  documentShareVisitorCodeSchema,
);
