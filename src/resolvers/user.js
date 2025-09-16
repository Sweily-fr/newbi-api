import jwt from "jsonwebtoken";
import crypto from "crypto";
import mongoose from "mongoose";
import User from "../models/User.js";
import { isAuthenticated } from "../middlewares/auth.js";
import { withWorkspace } from "../middlewares/better-auth.js";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendPasswordResetConfirmationEmail,
} from "../utils/mailer.js";
import { saveBase64Image, deleteFile } from "../utils/fileUpload.js";
import path from "path";
import CryptoJS from "crypto-js";
import {
  AppError,
  ERROR_CODES,
  createNotFoundError,
  createAlreadyExistsError,
  createValidationError,
} from "../utils/errors.js";

const generateToken = (user, rememberMe = false) => {
  // Définir la durée d'expiration en fonction de l'option "Se souvenir de moi"
  const expiresIn = rememberMe ? "30d" : "24h"; // 30 jours si "Se souvenir de moi" est activé, sinon 24 heures

  return jwt.sign(
    { id: user.id, email: user.email, isEmailVerified: user.isEmailVerified },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

// Fonction pour générer un token de vérification d'email
const generateVerificationToken = () => {
  return crypto.randomBytes(32).toString("hex");
};

const userResolvers = {
  Query: {
    me: isAuthenticated(async (_, __, { user }) => {
      return await User.findById(user.id);
    }),
  },

  Mutation: {
    register: async (_, { input }) => {
      try {
        const existingUser = await User.findOne({
          email: input.email.toLowerCase(),
        });
        if (existingUser) {
          throw createAlreadyExistsError("utilisateur", "email", input.email);
        }

        // Déchiffrer le mot de passe si nécessaire
        let password = input.password;
        if (input.passwordEncrypted) {
          try {
            const parts = password.split(":");
            if (parts.length !== 2) {
              throw new Error("Format de mot de passe chiffré invalide");
            }

            // SHA256 sur la clé, comme côté front !
            const keyRaw =
              process.env.PASSWORD_ENCRYPTION_KEY || "newbi-public-key";
            const key = CryptoJS.SHA256(keyRaw);

            const iv = CryptoJS.enc.Base64.parse(parts[0]);
            const cipherText = CryptoJS.enc.Base64.parse(parts[1]);

            const cipherParams = CryptoJS.lib.CipherParams.create({
              ciphertext: cipherText,
            });

            const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
              iv,
              mode: CryptoJS.mode.CBC,
              padding: CryptoJS.pad.Pkcs7,
            });

            const clearPassword = decrypted.toString(CryptoJS.enc.Utf8);

            if (!clearPassword) {
              throw new Error("Échec du déchiffrement du mot de passe");
            }
            password = clearPassword;
          } catch (error) {
            console.error(
              "Erreur lors du déchiffrement du mot de passe:",
              error
            );
            throw new AppError(
              "Erreur lors du traitement de votre demande. Veuillez réessayer.",
              ERROR_CODES.INTERNAL_ERROR
            );
          }
        }

        // Générer un token de vérification d'email
        const emailVerificationToken = generateVerificationToken();
        const emailVerificationExpires = new Date(
          Date.now() + 24 * 60 * 60 * 1000
        ); // 24 heures

        // Créer un nouvel utilisateur avec les données fournies
        const user = new User({
          ...input,
          password, // Utiliser le mot de passe déchiffré
          email: input.email.toLowerCase(),
          emailVerificationToken,
          emailVerificationExpires,
        });

        await user.save();

        // Envoyer l'email de vérification
        await sendVerificationEmail(user.email, emailVerificationToken);

        // Ne pas générer de token, l'utilisateur doit d'abord vérifier son email
        return {
          user,
          message:
            "Inscription réussie ! Veuillez vérifier votre boîte mail pour confirmer votre adresse email avant de vous connecter.",
        };
      } catch (error) {
        console.error("Erreur lors de l'inscription:", error);
        if (error.name === "AppError") throw error;

        throw new AppError(
          "Une erreur est survenue lors de l'inscription.",
          ERROR_CODES.INTERNAL_ERROR,
          error.message
        );
      }
    },

    login: async (_, { input }) => {
      try {
        const user = await User.findOne({ email: input.email.toLowerCase() });
        if (!user) {
          throw new AppError(
            "L'email n'existe pas",
            ERROR_CODES.UNAUTHENTICATED
          );
        }

        // Déchiffrer le mot de passe si nécessaire
        let password = input.password;
        if (input.passwordEncrypted) {
          try {
            // Déchiffrer avec AES-CBC
            // Format attendu: "iv_base64:encrypted_base64"
            const parts = password.split(":");
            if (parts.length !== 2) {
              throw new Error("Format de mot de passe chiffré invalide");
            }

            // SHA256 sur la clé, comme côté front !
            const keyRaw =
              process.env.PASSWORD_ENCRYPTION_KEY || "newbi-public-key";
            const key = CryptoJS.SHA256(keyRaw);

            const iv = CryptoJS.enc.Base64.parse(parts[0]);
            const cipherText = CryptoJS.enc.Base64.parse(parts[1]);

            const cipherParams = CryptoJS.lib.CipherParams.create({
              ciphertext: cipherText,
            });

            const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
              iv,
              mode: CryptoJS.mode.CBC,
              padding: CryptoJS.pad.Pkcs7,
            });

            const clearPassword = decrypted.toString(CryptoJS.enc.Utf8);

            if (!clearPassword) {
              throw new Error("Échec du déchiffrement du mot de passe");
            }
            password = clearPassword;
          } catch (error) {
            console.error(
              "Erreur lors du déchiffrement du mot de passe:",
              error
            );
            throw new AppError(
              "Erreur lors du traitement de votre demande. Veuillez réessayer.",
              ERROR_CODES.INTERNAL_ERROR
            );
          }
        }

        const validPassword = await user.comparePassword(password);
        if (!validPassword) {
          throw new AppError(
            "Le mot de passe ne correspond pas",
            ERROR_CODES.UNAUTHENTICATED
          );
        }

        // Vérifier si le compte est désactivé
        if (user.isDisabled) {
          throw new AppError(
            "Ce compte a été désactivé. Utilisez la mutation reactivateAccount pour le réactiver.",
            ERROR_CODES.ACCOUNT_DISABLED
          );
        }

        // Vérifier si l'email est vérifié
        if (!user.isEmailVerified) {
          throw new AppError(
            "Veuillez vérifier votre adresse email avant de vous connecter. Consultez votre boîte de réception.",
            ERROR_CODES.EMAIL_NOT_VERIFIED
          );
        }

        // Utiliser l'option rememberMe pour générer un token avec une durée appropriée
        const rememberMe = input.rememberMe || false;
        const token = generateToken(user, rememberMe);

        return { token, user };
      } catch (error) {
        if (error.name === "AppError") throw error;

        console.error("Erreur lors de la connexion:", error);
        throw new AppError(
          "Une erreur est survenue lors de la connexion.",
          ERROR_CODES.INTERNAL_ERROR,
          error.message
        );
      }
    },

    requestPasswordReset: async (_, { input }) => {
      try {
        const user = await User.findOne({ email: input.email.toLowerCase() });
        if (!user) {
          return true; // Pour des raisons de sécurité, toujours retourner true
        }

        // Générer un token aléatoire pour la réinitialisation
        const resetToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto
          .createHash("sha256")
          .update(resetToken)
          .digest("hex");

        user.resetPasswordToken = hashedToken;
        user.resetPasswordExpires = Date.now() + 3600000; // 1 heure
        await user.save();

        // Envoyer l'email avec le token non haché
        await sendPasswordResetEmail(input.email, resetToken);

        return true;
      } catch (error) {
        console.error("Error in requestPasswordReset:", error);
        return true; // Toujours retourner true pour des raisons de sécurité
      }
    },

    resetPassword: async (
      _,
      { input: { token, newPassword, passwordEncrypted } }
    ) => {
      try {
        // Hash le token reçu pour le comparer avec celui stocké dans la base
        const hashedToken = crypto
          .createHash("sha256")
          .update(token)
          .digest("hex");

        // Vérifier si le token existe et n'est pas expiré
        const user = await User.findOne({
          resetPasswordToken: hashedToken,
          resetPasswordExpires: { $gt: Date.now() },
        });

        if (!user) {
          throw new AppError(
            "Le lien de réinitialisation est invalide ou a expiré.",
            ERROR_CODES.INVALID_TOKEN
          );
        }

        // Déchiffrer le mot de passe si nécessaire
        let password = newPassword;
        if (passwordEncrypted) {
          try {
            const parts = password.split(":");
            if (parts.length !== 2) {
              throw new Error("Format de mot de passe chiffré invalide");
            }

            // SHA256 sur la clé, comme côté front !
            const keyRaw =
              process.env.PASSWORD_ENCRYPTION_KEY || "newbi-public-key";
            const key = CryptoJS.SHA256(keyRaw);

            const iv = CryptoJS.enc.Base64.parse(parts[0]);
            const cipherText = CryptoJS.enc.Base64.parse(parts[1]);

            const cipherParams = CryptoJS.lib.CipherParams.create({
              ciphertext: cipherText,
            });

            const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
              iv,
              mode: CryptoJS.mode.CBC,
              padding: CryptoJS.pad.Pkcs7,
            });

            const clearPassword = decrypted.toString(CryptoJS.enc.Utf8);

            if (!clearPassword) {
              throw new Error("Échec du déchiffrement du mot de passe");
            }
            password = clearPassword;
          } catch (error) {
            console.error(
              "Erreur lors du déchiffrement du mot de passe:",
              error
            );
            throw new AppError(
              "Erreur lors du traitement de votre demande. Veuillez réessayer.",
              ERROR_CODES.INTERNAL_ERROR
            );
          }
        }

        // Mettre à jour le mot de passe de l'utilisateur
        user.password = password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        // Envoyer un email de confirmation à l'utilisateur
        try {
          await sendPasswordResetConfirmationEmail(user.email);
        } catch (emailError) {
          console.error(
            "Erreur lors de l'envoi de l'email de confirmation:",
            emailError
          );
          // Continuer même si l'envoi de l'email échoue
        }

        return {
          success: true,
          message:
            "Votre mot de passe a été réinitialisé avec succès. Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.",
        };
      } catch (error) {
        console.error("Error in resetPassword:", error);
        return {
          success: false,
          message:
            "Une erreur est survenue lors de la réinitialisation du mot de passe.",
        };
      }
    },

    updateProfile: isAuthenticated(async (_, { input }, { user }) => {
      try {
        // Récupérer d'abord l'utilisateur
        const userDoc = await User.findById(user.id);

        if (!userDoc) {
          throw createNotFoundError("Utilisateur");
        }

        // Gérer l'upload de la photo de profil si présente dans l'input
        if (input.profilePicture !== undefined) {
          // Si la photo de profil est une chaîne vide, cela signifie que l'utilisateur veut la supprimer
          if (input.profilePicture === "") {
            // Si une photo de profil existe déjà, la supprimer
            if (userDoc.profile && userDoc.profile.profilePicture) {
              try {
                const oldPicturePath = userDoc.profile.profilePicture;
                await deleteFile(oldPicturePath);
                console.log("Photo de profil supprimée:", oldPicturePath);
              } catch (err) {
                console.error(
                  "Erreur lors de la suppression de l'ancienne photo de profil:",
                  err
                );
                // Continuer même si la suppression échoue
              }
            }

            // Mettre à jour le champ profilePicture à une chaîne vide
            input.profilePicture = "";
          }
          // Si la photo de profil est une chaîne base64, cela signifie que l'utilisateur veut la mettre à jour
          else if (input.profilePicture.startsWith("data:image")) {
            // Si une photo de profil existe déjà, la supprimer
            if (userDoc.profile && userDoc.profile.profilePicture) {
              try {
                const oldPicturePath = userDoc.profile.profilePicture;
                await deleteFile(oldPicturePath);
                console.log(
                  "Ancienne photo de profil supprimée:",
                  oldPicturePath
                );
              } catch (err) {
                console.error(
                  "Erreur lors de la suppression de l'ancienne photo de profil:",
                  err
                );
                // Continuer même si la suppression échoue
              }
            }

            // Sauvegarder la nouvelle image
            const picturePath = await saveBase64Image(
              input.profilePicture,
              "profile-pictures"
            );
            console.log("Nouvelle photo de profil sauvegardée:", picturePath);

            // Mettre à jour le champ profilePicture avec le chemin de la nouvelle image
            input.profilePicture = picturePath;
          }
          // Si la photo de profil n'est ni une chaîne vide ni une chaîne base64, la supprimer de l'input
          else if (!input.profilePicture.startsWith("/uploads/")) {
            delete input.profilePicture;
          }
        }

        // Mettre à jour les champs du profil
        userDoc.profile = {
          ...userDoc.profile.toObject(),
          ...input,
        };

        // Sauvegarder avec validation
        await userDoc.save();

        return userDoc;
      } catch (error) {
        if (error.name === "ValidationError") {
          throw createValidationError(error);
        }

        if (error.name === "AppError") throw error;

        console.error("Erreur lors de la mise à jour du profil:", error);
        throw new AppError(
          "Une erreur est survenue lors de la mise à jour du profil.",
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    updateCompany: isAuthenticated(async (_, { input }, { user }) => {
      try {
        // Récupérer d'abord l'utilisateur
        const userDoc = await User.findById(user.id);

        if (!userDoc) {
          throw createNotFoundError("Utilisateur");
        }

        // Mettre à jour les champs de l'entreprise
        userDoc.company = {
          ...userDoc.company.toObject(),
          ...input,
        };

        // S'assurer que transactionCategory est correctement défini
        console.log("Input complet:", JSON.stringify(input));
        console.log("Transaction Category reçue:", input.transactionCategory);

        // Traiter explicitement le champ transactionCategory
        // Si la valeur est définie (même vide), l'utiliser
        if (
          Object.prototype.hasOwnProperty.call(input, "transactionCategory")
        ) {
          userDoc.company.transactionCategory =
            input.transactionCategory || null;
          console.log(
            "Transaction Category après traitement:",
            userDoc.company.transactionCategory
          );
        }

        // Traiter explicitement le champ vatPaymentCondition
        if (
          Object.prototype.hasOwnProperty.call(input, "vatPaymentCondition")
        ) {
          // Si la valeur est vide ou null, utiliser 'NONE' comme valeur par défaut
          // Sinon, utiliser la valeur fournie si elle est valide
          const validValues = [
            "ENCAISSEMENTS",
            "DEBITS",
            "EXONERATION",
            "NONE",
          ];
          const value = input.vatPaymentCondition || "NONE";

          // Vérifier si la valeur est valide
          userDoc.company.vatPaymentCondition = validValues.includes(value)
            ? value
            : "NONE";
          console.log(
            "VAT Payment Condition après traitement:",
            userDoc.company.vatPaymentCondition
          );
        } else if (
          userDoc.company &&
          userDoc.company.vatPaymentCondition === ""
        ) {
          // Si la valeur est une chaîne vide, la remplacer par 'NONE'
          userDoc.company.vatPaymentCondition = "NONE";
        }
        // Ne pas définir de valeur par défaut si le champ n'existe pas du tout

        // Traiter explicitement le champ companyStatus
        if (Object.prototype.hasOwnProperty.call(input, "companyStatus")) {
          userDoc.company.companyStatus = input.companyStatus || "AUTRE";
          console.log(
            "Company Status après traitement:",
            userDoc.company.companyStatus
          );
        }

        // Traiter explicitement le champ capitalSocial
        if (Object.prototype.hasOwnProperty.call(input, "capitalSocial")) {
          userDoc.company.capitalSocial = input.capitalSocial || null;
          console.log(
            "Capital Social après traitement:",
            userDoc.company.capitalSocial
          );
        }

        // Traiter explicitement le champ rcs
        if (Object.prototype.hasOwnProperty.call(input, "rcs")) {
          userDoc.company.rcs = input.rcs || null;
          console.log("RCS après traitement:", userDoc.company.rcs);
        }

        // Sauvegarder avec validation
        await userDoc.save();

        return userDoc;
      } catch (error) {
        if (error.name === "ValidationError") {
          throw createValidationError(error);
        }

        if (error.name === "AppError") throw error;

        console.error(
          "Erreur lors de la mise à jour des informations de l'entreprise:",
          error
        );
        throw new AppError(
          "Une erreur est survenue lors de la mise à jour des informations de l'entreprise.",
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
          throw createNotFoundError("Utilisateur");
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
        console.log("Logo path reçu de saveBase64Image:", logoPath);

        // Mettre à jour l'utilisateur
        userDoc.company = userDoc.company || {};
        userDoc.company.logo = logoPath;
        console.log("Logo path sauvegardé dans userDoc:", userDoc.company.logo);

        await userDoc.save();
        console.log("Utilisateur sauvegardé avec logo:", userDoc.company.logo);

        return userDoc;
      } catch (error) {
        console.error("Erreur lors de l'upload du logo:", error);
        throw new AppError(
          "Une erreur est survenue lors de l'upload du logo.",
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    uploadProfilePicture: isAuthenticated(
      async (_, { base64Image }, { user }) => {
        try {
          // Vérifier si l'utilisateur existe
          const userDoc = await User.findById(user.id);
          if (!userDoc) {
            throw createNotFoundError("Utilisateur");
          }

          // Si une photo de profil existe déjà, la supprimer
          if (userDoc.profile && userDoc.profile.profilePicture) {
            try {
              const oldPicturePath = userDoc.profile.profilePicture;
              await deleteFile(oldPicturePath);
            } catch (err) {
              console.error(
                "Erreur lors de la suppression de l'ancienne photo de profil:",
                err
              );
              // Continuer même si la suppression échoue
            }
          }

          // Sauvegarder la nouvelle image dans le dossier profile-pictures
          const picturePath = await saveBase64Image(
            base64Image,
            "profile-pictures"
          );
          console.log("Photo path reçu de saveBase64Image:", picturePath);

          // Mettre à jour l'utilisateur
          userDoc.profile = userDoc.profile || {};
          userDoc.profile.profilePicture = picturePath;
          console.log(
            "Photo path sauvegardé dans userDoc:",
            userDoc.profile.profilePicture
          );

          await userDoc.save();
          console.log(
            "Utilisateur sauvegardé avec photo de profil:",
            userDoc.profile.profilePicture
          );

          return userDoc;
        } catch (error) {
          console.error(
            "Erreur lors de l'upload de la photo de profil:",
            error
          );
          throw new AppError(
            "Une erreur est survenue lors de l'upload de la photo de profil.",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    deleteCompanyLogo: isAuthenticated(async (_, __, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError("Utilisateur");
        }

        // Si un logo existe, le supprimer
        if (userDoc.company && userDoc.company.logo) {
          try {
            const logoPath = userDoc.company.logo;
            console.log("Tentative de suppression du logo:", logoPath);
            const deleted = await deleteFile(logoPath);
            console.log(
              "Résultat de la suppression:",
              deleted ? "Succès" : "Échec"
            );
          } catch (err) {
            console.error("Erreur lors de la suppression du logo:", err);
            // Continuer même si la suppression échoue
          }
        } else {
          console.log("Aucun logo à supprimer pour l'utilisateur:", user.id);
        }

        // Mettre à jour l'utilisateur
        userDoc.company = userDoc.company || {};
        userDoc.company.logo = "";
        await userDoc.save();
        console.log(
          "Logo supprimé de la base de données pour l'utilisateur:",
          user.id
        );

        return userDoc;
      } catch (error) {
        console.error("Erreur lors de la suppression du logo:", error);
        throw new AppError(
          "Une erreur est survenue lors de la suppression du logo.",
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    deleteProfilePicture: isAuthenticated(async (_, __, { user }) => {
      try {
        // Vérifier si l'utilisateur existe
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createNotFoundError("Utilisateur");
        }

        // Si une photo de profil existe, la supprimer
        if (userDoc.profile && userDoc.profile.profilePicture) {
          try {
            const picturePath = userDoc.profile.profilePicture;
            console.log(
              "Tentative de suppression de la photo de profil:",
              picturePath
            );
            const deleted = await deleteFile(picturePath);
            console.log(
              "Résultat de la suppression:",
              deleted ? "Succès" : "Échec"
            );
          } catch (err) {
            console.error(
              "Erreur lors de la suppression de la photo de profil:",
              err
            );
            // Continuer même si la suppression échoue
          }
        } else {
          console.log(
            "Aucune photo de profil à supprimer pour l'utilisateur:",
            user.id
          );
        }

        // Mettre à jour l'utilisateur
        userDoc.profile = userDoc.profile || {};
        userDoc.profile.profilePicture = "";
        await userDoc.save();
        console.log(
          "Photo de profil supprimée de la base de données pour l'utilisateur:",
          user.id
        );

        return userDoc;
      } catch (error) {
        console.error(
          "Erreur lors de la suppression de la photo de profil:",
          error
        );
        throw new AppError(
          "Une erreur est survenue lors de la suppression de la photo de profil.",
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    verifyEmail: async (_, { token }) => {
      // Rechercher l'utilisateur avec ce token de vérification
      const user = await User.findOne({
        emailVerificationToken: token,
        emailVerificationExpires: { $gt: Date.now() },
      });

      if (!user) {
        throw new AppError(
          "Le lien de vérification est invalide ou a expiré",
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
        message:
          "Votre adresse email a été vérifiée avec succès. Vous pouvez maintenant vous connecter.",
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
      const emailVerificationExpires = new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ); // 24 heures

      // Mettre à jour l'utilisateur avec le nouveau token
      user.emailVerificationToken = emailVerificationToken;
      user.emailVerificationExpires = emailVerificationExpires;
      await user.save();

      // Envoyer l'email de vérification
      await sendVerificationEmail(user.email, emailVerificationToken);

      return true;
    },

    updatePassword: isAuthenticated(
      async (_, { currentPassword, newPassword }, { user }) => {
        try {
          const userDoc = await User.findById(user.id);

          if (!userDoc) {
            throw createNotFoundError("Utilisateur");
          }

          const validPassword = await userDoc.comparePassword(currentPassword);
          if (!validPassword) {
            throw new AppError(
              "Le mot de passe actuel est incorrect",
              ERROR_CODES.INVALID_INPUT,
              { field: "currentPassword" }
            );
          }

          userDoc.password = newPassword;
          await userDoc.save();

          return {
            success: true,
            message: "Mot de passe mis à jour avec succès",
          };
        } catch (error) {
          if (error.name === "AppError") throw error;

          console.error(
            "Erreur lors de la mise à jour du mot de passe:",
            error
          );
          throw new AppError(
            "Une erreur est survenue lors de la mise à jour du mot de passe.",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    disableAccount: isAuthenticated(async (_, { password }, { user }) => {
      try {
        const userDoc = await User.findById(user.id);

        if (!userDoc) {
          throw createNotFoundError("Utilisateur");
        }

        // Vérifier le mot de passe pour confirmer l'action
        const validPassword = await userDoc.comparePassword(password);
        if (!validPassword) {
          throw new AppError(
            "Le mot de passe est incorrect",
            ERROR_CODES.INVALID_INPUT,
            { field: "password" }
          );
        }

        // Désactiver le compte
        userDoc.isDisabled = true;
        await userDoc.save();

        return {
          success: true,
          message: "Votre compte a été désactivé avec succès",
        };
      } catch (error) {
        if (error.name === "AppError") throw error;

        console.error("Erreur lors de la désactivation du compte:", error);
        throw new AppError(
          "Une erreur est survenue lors de la désactivation de votre compte.",
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),

    reactivateAccount: async (_, { email, password }) => {
      try {
        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
          throw createNotFoundError("Utilisateur");
        }

        // Vérifier si le compte est bien désactivé
        if (!user.isDisabled) {
          return {
            success: false,
            message: "Ce compte est déjà actif",
            user: null,
          };
        }

        // Vérifier le mot de passe pour confirmer l'action
        const validPassword = await user.comparePassword(password);
        if (!validPassword) {
          throw new AppError(
            "Le mot de passe est incorrect",
            ERROR_CODES.INVALID_INPUT,
            { field: "password" }
          );
        }

        // Réactiver le compte
        user.isDisabled = false;
        await user.save();

        return {
          success: true,
          message: "Votre compte a été réactivé avec succès",
          user: user,
        };
      } catch (error) {
        if (error.name === "AppError") throw error;

        console.error("Erreur lors de la réactivation du compte:", error);
        throw new AppError(
          "Une erreur est survenue lors de la réactivation de votre compte.",
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    },

    // Nouvelle mutation pour associer un ID client Stripe à un utilisateur
    setStripeCustomerId: isAuthenticated(
      async (_, { stripeCustomerId }, { user }) => {
        try {
          // Vérifier si l'utilisateur existe
          const userDoc = await User.findById(user.id);
          if (!userDoc) {
            throw createNotFoundError("Utilisateur non trouvé");
          }

          // Mettre à jour le Stripe Customer ID
          userDoc.subscription = userDoc.subscription || {};
          userDoc.subscription.stripeCustomerId = stripeCustomerId;

          // Sauvegarder les modifications
          await userDoc.save();

          console.log(
            `Stripe Customer ID associé à l'utilisateur ${userDoc.email}: ${stripeCustomerId}`
          );

          return userDoc;
        } catch (error) {
          console.error(
            "Erreur lors de l'association du Stripe Customer ID:",
            error
          );
          throw new AppError(
            "Erreur lors de l'association du Stripe Customer ID",
            ERROR_CODES.INTERNAL_ERROR,
            error.message
          );
        }
      }
    ),

    /**
     * Met à jour uniquement le logo de l'entreprise
     */
    updateCompanyLogo: withWorkspace(async (_, { logoUrl }, { user, workspaceId }) => {
      try {
        // Mise à jour directe dans la collection organization
        const db = mongoose.connection.db;
        const organizationCollection = db.collection('organization');
        
        const result = await organizationCollection.findOneAndUpdate(
          { _id: new mongoose.Types.ObjectId(workspaceId) },
          { $set: { logo: logoUrl } },
          { returnDocument: 'after' }
        );

        if (!result) {
          throw new AppError(
            'Organisation non trouvée',
            ERROR_CODES.NOT_FOUND
          );
        }

        console.log('✅ Logo mis à jour dans organization:', {
          workspaceId: workspaceId,
          logoUrl: logoUrl
        });

        // Retourner un objet de succès
        return {
          success: true,
          message: 'Logo mis à jour avec succès'
        };
      } catch (error) {
        console.error('Erreur mise à jour logo:', error);
        throw new AppError(
          'Erreur lors de la mise à jour du logo',
          ERROR_CODES.INTERNAL_ERROR
        );
      }
    }),
  },
};

export default userResolvers;
