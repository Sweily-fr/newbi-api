const EmailSignature = require('../models/EmailSignature');
const { isAuthenticated } = require('../middlewares/auth');
const { 
  createNotFoundError, 
  createAlreadyExistsError
} = require('../utils/errors');
const { saveEmailSignaturePhoto, deleteFile } = require('../utils/fileUpload');

const emailSignatureResolvers = {
  Query: {
    emailSignature: isAuthenticated(async (_, { id }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
      if (!signature) throw createNotFoundError('Signature email');
      return signature;
    }),

    emailSignatures: isAuthenticated(async (_, { search, page = 1, limit = 20 }, { user }) => {
      const query = { createdBy: user.id };
      
      if (search && search.trim() !== '') {
        // Créer une requête OR pour rechercher dans plusieurs champs
        const searchRegex = new RegExp(search, 'i'); // 'i' pour insensible à la casse
        
        query.$or = [
          { name: searchRegex },         // Recherche par nom
          { fullName: searchRegex },     // Recherche par nom complet
          { jobTitle: searchRegex },     // Recherche par titre de poste
          { email: searchRegex }         // Recherche par email
        ];
      }
      
      const skip = (page - 1) * limit;
      
      // Définir les options de tri
      let sortOptions = { updatedAt: -1 }; // Tri par défaut par date de mise à jour (plus récent en premier)
      
      const [signatures, totalCount] = await Promise.all([
        EmailSignature.find(query)
          .sort(sortOptions)
          .skip(skip)
          .limit(limit),
        EmailSignature.countDocuments(query)
      ]);
      
      return {
        signatures,
        totalCount,
        hasNextPage: skip + signatures.length < totalCount
      };
    }),

    defaultEmailSignature: isAuthenticated(async (_, __, { user }) => {
      const signature = await EmailSignature.findOne({ 
        createdBy: user.id,
        isDefault: true
      });
      
      return signature; // Peut être null si aucune signature par défaut n'existe
    })
  },

  Mutation: {
    createEmailSignature: isAuthenticated(async (_, { input }, { user }) => {
      // Vérifier si une signature avec ce nom existe déjà pour cet utilisateur
      const existingSignature = await EmailSignature.findOne({ 
        name: input.name,
        createdBy: user.id 
      });
      
      if (existingSignature) {
        throw createAlreadyExistsError('signature email', 'nom', input.name);
      }
      
      // Si c'est la première signature de l'utilisateur, la définir comme signature par défaut
      const signatureCount = await EmailSignature.countDocuments({ createdBy: user.id });
      const isDefault = input.isDefault !== undefined ? input.isDefault : (signatureCount === 0);
      
      // Traiter l'upload de la photo de profil si présente
      let profilePhotoUrl = input.profilePhotoUrl;
      if (input.profilePhotoBase64) {
        try {
          profilePhotoUrl = saveEmailSignaturePhoto(input.profilePhotoBase64);
        } catch (error) {
          console.error('Erreur lors de l\'upload de la photo de profil:', error);
          // Continuer sans la photo de profil en cas d'erreur
        }
      }
      
      const signature = new EmailSignature({
        ...input,
        profilePhotoUrl,
        isDefault,
        createdBy: user.id
      });
      
      await signature.save();
      return signature;
    }),

    updateEmailSignature: isAuthenticated(async (_, { id, input }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
      
      if (!signature) {
        throw createNotFoundError('Signature email');
      }
      
      // Si le nom est modifié, vérifier qu'il n'existe pas déjà
      if (input.name && input.name !== signature.name) {
        const existingSignature = await EmailSignature.findOne({ 
          name: input.name,
          createdBy: user.id,
          _id: { $ne: id }
        });
        
        if (existingSignature) {
          throw createAlreadyExistsError('signature email', 'nom', input.name);
        }
      }
      
      // Traiter l'upload de la photo de profil si présente
      if (input.profilePhotoBase64) {
        try {
          // Supprimer l'ancienne photo si elle existe
          if (signature.profilePhotoUrl) {
            deleteFile(signature.profilePhotoUrl);
          }
          // Sauvegarder la nouvelle photo
          input.profilePhotoUrl = saveEmailSignaturePhoto(input.profilePhotoBase64);
        } catch (error) {
          console.error('Erreur lors de l\'upload de la photo de profil:', error);
          // Continuer sans la photo de profil en cas d'erreur
        }
      } else if (input.profilePhotoToDelete && signature.profilePhotoUrl) {
        // Supprimer la photo si demandé
        try {
          deleteFile(signature.profilePhotoUrl);
          input.profilePhotoUrl = null;
        } catch (error) {
          console.error('Erreur lors de la suppression de la photo de profil:', error);
        }
      }
      
      // Mettre à jour la signature
      Object.keys(input).forEach(key => {
        if (key === 'socialLinks' && input[key]) {
          // Traitement spécial pour les liens sociaux (objet imbriqué)
          Object.keys(input[key]).forEach(socialKey => {
            signature.socialLinks[socialKey] = input[key][socialKey];
          });
        } else if (key !== 'profilePhotoBase64' && key !== 'profilePhotoToDelete') {
          // Ne pas copier ces propriétés dans le modèle
          signature[key] = input[key];
        }
      });
      
      await signature.save();
      return signature;
    }),

    deleteEmailSignature: isAuthenticated(async (_, { id }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
      
      if (!signature) {
        throw createNotFoundError('Signature email');
      }
      
      // Si la signature supprimée était la signature par défaut et qu'il y a d'autres signatures,
      // définir la signature la plus récente comme nouvelle signature par défaut
      if (signature.isDefault) {
        const otherSignature = await EmailSignature.findOne({ 
          createdBy: user.id,
          _id: { $ne: id }
        }).sort({ updatedAt: -1 });
        
        if (otherSignature) {
          otherSignature.isDefault = true;
          await otherSignature.save();
        }
      }
      
      // Supprimer la photo de profil si elle existe
      if (signature.profilePhotoUrl) {
        try {
          deleteFile(signature.profilePhotoUrl);
        } catch (error) {
          console.error('Erreur lors de la suppression de la photo de profil:', error);
          // Continuer même en cas d'erreur
        }
      }
      
      await EmailSignature.deleteOne({ _id: id, createdBy: user.id });
      return true;
    }),

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

module.exports = emailSignatureResolvers;
