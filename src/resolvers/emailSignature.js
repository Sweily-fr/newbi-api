import EmailSignature from '../models/EmailSignature.js';
import { isAuthenticated } from '../middlewares/auth.js';
import { 
  createNotFoundError, 
  createAlreadyExistsError,
  createValidationError
} from '../utils/errors.js';
import { saveEmailSignaturePhoto, deleteFile } from '../utils/fileUpload.js';
import { 
  NAME_REGEX, 
  EMAIL_REGEX, 
  PHONE_REGEX, 
  PHONE_FR_REGEX, 
  URL_REGEX 
} from '../utils/validators.js';

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
      // Validation explicite des champs sensibles
      const validationErrors = {};
      
      if (input.name && !NAME_REGEX.test(input.name)) {
        validationErrors.name = 'Le nom contient des caractères non autorisés';
      }
      
      if (input.fullName && !NAME_REGEX.test(input.fullName)) {
        validationErrors.fullName = 'Le nom complet contient des caractères non autorisés';
      }
      
      if (input.jobTitle && !NAME_REGEX.test(input.jobTitle)) {
        validationErrors.jobTitle = 'Le titre du poste contient des caractères non autorisés';
      }
      
      if (input.email && !EMAIL_REGEX.test(input.email)) {
        validationErrors.email = 'Format d\'email invalide';
      }
      
      if (input.phone && input.phone.trim() !== '' && !PHONE_FR_REGEX.test(input.phone)) {
        validationErrors.phone = 'Format de numéro de téléphone invalide';
      }
      
      if (input.mobilePhone && input.mobilePhone.trim() !== '' && !PHONE_FR_REGEX.test(input.mobilePhone)) {
        validationErrors.mobilePhone = 'Format de numéro de mobile invalide';
      }
      
      if (input.website && input.website.trim() !== '' && !URL_REGEX.test(input.website)) {
        validationErrors.website = 'Format d\'URL invalide';
      }
      
      // Vérifier les liens sociaux si présents
      if (input.socialLinks) {
        if (input.socialLinks.linkedin && !URL_REGEX.test(input.socialLinks.linkedin)) {
          validationErrors['socialLinks.linkedin'] = 'Format d\'URL LinkedIn invalide';
        }
        
        if (input.socialLinks.twitter && !URL_REGEX.test(input.socialLinks.twitter)) {
          validationErrors['socialLinks.twitter'] = 'Format d\'URL Twitter invalide';
        }
        
        if (input.socialLinks.facebook && !URL_REGEX.test(input.socialLinks.facebook)) {
          validationErrors['socialLinks.facebook'] = 'Format d\'URL Facebook invalide';
        }
        
        if (input.socialLinks.instagram && !URL_REGEX.test(input.socialLinks.instagram)) {
          validationErrors['socialLinks.instagram'] = 'Format d\'URL Instagram invalide';
        }
      }
      
      // Si des erreurs de validation sont détectées, lancer une exception
      if (Object.keys(validationErrors).length > 0) {
        throw createValidationError('Certains champs contiennent des erreurs de validation', validationErrors);
      }
      
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
      
      // Log des données reçues pour débogage
      console.log('Données reçues pour création de signature email:', {
        companyName: input.companyName,
        website: input.website,
        address: input.address
      });
      
      // S'assurer que companyName est correctement défini
      const signatureData = {
        ...input,
        profilePhotoUrl,
        isDefault,
        createdBy: user.id,
        // Forcer l'utilisation du companyName fourni par le client
        companyName: input.companyName || ''
      };
      
      const signature = new EmailSignature(signatureData);
      
      await signature.save();
      return signature;
    }),

    updateEmailSignature: isAuthenticated(async (_, { id, input }, { user }) => {
      const signature = await EmailSignature.findOne({ _id: id, createdBy: user.id });
      
      if (!signature) {
        throw createNotFoundError('Signature email');
      }
      
      // Validation explicite des champs sensibles
      const validationErrors = {};
      
      if (input.name && !NAME_REGEX.test(input.name)) {
        validationErrors.name = 'Le nom contient des caractères non autorisés';
      }
      
      if (input.fullName && !NAME_REGEX.test(input.fullName)) {
        validationErrors.fullName = 'Le nom complet contient des caractères non autorisés';
      }
      
      if (input.jobTitle && !NAME_REGEX.test(input.jobTitle)) {
        validationErrors.jobTitle = 'Le titre du poste contient des caractères non autorisés';
      }
      
      if (input.email && !EMAIL_REGEX.test(input.email)) {
        validationErrors.email = 'Format d\'email invalide';
      }
      
      if (input.phone && input.phone.trim() !== '' && !PHONE_FR_REGEX.test(input.phone)) {
        validationErrors.phone = 'Format de numéro de téléphone invalide';
      }
      
      if (input.mobilePhone && input.mobilePhone.trim() !== '' && !PHONE_FR_REGEX.test(input.mobilePhone)) {
        validationErrors.mobilePhone = 'Format de numéro de mobile invalide';
      }
      
      if (input.website && input.website.trim() !== '' && !URL_REGEX.test(input.website)) {
        validationErrors.website = 'Format d\'URL invalide';
      }
      
      // Vérifier les liens sociaux si présents
      if (input.socialLinks) {
        if (input.socialLinks.linkedin && !URL_REGEX.test(input.socialLinks.linkedin)) {
          validationErrors['socialLinks.linkedin'] = 'Format d\'URL LinkedIn invalide';
        }
        
        if (input.socialLinks.twitter && !URL_REGEX.test(input.socialLinks.twitter)) {
          validationErrors['socialLinks.twitter'] = 'Format d\'URL Twitter invalide';
        }
        
        if (input.socialLinks.facebook && !URL_REGEX.test(input.socialLinks.facebook)) {
          validationErrors['socialLinks.facebook'] = 'Format d\'URL Facebook invalide';
        }
        
        if (input.socialLinks.instagram && !URL_REGEX.test(input.socialLinks.instagram)) {
          validationErrors['socialLinks.instagram'] = 'Format d\'URL Instagram invalide';
        }
      }
      
      // Si des erreurs de validation sont détectées, lancer une exception
      if (Object.keys(validationErrors).length > 0) {
        throw createValidationError('Certains champs contiennent des erreurs de validation', validationErrors);
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
      
      // Log des données reçues pour débogage
      console.log('Données reçues pour mise à jour de signature email:', {
        id,
        companyName: input.companyName,
        website: input.website,
        address: input.address
      });
      
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
      
      // S'assurer explicitement que companyName est correctement défini
      if (input.companyName !== undefined) {
        signature.companyName = input.companyName;
      }
      
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

export default emailSignatureResolvers;
