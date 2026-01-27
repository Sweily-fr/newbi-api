import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { Schema } = mongoose;

const fileSchema = new Schema({
  originalName: {
    type: String,
    required: true,
    trim: true,
  },
  displayName: {
    type: String,
  },
  fileName: {
    type: String,
    required: true,
    trim: true,
  },
  filePath: {
    type: String,
    required: true,
    trim: true,
  },
  r2Key: {
    type: String,
  },
  mimeType: {
    type: String,
    required: true,
    trim: true,
  },
  size: {
    type: Number,
    required: true,
  },
  storageType: {
    type: String,
    enum: ["local", "r2"],
    default: "local",
  },
  fileId: {
    type: String,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
});

const FileTransferSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    files: [fileSchema],
    totalSize: {
      type: Number,
      required: true,
    },
    shareLink: {
      type: String,
      required: true,
      unique: true,
    },
    downloadLink: {
      type: String,
      unique: true,
      default: function () {
        return `dl-${this.shareLink}-${Date.now()}-${Math.random()
          .toString(36)
          .substring(2, 15)}`;
      },
    },
    accessKey: {
      type: String,
      required: true,
    },
    expiryDate: {
      type: Date,
      required: true,
    },
    downloadCount: {
      type: Number,
      default: 0,
    },
    lastDownloadDate: {
      type: Date,
    },
    isPaymentRequired: {
      type: Boolean,
      default: false,
    },
    paymentAmount: {
      type: Number,
      default: 0,
    },
    paymentCurrency: {
      type: String,
      default: "EUR",
    },
    isPaid: {
      type: Boolean,
      default: false,
    },
    paymentId: {
      type: String,
    },
    paymentDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["active", "expired", "deleted"],
      default: "active",
    },
    recipientEmail: {
      type: String,
      trim: true,
    },
    notificationSent: {
      type: Boolean,
      default: false,
    },
    // Nouvelles options
    notifyOnDownload: {
      type: Boolean,
      default: false,
    },
    passwordProtected: {
      type: Boolean,
      default: false,
    },
    password: {
      type: String,
      trim: true,
    },
    allowPreview: {
      type: Boolean,
      default: true,
    },
    uploadMethod: {
      type: String,
      enum: ["direct", "base64", "chunk"],
      default: "direct",
    },
    // Rappel avant expiration
    expiryReminderEnabled: {
      type: Boolean,
      default: false,
    },
    expiryReminderSent: {
      type: Boolean,
      default: false,
    },
    // Message personnalisé
    message: {
      type: String,
      trim: true,
    },
    // Filigrane appliqué sur les images
    hasWatermark: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Middleware pre-save pour hasher le mot de passe
FileTransferSchema.pre("save", async function (next) {
  // Ne hasher que si le mot de passe a été modifié et qu'il n'est pas déjà hashé
  if (this.isModified("password") && this.password) {
    // Vérifier si le mot de passe est déjà hashé (commence par $2a$ ou $2b$)
    if (!this.password.startsWith("$2a$") && !this.password.startsWith("$2b$")) {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    }
  }
  next();
});

// Méthode pour vérifier le mot de passe
FileTransferSchema.methods.verifyPassword = async function (candidatePassword) {
  if (!this.password || !candidatePassword) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.password);
};

// Méthode pour vérifier si le transfert est expiré
FileTransferSchema.methods.isExpired = function () {
  return this.expiryDate < new Date() || this.status === "expired";
};

// Méthode pour vérifier si le transfert est accessible (sans vérifier isPaid global)
FileTransferSchema.methods.isAccessible = function () {
  // Ne plus utiliser isPaid global - l'accès doit être vérifié via AccessGrant
  return !this.isExpired() && this.status === "active";
};

// Méthode pour incrémenter le compteur de téléchargements
FileTransferSchema.methods.incrementDownloadCount = function () {
  this.downloadCount += 1;
  this.lastDownloadDate = new Date();
  return this.save();
};

// Méthode pour marquer comme payé
FileTransferSchema.methods.markAsPaid = function (paymentId) {
  this.isPaid = true;
  this.paymentId = paymentId;
  this.paymentDate = new Date();
  return this.save();
};

// Méthode pour générer les identifiants de partage (shareLink et accessKey)
FileTransferSchema.methods.generateShareCredentials = function () {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 15);

  this.shareLink = `share-${timestamp}-${randomString}`;
  this.accessKey = `key-${timestamp}-${Math.random()
    .toString(36)
    .substring(2, 15)}`;
  this.downloadLink = `dl-${this._id}-${timestamp}-${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  // Définir la date d'expiration (par défaut 7 jours)
  if (!this.expiryDate) {
    this.expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  return this;
};

const FileTransfer = mongoose.model("FileTransfer", FileTransferSchema);

export default FileTransfer;
