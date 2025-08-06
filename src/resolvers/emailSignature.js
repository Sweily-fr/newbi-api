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
      console.log('🔍 [SERVER] Récupération des signatures pour utilisateur:', user.email);
      const signatures = await EmailSignature.find({ createdBy: user.id })
        .sort({ updatedAt: -1 }); // Tri par date de mise à jour (plus récent en premier)
      console.log('📊 [SERVER] Signatures trouvées:', signatures.length);
      console.log('📋 [SERVER] Détails des signatures:', signatures.map(s => ({
        id: s._id,
        signatureName: s.signatureName,
        firstName: s.firstName,
        lastName: s.lastName,
        email: s.email,
        isDefault: s.isDefault,
        createdAt: s.createdAt
      })));
      return signatures;
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
      console.log('🚀 [SERVER] Début création signature pour utilisateur:', user.email);
      console.log('📝 [SERVER] Données reçues:', JSON.stringify(input, null, 2));
      
      // Validation basique - seul le nom de signature est requis
      if (!input.signatureName || input.signatureName.trim() === '') {
        console.log('❌ [SERVER] Erreur: nom de signature manquant');
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
      
      // Supprimer les fichiers associés (photo et logo) si ils existent
      if (signature.photo) {
        try {
          deleteFile(signature.photo);
        } catch (error) {
          console.error('Erreur lors de la suppression de la photo de profil:', error);
        }
      }
      
      if (signature.logo) {
        try {
          deleteFile(signature.logo);
        } catch (error) {
          console.error('Erreur lors de la suppression du logo:', error);
        }
      }
      
      await EmailSignature.deleteOne({ _id: id, createdBy: user.id });
      return true;
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
