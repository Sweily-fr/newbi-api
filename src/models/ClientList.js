import mongoose from 'mongoose';

/**
 * Schéma pour les listes de segmentation de clients
 */
const clientListSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Le nom de la liste est requis'],
    trim: true,
    minlength: [2, 'Le nom doit contenir au moins 2 caractères'],
    maxlength: [100, 'Le nom ne peut pas dépasser 100 caractères']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'La description ne peut pas dépasser 500 caractères'],
    default: ''
  },
  // Référence à l'espace de travail
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Organization'
  },
  // Utilisateur qui a créé la liste
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  // Tableau des IDs des clients dans cette liste
  clients: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client'
  }],
  // Couleur pour l'affichage (optionnel)
  color: {
    type: String,
    default: '#3b82f6',
    validate: {
      validator: function(v) {
        return /^#[0-9A-F]{6}$/i.test(v);
      },
      message: 'La couleur doit être au format hexadécimal (#RRGGBB)'
    }
  },
  // Icône pour l'affichage (optionnel)
  icon: {
    type: String,
    default: 'Users'
  },
  // Indique si c'est une liste par défaut (non supprimable)
  isDefault: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances
clientListSchema.index({ workspaceId: 1 });
clientListSchema.index({ createdBy: 1 });
clientListSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export default mongoose.model('ClientList', clientListSchema);
