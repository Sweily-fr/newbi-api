import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

// Visiteur identifié (adresse prouvée par un code reçu par e-mail)
const visitorSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    firstName: { type: String, trim: true, default: "" },
    lastName: { type: String, trim: true, default: "" },
    firstVisitAt: { type: Date, default: Date.now },
    lastVisitAt: { type: Date, default: Date.now },
    visitCount: { type: Number, default: 0 },
    downloadCount: { type: Number, default: 0 },
  },
  { _id: true },
);

const bannedEmailSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    bannedAt: { type: Date, default: Date.now },
    reason: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const accessRequestSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "" },
    requestedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
  },
  { _id: true },
);

/**
 * Accès client des documents partagés : une URL publique, sans compte Newbi,
 * qui ouvre en lecture les dossiers choisis et leurs sous-dossiers, sur le
 * modèle du partage d'un tableau kanban (visiteurs identifiés par e-mail,
 * accès retiré à un visiteur, demandes d'accès). Le contenu n'est pas copié :
 * il est relu à chaque visite (voir services/documentShareAccess.js).
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
    folderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SharedFolder" }],
    // Premier format (un seul dossier), relu par shareFolderIds()
    folderId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    passwordHash: { type: String, default: null },
    visitors: [visitorSchema],
    bannedEmails: [bannedEmailSchema],
    accessRequests: [accessRequestSchema],
    stats: {
      totalViews: { type: Number, default: 0 },
      totalDownloads: { type: Number, default: 0 },
      lastViewedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
);

documentShareSchema.index({ workspaceId: 1, folderIds: 1 });

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

documentShareSchema.methods.isBanned = function (email) {
  const normalized = String(email || "").toLowerCase();
  return (this.bannedEmails || []).some((ban) => ban.email === normalized);
};

/** Dossiers partagés, y compris pour un accès du premier format. */
export function shareFolderIds(share) {
  if (share?.folderIds?.length) return share.folderIds;
  return share?.folderId ? [share.folderId] : [];
}

export default mongoose.model("DocumentShare", documentShareSchema);
