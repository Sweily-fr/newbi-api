import mongoose from 'mongoose';

const voteSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  voteType: {
    type: String,
    enum: ['upvote', 'downvote'],
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const communitySuggestionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['idea', 'bug'],
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 100
  },
  description: {
    type: String,
    required: true,
    minlength: 10,
    maxlength: 1000
  },
  page: {
    type: String,
    trim: true,
    maxlength: 50
  },
  status: {
    type: String,
    enum: ['pending', 'validated', 'rejected'],
    default: 'pending'
  },
  votes: [voteSchema],
  validatedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  validatedAt: {
    type: Date
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  isAnonymous: {
    type: Boolean,
    default: true
  },
  // Pour les bugs
  severity: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    required: function() {
      return this.type === 'bug';
    }
  },
  stepsToReproduce: {
    type: String,
    minlength: 10,
    maxlength: 500,
    required: function() {
      return this.type === 'bug';
    }
  },
  // Métadonnées
  upvoteCount: {
    type: Number,
    default: 0
  },
  downvoteCount: {
    type: Number,
    default: 0
  },
  validationCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances
communitySuggestionSchema.index({ workspaceId: 1, type: 1, status: 1 });
communitySuggestionSchema.index({ createdAt: -1 });
communitySuggestionSchema.index({ upvoteCount: -1 });

// Méthodes pour calculer les votes
communitySuggestionSchema.methods.calculateVotes = function() {
  this.upvoteCount = this.votes.filter(v => v.voteType === 'upvote').length;
  this.downvoteCount = this.votes.filter(v => v.voteType === 'downvote').length;
};

// Méthode pour ajouter/modifier un vote
communitySuggestionSchema.methods.addVote = function(userId, voteType) {
  const existingVoteIndex = this.votes.findIndex(
    v => v.userId.toString() === userId.toString()
  );

  if (existingVoteIndex > -1) {
    // Si le vote est identique, le retirer (toggle)
    if (this.votes[existingVoteIndex].voteType === voteType) {
      this.votes.splice(existingVoteIndex, 1);
    } else {
      // Sinon, changer le type de vote
      this.votes[existingVoteIndex].voteType = voteType;
      this.votes[existingVoteIndex].createdAt = new Date();
    }
  } else {
    // Ajouter un nouveau vote
    this.votes.push({ userId, voteType });
  }

  this.calculateVotes();
};

// Méthode pour valider une suggestion
communitySuggestionSchema.methods.validateSuggestion = function(userId) {
  if (!this.validatedBy.includes(userId)) {
    this.validatedBy.push(userId);
    this.validationCount = this.validatedBy.length;
    
    // Si 5 utilisateurs ou plus valident, passer en "validated"
    if (this.validationCount >= 5) {
      this.status = 'validated';
      this.validatedAt = new Date();
    }
  }
};

// Méthode pour retirer une validation
communitySuggestionSchema.methods.removeValidation = function(userId) {
  const index = this.validatedBy.findIndex(
    id => id.toString() === userId.toString()
  );
  
  if (index > -1) {
    this.validatedBy.splice(index, 1);
    this.validationCount = this.validatedBy.length;
    
    // Si moins de 5 validations, repasser en pending
    if (this.validationCount < 5 && this.status === 'validated') {
      this.status = 'pending';
      this.validatedAt = null;
    }
  }
};

// Méthode pour obtenir le score net
communitySuggestionSchema.methods.getNetScore = function() {
  return this.upvoteCount - this.downvoteCount;
};

const CommunitySuggestion = mongoose.model('CommunitySuggestion', communitySuggestionSchema);

export default CommunitySuggestion;
