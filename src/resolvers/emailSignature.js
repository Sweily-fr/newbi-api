import EmailSignature from '../models/EmailSignature.js';
import { isAuthenticated } from '../middlewares/auth.js';
import { 
  createNotFoundError, 
  createAlreadyExistsError,
  createValidationError
} from '../utils/errors.js';
import { deleteFile } from '../utils/fileUpload.js';

const emailSignatureResolvers = {
  Query: {
    // Récupérer toutes les signatures de l'utilisateur connecté
    getMyEmailSignatures: isAuthenticated(async (_, __, { user }) => {
      return EmailSignature.find({ createdBy: user.id })
        .sort({ updatedAt: -1 }); // Tri par date de mise à jour (plus récent en premier)
    }),

    // Récupérer une signature spécifique
    getEmailSignature: isAuthenticated(async (_, { id }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
      if (!signature) throw createNotFoundError('Signature email');
      return signature;
    }),

    // Récupérer la signature par défaut de l'utilisateur
    getDefaultEmailSignature: isAuthenticated(async (_, __, { user }) => {
      const signature = await EmailSignature.findOne({ 
        createdBy: user.id,
        isDefault: true
      });
      return signature; // Peut être null si aucune signature par défaut n'existe
    })
  },

  Mutation: {
    // Créer une nouvelle signature
    createEmailSignature: isAuthenticated(async (_, { input }, { user }) => {
      // Validation basique - seul le nom de signature est requis
      if (!input.signatureName || input.signatureName.trim() === '') {
        throw createValidationError('Le nom de la signature est requis');
      }
      
      // Vérifier si une signature avec ce nom existe déjà pour cet utilisateur
      const existingSignature = await EmailSignature.findOne({ 
        signatureName: input.signatureName,
        createdBy: user.id 
      });
      
      if (existingSignature) {
        throw createAlreadyExistsError('signature email', 'nom', input.signatureName);
      }
      
      // Si c'est la première signature de l'utilisateur, la définir comme signature par défaut
      const signatureCount = await EmailSignature.countDocuments({ createdBy: user.id });
      const isFirstSignature = signatureCount === 0;
      
      // Préparer les données de la signature avec les valeurs par défaut
      const signatureData = {
        ...input,
        createdBy: user.id,
        isDefault: input.isDefault !== undefined ? input.isDefault : isFirstSignature
      };
      
      const signature = new EmailSignature(signatureData);
      await signature.save();
      return signature;
    }),

    // Mettre à jour une signature existante
    updateEmailSignature: isAuthenticated(async (_, { input }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: input.id, createdBy: user.id });
      
      if (!signature) {
        throw createNotFoundError('Signature email');
      }
      
      // Validation basique - seul le nom de signature est requis
      if (!input.signatureName || input.signatureName.trim() === '') {
        throw createValidationError('Le nom de la signature est requis');
      }
      
      // Si le nom de la signature est modifié, vérifier qu'il n'existe pas déjà
      if (input.signatureName && input.signatureName !== signature.signatureName) {
        const existingSignature = await EmailSignature.findOne({ 
          signatureName: input.signatureName,
          createdBy: user.id,
          _id: { $ne: input.id }
        });
        
        if (existingSignature) {
          throw createAlreadyExistsError('signature email', 'nom', input.signatureName);
        }
      }
      
      // Mettre à jour la signature avec les nouvelles données
      Object.keys(input).forEach(key => {
        if (key !== 'id' && input[key] !== undefined) {
          // Traitement spécial pour les objets imbriqués
          if (key === 'colors' && input[key]) {
            signature.colors = { ...signature.colors, ...input[key] };
          } else if (key === 'columnWidths' && input[key]) {
            signature.columnWidths = { ...signature.columnWidths, ...input[key] };
          } else if (key === 'spacings' && input[key]) {
            signature.spacings = { ...signature.spacings, ...input[key] };
          } else if (key === 'fontSize' && input[key]) {
            signature.fontSize = { ...signature.fontSize, ...input[key] };
          } else {
            signature[key] = input[key];
          }
        }
      });
      
      await signature.save();
      return signature;
    }),

    // Supprimer une signature
    deleteEmailSignature: isAuthenticated(async (_, { id }, { user }) => {
      console.log(`🔍 [BACKEND] Début suppression signature ID: ${id} pour utilisateur: ${user.id}`);
      
      try {
        // 1. Vérifier que la signature existe et appartient à l'utilisateur
        console.log(`🔍 [BACKEND] Recherche de la signature à supprimer...`);
        const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
        
        if (!signature) {
          console.error(`❌ [BACKEND] Signature non trouvée ou non autorisée`);
          throw createNotFoundError('Signature email');
        }
        
        console.log(`✅ [BACKEND] Signature trouvée: ${signature.signatureName}`);

        // 2. Gestion de la signature par défaut
        if (signature.isDefault) {
          console.log(`ℹ️ [BACKEND] La signature est définie comme par défaut, recherche d'une autre signature...`);
          const otherSignature = await EmailSignature.findOne({ 
            createdBy: user.id,
            _id: { $ne: id }
          }).sort({ updatedAt: -1 });

          if (otherSignature) {
            console.log(`🔄 [BACKEND] Définition de la signature ${otherSignature._id} comme nouvelle signature par défaut`);
            otherSignature.isDefault = true;
            await otherSignature.save();
          } else {
            console.log(`ℹ️ [BACKEND] Aucune autre signature trouvée pour définir comme par défaut`);
          }
        }

        // 3. Préparer la suppression des fichiers associés
        console.log(`🔍 [BACKEND] Préparation de la suppression des fichiers associés...`);
        const filesToDelete = [];
        if (signature.photo) {
          console.log(`📷 [BACKEND] Fichier photo à supprimer: ${signature.photo}`);
          filesToDelete.push(signature.photo);
        }
        
        if (signature.logo) {
          console.log(`🏢 [BACKEND] Fichier logo à supprimer: ${signature.logo}`);
          filesToDelete.push(signature.logo);
        }

        // 4. Suppression des fichiers de manière séquentielle avec gestion d'erreur
        if (filesToDelete.length > 0) {
          console.log(`🔄 [BACKEND] Tentative de suppression de ${filesToDelete.length} fichier(s)...`);
          
          // Supprimer les fichiers un par un de manière séquentielle
          for (const filePath of filesToDelete) {
            try {
              console.log(`🗑️ [BACKEND] Suppression du fichier: ${filePath}`);
              await deleteFile(filePath);
              console.log(`✅ [BACKEND] Fichier supprimé avec succès: ${filePath}`);
            } catch (error) {
              console.error(`⚠️ [BACKEND] Échec de la suppression du fichier ${filePath}:`, error.message);
              // On continue même si la suppression d'un fichier échoue
            }
          }
        } else {
          console.log(`ℹ️ [BACKEND] Aucun fichier à supprimer`);
        }

        // 5. Suppression de la signature en base de données
        console.log(`🗑️ [BACKEND] Suppression de l'entrée en base de données...`);
        const deleteResult = await EmailSignature.deleteOne({ _id: id, createdBy: user.id });
        
        console.log(`🔍 [BACKEND] Résultat suppression DB:`, JSON.stringify(deleteResult, null, 2));
        
        if (deleteResult.deletedCount !== 1) {
          console.error(`❌ [BACKEND] Aucun document supprimé, deletedCount: ${deleteResult.deletedCount}`);
          throw new Error('Aucune signature trouvée à supprimer');
        }
        
        console.log(`✅ [BACKEND] Signature supprimée avec succès`);
        return true;
      } catch (error) {
        console.error(`❌ [BACKEND] Erreur lors de la suppression:`, error);
        
        // Si l'erreur est déjà une erreur métier, on la renvoie telle quelle
        if (error.extensions && error.extensions.code) {
          console.error(`❌ [BACKEND] Erreur métier:`, error.message);
          throw error;
        }
        
        // Sinon, on crée une erreur générique
        const errorMessage = error.message || 'Une erreur est survenue lors de la suppression de la signature';
        console.error(`❌ [BACKEND] Erreur technique: ${errorMessage}`);
        throw new Error(errorMessage);
      }
    }),

    // Définir une signature comme par défaut
    setDefaultEmailSignature: isAuthenticated(async (_, { id }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
      
      if (!signature) {
        throw createNotFoundError('Signature email');
      }
      
      // Définir cette signature comme signature par défaut
      signature.isDefault = true;
      await signature.save(); // Le middleware pre-save s'occupera de mettre à jour les autres signatures
      
      return signature;
    })
  }
};

export default emailSignatureResolvers;
