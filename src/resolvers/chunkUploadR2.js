import { ApolloError, UserInputError } from 'apollo-server-express';
import { isAuthenticated } from '../middlewares/auth.js';
import { 
  saveChunkToR2, 
  areAllChunksReceivedOnR2, 
  reconstructFileFromR2, 
  cleanupChunksFromR2,
  uploadFileDirectToR2,
  uploadBase64FileToR2
} from '../utils/chunkUploadR2Utils.js';
import FileTransfer from '../models/FileTransfer.js';
import { v4 as uuidv4 } from 'uuid';

// Fonction utilitaire pour récupérer les informations d'un fichier par son ID
// Cache temporaire pour stocker les métadonnées des fichiers uploadés
const fileMetadataCache = new Map();

const getFileInfoByTransferId = async (fileId) => {
  try {
    console.log(`🔍 Recherche du fichier avec ID: ${fileId}`);
    
    // D'abord, vérifier le cache temporaire
    if (fileMetadataCache.has(fileId)) {
      const cachedInfo = fileMetadataCache.get(fileId);
      console.log(`✅ Fichier trouvé dans le cache:`, cachedInfo);
      return cachedInfo;
    }
    
    // Rechercher par fileId dans les fichiers existants
    let fileTransfer = await FileTransfer.findOne({
      'files.fileId': fileId,
      'uploadMethod': 'chunk',
      'storageType': 'r2'
    });
    
    if (!fileTransfer) {
      // Fallback: rechercher par originalName (compatibilité)
      fileTransfer = await FileTransfer.findOne({
        'files.originalName': fileId,
        'uploadMethod': 'chunk'
      });
    }
    
    if (!fileTransfer) {
      throw new Error(`Transfert de fichier non trouvé pour fileId: ${fileId}`);
    }
    
    // Trouver le fichier spécifique
    let fileInfo = fileTransfer.files.find(file => file.fileId === fileId);
    if (!fileInfo) {
      fileInfo = fileTransfer.files.find(file => file.originalName === fileId);
    }
    
    if (!fileInfo) {
      throw new Error(`Fichier spécifique non trouvé dans le transfert: ${fileId}`);
    }
    
    console.log(`✅ Fichier trouvé:`, fileInfo);
    return fileInfo;
  } catch (error) {
    console.error(`❌ Erreur lors de la récupération du fichier ${fileId}:`, error);
    throw error;
  }
};

