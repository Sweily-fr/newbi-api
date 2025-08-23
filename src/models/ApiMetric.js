import mongoose from 'mongoose';

const apiMetricSchema = new mongoose.Schema({
  // Provider concerné
  provider: {
    type: String,
    required: true,
    enum: ['bridge', 'stripe', 'paypal', 'mock'],
    index: true
  },
  
  // Endpoint appelé
  endpoint: {
    type: String,
    required: true,
    index: true
  },
  
  // Méthode HTTP
  method: {
    type: String,
    required: true,
    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    default: 'POST'
  },
  
  // Métriques de performance
  requestCount: {
    type: Number,
    default: 0
  },
  
  successCount: {
    type: Number,
    default: 0
  },
  
  errorCount: {
    type: Number,
    default: 0
  },
  
  // Temps de réponse en millisecondes
  responseTime: {
    total: {
      type: Number,
      default: 0
    },
    average: {
      type: Number,
      default: 0
    },
    min: {
      type: Number
    },
    max: {
      type: Number
    }
  },
  
  // Coûts
  cost: {
    total: {
      type: Number,
      default: 0
    },
    perRequest: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'EUR'
    }
  },
  
  // Date de la métrique (par jour)
  date: {
    type: Date,
    required: true,
    index: true
  },
  
  // Workspace concerné
  workspaceId: {
    type: String,
    required: true,
    index: true
  },
  
  // Détails des erreurs
  errors: [{
    code: String,
    message: String,
    count: {
      type: Number,
      default: 1
    },
    lastOccurrence: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Métadonnées additionnelles
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true,
  collection: 'api_metrics'
});

// Index composés pour les requêtes d'analyse
apiMetricSchema.index({ provider: 1, date: -1 });
apiMetricSchema.index({ workspaceId: 1, date: -1 });
apiMetricSchema.index({ provider: 1, endpoint: 1, date: -1 });
apiMetricSchema.index({ date: -1, 'cost.total': -1 });

// Index unique pour éviter les doublons
apiMetricSchema.index({ 
  provider: 1, 
  endpoint: 1, 
  method: 1, 
  workspaceId: 1, 
  date: 1 
}, { unique: true });

// Méthodes d'instance
apiMetricSchema.methods.addRequest = function(responseTime, success = true, cost = 0) {
  this.requestCount += 1;
  
  if (success) {
    this.successCount += 1;
  } else {
    this.errorCount += 1;
  }
  
  // Mise à jour des temps de réponse
  this.responseTime.total += responseTime;
  this.responseTime.average = this.responseTime.total / this.requestCount;
  
  if (!this.responseTime.min || responseTime < this.responseTime.min) {
    this.responseTime.min = responseTime;
  }
  
  if (!this.responseTime.max || responseTime > this.responseTime.max) {
    this.responseTime.max = responseTime;
  }
  
  // Mise à jour des coûts
  this.cost.total += cost;
  this.cost.perRequest = this.cost.total / this.requestCount;
  
  return this.save();
};

apiMetricSchema.methods.addError = function(errorCode, errorMessage) {
  const existingError = this.errors.find(e => e.code === errorCode);
  
  if (existingError) {
    existingError.count += 1;
    existingError.lastOccurrence = new Date();
  } else {
    this.errors.push({
      code: errorCode,
      message: errorMessage,
      count: 1,
      lastOccurrence: new Date()
    });
  }
  
  return this.save();
};

apiMetricSchema.methods.getSuccessRate = function() {
  if (this.requestCount === 0) return 0;
  return (this.successCount / this.requestCount) * 100;
};

// Méthodes statiques
apiMetricSchema.statics.findOrCreate = async function(provider, endpoint, method, workspaceId, date = new Date()) {
  // Normaliser la date au début de la journée
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  
  let metric = await this.findOne({
    provider,
    endpoint,
    method,
    workspaceId,
    date: dayStart
  });
  
  if (!metric) {
    metric = new this({
      provider,
      endpoint,
      method,
      workspaceId,
      date: dayStart
    });
    await metric.save();
  }
  
  return metric;
};

apiMetricSchema.statics.getProviderStats = function(provider, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        provider,
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        totalRequests: { $sum: '$requestCount' },
        totalCost: { $sum: '$cost.total' },
        avgResponseTime: { $avg: '$responseTime.average' },
        successRate: { 
          $avg: { 
            $cond: [
              { $eq: ['$requestCount', 0] },
              0,
              { $multiply: [{ $divide: ['$successCount', '$requestCount'] }, 100] }
            ]
          }
        }
      }
    }
  ]);
};

apiMetricSchema.statics.getCostComparison = function(startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$provider',
        totalCost: { $sum: '$cost.total' },
        totalRequests: { $sum: '$requestCount' },
        avgCostPerRequest: { $avg: '$cost.perRequest' }
      }
    },
    {
      $sort: { totalCost: -1 }
    }
  ]);
};

const ApiMetric = mongoose.model('ApiMetric', apiMetricSchema);

export default ApiMetric;
