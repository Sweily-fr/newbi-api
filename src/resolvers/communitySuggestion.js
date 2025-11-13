import mongoose from 'mongoose';
import CommunitySuggestion from '../models/CommunitySuggestion.js';
import User from '../models/User.js';
import { isAuthenticated } from '../middlewares/better-auth-jwt.js';
import { validateSuggestionInput } from '../utils/suggestionValidation.js';

const communitySuggestionResolvers = {
  Query: {
    getCommunitySuggestions: isAuthenticated(async (_, { type, status, sortBy }, { user }) => {
      try {
        const query = {};
        
        if (type) {
          query.type = type;
        }
        
        if (status) {
          query.status = status;
        }

        let sort = {};
        switch (sortBy) {
        case 'recent':
          sort = { createdAt: -1 };
          break;
        case 'popular':
          sort = { upvoteCount: -1 };
          break;
        case 'validated':
          sort = { validationCount: -1 };
          break;
        default:
          sort = { createdAt: -1 };
        }

        const suggestions = await CommunitySuggestion.find(query).sort(sort).populate('createdBy');

        // Ajouter les informations de vote et validation de l'utilisateur
        return suggestions.map(suggestion => {
          const userVote = suggestion.votes.find(
            v => v.userId.toString() === user.id.toString()
          );
          
          const userHasValidated = suggestion.validatedBy.some(
            id => id.toString() === user.id.toString()
          );

          const suggestionObj = suggestion.toObject();
          
          // Ajouter les informations de l'utilisateur si non anonyme
          let createdByUser = null;
          if (!suggestion.isAnonymous && suggestion.createdBy) {
            const firstName = suggestion.createdBy.profile?.firstName || '';
            const lastName = suggestion.createdBy.profile?.lastName || '';
            const fullName = `${firstName} ${lastName}`.trim() || suggestion.createdBy.email.split('@')[0];
            
            createdByUser = {
              id: suggestion.createdBy._id.toString(),
              name: fullName,
              email: suggestion.createdBy.email
            };
          }
          
          return {
            ...suggestionObj,
            id: suggestionObj._id.toString(),
            createdByUser,
            netScore: suggestion.getNetScore(),
            userVote: userVote ? userVote.voteType : null,
            userHasValidated
          };
        });
      } catch (error) {
        throw new Error(`Erreur lors de la récupération des suggestions: ${error.message}`);
      }
    }),

    getCommunitySuggestion: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const suggestion = await CommunitySuggestion.findOne({
          _id: id
        }).populate('createdBy');

        if (!suggestion) {
          throw new Error('Suggestion non trouvée');
        }

        const userVote = suggestion.votes.find(
          v => v.userId.toString() === user.id.toString()
        );
        
        const userHasValidated = suggestion.validatedBy.some(
          id => id.toString() === user.id.toString()
        );

        const suggestionObj = suggestion.toObject();
        
        // Ajouter les informations de l'utilisateur si non anonyme
        let createdByUser = null;
        if (!suggestion.isAnonymous && suggestion.createdBy) {
          const firstName = suggestion.createdBy.profile?.firstName || '';
          const lastName = suggestion.createdBy.profile?.lastName || '';
          const fullName = `${firstName} ${lastName}`.trim() || suggestion.createdBy.email.split('@')[0];
          
          createdByUser = {
            id: suggestion.createdBy._id.toString(),
            name: fullName,
            email: suggestion.createdBy.email
          };
        }
        
        return {
          ...suggestionObj,
          id: suggestionObj._id.toString(),
          createdByUser,
          netScore: suggestion.getNetScore(),
          userVote: userVote ? userVote.voteType : null,
          userHasValidated
        };
      } catch (error) {
        throw new Error(`Erreur lors de la récupération de la suggestion: ${error.message}`);
      }
    }),

    getCommunitySuggestionStats: isAuthenticated(async (_, __) => {
      try {
        const [totalIdeas, totalBugs, totalValidated, totalPending] = await Promise.all([
          CommunitySuggestion.countDocuments({ type: 'idea', status: 'pending' }),
          CommunitySuggestion.countDocuments({ type: 'bug', status: 'pending' }),
          CommunitySuggestion.countDocuments({ status: 'validated' }),
          CommunitySuggestion.countDocuments({ status: 'pending' })
        ]);

        return {
          totalIdeas,
          totalBugs,
          totalValidated,
          totalPending
        };
      } catch (error) {
        throw new Error(`Erreur lors de la récupération des statistiques: ${error.message}`);
      }
    })
  },

  Mutation: {
    createCommunitySuggestion: isAuthenticated(async (_, { input }, { user }) => {
      try {
        // Validation des données avec regex
        const validatedData = validateSuggestionInput(input, input.type);

        // Utiliser un workspaceId fictif pour la communauté globale
        const globalWorkspaceId = new mongoose.Types.ObjectId('000000000000000000000000');

        const suggestion = new CommunitySuggestion({
          type: input.type,
          title: validatedData.title,
          description: validatedData.description,
          page: input.page,
          severity: validatedData.severity,
          stepsToReproduce: validatedData.stepsToReproduce,
          createdBy: user.id,
          workspaceId: globalWorkspaceId,
          isAnonymous: input.isAnonymous !== undefined ? input.isAnonymous : true
        });

        await suggestion.save();

        const suggestionObj = suggestion.toObject();
        return {
          ...suggestionObj,
          id: suggestionObj._id.toString(),
          netScore: suggestion.getNetScore(),
          userVote: null,
          userHasValidated: false
        };
      } catch (error) {
        throw new Error(`Erreur lors de la création de la suggestion: ${error.message}`);
      }
    }),

    updateCommunitySuggestion: isAuthenticated(async (_, { id, input }, { user }) => {
      try {
        const suggestion = await CommunitySuggestion.findOne({
          _id: id
        });

        if (!suggestion) {
          throw new Error('Suggestion non trouvée');
        }

        // Vérifier que l'utilisateur est le créateur
        if (suggestion.createdBy.toString() !== user.id.toString()) {
          throw new Error('Vous ne pouvez modifier que vos propres suggestions');
        }

        // Mettre à jour les champs
        Object.keys(input).forEach(key => {
          if (input[key] !== undefined) {
            suggestion[key] = input[key];
          }
        });

        await suggestion.save();

        const userVote = suggestion.votes.find(
          v => v.userId.toString() === user.id.toString()
        );
        
        const userHasValidated = suggestion.validatedBy.some(
          id => id.toString() === user.id.toString()
        );

        const suggestionObj = suggestion.toObject();
        return {
          ...suggestionObj,
          id: suggestionObj._id.toString(),
          netScore: suggestion.getNetScore(),
          userVote: userVote ? userVote.voteType : null,
          userHasValidated
        };
      } catch (error) {
        throw new Error(`Erreur lors de la mise à jour de la suggestion: ${error.message}`);
      }
    }),

    deleteCommunitySuggestion: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const suggestion = await CommunitySuggestion.findOne({
          _id: id
        });

        if (!suggestion) {
          throw new Error('Suggestion non trouvée');
        }

        // Vérifier que l'utilisateur est le créateur
        if (suggestion.createdBy.toString() !== user.id.toString()) {
          throw new Error('Vous ne pouvez supprimer que vos propres suggestions');
        }

        await CommunitySuggestion.deleteOne({ _id: id });

        return true;
      } catch (error) {
        throw new Error(`Erreur lors de la suppression de la suggestion: ${error.message}`);
      }
    }),

    voteCommunitySuggestion: isAuthenticated(async (_, { id, voteType }, { user }) => {
      try {
        const suggestion = await CommunitySuggestion.findOne({
          _id: id
        });

        if (!suggestion) {
          throw new Error('Suggestion non trouvée');
        }

        suggestion.addVote(user.id, voteType);
        await suggestion.save();

        const userVote = suggestion.votes.find(
          v => v.userId.toString() === user.id.toString()
        );
        
        const userHasValidated = suggestion.validatedBy.some(
          id => id.toString() === user.id.toString()
        );

        const suggestionObj = suggestion.toObject();
        return {
          ...suggestionObj,
          id: suggestionObj._id.toString(),
          netScore: suggestion.getNetScore(),
          userVote: userVote ? userVote.voteType : null,
          userHasValidated
        };
      } catch (error) {
        throw new Error(`Erreur lors du vote: ${error.message}`);
      }
    }),

    validateCommunitySuggestion: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const suggestion = await CommunitySuggestion.findOne({
          _id: id
        });

        if (!suggestion) {
          throw new Error('Suggestion non trouvée');
        }

        suggestion.validateSuggestion(user.id);
        await suggestion.save();

        const userVote = suggestion.votes.find(
          v => v.userId.toString() === user.id.toString()
        );
        
        const userHasValidated = suggestion.validatedBy.some(
          id => id.toString() === user.id.toString()
        );

        const suggestionObj = suggestion.toObject();
        return {
          ...suggestionObj,
          id: suggestionObj._id.toString(),
          netScore: suggestion.getNetScore(),
          userVote: userVote ? userVote.voteType : null,
          userHasValidated
        };
      } catch (error) {
        throw new Error(`Erreur lors de la validation: ${error.message}`);
      }
    }),

    unvalidateCommunitySuggestion: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const suggestion = await CommunitySuggestion.findOne({
          _id: id
        });

        if (!suggestion) {
          throw new Error('Suggestion non trouvée');
        }

        suggestion.removeValidation(user.id);
        await suggestion.save();

        const userVote = suggestion.votes.find(
          v => v.userId.toString() === user.id.toString()
        );
        
        const userHasValidated = suggestion.validatedBy.some(
          id => id.toString() === user.id.toString()
        );

        const suggestionObj = suggestion.toObject();
        return {
          ...suggestionObj,
          id: suggestionObj._id.toString(),
          netScore: suggestion.getNetScore(),
          userVote: userVote ? userVote.voteType : null,
          userHasValidated
        };
      } catch (error) {
        throw new Error(`Erreur lors du retrait de validation: ${error.message}`);
      }
    })
  }
};

export default communitySuggestionResolvers;
