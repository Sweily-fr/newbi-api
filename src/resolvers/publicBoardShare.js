// resolvers/publicBoardShare.js
import PublicBoardShare from '../models/PublicBoardShare.js';
import { Board, Column, Task } from '../models/kanban.js';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import { getPubSub } from '../config/redis.js';

// Événements de subscription (même que kanban.js)
const TASK_UPDATED = 'TASK_UPDATED';

// Fonction utilitaire pour publier en toute sécurité
const safePublish = (channel, payload, context = '') => {
  try {
    const pubsub = getPubSub();
    pubsub.publish(channel, payload).catch((error) => {
      logger.error(`❌ [PublicShare] Erreur publication ${context}:`, error);
    });
    logger.debug(`📢 [PublicShare] ${context} publié sur ${channel}`);
  } catch (error) {
    logger.error(`❌ [PublicShare] Erreur getPubSub ${context}:`, error);
  }
};

// URL de base pour les liens de partage (à configurer dans les variables d'environnement)
const getBaseUrl = () => process.env.FRONTEND_URL || 'http://localhost:3000';

const resolvers = {
  Query: {
    // Récupérer les liens de partage d'un tableau (utilisateurs connectés)
    getPublicShares: withWorkspace(
      async (_, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const shares = await PublicBoardShare.find({
          boardId,
          workspaceId: finalWorkspaceId
        }).sort({ createdAt: -1 });
        
        return shares.map(share => ({
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        }));
      }
    ),
    
    // Accéder au tableau via le token (visiteurs externes)
    getPublicBoard: async (_, { token, email, password }) => {
      try {
        logger.info(`🔓 [PublicShare] Accès demandé avec token: ${token.substring(0, 8)}...`);
        
        // Trouver le lien de partage
        const share = await PublicBoardShare.findOne({ token });
        
        if (!share) {
          return {
            success: false,
            message: "Lien de partage invalide ou expiré"
          };
        }
        
        // Vérifier si le lien est valide
        if (!share.isValid()) {
          return {
            success: false,
            message: "Ce lien de partage a expiré ou a été désactivé"
          };
        }
        
        // Vérifier le mot de passe si nécessaire
        if (share.password && share.password !== password) {
          return {
            success: false,
            message: "Mot de passe incorrect"
          };
        }
        
        // Enregistrer la visite
        await share.recordVisit(email);
        
        // Récupérer le tableau
        const board = await Board.findById(share.boardId);
        if (!board) {
          return {
            success: false,
            message: "Le tableau n'existe plus"
          };
        }
        
        // Récupérer les colonnes
        const columns = await Column.find({ boardId: share.boardId }).sort("order");
        
        // Récupérer les tâches
        const tasks = await Task.find({ boardId: share.boardId }).sort("position");
        
        // Récupérer les infos des membres assignés ET des auteurs de commentaires
        let membersMap = {};
        const db = mongoose.connection.db;
        const allMemberIds = [...new Set(tasks.flatMap(t => t.assignedMembers || []))];
        
        // Collecter aussi les userIds des commentaires non-externes
        const commentUserIds = [...new Set(
          tasks.flatMap(t => (t.comments || [])
            .filter(c => !c.isExternal && c.userId)
            .map(c => c.userId.toString())
          )
        )];
        
        // Combiner tous les IDs à récupérer
        const allUserIds = [...new Set([...allMemberIds, ...commentUserIds])];
        
        if (allUserIds.length > 0) {
          const objectIds = allUserIds.map(id => {
            try {
              return new mongoose.Types.ObjectId(id);
            } catch {
              return null;
            }
          }).filter(Boolean);
          
          const users = await db.collection('user').find({
            _id: { $in: objectIds }
          }).toArray();
          
          users.forEach(user => {
            membersMap[user._id.toString()] = {
              id: user._id.toString(),
              name: user.name || user.email || 'Utilisateur',
              image: user.image || user.avatar || null
            };
          });
        }
        
        // Formater les tâches - les invités voient tout (lecture seule)
        const publicTasks = tasks.map(task => ({
          id: task._id.toString(),
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          tags: task.tags,
          startDate: task.startDate,
          dueDate: task.dueDate,
          columnId: task.columnId,
          position: task.position,
          checklist: task.checklist,
          assignedMembers: (task.assignedMembers || []).map(memberId => 
            membersMap[memberId] || { id: memberId, name: 'Membre', image: null }
          ),
          comments: (task.comments || []).map(comment => {
            // Pour les commentaires externes, récupérer les infos du visiteur depuis share.visitors
            if (comment.isExternal && comment.userEmail) {
              const visitor = share.visitors?.find(v => v.email?.toLowerCase() === comment.userEmail.toLowerCase());
              return {
                id: comment._id?.toString(),
                userName: visitor?.name || visitor?.firstName || comment.userName || comment.userEmail.split('@')[0],
                userEmail: comment.userEmail,
                userImage: visitor?.image || comment.userImage || null,
                content: comment.content,
                isExternal: true,
                createdAt: comment.createdAt
              };
            }
            // Pour les commentaires non-externes, récupérer l'image depuis membersMap
            const userInfo = comment.userId ? membersMap[comment.userId.toString()] : null;
            return {
              id: comment._id?.toString(),
              userName: comment.userName || userInfo?.name || 'Utilisateur',
              userEmail: comment.userEmail || null,
              userImage: comment.userImage || userInfo?.image || null,
              content: comment.content,
              isExternal: comment.isExternal || false,
              createdAt: comment.createdAt
            };
          }),
          timeTracking: task.timeTracking ? {
            totalSeconds: task.timeTracking.totalSeconds || 0,
            isRunning: task.timeTracking.isRunning || false,
            hourlyRate: task.timeTracking.hourlyRate
          } : null,
          userId: task.userId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt
        }));
        
        // Formater les colonnes
        const publicColumns = columns.map(col => ({
          id: col._id.toString(),
          title: col.title,
          color: col.color,
          order: col.order
        }));
        
        // Formater les membres pour le board
        const publicMembers = Object.values(membersMap);
        
        return {
          success: true,
          board: {
            id: board._id.toString(),
            title: board.title,
            description: board.description,
            columns: publicColumns,
            tasks: publicTasks,
            members: publicMembers
          },
          share: {
            ...share.toObject(),
            id: share._id.toString(),
            hasPassword: !!share.password,
            shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
          },
          visitorEmail: email
        };
      } catch (error) {
        logger.error("❌ [PublicShare] Erreur accès public:", error);
        return {
          success: false,
          message: "Une erreur est survenue"
        };
      }
    },
    
    // Vérifier si un token est valide (sans email)
    validatePublicToken: async (_, { token }) => {
      try {
        const share = await PublicBoardShare.findOne({ token });
        return share ? share.isValid() : false;
      } catch {
        return false;
      }
    }
  },
  
  Mutation: {
    // Créer un lien de partage
    createPublicShare: withWorkspace(
      async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        // Vérifier que le tableau existe
        const board = await Board.findOne({
          _id: input.boardId,
          workspaceId: finalWorkspaceId
        });
        
        if (!board) {
          throw new Error("Tableau non trouvé");
        }
        
        // Générer un token unique
        const token = PublicBoardShare.generateToken();
        
        // Créer le lien de partage
        const share = new PublicBoardShare({
          token,
          boardId: input.boardId,
          workspaceId: finalWorkspaceId,
          createdBy: user.id,
          name: input.name,
          permissions: {
            canViewTasks: input.permissions?.canViewTasks ?? true,
            canComment: input.permissions?.canComment ?? true,
            canViewComments: input.permissions?.canViewComments ?? true,
            canViewAssignees: input.permissions?.canViewAssignees ?? true,
            canViewDueDates: input.permissions?.canViewDueDates ?? true,
            canViewAttachments: input.permissions?.canViewAttachments ?? true
          },
          expiresAt: input.expiresAt,
          password: input.password
        });
        
        await share.save();
        
        logger.info(`✅ [PublicShare] Lien créé pour le tableau ${input.boardId}`);
        
        return {
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        };
      }
    ),
    
    // Mettre à jour un lien de partage
    updatePublicShare: withWorkspace(
      async (_, { input, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const updates = {};
        if (input.name !== undefined) updates.name = input.name;
        if (input.isActive !== undefined) updates.isActive = input.isActive;
        if (input.expiresAt !== undefined) updates.expiresAt = input.expiresAt;
        if (input.password !== undefined) updates.password = input.password;
        if (input.permissions) {
          updates.permissions = input.permissions;
        }
        
        const share = await PublicBoardShare.findOneAndUpdate(
          { _id: input.id, workspaceId: finalWorkspaceId },
          { ...updates, updatedAt: new Date() },
          { new: true }
        );
        
        if (!share) {
          throw new Error("Lien de partage non trouvé");
        }
        
        return {
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        };
      }
    ),
    
    // Supprimer un lien de partage
    deletePublicShare: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const result = await PublicBoardShare.deleteOne({
          _id: id,
          workspaceId: finalWorkspaceId
        });
        
        return result.deletedCount > 0;
      }
    ),
    
    // Révoquer un lien de partage (désactiver sans supprimer)
    revokePublicShare: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const share = await PublicBoardShare.findOneAndUpdate(
          { _id: id, workspaceId: finalWorkspaceId },
          { isActive: false, updatedAt: new Date() },
          { new: true }
        );
        
        return !!share;
      }
    ),
    
    // Ajouter un commentaire externe
    addExternalComment: async (_, { token, taskId, content, visitorEmail }) => {
      try {
        // Vérifier le lien de partage
        const share = await PublicBoardShare.findOne({ token });
        
        if (!share || !share.isValid()) {
          return {
            success: false,
            message: "Lien de partage invalide ou expiré"
          };
        }
        
        if (!share.permissions.canComment) {
          return {
            success: false,
            message: "Les commentaires ne sont pas autorisés sur ce tableau"
          };
        }
        
        // Vérifier que la tâche appartient au tableau partagé
        const task = await Task.findOne({
          _id: taskId,
          boardId: share.boardId
        });
        
        if (!task) {
          return {
            success: false,
            message: "Tâche non trouvée"
          };
        }
        
        // Récupérer les infos du visiteur depuis le share
        const visitor = share.visitors?.find(v => v.email?.toLowerCase() === visitorEmail.toLowerCase());
        const userName = visitor?.name || visitor?.firstName || visitorEmail.split("@")[0];
        const userImage = visitor?.image || null;
        
        // Ajouter le commentaire avec l'image du visiteur
        const newComment = {
          userId: `external_${visitorEmail}`,
          userName: userName,
          userEmail: visitorEmail,
          userImage: userImage,
          content: content.trim(),
          isExternal: true,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        
        task.comments = task.comments || [];
        task.comments.push(newComment);
        
        // Ajouter une entrée d'activité
        task.activity = task.activity || [];
        task.activity.push({
          userId: `external_${visitorEmail}`,
          userName: userName,
          type: "comment_added",
          description: "a ajouté un commentaire (visiteur externe)",
          createdAt: new Date()
        });
        
        await task.save();
        
        // Incrémenter le compteur de commentaires
        await share.incrementCommentCount();
        
        logger.info(`💬 [PublicShare] Commentaire externe ajouté par ${visitorEmail}`);
        
        // Publier la mise à jour en temps réel via Redis
        // IMPORTANT: Inclure TOUS les champs requis par le type Task pour la subscription kanban
        const taskPayload = {
          id: task._id.toString(),
          _id: task._id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          tags: task.tags || [],
          startDate: task.startDate,
          dueDate: task.dueDate,
          boardId: share.boardId.toString(),
          columnId: task.columnId.toString(),
          position: task.position,
          checklist: task.checklist || [],
          assignedMembers: task.assignedMembers || [],
          comments: task.comments.map(c => ({
            id: c._id?.toString(),
            _id: c._id,
            userId: c.userId || 'unknown',
            userName: c.userName || 'Utilisateur',
            userEmail: c.userEmail || null,
            userImage: c.userImage || null,
            content: c.content,
            isExternal: c.isExternal || false,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          })),
          activity: task.activity || [],
          timeTracking: task.timeTracking ? {
            totalSeconds: task.timeTracking.totalSeconds || 0,
            isRunning: task.timeTracking.isRunning || false,
            currentStartTime: task.timeTracking.currentStartTime,
            startedBy: task.timeTracking.startedBy,
            entries: (task.timeTracking.entries || []).map(e => ({
              id: e._id?.toString() || e.id,
              startTime: e.startTime,
              endTime: e.endTime,
              duration: e.duration || 0
            })),
            hourlyRate: task.timeTracking.hourlyRate,
            roundingOption: task.timeTracking.roundingOption
          } : null,
          userId: task.userId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt
        };
        
        // Publier sur le canal du workspace+board pour que tous les clients reçoivent la mise à jour
        // Le canal doit être le même que celui utilisé par le kanban: TASK_UPDATED_workspaceId_boardId
        const channel = `${TASK_UPDATED}_${share.workspaceId}_${share.boardId}`;
        logger.info(`📡 [PublicShare] Publication sur canal: ${channel}`);
        
        safePublish(
          channel,
          {
            type: 'UPDATED',
            task: taskPayload,
            taskId: task._id.toString(),
            boardId: share.boardId.toString(),
            workspaceId: share.workspaceId.toString()
          },
          'Commentaire externe ajouté'
        );
        
        logger.info(`✅ [PublicShare] Événement UPDATED publié pour tâche ${task._id}`);
        
        // Retourner la tâche mise à jour
        return {
          success: true,
          task: {
            id: task._id.toString(),
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            tags: task.tags,
            dueDate: task.dueDate,
            columnId: task.columnId,
            position: task.position,
            checklist: task.checklist,
            assignedMembers: [],
            comments: task.comments.map(c => ({
              id: c._id?.toString(),
              userName: c.userName || "Utilisateur",
              userEmail: c.userEmail || null,
              content: c.content,
              isExternal: c.isExternal || false,
              createdAt: c.createdAt
            }))
          }
        };
      } catch (error) {
        logger.error("❌ [PublicShare] Erreur ajout commentaire externe:", error);
        return {
          success: false,
          message: "Une erreur est survenue"
        };
      }
    },
    
    // Mutation pour mettre à jour le profil d'un visiteur externe
    updateVisitorProfile: async (_, { token, email, input }) => {
      try {
        const share = await PublicBoardShare.findOne({ token, isActive: true });
        
        if (!share) {
          return {
            success: false,
            message: "Lien de partage invalide ou expiré"
          };
        }
        
        // Trouver le visiteur par email
        const visitorIndex = share.visitors.findIndex(v => v.email === email.toLowerCase());
        
        if (visitorIndex === -1) {
          return {
            success: false,
            message: "Visiteur non trouvé"
          };
        }
        
        // Mettre à jour le profil
        const visitor = share.visitors[visitorIndex];
        
        if (input.firstName !== undefined) {
          visitor.firstName = input.firstName;
        }
        if (input.lastName !== undefined) {
          visitor.lastName = input.lastName;
        }
        if (input.image !== undefined) {
          visitor.image = input.image;
        }
        
        // Mettre à jour le nom complet
        if (input.firstName || input.lastName) {
          visitor.name = [input.firstName, input.lastName].filter(Boolean).join(' ') || visitor.email.split('@')[0];
        }
        
        await share.save();
        
        logger.info(`👤 [PublicShare] Profil visiteur mis à jour: ${email}`);
        
        return {
          success: true,
          message: "Profil mis à jour avec succès",
          visitor: {
            id: visitor._id.toString(),
            email: visitor.email,
            firstName: visitor.firstName,
            lastName: visitor.lastName,
            name: visitor.name,
            image: visitor.image,
            firstVisitAt: visitor.firstVisitAt,
            lastVisitAt: visitor.lastVisitAt,
            visitCount: visitor.visitCount
          }
        };
      } catch (error) {
        logger.error("❌ [PublicShare] Erreur mise à jour profil visiteur:", error);
        return {
          success: false,
          message: "Une erreur est survenue"
        };
      }
    }
  },
  
  // Resolvers de type pour PublicBoardShare
  PublicBoardShare: {
    id: (parent) => parent._id?.toString() || parent.id,
    hasPassword: (parent) => !!parent.password,
    shareUrl: (parent) => `${getBaseUrl()}/public/kanban/${parent.token}`
  },
  
  // Subscription pour les mises à jour en temps réel sur la page publique
  Subscription: {
    publicTaskUpdated: {
      subscribe: async (_, { token, boardId }) => {
        try {
          // Vérifier que le token est valide
          const share = await PublicBoardShare.findOne({ token, isActive: true });
          if (!share) {
            throw new Error('Lien de partage invalide ou expiré');
          }
          
          // Vérifier que le boardId correspond
          if (share.boardId.toString() !== boardId) {
            throw new Error('Board ID invalide');
          }
          
          const pubsub = getPubSub();
          // S'abonner au canal du workspace+board pour recevoir les mises à jour
          // Le canal doit être le même que celui utilisé par le kanban: TASK_UPDATED_workspaceId_boardId
          const channel = `${TASK_UPDATED}_${share.workspaceId}_${share.boardId}`;
          logger.debug(`📡 [PublicShare] Subscription au canal: ${channel}`);
          
          return pubsub.asyncIterator([channel]);
        } catch (error) {
          logger.error('❌ [PublicShare] Erreur subscription publicTaskUpdated:', error);
          throw error;
        }
      },
      resolve: async (payload) => {
        // Transformer le payload pour correspondre au type PublicTaskUpdatePayload
        logger.info(`📡 [PublicShare] Subscription resolve - type: ${payload.type}, taskId: ${payload.taskId}`);
        
        const task = payload.task;
        if (!task) {
          logger.warn('⚠️ [PublicShare] Subscription resolve - task is null');
          return {
            type: payload.type,
            task: null,
            taskId: payload.taskId,
            boardId: payload.boardId
          };
        }
        
        const db = mongoose.connection.db;
        let usersMap = {};
        
        // Récupérer le share pour enrichir les commentaires externes avec les infos des visiteurs
        let visitorsMap = {};
        try {
          const share = await PublicBoardShare.findOne({ boardId: payload.boardId, isActive: true });
          if (share?.visitors) {
            share.visitors.forEach(v => {
              if (v.email) {
                visitorsMap[v.email.toLowerCase()] = {
                  name: v.name || v.firstName || v.email.split('@')[0],
                  image: v.image || null
                };
              }
            });
          }
        } catch (error) {
          logger.error('❌ [PublicShare] Erreur récupération share pour visiteurs:', error);
        }
        
        // Collecter tous les userIds à enrichir (membres + commentaires)
        const memberIds = task.assignedMembers || [];
        const comments = task.comments || [];
        const allUserIds = new Set();
        
        // Ajouter les IDs des membres assignés
        memberIds.forEach(id => {
          if (typeof id === 'string') allUserIds.add(id);
          else if (id && typeof id === 'object' && !id.name) allUserIds.add(id.toString());
        });
        
        // Ajouter les IDs des auteurs de commentaires (toujours, pour avoir userImage)
        comments.forEach(c => {
          if (c.userId && !c.isExternal) allUserIds.add(c.userId.toString());
        });
        
        // Récupérer les infos de tous les utilisateurs en une seule requête
        if (allUserIds.size > 0) {
          try {
            const objectIds = [...allUserIds].map(id => {
              try {
                return new mongoose.Types.ObjectId(id);
              } catch {
                return null;
              }
            }).filter(Boolean);
            
            if (objectIds.length > 0) {
              const users = await db.collection('user').find({
                _id: { $in: objectIds }
              }).toArray();
              
              users.forEach(user => {
                usersMap[user._id.toString()] = {
                  id: user._id.toString(),
                  name: user.name || user.email || 'Utilisateur',
                  image: user.image || user.avatar || null
                };
              });
            }
          } catch (error) {
            logger.error('❌ [PublicShare] Erreur récupération utilisateurs:', error);
          }
        }
        
        // Enrichir les assignedMembers
        let enrichedMembers = [];
        if (memberIds.length > 0) {
          const isAlreadyEnriched = memberIds[0] && typeof memberIds[0] === 'object' && memberIds[0].name;
          if (isAlreadyEnriched) {
            enrichedMembers = memberIds.map(m => ({
              id: m.id || m._id?.toString() || 'unknown',
              name: m.name || 'Membre',
              image: m.image || null
            }));
          } else {
            enrichedMembers = memberIds.map(id => {
              const idStr = typeof id === 'object' ? id.toString() : id;
              return usersMap[idStr] || { id: idStr, name: 'Membre', image: null };
            });
          }
        }
        
        // Enrichir les commentaires
        const enrichedComments = comments.map(c => {
          // Si c'est un commentaire externe, enrichir avec les infos du visiteur
          if (c.isExternal && c.userEmail) {
            const visitorInfo = visitorsMap[c.userEmail.toLowerCase()];
            return {
              id: c._id?.toString() || c.id,
              userName: visitorInfo?.name || c.userName || c.userEmail.split('@')[0],
              userEmail: c.userEmail,
              userImage: visitorInfo?.image || c.userImage || null,
              content: c.content,
              isExternal: true,
              createdAt: c.createdAt
            };
          }
          
          // Sinon, enrichir avec les infos de l'utilisateur
          const userInfo = c.userId ? usersMap[c.userId.toString()] : null;
          return {
            id: c._id?.toString() || c.id,
            userName: c.userName || userInfo?.name || 'Utilisateur',
            userEmail: c.userEmail || null,
            userImage: c.userImage || userInfo?.image || null,
            content: c.content,
            isExternal: false,
            createdAt: c.createdAt
          };
        });
        
        // Construire l'objet task enrichi avec tous les champs de PublicTask
        const enrichedTask = {
          id: task._id?.toString() || task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          tags: task.tags || [],
          startDate: task.startDate,
          dueDate: task.dueDate,
          columnId: task.columnId?.toString() || task.columnId,
          position: task.position,
          checklist: task.checklist || [],
          assignedMembers: enrichedMembers,
          comments: enrichedComments,
          timeTracking: task.timeTracking ? {
            totalSeconds: task.timeTracking.totalSeconds || 0,
            isRunning: task.timeTracking.isRunning || false,
            hourlyRate: task.timeTracking.hourlyRate
          } : null,
          userId: task.userId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          __typename: 'PublicTask'
        };
        
        logger.info(`✅ [PublicShare] Subscription resolve terminé - ${enrichedComments.length} commentaires enrichis`);
        
        return {
          type: payload.type,
          task: enrichedTask,
          taskId: enrichedTask.id,
          boardId: task.boardId?.toString() || payload.boardId
        };
      }
    }
  }
};

export default resolvers;
