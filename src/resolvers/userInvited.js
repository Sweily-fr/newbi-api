// resolvers/userInvited.js
import UserInvited from '../models/UserInvited.js';
import PublicBoardShare from '../models/PublicBoardShare.js';
import logger from '../utils/logger.js';
import { GraphQLError } from 'graphql';
import mongoose from 'mongoose';

// Helper pour obtenir les infos d'un utilisateur Newbi lié
const getLinkedUserInfo = async (db, userId) => {
  if (!userId) return null;
  
  try {
    const user = await db.collection('user').findOne({
      _id: new mongoose.Types.ObjectId(userId)
    });
    
    if (!user) return null;
    
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name || `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() || user.email.split('@')[0],
      firstName: user.name || user.profile?.firstName,
      lastName: user.lastName || user.profile?.lastName,
      image: user.image || user.avatar || null
    };
  } catch (error) {
    logger.error('❌ [UserInvited] Erreur récupération utilisateur Newbi:', error);
    return null;
  }
};

// Helper pour vérifier si un email existe dans la collection user (compte Newbi)
const checkNewbiAccount = async (db, email) => {
  try {
    const user = await db.collection('user').findOne({
      email: email.toLowerCase().trim()
    });
    
    if (!user) return null;
    
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name || `${user.profile?.firstName || ''} ${user.profile?.lastName || ''}`.trim() || user.email.split('@')[0],
      firstName: user.name || user.profile?.firstName,
      lastName: user.lastName || user.profile?.lastName,
      image: user.image || user.avatar || null
    };
  } catch (error) {
    logger.error('❌ [UserInvited] Erreur vérification compte Newbi:', error);
    return null;
  }
};

const userInvitedResolvers = {
  Query: {
    // Vérifier si un email existe et ses caractéristiques
    checkInvitedEmail: async (_, { email, token }, { db }) => {
      try {
        const normalizedEmail = email.toLowerCase().trim();
        logger.info(`🔍 [UserInvited] Vérification email: ${normalizedEmail}`);
        
        // Vérifier que le token est valide
        const share = await PublicBoardShare.findOne({ token, isActive: true });
        if (!share) {
          throw new GraphQLError('Lien de partage invalide ou expiré');
        }
        
        // Chercher l'utilisateur invité existant
        const userInvited = await UserInvited.findOne({ email: normalizedEmail });
        
        // Chercher un compte Newbi avec cet email
        const linkedUser = await checkNewbiAccount(db, normalizedEmail);
        
        if (userInvited) {
          // Vérifier si banni de ce board
          const isBanned = userInvited.isBannedFromBoard(share.boardId);
          
          return {
            exists: true,
            requiresPassword: userInvited.requiresPassword,
            hasLinkedNewbiAccount: !!userInvited.linkedUserId || !!linkedUser,
            linkedUser: linkedUser,
            userInvited: isBanned ? null : userInvited.getPublicInfo()
          };
        }
        
        // Nouvel utilisateur
        return {
          exists: false,
          requiresPassword: false,
          hasLinkedNewbiAccount: !!linkedUser,
          linkedUser: linkedUser,
          userInvited: null
        };
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur checkInvitedEmail:', error);
        throw new GraphQLError(error.message || 'Erreur lors de la vérification de l\'email');
      }
    },
    
    // Récupérer un utilisateur invité par son ID
    getInvitedUser: async (_, { id }) => {
      try {
        const userInvited = await UserInvited.findById(id);
        return userInvited ? userInvited.getPublicInfo() : null;
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur getInvitedUser:', error);
        return null;
      }
    },
    
    // Récupérer un utilisateur invité par son email
    getInvitedUserByEmail: async (_, { email }) => {
      try {
        const userInvited = await UserInvited.findOne({ 
          email: email.toLowerCase().trim() 
        });
        return userInvited ? userInvited.getPublicInfo() : null;
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur getInvitedUserByEmail:', error);
        return null;
      }
    },
    
    // Récupérer tous les utilisateurs invités ayant accès à un board
    getInvitedUsersForBoard: async (_, { boardId, workspaceId }) => {
      try {
        const users = await UserInvited.find({
          'boardsAccess.boardId': new mongoose.Types.ObjectId(boardId)
        });
        
        return users.map(u => u.getPublicInfo());
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur getInvitedUsersForBoard:', error);
        return [];
      }
    },
    
    // Valider un token de session
    validateInvitedSession: async (_, { sessionToken }) => {
      try {
        const userInvited = await UserInvited.findOne({ sessionToken });
        
        if (!userInvited) return null;
        
        if (!userInvited.validateSessionToken(sessionToken)) {
          return null;
        }
        
        return userInvited.getPublicInfo();
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur validateInvitedSession:', error);
        return null;
      }
    }
  },
  
  Mutation: {
    // Authentifier ou créer un utilisateur invité
    authenticateInvitedUser: async (_, { input }, { db, pubsub }) => {
      const { token, email, password, skipPassword, firstName, lastName } = input;
      
      try {
        const normalizedEmail = email.toLowerCase().trim();
        logger.info(`🔐 [UserInvited] Authentification: ${normalizedEmail}`);
        
        // 1. Vérifier que le token est valide
        const share = await PublicBoardShare.findOne({ token, isActive: true });
        if (!share) {
          return {
            success: false,
            message: 'Lien de partage invalide ou expiré',
            isBanned: false
          };
        }
        
        // 2. Chercher l'utilisateur invité existant
        let userInvited = await UserInvited.findOne({ email: normalizedEmail });
        let isNewUser = false;
        
        // 3. Chercher un compte Newbi avec cet email
        const linkedUser = await checkNewbiAccount(db, normalizedEmail);
        
        if (userInvited) {
          // === UTILISATEUR EXISTANT ===
          logger.info(`👤 [UserInvited] Utilisateur existant trouvé: ${userInvited._id}`);
          
          // Vérifier si banni de ce board
          if (userInvited.isBannedFromBoard(share.boardId)) {
            const access = userInvited.boardsAccess.find(
              b => b.boardId.toString() === share.boardId.toString()
            );
            return {
              success: false,
              message: 'Votre accès à ce tableau a été révoqué',
              isBanned: true,
              banReason: access?.banReason || null
            };
          }
          
          // Vérifier le mot de passe si requis
          if (userInvited.requiresPassword && !skipPassword) {
            if (!password) {
              return {
                success: false,
                message: 'Mot de passe requis',
                requiresPassword: true,
                userInvited: null
              };
            }
            
            const isValidPassword = await userInvited.comparePassword(password);
            if (!isValidPassword) {
              return {
                success: false,
                message: 'Mot de passe incorrect',
                requiresPassword: true
              };
            }
          }
          
          // Mettre à jour les infos si un compte Newbi est trouvé et pas encore lié
          if (linkedUser && !userInvited.linkedUserId) {
            userInvited.linkedUserId = linkedUser.id;
            if (!userInvited.firstName) userInvited.firstName = linkedUser.firstName;
            if (!userInvited.lastName) userInvited.lastName = linkedUser.lastName;
            if (!userInvited.image) userInvited.image = linkedUser.image;
          }
          
          // Ajouter/mettre à jour l'accès au board
          await userInvited.addBoardAccess(share.boardId, share._id, share.workspaceId);
          
        } else {
          // === NOUVEL UTILISATEUR ===
          logger.info(`✨ [UserInvited] Création nouvel utilisateur: ${normalizedEmail}`);
          isNewUser = true;
          
          // Créer le nouvel utilisateur
          userInvited = new UserInvited({
            email: normalizedEmail,
            firstName: firstName || linkedUser?.firstName || null,
            lastName: lastName || linkedUser?.lastName || null,
            name: linkedUser?.name || [firstName, lastName].filter(Boolean).join(' ') || normalizedEmail.split('@')[0],
            image: linkedUser?.image || null,
            linkedUserId: linkedUser?.id || null,
            requiresPassword: false
          });
          
          // Si un mot de passe est fourni et skipPassword est false, le définir
          if (password && !skipPassword) {
            userInvited.password = password;
            userInvited.requiresPassword = true;
          }
          
          await userInvited.save();
          
          // Ajouter l'accès au board
          await userInvited.addBoardAccess(share.boardId, share._id, share.workspaceId);
        }
        
        // Générer un token de session
        const sessionToken = await userInvited.generateSessionToken();
        
        // Mettre à jour PublicBoardShare.visitors pour compatibilité
        await updatePublicBoardShareVisitor(share, userInvited);
        
        logger.info(`✅ [UserInvited] Authentification réussie: ${userInvited._id}`);
        
        return {
          success: true,
          message: isNewUser ? 'Compte créé avec succès' : 'Connexion réussie',
          userInvited: userInvited.getPublicInfo(),
          sessionToken,
          isNewUser,
          requiresPassword: userInvited.requiresPassword,
          linkedUser: linkedUser,
          isBanned: false
        };
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur authenticateInvitedUser:', error);
        return {
          success: false,
          message: error.message || 'Erreur lors de l\'authentification'
        };
      }
    },
    
    // Définir ou modifier le mot de passe
    setInvitedUserPassword: async (_, { input }) => {
      const { email, currentPassword, newPassword } = input;
      
      try {
        const normalizedEmail = email.toLowerCase().trim();
        const userInvited = await UserInvited.findOne({ email: normalizedEmail });
        
        if (!userInvited) {
          return {
            success: false,
            message: 'Utilisateur non trouvé'
          };
        }
        
        // Si l'utilisateur a déjà un mot de passe, vérifier l'ancien
        if (userInvited.requiresPassword && userInvited.password) {
          if (!currentPassword) {
            return {
              success: false,
              message: 'Mot de passe actuel requis'
            };
          }
          
          const isValid = await userInvited.comparePassword(currentPassword);
          if (!isValid) {
            return {
              success: false,
              message: 'Mot de passe actuel incorrect'
            };
          }
        }
        
        // Définir le nouveau mot de passe
        await userInvited.setPassword(newPassword);
        
        logger.info(`🔒 [UserInvited] Mot de passe défini pour: ${normalizedEmail}`);
        
        return {
          success: true,
          message: 'Mot de passe défini avec succès',
          userInvited: userInvited.getPublicInfo(),
          requiresPassword: true
        };
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur setInvitedUserPassword:', error);
        return {
          success: false,
          message: error.message || 'Erreur lors de la définition du mot de passe'
        };
      }
    },
    
    // Supprimer le mot de passe
    removeInvitedUserPassword: async (_, { email, currentPassword }) => {
      try {
        const normalizedEmail = email.toLowerCase().trim();
        const userInvited = await UserInvited.findOne({ email: normalizedEmail });
        
        if (!userInvited) {
          return {
            success: false,
            message: 'Utilisateur non trouvé'
          };
        }
        
        // Vérifier le mot de passe actuel
        if (userInvited.requiresPassword) {
          const isValid = await userInvited.comparePassword(currentPassword);
          if (!isValid) {
            return {
              success: false,
              message: 'Mot de passe incorrect'
            };
          }
        }
        
        // Supprimer le mot de passe
        await userInvited.removePassword();
        
        logger.info(`🔓 [UserInvited] Mot de passe supprimé pour: ${normalizedEmail}`);
        
        return {
          success: true,
          message: 'Mot de passe supprimé avec succès',
          userInvited: userInvited.getPublicInfo(),
          requiresPassword: false
        };
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur removeInvitedUserPassword:', error);
        return {
          success: false,
          message: error.message || 'Erreur lors de la suppression du mot de passe'
        };
      }
    },
    
    // Mettre à jour le profil
    updateInvitedUserProfile: async (_, { email, input }) => {
      try {
        const normalizedEmail = email.toLowerCase().trim();
        const userInvited = await UserInvited.findOne({ email: normalizedEmail });
        
        if (!userInvited) {
          throw new GraphQLError('Utilisateur non trouvé');
        }
        
        // Mettre à jour les champs
        if (input.firstName !== undefined) userInvited.firstName = input.firstName;
        if (input.lastName !== undefined) userInvited.lastName = input.lastName;
        if (input.image !== undefined) userInvited.image = input.image;
        
        await userInvited.save();
        
        // Mettre à jour aussi dans PublicBoardShare.visitors pour compatibilité
        await updateAllPublicBoardShareVisitors(userInvited);
        
        logger.info(`📝 [UserInvited] Profil mis à jour: ${normalizedEmail}`);
        
        return userInvited.getPublicInfo();
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur updateInvitedUserProfile:', error);
        throw new GraphQLError(error.message || 'Erreur lors de la mise à jour du profil');
      }
    },
    
    // Bannir d'un board
    banInvitedUserFromBoard: async (_, { userInvitedId, boardId, reason, workspaceId }, { user }) => {
      try {
        const userInvited = await UserInvited.findById(userInvitedId);
        
        if (!userInvited) {
          throw new GraphQLError('Utilisateur invité non trouvé');
        }
        
        await userInvited.banFromBoard(boardId, reason);
        
        // Mettre à jour aussi dans PublicBoardShare
        const share = await PublicBoardShare.findOne({ boardId });
        if (share) {
          // Ajouter à la liste des emails bannis
          const alreadyBanned = share.bannedEmails.some(
            b => b.email === userInvited.email
          );
          if (!alreadyBanned) {
            share.bannedEmails.push({
              email: userInvited.email,
              bannedAt: new Date(),
              reason
            });
            await share.save();
          }
        }
        
        logger.info(`🚫 [UserInvited] Utilisateur banni: ${userInvited.email} du board ${boardId}`);
        
        return userInvited.getPublicInfo();
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur banInvitedUserFromBoard:', error);
        throw new GraphQLError(error.message || 'Erreur lors du bannissement');
      }
    },
    
    // Débannir d'un board
    unbanInvitedUserFromBoard: async (_, { userInvitedId, boardId, workspaceId }, { user }) => {
      try {
        const userInvited = await UserInvited.findById(userInvitedId);
        
        if (!userInvited) {
          throw new GraphQLError('Utilisateur invité non trouvé');
        }
        
        await userInvited.unbanFromBoard(boardId);
        
        // Mettre à jour aussi dans PublicBoardShare
        const share = await PublicBoardShare.findOne({ boardId });
        if (share) {
          share.bannedEmails = share.bannedEmails.filter(
            b => b.email !== userInvited.email
          );
          await share.save();
        }
        
        logger.info(`✅ [UserInvited] Utilisateur débanni: ${userInvited.email} du board ${boardId}`);
        
        return userInvited.getPublicInfo();
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur unbanInvitedUserFromBoard:', error);
        throw new GraphQLError(error.message || 'Erreur lors du débannissement');
      }
    },
    
    // Déconnecter
    logoutInvitedUser: async (_, { sessionToken }) => {
      try {
        const userInvited = await UserInvited.findOne({ sessionToken });
        
        if (userInvited) {
          await userInvited.invalidateSession();
          logger.info(`👋 [UserInvited] Déconnexion: ${userInvited.email}`);
        }
        
        return true;
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur logoutInvitedUser:', error);
        return false;
      }
    },
    
    // Lier manuellement à un compte Newbi
    linkInvitedUserToNewbi: async (_, { userInvitedId, newbiUserId }, { db }) => {
      try {
        const userInvited = await UserInvited.findById(userInvitedId);
        
        if (!userInvited) {
          throw new GraphQLError('Utilisateur invité non trouvé');
        }
        
        const newbiUser = await db.collection('user').findOne({
          _id: new mongoose.Types.ObjectId(newbiUserId)
        });
        
        if (!newbiUser) {
          throw new GraphQLError('Compte Newbi non trouvé');
        }
        
        await userInvited.linkToNewbiUser(newbiUser);
        
        logger.info(`🔗 [UserInvited] Lié à Newbi: ${userInvited.email} -> ${newbiUserId}`);
        
        return userInvited.getPublicInfo();
        
      } catch (error) {
        logger.error('❌ [UserInvited] Erreur linkInvitedUserToNewbi:', error);
        throw new GraphQLError(error.message || 'Erreur lors de la liaison');
      }
    }
  },
  
  // Resolvers de champs
  UserInvited: {
    linkedUser: async (parent, _, { db }) => {
      if (!parent.linkedUserId) return null;
      return getLinkedUserInfo(db, parent.linkedUserId);
    }
  }
};

// Helper pour mettre à jour PublicBoardShare.visitors (compatibilité)
async function updatePublicBoardShareVisitor(share, userInvited) {
  try {
    const visitorIndex = share.visitors.findIndex(
      v => v.email === userInvited.email
    );
    
    const visitorData = {
      email: userInvited.email,
      firstName: userInvited.firstName,
      lastName: userInvited.lastName,
      name: userInvited.name,
      image: userInvited.image,
      lastVisitAt: new Date()
    };
    
    if (visitorIndex >= 0) {
      // Mettre à jour le visiteur existant
      share.visitors[visitorIndex] = {
        ...share.visitors[visitorIndex].toObject(),
        ...visitorData,
        visitCount: (share.visitors[visitorIndex].visitCount || 0) + 1
      };
    } else {
      // Ajouter un nouveau visiteur
      share.visitors.push({
        ...visitorData,
        firstVisitAt: new Date(),
        visitCount: 1
      });
    }
    
    await share.save();
  } catch (error) {
    logger.error('❌ [UserInvited] Erreur mise à jour PublicBoardShare.visitors:', error);
  }
}

// Helper pour mettre à jour tous les PublicBoardShare.visitors
async function updateAllPublicBoardShareVisitors(userInvited) {
  try {
    const boardIds = userInvited.boardsAccess.map(b => b.boardId);
    
    await PublicBoardShare.updateMany(
      { 
        boardId: { $in: boardIds },
        'visitors.email': userInvited.email
      },
      {
        $set: {
          'visitors.$.firstName': userInvited.firstName,
          'visitors.$.lastName': userInvited.lastName,
          'visitors.$.name': userInvited.name,
          'visitors.$.image': userInvited.image
        }
      }
    );
  } catch (error) {
    logger.error('❌ [UserInvited] Erreur mise à jour tous les PublicBoardShare.visitors:', error);
  }
}

export default userInvitedResolvers;
