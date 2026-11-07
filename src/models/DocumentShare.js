import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

/**
 * Lien client d'un dossier des documents partagés : une URL publique, sans
 * compte, qui donne accès en lecture au dossier et à ses sous-dossiers.
 * Le contenu n'est pas copié : il est relu à chaque visite (voir
 * services/documentShareAccess.js).
 */
const documentShareSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    folderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SharedFolder",
      required: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    passwordHash: { type: String, default: null },
    stats: {
      totalViews: { type: Number, default: 0 },
      totalDownloads: { type: Number, default: 0 },
      lastViewedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

documentShareSchema.index({ workspaceId: 1, folderId: 1 });

documentShareSchema.statics.generateToken = function () {
  return crypto.randomBytes(32).toString("hex");
};

documentShareSchema.methods.setPassword = async function (plainPassword) {
  this.passwordHash = plainPassword
    ? await bcrypt.hash(plainPassword, BCRYPT_COST)
    : null;
};

documentShareSchema.methods.verifyPassword = async function (plainPassword) {
  if (!plainPassword || !this.passwordHash) return false;
  return bcrypt.compare(plainPassword, this.passwordHash);
};

documentShareSchema.methods.isValid = function () {
  if (!this.isActive) return false;
  return !(this.expiresAt && new Date() > this.expiresAt);
};

export default mongoose.model("DocumentShare", documentShareSchema);
