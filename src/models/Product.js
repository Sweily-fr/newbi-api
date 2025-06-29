import mongoose from "mongoose";
import { NAME_REGEX } from "../utils/validators.js";

/**
 * Schéma principal du produit/service
 */
const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    match: [NAME_REGEX, 'Veuillez fournir un nom valide']
  },
  description: {
    type: String,
    trim: true
  },
  unitPrice: {
    type: Number,
    required: true,
    min: [0, 'Le prix unitaire doit être supérieur ou égal à 0']
  },
  vatRate: {
    type: Number,
    required: true,
    min: [0, 'Le taux de TVA doit être supérieur ou égal à 0'],
    max: [100, 'Le taux de TVA doit être inférieur ou égal à 100']
  },
  unit: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    trim: true
  },
  reference: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
productSchema.index({ createdBy: 1 });
productSchema.index({ name: 'text', description: 'text', reference: 'text' });

// Méthode pour convertir un produit en item pour facture/devis
productSchema.methods.toItem = function() {
  return {
    description: this.name,
    details: this.description,
    quantity: 1,
    unitPrice: this.unitPrice,
    vatRate: this.vatRate,
    unit: this.unit
  };
};

const Product = mongoose.model('Product', productSchema);

export default Product;
