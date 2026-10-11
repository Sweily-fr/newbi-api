import mongoose from "mongoose";

/**
 * Code à usage unique envoyé par e-mail à un visiteur d'un tableau partagé,
 * pour prouver son adresse avant de recevoir une session visiteur.
 * Un code par adresse et par lien de partage ; seule son empreinte (HMAC)
 * est stockée. Supprimé à l'expiration (index TTL), à l'usage ou après trop
 * d'essais.
 */
const boardVisitorCodeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    shareId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PublicBoardShare",
      required: true,
    },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

boardVisitorCodeSchema.index({ email: 1, shareId: 1 }, { unique: true });
boardVisitorCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const BoardVisitorCode = mongoose.model(
  "BoardVisitorCode",
  boardVisitorCodeSchema,
);

export default BoardVisitorCode;
