const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const { isAuthenticated } = require('../middlewares/auth');
const { sendPasswordResetEmail, sendVerificationEmail, sendPasswordResetConfirmationEmail } = require('../utils/mailer');
const { saveBase64Image, deleteFile } = require('../utils/fileUpload');
const path = require('path');
const { 
  AppError, 
  ERROR_CODES,
  createNotFoundError,
  createAlreadyExistsError,
  createValidationError
} = require('../utils/errors');

const generateToken = (user, rememberMe = false) => {
  // Définir la durée d'expiration en fonction de l'option "Se souvenir de moi"
  const expiresIn = rememberMe ? '30d' : '24h'; // 30 jours si "Se souvenir de moi" est activé, sinon 24 heures
  
  return jwt.sign(
    { id: user.id, email: user.email, isEmailVerified: user.isEmailVerified },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

// Fonction pour générer un token de vérification d'email
const generateVerificationToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const userResolvers = {
  Query: {
    me: isAuthenticated(async (_, __, { user }) => {
      return await User.findById(user.id);
    }),
  },

  Mutation: {
    register: async (_, { input }) => {
      const existingUser = await User.findOne({ email: input.email.toLowerCase() });
      if (existingUser) {
        throw createAlreadyExistsError('utilisateur', 'email', input.email);
      }

      // Générer un token de vérification d'email
      const emailVerificationToken = generateVerificationToken();
      const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 heures

      const user = new User({
        ...input,
        email: input.email.toLowerCase(),
        emailVerificationToken,
        emailVerificationExpires
      });
      await user.save();

      // Envoyer l'email de vérification
      await sendVerificationEmail(user.email, emailVerificationToken);

      // Ne pas générer de token, l'utilisateur doit d'abord vérifier son email
      return { 
        user,
        message: "Inscription réussie ! Veuillez vérifier votre boîte mail pour confirmer votre adresse email avant de vous connecter."
      };
    },

    login: async (_, { input }) => {
      const user = await User.findOne({ email: input.email.toLowerCase() });
      if (!user) {
        throw new AppError(
          'L\'email n\'existe pas',
          ERROR_CODES.UNAUTHENTICATED
        );
      }

      const validPassword = await user.comparePassword(input.password);
      if (!validPassword) {
        throw new AppError(
          'Le mot de passe ne correspond pas',
          ERROR_CODES.UNAUTHENTICATED
        );
      }

      // Vérifier si le compte est désactivé
      if (user.isDisabled) {
        throw new AppError(
          'Ce compte a été désactivé. Utilisez la mutation reactivateAccount pour le réactiver.',
          ERROR_CODES.ACCOUNT_DISABLED
        );
      }

      // Vérifier si l'email est vérifié
      if (!user.isEmailVerified) {
        throw new AppError(
          'Veuillez vérifier votre adresse email avant de vous connecter. Consultez votre boîte de réception.',
          ERROR_CODES.EMAIL_NOT_VERIFIED
        );
      }

      // Utiliser l'option rememberMe pour générer un token avec une durée appropriée
      const rememberMe = input.rememberMe || false;
      const token = generateToken(user, rememberMe);
      
      return { token, user };
    },

    requestPasswordReset: async (_, { input }) => {
      try {
        const user = await User.findOne({ email: input.email.toLowerCase() });
        if (!user) {
          return true; // Pour des raisons de sécurité, toujours retourner true
        }

        // Générer un token aléatoire pour la réinitialisation
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        user.resetPasswordToken = hashedToken;
        user.resetPasswordExpires = Date.now() + 3600000; // 1 heure
        await user.save();

        // Envoyer l'email avec le token non haché
        await sendPasswordResetEmail(input.email, resetToken);

        return true;
      } catch (error) {
        console.error('Error in requestPasswordReset:', error);
        return true; // Toujours retourner true pour des raisons de sécurité
      }
    },

    resetPassword: async (_, { input: { token, newPassword } }) => {
      try {
        // Hash le token reçu pour le comparer avec celui stocké dans la base
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        // Vérifier si le token existe et n'est pas expiré
        const user = await User.findOne({
          resetPasswordToken: hashedToken,
          resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) {
          throw new AppError(
            'Le lien de réinitialisation est invalide ou a expiré.',
            ERROR_CODES.INVALID_TOKEN
          );
        }

        // Assigner le nouveau mot de passe (sera hashé par le middleware pre-save)
        user.password = newPassword;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();
        
        // Envoyer un email de confirmation à l'utilisateur
        try {
          await sendPasswordResetConfirmationEmail(user.email);
          console.log(`Email de confirmation de réinitialisation de mot de passe envoyé à ${user.email}`);
        } catch (emailError) {
          console.error('Erreur lors de l\'envoi de l\'email de confirmation:', emailError);
          // Ne pas bloquer le processus si l'envoi de l'email échoue
        }

        return {
          success: true,
          message: 'Votre mot de passe a été réinitialisé avec succès.'
        };
      } catch (error) {
        console.error('Erreur lors de la réinitialisation du mot de passe:', error);
        throw new AppError(
          'Une erreur est survenue lors de la réinitialisation du mot de passe.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    },

    updateProfile: isAuthenticated(async (_, { input }, { user }) => {
      try {
        // Récupérer d'abord l'utilisateur
        const userDoc = await User.findById(user.id);
        
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }
        
        // Gérer l'upload de la photo de profil si présente dans l'input
        if (input.profilePicture !== undefined) {
          // Si la photo de profil est une chaîne vide, cela signifie que l'utilisateur veut la supprimer
          if (input.profilePicture === '') {
            // Si une photo de profil existe déjà, la supprimer
            if (userDoc.profile && userDoc.profile.profilePicture) {
              try {
                const oldPicturePath = userDoc.profile.profilePicture;
                await deleteFile(oldPicturePath);
                console.log('Photo de profil supprimée:', oldPicturePath);
              } catch (err) {
                console.error('Erreur lors de la suppression de l\'ancienne photo de profil:', err);
                // Continuer même si la suppression échoue
              }
            }
            
            // Mettre à jour le champ profilePicture à une chaîne vide
            input.profilePicture = '';
          } 
          // Si la photo de profil est une chaîne base64, cela signifie que l'utilisateur veut la mettre à jour
          else if (input.profilePicture.startsWith('data:image')) {
            // Si une photo de profil existe déjà, la supprimer
            if (userDoc.profile && userDoc.profile.profilePicture) {
              try {
                const oldPicturePath = userDoc.profile.profilePicture;
                await deleteFile(oldPicturePath);
                console.log('Ancienne photo de profil supprimée:', oldPicturePath);
              } catch (err) {
                console.error('Erreur lors de la suppression de l\'ancienne photo de profil:', err);
                // Continuer même si la suppression échoue
              }
            }
            
            // Sauvegarder la nouvelle image
            const picturePath = await saveBase64Image(input.profilePicture, 'profile-pictures');
            console.log('Nouvelle photo de profil sauvegardée:', picturePath);
            
            // Mettre à jour le champ profilePicture avec le chemin de la nouvelle image
            input.profilePicture = picturePath;
          }
          // Si la photo de profil n'est ni une chaîne vide ni une chaîne base64, la supprimer de l'input
          else if (!input.profilePicture.startsWith('/uploads/')) {
            delete input.profilePicture;
          }
        }
        
        // Mettre à jour les champs du profil
        userDoc.profile = {
          ...userDoc.profile.toObject(),
          ...input
        };
        
        // Sauvegarder avec validation
        await userDoc.save();
        
        return userDoc;
      } catch (error) {
        if (error.name === 'ValidationError') {
          throw createValidationError(error);
        }
        
        if (error.name === 'AppError') throw error;
        
        console.error('Erreur lors de la mise à jour du profil:', error);
        throw new AppError(
          'Une erreur est survenue lors de la mise à jour du profil.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    updateCompany: isAuthenticated(async (_, { input }, { user }) => {
      try {
        // Récupérer d'abord l'utilisateur
        const userDoc = await User.findById(user.id);
        
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }
        
        // Mettre à jour les champs de l'entreprise
        userDoc.company = {
          ...userDoc.company.toObject(),
          ...input
        };
        
        // S'assurer que transactionCategory est correctement défini
        console.log('Input complet:', JSON.stringify(input));
        console.log('Transaction Category reçue:', input.transactionCategory);
        
        // Traiter explicitement le champ transactionCategory
        // Si la valeur est définie (même vide), l'utiliser
        if (Object.prototype.hasOwnProperty.call(input, 'transactionCategory')) {
          userDoc.company.transactionCategory = input.transactionCategory || null;
          console.log('Transaction Category après traitement:', userDoc.company.transactionCategory);
        }
        
        // Traiter explicitement le champ vatPaymentCondition
        if (Object.prototype.hasOwnProperty.call(input, 'vatPaymentCondition')) {
          userDoc.company.vatPaymentCondition = input.vatPaymentCondition || null;
          console.log('VAT Payment Condition après traitement:', userDoc.company.vatPaymentCondition);
        }
        
        // Traiter explicitement le champ companyStatus
        if (Object.prototype.hasOwnProperty.call(input, 'companyStatus')) {
          userDoc.company.companyStatus = input.companyStatus || 'AUTRE';
          console.log('Company Status après traitement:', userDoc.company.companyStatus);
        }
        
        // Traiter explicitement le champ capitalSocial
        if (Object.prototype.hasOwnProperty.call(input, 'capitalSocial')) {
          userDoc.company.capitalSocial = input.capitalSocial || null;
          console.log('Capital Social après traitement:', userDoc.company.capitalSocial);
        }
        
        // Traiter explicitement le champ rcs
        if (Object.prototype.hasOwnProperty.call(input, 'rcs')) {
          userDoc.company.rcs = input.rcs || null;
          console.log('RCS après traitement:', userDoc.company.rcs);
        }
        
        // Sauvegarder avec validation
        await userDoc.save();
        
        return userDoc;
      } catch (error) {
        if (error.name === 'ValidationError') {
          throw createValidationError(error);
        }
        
        if (error.name === 'AppError') throw error;
        
        console.error('Erreur lors de la mise à jour des informations de l\'entreprise:', error);
        throw new AppError(
          'Une erreur est survenue lors de la mise à jour des informations de l\'entreprise.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),
    // Ajouter cette mutation dans l'objet Mutation du resolver
    uploadCompanyLogo: isAuthenticated(async (_, { base64Image }, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }

        // Nous ne supprimons plus l'ancien logo pour préserver les références dans les factures et devis existants
        // if (userDoc.company && userDoc.company.logo) {
        //   try {
        //     const oldLogoPath = userDoc.company.logo;
        //     await deleteFile(oldLogoPath);
        //   } catch (err) {
        //     console.error('Erreur lors de la suppression de l\'ancien logo:', err);
        //     // Continuer même si la suppression échoue
        //   }
        // }

        // Sauvegarder la nouvelle image
        const logoPath = await saveBase64Image(base64Image);
        console.log('Logo path reçu de saveBase64Image:', logoPath);

        // Mettre à jour l'utilisateur
        userDoc.company = userDoc.company || {};
        userDoc.company.logo = logoPath;
        console.log('Logo path sauvegardé dans userDoc:', userDoc.company.logo);
        
        await userDoc.save();
        console.log('Utilisateur sauvegardé avec logo:', userDoc.company.logo);

        return userDoc;
      } catch (error) {
        console.error('Erreur lors de l\'upload du logo:', error);
        throw new AppError(
          'Une erreur est survenue lors de l\'upload du logo.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    uploadProfilePicture: isAuthenticated(async (_, { base64Image }, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }

        // Si une photo de profil existe déjà, la supprimer
        if (userDoc.profile && userDoc.profile.profilePicture) {
          try {
            const oldPicturePath = userDoc.profile.profilePicture;
            await deleteFile(oldPicturePath);
          } catch (err) {
            console.error('Erreur lors de la suppression de l\'ancienne photo de profil:', err);
            // Continuer même si la suppression échoue
          }
        }

        // Sauvegarder la nouvelle image dans le dossier profile-pictures
        const picturePath = await saveBase64Image(base64Image, 'profile-pictures');
        console.log('Photo path reçu de saveBase64Image:', picturePath);

        // Mettre à jour l'utilisateur
        userDoc.profile = userDoc.profile || {};
        userDoc.profile.profilePicture = picturePath;
        console.log('Photo path sauvegardé dans userDoc:', userDoc.profile.profilePicture);
        
        await userDoc.save();
        console.log('Utilisateur sauvegardé avec photo de profil:', userDoc.profile.profilePicture);

        return userDoc;
      } catch (error) {
        console.error('Erreur lors de l\'upload de la photo de profil:', error);
        throw new AppError(
          'Une erreur est survenue lors de l\'upload de la photo de profil.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    deleteCompanyLogo: isAuthenticated(async (_, __, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }

        // Si un logo existe, le supprimer
        if (userDoc.company && userDoc.company.logo) {
          try {
            const logoPath = userDoc.company.logo;
            console.log('Tentative de suppression du logo:', logoPath);
            const deleted = await deleteFile(logoPath);
            console.log('Résultat de la suppression:', deleted ? 'Succès' : 'Échec');
          } catch (err) {
            console.error('Erreur lors de la suppression du logo:', err);
            // Continuer même si la suppression échoue
          }
        } else {
          console.log('Aucun logo à supprimer pour l\'utilisateur:', user.id);
        }

        // Mettre à jour l'utilisateur
        userDoc.company = userDoc.company || {};
        userDoc.company.logo = '';
        await userDoc.save();
        console.log('Logo supprimé de la base de données pour l\'utilisateur:', user.id);

        return userDoc;
      } catch (error) {
        console.error('Erreur lors de la suppression du logo:', error);
        throw new AppError(
          'Une erreur est survenue lors de la suppression du logo.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    deleteProfilePicture: isAuthenticated(async (_, __, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }

        // Si une photo de profil existe, la supprimer
        if (userDoc.profile && userDoc.profile.profilePicture) {
          try {
            const picturePath = userDoc.profile.profilePicture;
            console.log('Tentative de suppression de la photo de profil:', picturePath);
            const deleted = await deleteFile(picturePath);
            console.log('Résultat de la suppression:', deleted ? 'Succès' : 'Échec');
          } catch (err) {
            console.error('Erreur lors de la suppression de la photo de profil:', err);
            // Continuer même si la suppression échoue
          }
        } else {
          console.log('Aucune photo de profil à supprimer pour l\'utilisateur:', user.id);
        }

        // Mettre à jour l'utilisateur
        userDoc.profile = userDoc.profile || {};
        userDoc.profile.profilePicture = '';
        await userDoc.save();
        console.log('Photo de profil supprimée de la base de données pour l\'utilisateur:', user.id);

        return userDoc;
      } catch (error) {
        console.error('Erreur lors de la suppression de la photo de profil:', error);
        throw new AppError(
          'Une erreur est survenue lors de la suppression de la photo de profil.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    verifyEmail: async (_, { token }) => {
      // Rechercher l'utilisateur avec ce token de vérification
      const user = await User.findOne({
        emailVerificationToken: token,
        emailVerificationExpires: { $gt: Date.now() }
      });

      if (!user) {
        throw new AppError(
          'Le lien de vérification est invalide ou a expiré',
          ERROR_CODES.INVALID_TOKEN
        );
      }

      // Marquer l'email comme vérifié et supprimer le token
      user.isEmailVerified = true;
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
      await user.save();

      return {
        success: true,
        message: 'Votre adresse email a été vérifiée avec succès. Vous pouvez maintenant vous connecter.'
      };
    },

    resendVerificationEmail: async (_, { email }) => {
      // Rechercher l'utilisateur par email
      const user = await User.findOne({ email: email.toLowerCase() });
      
      if (!user) {
        // Pour des raisons de sécurité, ne pas indiquer si l'email existe ou non
        return true;
      }

      // Vérifier si l'email est déjà vérifié
      if (user.isEmailVerified) {
        return true;
      }

      // Générer un nouveau token
      const emailVerificationToken = generateVerificationToken();
      const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 heures

      // Mettre à jour l'utilisateur avec le nouveau token
      user.emailVerificationToken = emailVerificationToken;
      user.emailVerificationExpires = emailVerificationExpires;
      await user.save();

      // Envoyer l'email de vérification
      await sendVerificationEmail(user.email, emailVerificationToken);

      return true;
    },

    updatePassword: isAuthenticated(async (_, { currentPassword, newPassword }, { user }) => {
      try {
        const userDoc = await User.findById(user.id);
        
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }
        
        const validPassword = await userDoc.comparePassword(currentPassword);
        if (!validPassword) {
          throw new AppError(
            'Le mot de passe actuel est incorrect',
            ERROR_CODES.INVALID_INPUT,
            { field: 'currentPassword' }
          );
        }
        
        userDoc.password = newPassword;
        await userDoc.save();
        
        return {
          success: true,
          message: 'Mot de passe mis à jour avec succès'
        };
      } catch (error) {
        if (error.name === 'AppError') throw error;
        
        console.error('Erreur lors de la mise à jour du mot de passe:', error);
        throw new AppError(
          'Une erreur est survenue lors de la mise à jour du mot de passe.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    disableAccount: isAuthenticated(async (_, { password }, { user }) => {
      try {
        const userDoc = await User.findById(user.id);
        
        if (!userDoc) {
          throw createNotFoundError('Utilisateur');
        }
        
        // Vérifier le mot de passe pour confirmer l'action
        const validPassword = await userDoc.comparePassword(password);
        if (!validPassword) {
          throw new AppError(
            'Le mot de passe est incorrect',
            ERROR_CODES.INVALID_INPUT,
            { field: 'password' }
          );
        }
        
        // Désactiver le compte
        userDoc.isDisabled = true;
        await userDoc.save();
        
        return {
          success: true,
          message: 'Votre compte a été désactivé avec succès'
        };
      } catch (error) {
        if (error.name === 'AppError') throw error;
        
        console.error('Erreur lors de la désactivation du compte:', error);
        throw new AppError(
          'Une erreur est survenue lors de la désactivation de votre compte.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    reactivateAccount: async (_, { email, password }) => {
      try {
        const user = await User.findOne({ email: email.toLowerCase() });
        
        if (!user) {
          throw createNotFoundError('Utilisateur');
        }
        
        // Vérifier si le compte est bien désactivé
        if (!user.isDisabled) {
          return {
            success: false,
            message: 'Ce compte est déjà actif',
            user: null
          };
        }
        
        // Vérifier le mot de passe pour confirmer l'action
        const validPassword = await user.comparePassword(password);
        if (!validPassword) {
          throw new AppError(
            'Le mot de passe est incorrect',
            ERROR_CODES.INVALID_INPUT,
            { field: 'password' }
          );
        }
        
        // Réactiver le compte
        user.isDisabled = false;
        await user.save();
        
        return {
          success: true,
          message: 'Votre compte a été réactivé avec succès',
          user: user
        };
      } catch (error) {
        if (error.name === 'AppError') throw error;
        
        console.error('Erreur lors de la réactivation du compte:', error);
        throw new AppError(
          'Une erreur est survenue lors de la réactivation de votre compte.',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    },
    
    // Nouvelle mutation pour associer un ID client Stripe à un utilisateur
    setStripeCustomerId: isAuthenticated(async (_, { stripeCustomerId }, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError('Utilisateur non trouvé');
        }
        
        // Mettre à jour le Stripe Customer ID
        userDoc.subscription = userDoc.subscription || {};
        userDoc.subscription.stripeCustomerId = stripeCustomerId;
        
        // Sauvegarder les modifications
        await userDoc.save();
        
        console.log(`Stripe Customer ID associé à l'utilisateur ${userDoc.email}: ${stripeCustomerId}`);
        
        return userDoc;
      } catch (error) {
        console.error('Erreur lors de l\'association du Stripe Customer ID:', error);
        throw new AppError(
          'Erreur lors de l\'association du Stripe Customer ID',
          ERROR_CODES.INTERNAL_ERROR,
          error.message
        );
      }
    })
  }
};

module.exports = userResolvers;
