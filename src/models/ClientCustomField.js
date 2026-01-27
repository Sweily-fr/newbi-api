import mongoose from 'mongoose';

/**
 * Types de champs personnalisés supportés
 */
const FIELD_TYPES = [
  'TEXT',           // Texte simple
  'TEXTAREA',       // Texte long
  'NUMBER',         // Nombre
  'DATE',           // Date
  'SELECT',         // Choix unique
  'MULTISELECT',    // Choix multiple
  'CHECKBOX',       // Case à cocher (oui/non)
  'URL',            // Lien URL
  'EMAIL',          // Email
  'PHONE',          // Téléphone
];

/**
 * Schéma pour les définitions de champs personnalisés (au niveau workspace)
 * Définit les champs disponibles pour tous les clients d'un workspace
 */
const clientCustomFieldSchema = new mongoose.Schema({
  // Nom du champ (ex: "Date anniversaire", "Source", "Réseaux sociaux")
  name: {
    type: String,
    required: [true, 'Le nom du champ est requis'],
    trim: true,
    minlength: [2, 'Le nom doit contenir au moins 2 caractères'],
    maxlength: [100, 'Le nom ne peut pas dépasser 100 caractères']
  },
  // Type du champ
  fieldType: {
    type: String,
    required: [true, 'Le type du champ est requis'],
    enum: FIELD_TYPES
  },
  // Description optionnelle du champ
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'La description ne peut pas dépasser 500 caractères'],
    default: ''
  },
  // Options pour les champs SELECT et MULTISELECT
  options: [{
    label: {
      type: String,
      required: true,
      trim: true
    },
    value: {
      type: String,
      required: true,
      trim: true
    },
    color: {
      type: String,
      default: '#6b7280'
    }
  }],
  // Placeholder pour le champ
  placeholder: {
    type: String,
    trim: true,
    default: ''
  },
  // Champ obligatoire ou non
  isRequired: {
    type: Boolean,
    default: false
  },
  // Ordre d'affichage
  order: {
    type: Number,
    default: 0
  },
  // Champ actif ou non (permet de désactiver sans supprimer)
  isActive: {
    type: Boolean,
    default: true
  },
  // Référence à l'espace de travail
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Organization'
  },
  // Utilisateur qui a créé le champ
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances
clientCustomFieldSchema.index({ workspaceId: 1 });
clientCustomFieldSchema.index({ workspaceId: 1, order: 1 });
clientCustomFieldSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export default mongoose.model('ClientCustomField', clientCustomFieldSchema);
export { FIELD_TYPES };
