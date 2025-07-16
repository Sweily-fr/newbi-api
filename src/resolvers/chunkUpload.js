import { ApolloError, UserInputError } from 'apollo-server-express';
import { isAuthenticated } from '../middlewares/auth.js';
import { 
  saveChunk, 
  areAllChunksReceived, 
  reconstructFile, 
  cleanupChunks 
} from '../utils/chunkUploadUtils.js';
import FileTransfer from '../models/FileTransfer.js';

// Fonction utilitaire pour récupérer les informations d'un fichier temporaire par son ID
const getFileInfoByTransferId = async (fileId) => {
  try {
    console.log(`Recherche du fichier avec ID: ${fileId}`);
    
    // Rechercher principalement par originalName qui contient maintenant le fileId
    let fileTransfer = await FileTransfer.findOne({
      'files.originalName': fileId,
      'uploadMethod': 'chunk'
    });
    
    console.log('Recherche par originalName:', fileTransfer ? 'Trouvé' : 'Non trouvé');
    
    // Si non trouvé, essayer par fileName (pour compatibilité avec l'ancien code)
    if (!fileTransfer) {
      fileTransfer = await FileTransfer.findOne({
        'files.fileName': fileId,
        'uploadMethod': 'chunk'
      });
      console.log('Recherche par fileName:', fileTransfer ? 'Trouvé' : 'Non trouvé');
    }
    
    // Si toujours pas trouvé, récupérer tous les transferts en mode chunk pour déboguer
    if (!fileTransfer) {
      const allChunkTransfers = await FileTransfer.find({
        'uploadMethod': 'chunk'
      });
      
      console.log(`Tous les transferts en mode chunk (${allChunkTransfers.length}):`, 
        allChunkTransfers.map(t => ({
          id: t._id.toString(),
          files: t.files.map(f => ({ 
            fileName: f.fileName, 
            originalName: f.originalName,
            displayName: f.displayName || 'non défini'
          }))
        }))
      );
      
      throw new Error(`Transfert de fichier non trouvé pour fileId: ${fileId}`);
    }
    
    if (!fileTransfer.files || fileTransfer.files.length === 0) {
      throw new Error(`Transfert trouvé mais sans fichiers pour fileId: ${fileId}`);
    }
    
    // Trouver le fichier spécifique dans le tableau des fichiers par originalName (prioritaire)
    let fileInfo = fileTransfer.files.find(file => file.originalName === fileId);
    
    // Si non trouvé par originalName, essayer par fileName (compatibilité)
    if (!fileInfo) {
      fileInfo = fileTransfer.files.find(file => file.fileName === fileId);
      console.log('Recherche dans les fichiers par fileName:', fileInfo ? 'Trouvé' : 'Non trouvé');
    }
    
    if (!fileInfo) {
      console.log('Fichiers disponibles dans le transfert:', 
        fileTransfer.files.map(f => ({ 
          fileName: f.fileName, 
          originalName: f.originalName,
          displayName: f.displayName || 'non défini'
        }))
      );
      throw new Error(`Fichier spécifique non trouvé dans le transfert: ${fileId}`);
    }
    
    console.log(`Fichier trouvé:`, fileInfo);
    return fileInfo;
  } catch (error) {
    console.error(`Erreur lors de la récupération du fichier ${fileId}:`, error);
    throw error;
  }
};

