import mongoose from 'mongoose';

const downloadEventSchema = new mongoose.Schema({
  accessGrantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AccessGrant',
    required: false, // Rendu optionnel pour supporter le mode sans AccessGrant
    index: true
  },
  transferId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FileTransfer',
    required: true,
    index: true
  },
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  fileName: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    required: false
  },
  downloadType: {
    type: String,
    enum: ['single', 'bulk', 'zip'],
    default: 'single'
  },
  buyerEmail: {
    type: String,
    required: true,
    index: true
  },
  buyerIp: {
    type: String,
    required: true,
    index: true
  },
  buyerUserAgent: {
    type: String,
    required: false
  },
  downloadUrl: {
    type: String,
    required: false // URL générée pour le téléchargement
  },
  urlExpiresAt: {
    type: Date,
    required: false
  },
  status: {
    type: String,
    enum: ['initiated', 'completed', 'failed', 'expired'],
    default: 'initiated',
    index: true
  },
  errorMessage: {
    type: String,
    required: false
  },
  downloadDuration: {
    type: Number, // en millisecondes
    required: false
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index composés pour les requêtes fréquentes
downloadEventSchema.index({ transferId: 1, createdAt: -1 });
downloadEventSchema.index({ buyerEmail: 1, createdAt: -1 });
downloadEventSchema.index({ buyerIp: 1, createdAt: -1 });
downloadEventSchema.index({ status: 1, createdAt: -1 });

// Méthodes d'instance
downloadEventSchema.methods.markCompleted = async function(duration = null) {
  this.status = 'completed';
  if (duration) {
    this.downloadDuration = duration;
  }
  return await this.save();
};

downloadEventSchema.methods.markFailed = async function(errorMessage) {
  this.status = 'failed';
  this.errorMessage = errorMessage;
  return await this.save();
};

// Méthodes statiques
downloadEventSchema.statics.logDownload = async function(data) {
  const {
    accessGrantId,
    transferId,
    fileId,
    fileName,
    fileSize,
    downloadType = 'single',
    buyerEmail,
    buyerIp,
    buyerUserAgent,
    downloadUrl,
    urlExpiresAt
  } = data;
  
  return await this.create({
    accessGrantId,
    transferId,
    fileId,
    fileName,
    fileSize,
    downloadType,
    buyerEmail,
    buyerIp,
    buyerUserAgent,
    downloadUrl,
    urlExpiresAt,
    status: 'initiated'
  });
};

downloadEventSchema.statics.getDownloadStats = async function(transferId) {
  const stats = await this.aggregate([
    { $match: { transferId: new mongoose.Types.ObjectId(transferId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalSize: { $sum: '$fileSize' }
      }
    }
  ]);
  
  const result = {
    total: 0,
    completed: 0,
    failed: 0,
    initiated: 0,
    totalSizeDownloaded: 0
  };
  
  stats.forEach(stat => {
    result.total += stat.count;
    result[stat._id] = stat.count;
    if (stat._id === 'completed') {
      result.totalSizeDownloaded = stat.totalSize || 0;
    }
  });
  
  return result;
};

downloadEventSchema.statics.getRecentDownloads = async function(transferId, limit = 50) {
  return await this.find({ transferId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('accessGrantId', 'buyerEmail paidAmount currency')
    .lean();
};

// Détection d'abus potentiel
downloadEventSchema.statics.detectSuspiciousActivity = async function(buyerIp, timeWindowHours = 1) {
  const since = new Date();
  since.setHours(since.getHours() - timeWindowHours);
  
  const downloads = await this.countDocuments({
    buyerIp,
    createdAt: { $gte: since }
  });
  
  // Plus de 50 téléchargements en 1h = suspect
  return downloads > 50;
};

const DownloadEvent = mongoose.model('DownloadEvent', downloadEventSchema);

export default DownloadEvent;
