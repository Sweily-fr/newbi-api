import mongoose from "mongoose";

/**
 * Image téléversée pour un post (déjà normalisée en JPEG et déposée chez le
 * fournisseur). Un post n'accepte que des médias téléversés par son espace :
 * jamais d'adresse libre venue du client.
 */
const socialPostMediaSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    provider: { type: String, default: "zernio" },
    url: { type: String, required: true },
    key: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    contentType: { type: String, default: "image/jpeg" },
    size: { type: Number, default: null },
  },
  { timestamps: true },
);

const SocialPostMedia =
  mongoose.models.SocialPostMedia ||
  mongoose.model("SocialPostMedia", socialPostMediaSchema);

export default SocialPostMedia;
