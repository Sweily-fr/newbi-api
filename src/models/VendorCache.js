/**
 * Cache des fournisseurs pour accélérer l'extraction OCR
 * Stocke les infos fournisseur par SIRET pour éviter de rappeler l'IA
 */

import mongoose from 'mongoose';

const vendorCacheSchema = new mongoose.Schema({
  // SIRET comme clé unique
  siret: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  
  // Informations du fournisseur
  name: {
    type: String,
    required: true,
  },
  address: String,
  city: String,
  postalCode: String,
  vatNumber: String,
  email: String,
  phone: String,
  
  // Métadonnées
  hitCount: {
    type: Number,
    default: 1,
  },
  lastUsedAt: {
    type: Date,
    default: Date.now,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index pour nettoyage des entrées anciennes
vendorCacheSchema.index({ lastUsedAt: 1 });

// Méthode statique pour récupérer ou créer un fournisseur
vendorCacheSchema.statics.getOrCreate = async function(siret, vendorData) {
  if (!siret || siret.length !== 14) return null;
  
  const existing = await this.findOneAndUpdate(
    { siret },
    {
      $set: {
        name: vendorData.name,
        address: vendorData.address,
        city: vendorData.city,
        postalCode: vendorData.postalCode,
        vatNumber: vendorData.vatNumber,
        email: vendorData.email,
        phone: vendorData.phone,
        lastUsedAt: new Date(),
      },
      $inc: { hitCount: 1 },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
  
  return existing;
};

// Méthode statique pour récupérer un fournisseur par SIRET
vendorCacheSchema.statics.getBySiret = async function(siret) {
  if (!siret || siret.length !== 14) return null;
  
  const vendor = await this.findOneAndUpdate(
    { siret },
    { $inc: { hitCount: 1 }, $set: { lastUsedAt: new Date() } },
    { new: true }
  );
  
  return vendor;
};

// Méthode statique pour nettoyer les entrées anciennes (> 90 jours sans utilisation)
vendorCacheSchema.statics.cleanOldEntries = async function() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({ lastUsedAt: { $lt: ninetyDaysAgo } });
  return result.deletedCount;
};

const VendorCache = mongoose.model('VendorCache', vendorCacheSchema);

export default VendorCache;
