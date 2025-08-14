import mongoose from 'mongoose';

const eventSchema = new mongoose.Schema({
  // Informations de base
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  
  // Dates et horaires
  start: {
    type: Date,
    required: true
  },
  end: {
    type: Date,
    required: true
  },
  allDay: {
    type: Boolean,
    default: false
  },
  
  // Apparence
  color: {
    type: String,
    enum: ['sky', 'amber', 'orange', 'emerald', 'violet', 'rose', 'blue', 'green', 'red', 'purple', 'pink', 'yellow'],
    default: 'sky'
  },
  
  // Localisation
  location: {
    type: String,
    trim: true
  },
  
  // Type d'événement
  type: {
    type: String,
    enum: ['MANUAL', 'INVOICE_DUE', 'MEETING', 'DEADLINE', 'REMINDER'],
    default: 'MANUAL'
  },
  
  // Référence vers une facture (si l'événement est lié à une échéance de facture)
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    sparse: true // Permet d'avoir des événements sans facture associée
  },
  
  // Référence vers l'organisation/workspace (Better Auth)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  
  // Propriétaire de l'événement (pour audit trail)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Métadonnées
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index pour optimiser les requêtes
// Index composés workspace + autres champs
eventSchema.index({ workspaceId: 1, start: 1 });
eventSchema.index({ workspaceId: 1, type: 1 });
eventSchema.index({ workspaceId: 1, invoiceId: 1 }, { sparse: true });
// Index legacy pour la migration
eventSchema.index({ userId: 1, start: 1 });
eventSchema.index({ invoiceId: 1 }, { sparse: true });

// Middleware pour mettre à jour updatedAt
eventSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Méthodes statiques
eventSchema.statics.createInvoiceDueEvent = async function(invoice, userId, workspaceId) {
  try {
    // Vérifier si un événement existe déjà pour cette facture
    const existingEvent = await this.findOne({ 
      invoiceId: invoice._id,
      type: 'INVOICE_DUE',
      workspaceId: workspaceId || invoice.workspaceId
    });
    
    if (existingEvent) {
      // Mettre à jour l'événement existant
      existingEvent.title = `Échéance facture ${invoice.prefix}${invoice.number}`;
      existingEvent.description = `Facture ${invoice.prefix}${invoice.number} - ${invoice.client.name} - ${invoice.finalTotalTTC}€`;
      existingEvent.start = new Date(invoice.dueDate);
      existingEvent.end = new Date(invoice.dueDate);
      existingEvent.allDay = true;
      existingEvent.color = invoice.status === 'COMPLETED' ? 'green' : 'amber';
      
      return await existingEvent.save();
    } else {
      // Créer un nouvel événement
      const event = new this({
        title: `Échéance facture ${invoice.prefix}${invoice.number}`,
        description: `Facture ${invoice.prefix}${invoice.number} - ${invoice.client.name} - ${invoice.finalTotalTTC}€`,
        start: new Date(invoice.dueDate),
        end: new Date(invoice.dueDate),
        allDay: true,
        color: invoice.status === 'COMPLETED' ? 'green' : 'amber',
        type: 'INVOICE_DUE',
        invoiceId: invoice._id,
        workspaceId: workspaceId || invoice.workspaceId, // ✅ Ajout du workspaceId
        userId: userId
      });
      
      return await event.save();
    }
  } catch (error) {
    console.error('Erreur lors de la création de l\'événement de facture:', error);
    throw error;
  }
};

eventSchema.statics.updateInvoiceEvent = async function(invoice, userId) {
  try {
    const event = await this.findOne({ 
      invoiceId: invoice._id,
      type: 'INVOICE_DUE',
      userId: userId
    });
    
    if (event) {
      event.title = `Échéance facture ${invoice.prefix}${invoice.number}`;
      event.description = `Facture ${invoice.prefix}${invoice.number} - ${invoice.client.name} - ${invoice.finalTotalTTC}€`;
      event.start = new Date(invoice.dueDate);
      event.end = new Date(invoice.dueDate);
      event.color = invoice.status === 'COMPLETED' ? 'green' : 'amber';
      
      return await event.save();
    }
    
    return null;
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'événement de facture:', error);
    throw error;
  }
};

eventSchema.statics.deleteInvoiceEvent = async function(invoiceId, userId) {
  try {
    return await this.findOneAndDelete({ 
      invoiceId: invoiceId,
      type: 'INVOICE_DUE',
      userId: userId
    });
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'événement de facture:', error);
    throw error;
  }
};

const Event = mongoose.model('Event', eventSchema);
export default Event;
