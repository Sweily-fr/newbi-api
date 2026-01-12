// resolvers/publicBoardShare.js
import PublicBoardShare from '../models/PublicBoardShare.js';
import { Board, Column, Task } from '../models/kanban.js';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import { getPubSub } from '../config/redis.js';
import cloudflareService from '../services/cloudflareService.js';

// Événements de subscription (même que kanban.js)
const TASK_UPDATED = 'TASK_UPDATED';
const PUBLIC_VISITOR_UPDATED = 'PUBLIC_VISITOR_UPDATED';

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
        
        return shares.map(share => {
          const shareObj = share.toObject();
          return {
            ...shareObj,
            id: share._id.toString(),
            hasPassword: !!share.password,
            shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`,
            // S'assurer que chaque visiteur a un id
            visitors: (shareObj.visitors || []).map(v => ({
              ...v,
              id: v._id?.toString() || v.email || 'unknown',
              firstVisitAt: v.firstVisitAt || new Date(),
              lastVisitAt: v.lastVisitAt || new Date(),
              visitCount: v.visitCount || 1
            })),
            // Inclure les emails bannis
            bannedEmails: shareObj.bannedEmails || [],
            // Inclure les demandes d'accès avec id
            accessRequests: (shareObj.accessRequests || []).map(r => ({
              ...r,
              id: r._id?.toString() || r.id
            }))
          };
        });
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
        
        // Vérifier si l'email est banni
        const emailLower = email.toLowerCase();
        const isBanned = (share.bannedEmails || []).some(b => b.email === emailLower);
        if (isBanned) {
          return {
            success: false,
            message: "BANNED",
            isBanned: true
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
        let emailToUserMap = {};
        const db = mongoose.connection.db;
        const allMemberIds = [...new Set(tasks.flatMap(t => t.assignedMembers || []))];
        
        // Collecter aussi les userIds des commentaires non-externes
        const commentUserIds = [...new Set(
          tasks.flatMap(t => (t.comments || [])
            .filter(c => !c.isExternal && c.userId)
            .map(c => c.userId.toString())
          )
        )];
        
        // Collecter les emails des commentaires non-externes sans userId
        const commentEmails = [...new Set(
          tasks.flatMap(t => (t.comments || [])
            .filter(c => !c.isExternal && !c.userId && c.userEmail)
            .map(c => c.userEmail.toLowerCase())
          )
        )];
        
        // Combiner tous les IDs à récupérer
        const allUserIds = [...new Set([...allMemberIds, ...commentUserIds])];
        
        if (allUserIds.length > 0 || commentEmails.length > 0) {
          const objectIds = allUserIds.map(id => {
            try {
              return new mongoose.Types.ObjectId(id);
            } catch {
              return null;
            }
          }).filter(Boolean);
          
          // Construire la requête pour récupérer par ID ou par email
          const query = { $or: [] };
          if (objectIds.length > 0) {
            query.$or.push({ _id: { $in: objectIds } });
          }
          if (commentEmails.length > 0) {
            query.$or.push({ email: { $in: commentEmails } });
          }
          
          if (query.$or.length > 0) {
            const users = await db.collection('user').find(query).toArray();
            
            users.forEach(user => {
              membersMap[user._id.toString()] = {
                id: user._id.toString(),
                name: user.name || user.email || 'Utilisateur',
                image: user.image || user.avatar || null
              };
              // Aussi mapper par email pour les commentaires sans userId
              if (user.email) {
                emailToUserMap[user.email.toLowerCase()] = {
                  id: user._id.toString(),
                  name: user.name || user.email || 'Utilisateur',
                  image: user.image || user.avatar || null
                };
              }
            });
          }
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
          images: (task.images || []).map(img => ({
            id: img._id?.toString() || img.id,
            key: img.key,
            url: img.url,
            fileName: img.fileName,
            fileSize: img.fileSize,
            contentType: img.contentType,
            uploadedBy: img.uploadedBy,
            uploadedAt: img.uploadedAt
          })),
          assignedMembers: (task.assignedMembers || []).map(memberId => 
            membersMap[memberId] || { id: memberId, name: 'Membre', image: null }
          ),
          comments: (task.comments || []).map(comment => {
            // Formater les images du commentaire
            const commentImages = (comment.images || []).map(img => ({
              id: img._id?.toString() || img.id,
              key: img.key,
              url: img.url,
              fileName: img.fileName,
              fileSize: img.fileSize,
              contentType: img.contentType,
              uploadedBy: img.uploadedBy,
              uploadedAt: img.uploadedAt
            }));
            
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
                images: commentImages,
                createdAt: comment.createdAt
              };
            }
            // Pour les commentaires non-externes, récupérer l'info depuis membersMap ou emailToUserMap
            let userInfo = comment.userId ? membersMap[comment.userId.toString()] : null;
            // Si pas trouvé par userId, essayer par email
            if (!userInfo && comment.userEmail) {
              userInfo = emailToUserMap[comment.userEmail.toLowerCase()];
            }
            return {
              id: comment._id?.toString(),
              userName: userInfo?.name || comment.userName || (comment.userEmail ? comment.userEmail.split('@')[0] : 'Utilisateur'),
              userEmail: comment.userEmail || null,
              userImage: userInfo?.image || comment.userImage || null,
              content: comment.content,
              isExternal: comment.isExternal || false,
              images: commentImages,
              createdAt: comment.createdAt
            };
          }),
          timeTracking: task.timeTracking ? {
            totalSeconds: task.timeTracking.totalSeconds || 0,
            isRunning: task.timeTracking.isRunning || false,
            currentStartTime: task.timeTracking.currentStartTime,
            hourlyRate: task.timeTracking.hourlyRate,
            startedBy: task.timeTracking.startedBy ? {
              userId: task.timeTracking.startedBy.userId,
              userName: task.timeTracking.startedBy.userName,
              userImage: task.timeTracking.startedBy.userImage
            } : null
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
        
        // Publier la présence du visiteur (connecté)
        const visitorInfo = share.visitors?.find(v => v.email === emailLower);
        safePublish('VISITOR_PRESENCE', {
          visitorPresence: {
            email: emailLower,
            name: visitorInfo?.name || visitorInfo?.firstName || email.split('@')[0],
            image: visitorInfo?.image || null,
            boardId: board._id.toString(),
            isConnected: true
          }
        }, `Visiteur ${emailLower} connecté`);
        
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
    
    // Révoquer l'accès d'un visiteur spécifique (le bannit)
    revokeVisitorAccess: withWorkspace(
      async (_, { shareId, visitorEmail, reason, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const share = await PublicBoardShare.findOne({
          _id: shareId,
          workspaceId: finalWorkspaceId
        });
        
        if (!share) {
          throw new Error('Lien de partage non trouvé');
        }
        
        const emailLower = visitorEmail.toLowerCase();
        
        // Retirer le visiteur de la liste
        share.visitors = share.visitors.filter(v => 
          v.email?.toLowerCase() !== emailLower
        );
        
        // Ajouter l'email à la liste des bannis
        if (!share.bannedEmails) {
          share.bannedEmails = [];
        }
        
        // Vérifier si l'email n'est pas déjà banni
        const alreadyBanned = share.bannedEmails.some(b => b.email === emailLower);
        if (!alreadyBanned) {
          share.bannedEmails.push({
            email: emailLower,
            bannedAt: new Date(),
            reason: reason || 'Accès révoqué par le propriétaire'
          });
        }
        
        share.updatedAt = new Date();
        
        await share.save();
        
        logger.info(`✅ [PublicShare] Accès révoqué et banni pour ${visitorEmail}`);
        
        // Publier l'événement pour déconnecter le visiteur en temps réel
        safePublish('ACCESS_REVOKED', {
          accessRevoked: {
            email: emailLower,
            token: share.token,
            reason: reason || 'Accès révoqué par le propriétaire'
          }
        }, `Accès révoqué pour ${emailLower}`);
        
        return {
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          bannedEmails: share.bannedEmails || [],
          accessRequests: (share.accessRequests || []).map(r => ({
            ...r.toObject ? r.toObject() : r,
            id: r._id?.toString() || r.id
          })),
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        };
      }
    ),
    
    // Débannir un visiteur
    unbanVisitor: withWorkspace(
      async (_, { shareId, visitorEmail, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const share = await PublicBoardShare.findOne({
          _id: shareId,
          workspaceId: finalWorkspaceId
        });
        
        if (!share) {
          throw new Error('Lien de partage non trouvé');
        }
        
        const emailLower = visitorEmail.toLowerCase();
        
        // Retirer l'email de la liste des bannis
        share.bannedEmails = (share.bannedEmails || []).filter(b => 
          b.email !== emailLower
        );
        
        share.updatedAt = new Date();
        await share.save();
        
        logger.info(`✅ [PublicShare] Visiteur débanni: ${visitorEmail}`);
        
        return {
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          bannedEmails: share.bannedEmails || [],
          accessRequests: (share.accessRequests || []).map(r => ({
            ...r.toObject ? r.toObject() : r,
            id: r._id?.toString() || r.id
          })),
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        };
      }
    ),
    
    // Demander l'accès (pour les visiteurs bannis)
    requestAccess: async (_, { token, email, name, message }) => {
      try {
        const share = await PublicBoardShare.findOne({ token });
        
        if (!share) {
          return {
            success: false,
            message: 'Lien de partage non trouvé',
            alreadyRequested: false
          };
        }
        
        const emailLower = email.toLowerCase();
        
        // Vérifier si l'email est bien banni
        const isBanned = (share.bannedEmails || []).some(b => b.email === emailLower);
        if (!isBanned) {
          return {
            success: false,
            message: 'Vous n\'êtes pas dans la liste des accès révoqués',
            alreadyRequested: false
          };
        }
        
        // Vérifier si une demande est déjà en attente
        if (!share.accessRequests) {
          share.accessRequests = [];
        }
        
        const existingRequest = share.accessRequests.find(r => 
          r.email === emailLower && r.status === 'pending'
        );
        
        if (existingRequest) {
          return {
            success: true,
            message: 'Votre demande d\'accès est déjà en attente de validation',
            alreadyRequested: true
          };
        }
        
        // Ajouter la demande d'accès
        const newRequest = {
          email: emailLower,
          name: name || email.split('@')[0],
          message: message || '',
          requestedAt: new Date(),
          status: 'pending'
        };
        share.accessRequests.push(newRequest);
        
        await share.save();
        
        // Récupérer l'ID de la demande créée
        const createdRequest = share.accessRequests[share.accessRequests.length - 1];
        
        logger.info(`📩 [PublicShare] Nouvelle demande d'accès de ${email}`);
        
        // Publier l'événement pour notifier le propriétaire en temps réel
        safePublish('ACCESS_REQUESTED', {
          accessRequested: {
            id: createdRequest._id?.toString() || createdRequest.id,
            email: emailLower,
            name: name || email.split('@')[0],
            message: message || '',
            requestedAt: newRequest.requestedAt,
            boardId: share.boardId.toString()
          }
        }, `Nouvelle demande d'accès de ${emailLower}`);
        
        return {
          success: true,
          message: 'Votre demande d\'accès a été envoyée. Vous serez notifié une fois qu\'elle sera traitée.',
          alreadyRequested: false
        };
      } catch (error) {
        logger.error('❌ [PublicShare] Erreur demande d\'accès:', error);
        return {
          success: false,
          message: 'Erreur lors de la demande d\'accès',
          alreadyRequested: false
        };
      }
    },
    
    // Approuver une demande d'accès
    approveAccessRequest: withWorkspace(
      async (_, { shareId, requestId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const share = await PublicBoardShare.findOne({
          _id: shareId,
          workspaceId: finalWorkspaceId
        });
        
        if (!share) {
          throw new Error('Lien de partage non trouvé');
        }
        
        // Trouver la demande
        const request = share.accessRequests?.id(requestId);
        if (!request) {
          throw new Error('Demande d\'accès non trouvée');
        }
        
        const emailLower = request.email.toLowerCase();
        
        // Mettre à jour le statut de la demande
        request.status = 'approved';
        
        // Retirer l'email de la liste des bannis
        share.bannedEmails = (share.bannedEmails || []).filter(b => 
          b.email !== emailLower
        );
        
        share.updatedAt = new Date();
        await share.save();
        
        logger.info(`✅ [PublicShare] Demande d'accès approuvée pour ${request.email}`);
        
        // Publier l'événement pour notifier le visiteur en temps réel
        safePublish('ACCESS_APPROVED', {
          accessApproved: {
            email: emailLower,
            token: share.token,
            approved: true
          }
        }, `Accès approuvé pour ${emailLower}`);
        
        return {
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          bannedEmails: share.bannedEmails || [],
          accessRequests: (share.accessRequests || []).map(r => ({
            ...r.toObject ? r.toObject() : r,
            id: r._id?.toString() || r.id
          })),
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        };
      }
    ),
    
    // Rejeter une demande d'accès
    rejectAccessRequest: withWorkspace(
      async (_, { shareId, requestId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        
        const share = await PublicBoardShare.findOne({
          _id: shareId,
          workspaceId: finalWorkspaceId
        });
        
        if (!share) {
          throw new Error('Lien de partage non trouvé');
        }
        
        // Trouver la demande
        const request = share.accessRequests?.id(requestId);
        if (!request) {
          throw new Error('Demande d\'accès non trouvée');
        }
        
        // Mettre à jour le statut de la demande
        request.status = 'rejected';
        
        share.updatedAt = new Date();
        await share.save();
        
        logger.info(`❌ [PublicShare] Demande d'accès rejetée pour ${request.email}`);
        
        return {
          ...share.toObject(),
          id: share._id.toString(),
          hasPassword: !!share.password,
          bannedEmails: share.bannedEmails || [],
          accessRequests: (share.accessRequests || []).map(r => ({
            ...r.toObject ? r.toObject() : r,
            id: r._id?.toString() || r.id
          })),
          shareUrl: `${getBaseUrl()}/public/kanban/${share.token}`
        };
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
        const visitorId = visitor?._id?.toString();
        const userName = visitor?.name || visitor?.firstName || visitorEmail.split("@")[0];
        
        // Ajouter le commentaire avec le visitorId pour pouvoir récupérer les infos à jour
        // NE PAS stocker userImage ici car elle peut être en base64 et dépasser la limite MongoDB
        // L'image sera récupérée dynamiquement via enrichTaskWithUserInfo
        const newComment = {
          visitorId: visitorId, // ID du visiteur pour récupérer les infos à jour
          userId: `external_${visitorEmail}`,
          userName: userName, // Stocké pour fallback si le visiteur est supprimé
          userEmail: visitorEmail,
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
          images: (task.images || []).map(img => ({
            id: img._id?.toString() || img.id,
            key: img.key,
            url: img.url,
            fileName: img.fileName,
            fileSize: img.fileSize,
            contentType: img.contentType,
            uploadedBy: img.uploadedBy,
            uploadedAt: img.uploadedAt
          })),
          comments: task.comments.map(c => ({
            id: c._id?.toString(),
            _id: c._id,
            userId: c.userId || 'unknown',
            userName: c.userName || 'Utilisateur',
            userEmail: c.userEmail || null,
            userImage: c.userImage || null,
            content: c.content,
            isExternal: c.isExternal || false,
            images: (c.images || []).map(img => ({
              id: img._id?.toString() || img.id,
              key: img.key,
              url: img.url,
              fileName: img.fileName,
              fileSize: img.fileSize,
              contentType: img.contentType,
              uploadedBy: img.uploadedBy,
              uploadedAt: img.uploadedAt
            })),
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
            type: 'COMMENT_ADDED',
            task: taskPayload,
            taskId: task._id.toString(),
            boardId: share.boardId.toString(),
            workspaceId: share.workspaceId.toString()
          },
          'Commentaire externe ajouté'
        );
        
        logger.info(`✅ [PublicShare] Événement UPDATED publié pour tâche ${task._id}`);
        
        // Récupérer les infos des membres assignés et des auteurs de commentaires
        const db = mongoose.connection.db;
        let membersMap = {};
        let emailToUserMap = {};
        
        const allMemberIds = task.assignedMembers || [];
        const commentUserIds = (task.comments || [])
          .filter(c => !c.isExternal && c.userId && !c.userId.toString().startsWith('external_'))
          .map(c => c.userId.toString());
        const commentEmails = (task.comments || [])
          .filter(c => !c.isExternal && c.userEmail)
          .map(c => c.userEmail.toLowerCase());
        
        const allUserIds = [...new Set([...allMemberIds, ...commentUserIds])];
        
        if (allUserIds.length > 0 || commentEmails.length > 0) {
          const objectIds = allUserIds.map(id => {
            try {
              return new mongoose.Types.ObjectId(id);
            } catch {
              return null;
            }
          }).filter(Boolean);
          
          const query = { $or: [] };
          if (objectIds.length > 0) {
            query.$or.push({ _id: { $in: objectIds } });
          }
          if (commentEmails.length > 0) {
            query.$or.push({ email: { $in: commentEmails } });
          }
          
          if (query.$or.length > 0) {
            const users = await db.collection('user').find(query).toArray();
            users.forEach(user => {
              membersMap[user._id.toString()] = {
                id: user._id.toString(),
                name: user.name || user.email || 'Utilisateur',
                image: user.image || user.avatar || null
              };
              if (user.email) {
                emailToUserMap[user.email.toLowerCase()] = {
                  id: user._id.toString(),
                  name: user.name || user.email || 'Utilisateur',
                  image: user.image || user.avatar || null
                };
              }
            });
          }
        }
        
        // Retourner la tâche mise à jour avec TOUTES les données
        return {
          success: true,
          task: {
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
            images: (task.images || []).map(img => ({
              id: img._id?.toString() || img.id,
              key: img.key,
              url: img.url,
              fileName: img.fileName,
              contentType: img.contentType
            })),
            assignedMembers: (task.assignedMembers || []).map(memberId => 
              membersMap[memberId] || { id: memberId, name: 'Membre', image: null }
            ),
            timeTracking: task.timeTracking ? {
              totalSeconds: task.timeTracking.totalSeconds || 0,
              isRunning: task.timeTracking.isRunning || false,
              currentStartTime: task.timeTracking.currentStartTime,
              hourlyRate: task.timeTracking.hourlyRate,
              startedBy: task.timeTracking.startedBy ? {
                userId: task.timeTracking.startedBy.userId,
                userName: task.timeTracking.startedBy.userName,
                userImage: task.timeTracking.startedBy.userImage
              } : null
            } : null,
            comments: task.comments.map(c => {
              // Pour les commentaires externes, récupérer les infos du visiteur
              if (c.isExternal && c.userEmail) {
                const visitorInfo = share.visitors?.find(v => v.email?.toLowerCase() === c.userEmail.toLowerCase());
                return {
                  id: c._id?.toString(),
                  userName: visitorInfo?.name || visitorInfo?.firstName || c.userName || c.userEmail.split('@')[0],
                  userEmail: c.userEmail,
                  userImage: visitorInfo?.image || c.userImage || null,
                  content: c.content,
                  isExternal: true,
                  images: (c.images || []).map(img => ({
                    id: img._id?.toString() || img.id,
                    key: img.key,
                    url: img.url,
                    fileName: img.fileName,
                    contentType: img.contentType
                  })),
                  createdAt: c.createdAt
                };
              }
              // Pour les commentaires non-externes
              let userInfo = c.userId && !c.userId.toString().startsWith('external_') ? membersMap[c.userId.toString()] : null;
              if (!userInfo && c.userEmail) {
                userInfo = emailToUserMap[c.userEmail.toLowerCase()];
              }
              return {
                id: c._id?.toString(),
                userName: userInfo?.name || c.userName || (c.userEmail ? c.userEmail.split('@')[0] : 'Utilisateur'),
                userEmail: c.userEmail || null,
                userImage: userInfo?.image || c.userImage || null,
                content: c.content,
                isExternal: c.isExternal || false,
                images: (c.images || []).map(img => ({
                  id: img._id?.toString() || img.id,
                  key: img.key,
                  url: img.url,
                  fileName: img.fileName,
                  contentType: img.contentType
                })),
                createdAt: c.createdAt
              };
            }),
            userId: task.userId,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt
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
        const visitorId = visitor._id.toString();
        
        if (input.firstName !== undefined) {
          visitor.firstName = input.firstName;
        }
        if (input.lastName !== undefined) {
          visitor.lastName = input.lastName;
        }
        
        // L'image est maintenant uploadée via uploadVisitorImage (pas de base64)
        // On accepte uniquement les URLs Cloudflare ou null
        if (input.image !== undefined) {
          if (input.image === null || input.image === '') {
            // Supprimer l'image
            await cloudflareService.deleteVisitorImages(visitorId);
            visitor.image = null;
          } else if (input.image.startsWith('http')) {
            // C'est une URL Cloudflare, la garder
            visitor.image = input.image;
          }
          // Ignorer les base64 - ils ne devraient plus être envoyés
        }
        
        // Mettre à jour le nom complet
        if (input.firstName || input.lastName) {
          visitor.name = [input.firstName, input.lastName].filter(Boolean).join(' ') || visitor.email.split('@')[0];
        }
        
        await share.save();
        
        logger.info(`👤 [PublicShare] Profil visiteur mis à jour: ${email}`);
        
        // NE PLUS mettre à jour les commentaires existants car :
        // 1. L'image peut être en base64 et dépasser la limite MongoDB de 16MB
        // 2. On récupère maintenant les infos du visiteur dynamiquement via enrichTaskWithUserInfo
        // Les commentaires sont enrichis à la volée avec les infos à jour du visiteur
        try {
          // Optionnel: mettre à jour uniquement le userName (pas l'image) pour les anciens commentaires sans visitorId
          const updateResult = await Task.updateMany(
            { 
              boardId: share.boardId,
              'comments.userEmail': { $regex: new RegExp(`^${email}$`, 'i') },
              'comments.visitorId': { $exists: false } // Seulement les anciens commentaires
            },
            {
              $set: {
                'comments.$[elem].userName': visitor.name
                // NE PAS mettre à jour userImage ici
              }
            },
            {
              arrayFilters: [{ 'elem.userEmail': { $regex: new RegExp(`^${email}$`, 'i') } }]
            }
          );
          logger.info(`📝 [PublicShare] ${updateResult.modifiedCount} tâche(s) mise(s) à jour avec le nouveau profil visiteur`);
        } catch (updateError) {
          logger.error('❌ [PublicShare] Erreur mise à jour commentaires:', updateError);
        }
        
        // Payload commun pour les deux canaux
        const visitorPayload = {
          type: 'VISITOR_PROFILE_UPDATED',
          visitor: {
            id: visitor._id.toString(),
            email: visitor.email,
            firstName: visitor.firstName,
            lastName: visitor.lastName,
            name: visitor.name,
            image: visitor.image
          },
          boardId: share.boardId.toString(),
          workspaceId: share.workspaceId.toString()
        };
        
        // Publier sur le canal séparé pour les visiteurs (subscription publique)
        const visitorChannel = `${PUBLIC_VISITOR_UPDATED}_${share.workspaceId}_${share.boardId}`;
        safePublish(visitorChannel, visitorPayload, 'Profil visiteur (public)');
        
        // Publier aussi sur le canal TASK_UPDATED pour les utilisateurs connectés
        const taskChannel = `${TASK_UPDATED}_${share.workspaceId}_${share.boardId}`;
        safePublish(taskChannel, visitorPayload, 'Profil visiteur (connecté)');
        
        logger.info(`📡 [PublicShare] Événement VISITOR_PROFILE_UPDATED publié sur les deux canaux pour ${email}`);
        
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
    },

    // Upload une image de profil visiteur sur Cloudflare
    uploadVisitorImage: async (_, { token, email, file }) => {
      try {
        const share = await PublicBoardShare.findOne({ token, isActive: true });
        
        if (!share || !share.isValid()) {
          return {
            success: false,
            message: 'Lien de partage invalide ou expiré',
            imageUrl: null
          };
        }
        
        // Trouver le visiteur
        const visitorIndex = share.visitors.findIndex(v => v.email === email.toLowerCase());
        if (visitorIndex === -1) {
          return {
            success: false,
            message: 'Visiteur non trouvé',
            imageUrl: null
          };
        }
        
        const visitor = share.visitors[visitorIndex];
        const visitorId = visitor._id.toString();
        
        // Traiter le fichier uploadé
        const { createReadStream, filename, mimetype } = await file;
        
        if (!mimetype.startsWith('image/')) {
          return {
            success: false,
            message: 'Le fichier doit être une image',
            imageUrl: null
          };
        }
        
        // Lire le fichier en buffer
        const stream = createReadStream();
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        
        // Vérifier la taille (max 2MB)
        if (buffer.length > 2 * 1024 * 1024) {
          return {
            success: false,
            message: 'L\'image ne doit pas dépasser 2MB',
            imageUrl: null
          };
        }
        
        // Uploader sur Cloudflare
        const uploadResult = await cloudflareService.uploadVisitorImage(buffer, filename, visitorId);
        
        if (!uploadResult.success) {
          return {
            success: false,
            message: 'Erreur lors de l\'upload de l\'image',
            imageUrl: null
          };
        }
        
        // Mettre à jour l'image du visiteur
        visitor.image = uploadResult.url;
        await share.save();
        
        logger.info(`📸 [PublicShare] Image visiteur uploadée: ${uploadResult.url}`);
        
        // Publier l'événement Redis pour synchroniser en temps réel
        safePublish(
          `${TASK_UPDATED}_${share.workspaceId}_${share.boardId}`,
          {
            type: 'VISITOR_PROFILE_UPDATED',
            task: null,
            boardId: share.boardId.toString(),
            workspaceId: share.workspaceId.toString(),
            visitor: {
              id: visitorId,
              email: visitor.email,
              firstName: visitor.firstName,
              lastName: visitor.lastName,
              name: visitor.name,
              image: visitor.image
            }
          },
          'Image visiteur uploadée'
        );
        
        // Publier aussi sur le canal public
        safePublish(
          `${PUBLIC_VISITOR_UPDATED}_${share.workspaceId}_${share.boardId}`,
          {
            type: 'VISITOR_PROFILE_UPDATED',
            boardId: share.boardId.toString(),
            workspaceId: share.workspaceId.toString(),
            visitor: {
              id: visitorId,
              email: visitor.email,
              firstName: visitor.firstName,
              lastName: visitor.lastName,
              name: visitor.name,
              image: visitor.image
            }
          },
          'Image visiteur uploadée (public)'
        );
        
        return {
          success: true,
          message: 'Image uploadée avec succès',
          imageUrl: uploadResult.url
        };
      } catch (error) {
        logger.error('❌ [PublicShare] Erreur upload image visiteur:', error);
        return {
          success: false,
          message: 'Une erreur est survenue',
          imageUrl: null
        };
      }
    },

    // Upload une image pour un commentaire externe (visiteur)
    uploadExternalCommentImage: async (_, { token, taskId, file, visitorEmail }) => {
      try {
        // Vérifier le lien de partage
        const share = await PublicBoardShare.findOne({ token, isActive: true });
        
        if (!share || !share.isValid()) {
          return {
            success: false,
            image: null,
            message: 'Lien de partage invalide ou expiré'
          };
        }
        
        if (!share.permissions.canComment) {
          return {
            success: false,
            image: null,
            message: 'Les commentaires ne sont pas autorisés sur ce tableau'
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
            image: null,
            message: 'Tâche non trouvée'
          };
        }

        // Traiter le fichier uploadé
        const { createReadStream, filename, mimetype } = await file;
        const stream = createReadStream();
        const chunks = [];
        
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        const fileBuffer = Buffer.concat(chunks);

        // Valider le type de fichier
        const validMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validMimeTypes.includes(mimetype)) {
          return {
            success: false,
            image: null,
            message: 'Type de fichier non supporté. Utilisez JPEG, PNG, GIF ou WebP.'
          };
        }

        // Valider la taille (max 5MB pour les visiteurs)
        const maxSize = 5 * 1024 * 1024;
        if (fileBuffer.length > maxSize) {
          return {
            success: false,
            image: null,
            message: 'Fichier trop volumineux. Maximum 5MB.'
          };
        }

        // Upload vers Cloudflare R2
        const uploadResult = await cloudflareService.uploadTaskImage(
          fileBuffer,
          filename,
          taskId,
          `visitor_${visitorEmail.replace('@', '_at_')}`,
          'comments'
        );

        // Créer l'objet image
        const newImage = {
          id: new mongoose.Types.ObjectId().toString(),
          key: uploadResult.key,
          url: uploadResult.url,
          fileName: uploadResult.fileName,
          fileSize: uploadResult.fileSize,
          contentType: uploadResult.contentType,
          uploadedBy: `external_${visitorEmail}`,
          uploadedAt: new Date()
        };

        logger.info(`✅ [PublicShare] Image uploadée par visiteur ${visitorEmail}: ${newImage.url}`);

        return {
          success: true,
          image: newImage,
          message: 'Image uploadée avec succès'
        };
      } catch (error) {
        logger.error('❌ [PublicShare] Erreur upload image externe:', error);
        return {
          success: false,
          image: null,
          message: `Erreur lors de l'upload: ${error.message}`
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
          // S'abonner aux canaux du workspace+board pour recevoir les mises à jour
          const taskChannel = `${TASK_UPDATED}_${share.workspaceId}_${share.boardId}`;
          const visitorChannel = `${PUBLIC_VISITOR_UPDATED}_${share.workspaceId}_${share.boardId}`;
          logger.debug(`📡 [PublicShare] Subscription aux canaux: ${taskChannel}, ${visitorChannel}`);
          
          return pubsub.asyncIterableIterator([taskChannel, visitorChannel]);
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
          // Pour les événements sans task (ex: VISITOR_PROFILE_UPDATED), retourner le payload tel quel
          logger.info(`📡 [PublicShare] Subscription resolve - événement sans task: ${payload.type}`);
          return {
            type: payload.type,
            task: null,
            taskId: payload.taskId,
            boardId: payload.boardId,
            visitor: payload.visitor || null
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
          const userIdStr = c.userId?.toString();
          const userInfo = userIdStr ? usersMap[userIdStr] : null;
          // Priorité: userInfo (récupéré de la DB) > c.userName (déjà enrichi) > fallback
          const finalUserName = userInfo?.name || (c.userName && c.userName !== 'Utilisateur' ? c.userName : null) || 'Utilisateur';
          const finalUserImage = userInfo?.image || c.userImage || null;
          
          return {
            id: c._id?.toString() || c.id,
            userName: finalUserName,
            userEmail: c.userEmail || null,
            userImage: finalUserImage,
            content: c.content,
            isExternal: false,
            createdAt: c.createdAt
          };
        });
        
        // Enrichir les images des commentaires
        const enrichedCommentsWithImages = enrichedComments.map(c => {
          const originalComment = comments.find(oc => (oc._id?.toString() || oc.id) === c.id);
          return {
            ...c,
            images: (originalComment?.images || []).map(img => ({
              id: img._id?.toString() || img.id,
              key: img.key,
              url: img.url,
              fileName: img.fileName,
              contentType: img.contentType
            }))
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
          images: (task.images || []).map(img => ({
            id: img._id?.toString() || img.id,
            key: img.key,
            url: img.url,
            fileName: img.fileName,
            contentType: img.contentType
          })),
          assignedMembers: enrichedMembers,
          comments: enrichedCommentsWithImages,
          timeTracking: task.timeTracking ? {
            totalSeconds: task.timeTracking.totalSeconds || 0,
            isRunning: task.timeTracking.isRunning || false,
            currentStartTime: task.timeTracking.currentStartTime,
            hourlyRate: task.timeTracking.hourlyRate,
            startedBy: task.timeTracking.startedBy ? {
              userId: task.timeTracking.startedBy.userId,
              userName: task.timeTracking.startedBy.userName,
              userImage: task.timeTracking.startedBy.userImage
            } : null
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
    },
    
    // Subscription pour notifier quand un accès est approuvé
    accessApproved: {
      subscribe: async (_, { token, email }) => {
        try {
          // Vérifier que le token est valide
          const share = await PublicBoardShare.findOne({ token, isActive: true });
          if (!share) {
            throw new Error('Lien de partage invalide ou expiré');
          }
          
          const pubsub = getPubSub();
          logger.debug(`📡 [PublicShare] Subscription accessApproved pour ${email} sur token ${token.substring(0, 8)}...`);
          
          return pubsub.asyncIterator(['ACCESS_APPROVED']);
        } catch (error) {
          logger.error('❌ [PublicShare] Erreur subscription accessApproved:', error);
          throw error;
        }
      },
      resolve: (payload, { token, email }) => {
        // Filtrer pour ne retourner que si c'est le bon token et email
        if (payload.accessApproved.token === token && 
            payload.accessApproved.email === email.toLowerCase()) {
          logger.info(`✅ [PublicShare] Notification accès approuvé envoyée à ${email}`);
          return payload.accessApproved;
        }
        // Retourner null pour ignorer les événements qui ne correspondent pas
        return null;
      }
    },
    
    // Subscription pour notifier quand un accès est révoqué (déconnexion temps réel)
    accessRevoked: {
      subscribe: async (_, { token, email }) => {
        try {
          const pubsub = getPubSub();
          logger.debug(`📡 [PublicShare] Subscription accessRevoked pour ${email} sur token ${token.substring(0, 8)}...`);
          
          return pubsub.asyncIterator(['ACCESS_REVOKED']);
        } catch (error) {
          logger.error('❌ [PublicShare] Erreur subscription accessRevoked:', error);
          throw error;
        }
      },
      resolve: (payload, { token, email }) => {
        // Filtrer pour ne retourner que si c'est le bon token et email
        if (payload.accessRevoked.token === token && 
            payload.accessRevoked.email === email.toLowerCase()) {
          logger.info(`🚫 [PublicShare] Notification accès révoqué envoyée à ${email}`);
          return payload.accessRevoked;
        }
        // Retourner null pour ignorer les événements qui ne correspondent pas
        return null;
      }
    },
    
    // Subscription pour notifier le propriétaire d'une nouvelle demande d'accès
    accessRequested: {
      subscribe: async (_, { boardId }) => {
        try {
          const pubsub = getPubSub();
          logger.debug(`📡 [PublicShare] Subscription accessRequested pour board ${boardId}`);
          
          return pubsub.asyncIterator(['ACCESS_REQUESTED']);
        } catch (error) {
          logger.error('❌ [PublicShare] Erreur subscription accessRequested:', error);
          throw error;
        }
      },
      resolve: (payload, { boardId }) => {
        // Filtrer pour ne retourner que si c'est le bon boardId
        if (payload.accessRequested.boardId === boardId) {
          logger.info(`📩 [PublicShare] Notification nouvelle demande pour board ${boardId}`);
          return payload.accessRequested;
        }
        return null;
      }
    },
    
    // Subscription pour voir les visiteurs connectés en temps réel
    visitorPresence: {
      subscribe: async (_, { boardId }) => {
        try {
          const pubsub = getPubSub();
          logger.debug(`📡 [PublicShare] Subscription visitorPresence pour board ${boardId}`);
          
          return pubsub.asyncIterator(['VISITOR_PRESENCE']);
        } catch (error) {
          logger.error('❌ [PublicShare] Erreur subscription visitorPresence:', error);
          throw error;
        }
      },
      resolve: (payload, { boardId }) => {
        // Filtrer pour ne retourner que si c'est le bon boardId
        if (payload.visitorPresence.boardId === boardId) {
          logger.info(`👤 [PublicShare] Présence visiteur ${payload.visitorPresence.email} - ${payload.visitorPresence.isConnected ? 'connecté' : 'déconnecté'}`);
          return payload.visitorPresence;
        }
        return null;
      }
    }
  }
};

export default resolvers;
