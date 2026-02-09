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
    enum: ['MANUAL', 'INVOICE_DUE', 'MEETING', 'DEADLINE', 'REMINDER', 'CREDIT_NOTE_CREATED', 'EXTERNAL'],
    default: 'MANUAL'
  },

  // Source de l'événement
  source: {
    type: String,
    enum: ['newbi', 'google', 'microsoft', 'apple'],
    default: 'newbi'
  },

  // Visibilité (workspace = tous les membres, private = seulement le propriétaire)
  visibility: {
    type: String,
    enum: ['workspace', 'private'],
    default: 'workspace'
  },

  // Événement en lecture seule (provenant d'un calendrier externe)
  isReadOnly: {
    type: Boolean,
    default: false
  },

  // ID de l'événement dans le calendrier externe
  externalEventId: {
    type: String,
    default: null,
    sparse: true
  },

  // Référence vers la connexion calendrier
  calendarConnectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CalendarConnection',
    default: null,
    sparse: true
  },

  // Liens vers les calendriers externes (quand un événement Newbi est poussé vers un calendrier externe)
  externalCalendarLinks: [{
    provider: {
      type: String,
      enum: ['google', 'microsoft', 'apple']
    },
    externalEventId: String,
    calendarConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CalendarConnection'
    }
  }],
  
  // Référence vers une facture (si l'événement est lié à une échéance de facture)
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    sparse: true // Permet d'avoir des événements sans facture associée
  },
  
  // Référence vers l'organisation/workspace (Better Auth)
  // Optionnel pour les événements externes (user-scoped)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    index: true
  },
  
  // Propriétaire de l'événement (pour audit trail)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Rappel par email
  emailReminder: {
    enabled: {
      type: Boolean,
      default: false
    },
    anticipation: {
      type: String,
      enum: [null, '1h', '3h', '1d', '3d'],
      default: null
    },
    sentAt: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'cancelled'],
      default: 'pending'
    },
    scheduledFor: {
      type: Date,
      default: null
    },
    failureReason: {
      type: String,
      default: null
    }
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
// Index pour les événements externes
eventSchema.index({ externalEventId: 1, calendarConnectionId: 1 }, { sparse: true });
eventSchema.index({ userId: 1, visibility: 1, start: 1 });
eventSchema.index({ calendarConnectionId: 1 }, { sparse: true });

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

eventSchema.statics.updateInvoiceEvent = async function(invoice, userId, workspaceId) {
  try {
    const event = await this.findOne({ 
      invoiceId: invoice._id,
      type: 'INVOICE_DUE',
      workspaceId: workspaceId || invoice.workspaceId
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

eventSchema.statics.deleteInvoiceEvent = async function(invoiceId, userId, workspaceId) {
  try {
    const filter = {
      invoiceId: invoiceId,
      type: 'INVOICE_DUE'
    };
    // Préférer workspaceId pour la cohérence avec createInvoiceDueEvent/updateInvoiceEvent
    if (workspaceId) {
      filter.workspaceId = workspaceId;
    } else {
      filter.userId = userId;
    }
    return await this.findOneAndDelete(filter);
  } catch (error) {
    console.error('Erreur lors de la suppression de l\'événement de facture:', error);
    throw error;
  }
};

const Event = mongoose.model('Event', eventSchema);
export default Event;