export default {
  Mutation: {
    // Uploader un chunk de fichier vers R2
    uploadFileChunkToR2: isAuthenticated(async (_, { 
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
        
        // Générer un transferId temporaire pour ce fichier
        const transferId = `temp_${fileId}`;
        
        // Sauvegarder le chunk sur R2
        const chunkInfo = await saveChunkToR2(chunk, fileId, chunkIndex, fileName, transferId);
        
        // Vérifier si c'était le dernier chunk
        const allChunksReceived = await areAllChunksReceivedOnR2(transferId, fileId, totalChunks);
        
        // Si tous les chunks sont reçus, reconstruire le fichier
        let fileInfo = null;
        let fileTransferId = null;
        
        if (allChunksReceived) {
          // Déterminer le type MIME
          const ext = fileName.split('.').pop()?.toLowerCase();
          const mimeTypes = {
            'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
            'pdf': 'application/pdf', 'doc': 'application/msword',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'txt': 'text/plain', 'zip': 'application/zip'
          };
          const mimeType = mimeTypes[ext] || 'application/octet-stream';
          
          // Reconstruire le fichier à partir des chunks
          fileInfo = await reconstructFileFromR2(transferId, fileId, fileName, totalChunks, mimeType);
          
          // Stocker les métadonnées du fichier dans le cache temporaire
          const fileMetadata = {
            originalName: fileInfo.originalName,
            displayName: fileInfo.displayName,
            fileName: fileInfo.fileName,
            filePath: fileInfo.filePath,
            r2Key: fileInfo.r2Key,
            mimeType: fileInfo.mimeType,
            size: fileInfo.size,
            storageType: 'r2',
            fileId: fileId,
            uploadedAt: new Date()
          };
          
          // Ajouter au cache temporaire pour la création du transfert
          fileMetadataCache.set(fileId, fileMetadata);
          
          console.log(`✅ Métadonnées du fichier ${fileId} stockées dans le cache`);
          
          // Nettoyer le cache après 1 heure (pour éviter l'accumulation)
          setTimeout(() => {
            fileMetadataCache.delete(fileId);
            console.log(`🧹 Cache nettoyé pour le fichier ${fileId}`);
          }, 60 * 60 * 1000);
        }
        
        return {
          chunkReceived: true,
          fileCompleted: allChunksReceived,
          fileId,
          fileName: fileInfo ? fileInfo.fileName : null,
          filePath: fileInfo ? fileInfo.filePath : null,
          fileTransferId: fileTransferId,
          storageType: 'r2'
        };
      } catch (error) {
        // En cas d'erreur, nettoyer les chunks temporaires
        await cleanupChunksFromR2(`temp_${fileId}`, fileId, totalChunks);
        
        if (error instanceof UserInputError) {
          throw error;
        }
        
        console.error('❌ Erreur lors de l\'upload du chunk vers R2:', error);
        throw new ApolloError(
          'Une erreur est survenue lors de l\'upload du chunk vers R2.',
          'CHUNK_UPLOAD_R2_ERROR'
        );
      }
    }),
    
    // Créer un transfert de fichier à partir des IDs de fichiers déjà uploadés en chunks sur R2
    createFileTransferWithIdsR2: isAuthenticated(async (_, { fileIds, input }, { user }) => {
      try {
        // Vérifier que les IDs de fichiers sont fournis
        if (!fileIds || fileIds.length === 0) {
          throw new UserInputError('Aucun ID de fichier fourni');
        }
        
        console.log('🔧 Création de transfert R2 avec les fileIds:', fileIds);
        
        // Récupérer les informations de chaque fichier
        const filesInfo = [];
        let totalSize = 0;
        
        for (const fileId of fileIds) {
          try {
            // Récupérer les informations du fichier à partir du transfert temporaire
            const fileInfo = await getFileInfoByTransferId(fileId);
            
            console.log('📄 Informations du fichier récupérées:', fileInfo);
            
            // Ajouter les informations du fichier à la liste
            filesInfo.push({
              originalName: fileInfo.originalName,
              displayName: fileInfo.displayName || fileInfo.originalName,
              fileName: fileInfo.fileName,
              filePath: fileInfo.filePath,
              r2Key: fileInfo.r2Key,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size,
              storageType: 'r2',
              fileId: fileInfo.fileId || fileId,
              uploadedAt: fileInfo.uploadedAt || new Date()
            });
            
            // Ajouter la taille du fichier au total
            totalSize += fileInfo.size;
            
          } catch (error) {
            console.error(`❌ Erreur lors de la récupération du fichier ${fileId}:`, error);
            throw new ApolloError(
              `Impossible de récupérer les informations du fichier ${fileId}`,
              'FILE_NOT_FOUND'
            );
          }
        }
        
        // Définir les options du transfert de fichier
        const expiryDays = input?.expiryDays || 7;
        const isPaymentRequired = input?.isPaymentRequired || input?.requirePayment || false;
        const paymentAmount = input?.paymentAmount || 0;
        const paymentCurrency = input?.paymentCurrency || input?.currency || 'EUR';
        const recipientEmail = input?.recipientEmail || null;
        const message = input?.message || null;
        
        console.log('⚙️ Options du transfert:', { 
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
        
        console.log('✅ Transfert de fichier R2 créé avec succès:', fileTransfer._id);
        
        // Envoyer l'email si un destinataire est spécifié et si SMTP est configuré
        if (recipientEmail && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
          try {
            const { sendFileTransferEmail } = await import('../utils/mailer.js');
            
            const transferData = {
              shareLink: fileTransfer.shareLink,
              accessKey: fileTransfer.accessKey,
              senderName: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email,
              message: message,
              files: filesInfo,
              expiryDate: fileTransfer.expiryDate
            };
            
            const emailSent = await sendFileTransferEmail(recipientEmail, transferData);
            
            if (emailSent) {
              console.log('📧 Email de transfert envoyé avec succès à:', recipientEmail);
            } else {
              console.warn('⚠️ Échec de l\'envoi de l\'email de transfert à:', recipientEmail);
            }
          } catch (emailError) {
            console.error('❌ Erreur lors de l\'envoi de l\'email de transfert:', emailError);
            // Ne pas faire échouer la création du transfert si l'email échoue
          }
        } else if (recipientEmail) {
          console.log('📧 Email destinataire fourni mais SMTP non configuré. Lien de partage:', 
            `${process.env.FRONTEND_URL || 'http://localhost:3000'}/transfer/${fileTransfer.shareLink}?accessKey=${fileTransfer.accessKey}`);
        }
        
        // Retourner le transfert de fichier créé
        return {
          fileTransfer,
          shareLink: fileTransfer.shareLink,
          accessKey: fileTransfer.accessKey
        };
      } catch (error) {
        console.error('❌ Erreur lors de la création du transfert de fichier R2:', error);
        
        if (error instanceof UserInputError) {
          throw error;
        }
        
        throw new ApolloError(
          'Une erreur est survenue lors de la création du transfert de fichier R2.',
          'FILE_TRANSFER_R2_CREATION_ERROR'
        );
      }
    }),

    // Upload direct d'un fichier vers R2
    uploadFileDirectToR2: isAuthenticated(async (_, { file, transferId }, { user }) => {
      try {
        if (!file) {
          throw new UserInputError('Aucun fichier fourni');
        }

        // Générer un ID unique pour le fichier
        const fileId = uuidv4();
        
        // Générer un transferId si non fourni
        if (!transferId) {
          transferId = uuidv4();
        }

        // Upload direct vers R2
        const fileInfo = await uploadFileDirectToR2(file, transferId, fileId);

        console.log('✅ Fichier uploadé directement vers R2:', fileInfo);

        return {
          fileId,
          fileName: fileInfo.fileName,
          filePath: fileInfo.filePath,
          r2Key: fileInfo.r2Key,
          size: fileInfo.size,
          mimeType: fileInfo.mimeType,
          storageType: 'r2'
        };
      } catch (error) {
        console.error('❌ Erreur lors de l\'upload direct vers R2:', error);
        
        if (error instanceof UserInputError) {
          throw error;
        }
        
        throw new ApolloError(
          'Une erreur est survenue lors de l\'upload direct vers R2.',
          'DIRECT_UPLOAD_R2_ERROR'
        );
      }
    }),

    // Upload d'un fichier base64 vers R2
    uploadBase64FileToR2: isAuthenticated(async (_, { fileInput, transferId }, { user }) => {
      try {
        if (!fileInput) {
          throw new UserInputError('Aucune donnée de fichier fournie');
        }

        // Générer un ID unique pour le fichier
        const fileId = uuidv4();
        
        // Générer un transferId si non fourni
        if (!transferId) {
          transferId = uuidv4();
        }

        // Upload base64 vers R2
        const fileInfo = await uploadBase64FileToR2(fileInput, transferId, fileId);

        console.log('✅ Fichier base64 uploadé vers R2:', fileInfo);

        return {
          fileId,
          fileName: fileInfo.fileName,
          filePath: fileInfo.filePath,
          r2Key: fileInfo.r2Key,
          size: fileInfo.size,
          mimeType: fileInfo.mimeType,
          storageType: 'r2'
        };
      } catch (error) {
        console.error('❌ Erreur lors de l\'upload base64 vers R2:', error);
        
        if (error instanceof UserInputError) {
          throw error;
        }
        
        throw new ApolloError(
          'Une erreur est survenue lors de l\'upload base64 vers R2.',
          'BASE64_UPLOAD_R2_ERROR'
        );
      }
    })
  }
};
