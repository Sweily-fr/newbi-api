import mongoose from "mongoose";
const { Schema } = mongoose;

const fileSchema = new Schema({
  originalName: {
    type: String,
    required: true,
    trim: true,
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
  mimeType: {
    type: String,
    required: true,
    trim: true,
  },
  size: {
    type: Number,
    required: true,
  },
  uploadDate: {
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
        return `dl-${this.shareLink}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
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
    uploadMethod: {
      type: String,
      enum: ["direct", "base64", "chunk"],
      default: "direct",
    },
  },
  {
    timestamps: true,
  }
);

// Méthode pour vérifier si le transfert est expiré
FileTransferSchema.methods.isExpired = function () {
  return this.expiryDate < new Date() || this.status === "expired";
};

// Méthode pour vérifier si le transfert est accessible
FileTransferSchema.methods.isAccessible = function () {
  if (this.isPaymentRequired && !this.isPaid) {
    return false;
  }
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
  this.accessKey = `key-${timestamp}-${Math.random().toString(36).substring(2, 15)}`;

  // Définir la date d'expiration (par défaut 7 jours)
  if (!this.expiryDate) {
    this.expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }

  return this;
};

const FileTransfer = mongoose.model("FileTransfer", FileTransferSchema);

export default FileTransfer;