export default {
  Mutation: {
    // Uploader un chunk de fichier
    uploadFileChunk: isAuthenticated(async (_, { 
      chunk, 
      fileId, 
      chunkIndex, 
      totalChunks, 
      fileName, 
      fileSize 
    }, { user }) => {
      try {
        // Vérifier que les paramètres sont valides
        if (!fileId || !fileName) {
          throw new UserInputError('Identifiant de fichier ou nom de fichier manquant');
        }
        
        if (chunkIndex < 0 || chunkIndex >= totalChunks) {
          throw new UserInputError('Index de chunk invalide');
        }
        
        // Sauvegarder le chunk
        const chunkInfo = await saveChunk(chunk, fileId, chunkIndex, fileName);
        
        // Vérifier si c'était le dernier chunk
        const allChunksReceived = await areAllChunksReceived(fileId, totalChunks);
        
        // Si tous les chunks sont reçus, reconstruire le fichier
        let fileInfo = null;
        let fileTransferId = null;
        
        if (allChunksReceived) {
          // Reconstruire le fichier à partir des chunks
          fileInfo = await reconstructFile(fileId, fileName, totalChunks, user.id);
          
          // Créer une entrée dans la base de données pour le fichier
          try {
            // Créer un nouveau transfert de fichier dans la base de données
            const timestamp = Date.now();
            const randomString = Math.random().toString(36).substring(2, 15);
            
            const fileTransfer = new FileTransfer({
              userId: user.id,
              files: [{
                originalName: fileInfo.originalName, // Contient maintenant le fileId
                displayName: fileInfo.displayName || fileName, // Utiliser le displayName ou le fileName comme fallback
                fileName: fileInfo.fileName,
                filePath: fileInfo.filePath,
                mimeType: fileInfo.mimeType,
                size: fileInfo.size
              }],
              status: 'active',
              createdAt: new Date(),
              expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Expire dans 7 jours par défaut
              isPaymentRequired: false,
              uploadMethod: 'chunk',
              totalSize: fileInfo.size
            });
            
            // Générer les identifiants de partage avec la méthode du modèle
            await fileTransfer.generateShareCredentials();
            
            // Sauvegarder le transfert de fichier
            await fileTransfer.save();
            
            console.log('Identifiants générés:', {
              shareLink: fileTransfer.shareLink,
              accessKey: fileTransfer.accessKey
            });
            
            // Récupérer l'ID du transfert de fichier
            fileTransferId = fileTransfer._id.toString();
            
            console.log(`Transfert de fichier créé avec succès: ${fileTransferId}`);
          } catch (dbError) {
            console.error('Erreur lors de la création du transfert de fichier:', dbError);
            // Ne pas échouer l'opération complète si la création de l'entrée en base échoue
            // Le fichier est déjà reconstruit et sauvegardé sur le disque
          }
        }
        
        return {
          chunkReceived: true,
          fileCompleted: allChunksReceived,
          fileId,
          fileName: fileInfo ? fileInfo.fileName : null,
          filePath: fileInfo ? fileInfo.filePath : null,
          fileTransferId: fileTransferId
        };
      } catch (error) {
        // En cas d'erreur, nettoyer les chunks temporaires
        await cleanupChunks(fileId);
        
        if (error instanceof UserInputError) {
          throw error;
        }
        
        console.error('Erreur lors de l\'upload du chunk:', error);
        throw new ApolloError(
          'Une erreur est survenue lors de l\'upload du chunk.',
          'CHUNK_UPLOAD_ERROR'
        );
      }
    }),
    
    // Créer un transfert de fichier à partir des IDs de fichiers déjà uploadés en chunks
    createFileTransferWithIds: isAuthenticated(async (_, { fileIds, input }, { user }) => {
      try {
        // Vérifier que les IDs de fichiers sont fournis
        if (!fileIds || fileIds.length === 0) {
          throw new UserInputError('Aucun ID de fichier fourni');
        }
        
        console.log('Création de transfert avec les fileIds:', fileIds);
        
        // Récupérer les informations de chaque fichier
        const filesInfo = [];
        let totalSize = 0;
        
        for (const fileId of fileIds) {
          try {
            // Récupérer les informations du fichier à partir du transfert temporaire
            const fileInfo = await getFileInfoByTransferId(fileId);
            
            console.log('Informations du fichier récupérées:', fileInfo);
            
            // Ajouter les informations du fichier à la liste
            filesInfo.push({
              originalName: fileInfo.originalName,
              displayName: fileInfo.displayName || fileInfo.originalName, // Utiliser displayName s'il existe
              fileName: fileInfo.fileName,
              filePath: fileInfo.filePath,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size
            });
            
            // Ajouter la taille du fichier au total
            totalSize += fileInfo.size;
            
          } catch (error) {
            console.error(`Erreur lors de la récupération du fichier ${fileId}:`, error);
            throw new ApolloError(
              `Impossible de récupérer les informations du fichier ${fileId}`,
              'FILE_NOT_FOUND'
            );
          }
        }
        
        // Définir les options du transfert de fichier
        const expiryDays = input?.expiryDays || 7; // 7 jours par défaut
        
        // Gérer les champs avec alias pour compatibilité avec le frontend
        const isPaymentRequired = input?.isPaymentRequired || input?.requirePayment || false;
        const paymentAmount = input?.paymentAmount || 0;
        const paymentCurrency = input?.paymentCurrency || input?.currency || 'EUR';
        const recipientEmail = input?.recipientEmail || null;
        const message = input?.message || null;
        
        console.log('Options du transfert:', { 
          expiryDays, 
          isPaymentRequired, 
          paymentAmount, 
          paymentCurrency, 
          recipientEmail, 
          message 
        });
        
        // Créer un nouveau transfert de fichier
        const fileTransfer = new FileTransfer({
          userId: user.id,
          files: filesInfo,
          totalSize,
          status: 'active',
          createdAt: new Date(),
          expiryDate: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
          isPaymentRequired,
          paymentAmount,
          paymentCurrency,
          recipientEmail,
          message,
          uploadMethod: 'chunk'
        });
        
        // Générer les liens de partage et clé d'accès
        await fileTransfer.generateShareCredentials();
        
        // Sauvegarder le transfert de fichier
        await fileTransfer.save();
        
        // Retourner le transfert de fichier créé
        return {
          fileTransfer,
          shareLink: fileTransfer.shareLink,
          accessKey: fileTransfer.accessKey
        };
      } catch (error) {
        console.error('Erreur lors de la création du transfert de fichier:', error);
        
        if (error instanceof UserInputError) {
          throw error;
        }
        
        throw new ApolloError(
          'Une erreur est survenue lors de la création du transfert de fichier.',
          'FILE_TRANSFER_CREATION_ERROR'
        );
      }
    })
  }
};
