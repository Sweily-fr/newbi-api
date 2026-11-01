import logger from "../utils/logger.js";
import crypto from "crypto";
import mongoose from "mongoose";
import User from "../models/User.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import { isBackofficeAdmin } from "../utils/backofficeAdmin.js";
import {
  checkSubscriptionActive,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import { saveBase64Image, deleteFile } from "../utils/fileUpload.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  AppError,
  ERROR_CODES,
  createNotFoundError,
  createValidationError,
} from "../utils/errors.js";

// Logo de l'organisation : paramètres de l'entreprise (« orgSettings »)
const writeOrgSettings = requireWorkspaceLevel("orgSettings", "write");

const userResolvers = {
  Query: {
    me: isAuthenticated(async (_, __, { user }) => {
      return await User.findById(user.id);
    }),
    // Avatars des invités au récapitulatif de création d'un espace. Seuls les
    // comptes que l'appelant voit déjà (membres ou invités en attente de l'un
    // de ses espaces) et au plus 30 e-mails (invitations possibles à la
    // création) : la requête disait sinon, pour n'importe quelle liste
    // d'e-mails, si un compte Newbi existe, avec son nom et sa photo.
    lookupUsersByEmails: isAuthenticated(
      async (_, { emails }, { db, user: caller }) => {
        const MAX_LOOKUP_EMAILS = 30;
        const normalizedEmails = [
          ...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean)),
        ].slice(0, MAX_LOOKUP_EMAILS);
        const callerId = String(caller._id || caller.id);
        if (
          normalizedEmails.length === 0 ||
          !mongoose.isValidObjectId(callerId)
        ) {
          return [];
        }

        const orgIds = await db
          .collection("member")
          .distinct("organizationId", {
            userId: new mongoose.Types.ObjectId(callerId),
          });
        if (orgIds.length === 0) return [];

        const found = await db
          .collection("user")
          .find({
            email: { $in: normalizedEmails },
          })
          .project({ email: 1, name: 1, image: 1, avatar: 1, profile: 1 })
          .toArray();
        if (found.length === 0) return [];

        const [memberUserIds, invitedEmails] = await Promise.all([
          db.collection("member").distinct("userId", {
            organizationId: { $in: orgIds },
            userId: { $in: found.map((u) => u._id) },
          }),
          db.collection("invitation").distinct("email", {
            organizationId: { $in: orgIds },
            email: {
              $in: [
                ...new Set([...normalizedEmails, ...found.map((u) => u.email)]),
              ],
            },
            status: "pending",
          }),
        ]);
        const memberSet = new Set(memberUserIds.map(String));
        const invitedSet = new Set(
          invitedEmails.map((e) => String(e).toLowerCase()),
        );
        const users = found.filter(
          (u) =>
            memberSet.has(String(u._id)) ||
            invitedSet.has(String(u.email).toLowerCase()),
        );

        return users.map((user) => ({
          email: user.email,
          name:
            user.name ||
            `${user.profile?.firstName || ""} ${user.profile?.lastName || ""}`.trim() ||
            null,
          image: user.image || user.avatar || null,
        }));
      },
    ),
  },

  Mutation: {
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
              } catch (err) {
                console.error(
                  "Erreur lors de la suppression de l'ancienne photo de profil:",
                  err,
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
              } catch (err) {
                console.error(
                  "Erreur lors de la suppression de l'ancienne photo de profil:",
                  err,
                );
                // Continuer même si la suppression échoue
              }
            }

            // Sauvegarder la nouvelle image
            const picturePath = await saveBase64Image(
              input.profilePicture,
              "profile-pictures",
            );

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
          ERROR_CODES.INTERNAL_ERROR,
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

        // Traiter explicitement le champ transactionCategory
        // Si la valeur est définie (même vide), l'utiliser
        if (
          Object.prototype.hasOwnProperty.call(input, "transactionCategory")
        ) {
          userDoc.company.transactionCategory =
            input.transactionCategory || null;
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
        }

        // Traiter explicitement le champ capitalSocial
        if (Object.prototype.hasOwnProperty.call(input, "capitalSocial")) {
          userDoc.company.capitalSocial = input.capitalSocial || null;
        }

        // Traiter explicitement le champ rcs
        if (Object.prototype.hasOwnProperty.call(input, "rcs")) {
          userDoc.company.rcs = input.rcs || null;
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
          error,
        );
        throw new AppError(
          "Une erreur est survenue lors de la mise à jour des informations de l'entreprise.",
          ERROR_CODES.INTERNAL_ERROR,
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

        // Mettre à jour l'utilisateur
        userDoc.company = userDoc.company || {};
        userDoc.company.logo = logoPath;

        await userDoc.save();

        return userDoc;
      } catch (error) {
        console.error("Erreur lors de l'upload du logo:", error);
        throw new AppError(
          "Une erreur est survenue lors de l'upload du logo.",
          ERROR_CODES.INTERNAL_ERROR,
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
                err,
              );
              // Continuer même si la suppression échoue
            }
          }

          // Sauvegarder la nouvelle image dans le dossier profile-pictures
          const picturePath = await saveBase64Image(
            base64Image,
            "profile-pictures",
          );

          // Mettre à jour l'utilisateur
          userDoc.profile = userDoc.profile || {};
          userDoc.profile.profilePicture = picturePath;

          await userDoc.save();

          return userDoc;
        } catch (error) {
          console.error(
            "Erreur lors de l'upload de la photo de profil:",
            error,
          );
          throw new AppError(
            "Une erreur est survenue lors de l'upload de la photo de profil.",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
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
            const deleted = await deleteFile(logoPath);
          } catch (err) {
            console.error("Erreur lors de la suppression du logo:", err);
            // Continuer même si la suppression échoue
          }
        } else {
          logger.debug("Aucun logo à supprimer pour l'utilisateur:", user.id);
        }

        // Mettre à jour l'utilisateur
        userDoc.company = userDoc.company || {};
        userDoc.company.logo = "";
        await userDoc.save();

        return userDoc;
      } catch (error) {
        console.error("Erreur lors de la suppression du logo:", error);
        throw new AppError(
          "Une erreur est survenue lors de la suppression du logo.",
          ERROR_CODES.INTERNAL_ERROR,
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
            const deleted = await deleteFile(picturePath);
          } catch (err) {
            console.error(
              "Erreur lors de la suppression de la photo de profil:",
              err,
            );
            // Continuer même si la suppression échoue
          }
        } else {
          logger.debug(
            "Aucune photo de profil à supprimer pour l'utilisateur:",
            user.id,
          );
        }

        // Mettre à jour l'utilisateur
        userDoc.profile = userDoc.profile || {};
        userDoc.profile.profilePicture = "";
        await userDoc.save();

        return userDoc;
      } catch (error) {
        console.error(
          "Erreur lors de la suppression de la photo de profil:",
          error,
        );
        throw new AppError(
          "Une erreur est survenue lors de la suppression de la photo de profil.",
          ERROR_CODES.INTERNAL_ERROR,
        );
      }
    }),

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
              { field: "currentPassword" },
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
            error,
          );
          throw new AppError(
            "Une erreur est survenue lors de la mise à jour du mot de passe.",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Met à jour le statut partenaire d'un utilisateur.
     * 🔐 Mutation publique jusqu'ici : n'importe qui (même sans compte)
     * devenait partenaire, recevait un code de parrainage et touchait des
     * commissions, ou retirait ce statut à un vrai partenaire. Réservée aux
     * administrateurs du back-office (BACKOFFICE_ADMIN_USER_IDS, comptes
     * @sweily.fr / @newbi.fr) : aucun écran ne l'appelle, le statut
     * partenaire s'attribue en interne (le webhook Stripe s'en sert pour
     * calculer les commissions).
     */
    updatePartnerStatus: isAuthenticated(
      async (_, { email, isPartner }, { user: caller }) => {
        if (!(await isBackofficeAdmin(caller._id || caller.id))) {
          throw new AppError(
            "Accès réservé aux administrateurs",
            ERROR_CODES.FORBIDDEN,
          );
        }
        try {
          // Trouver l'utilisateur par email
          const user = await User.findOne({ email: email.toLowerCase() });

          if (!user) {
            throw createNotFoundError("Utilisateur non trouvé");
          }

          // Mettre à jour le statut partenaire
          user.isPartner = isPartner;

          // Générer un code de parrainage si l'utilisateur devient partenaire et n'en a pas
          if (isPartner && !user.referralCode) {
            user.referralCode = crypto
              .randomBytes(8)
              .toString("hex")
              .toUpperCase();
          }

          await user.save();

          logger.debug(
            `✅ Utilisateur ${email} mis à jour : isPartner=${isPartner}`,
          );

          return user;
        } catch (error) {
          if (error.name === "AppError") throw error;

          console.error(
            "Erreur lors de la mise à jour du statut partenaire:",
            error,
          );
          throw new AppError(
            "Erreur lors de la mise à jour du statut partenaire",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Met à jour uniquement le logo de l'entreprise
     * (organisation de l'espace : droit « orgSettings » en écriture)
     */
    updateCompanyLogo: writeOrgSettings(
      async (_, { logoUrl }, { user, workspaceId }) => {
        try {
          // Mise à jour directe dans la collection organization
          const db = mongoose.connection.db;
          const organizationCollection = db.collection("organization");

          // Récupérer l'ancien logo avant mise à jour
          const currentOrg = await organizationCollection.findOne({
            _id: new mongoose.Types.ObjectId(workspaceId),
          });
          const oldLogoUrl = currentOrg?.logo;

          // Si on supprime le logo (logoUrl est null/vide), supprimer l'ancien fichier de Cloudflare R2
          if (!logoUrl && oldLogoUrl) {
            try {
              // Le logo enregistré vient du client : on ne supprime que s'il
              // est rangé sous le préfixe de cet espace. Sinon, un logo
              // pointant vers l'objet d'un autre espace le faisait effacer.
              const resolved = cloudflareService.resolveWorkspaceFileUrl(
                oldLogoUrl,
                String(workspaceId),
                ["imgCompany"],
              );

              if (resolved) {
                await cloudflareService.deleteImage(
                  resolved.key,
                  resolved.bucket,
                );
                logger.debug(
                  "✅ Logo supprimé de Cloudflare R2:",
                  resolved.key,
                );
              }
            } catch (err) {
              console.error(
                "⚠️ Erreur suppression logo R2 (non bloquant):",
                err.message,
              );
              // Continuer même si la suppression R2 échoue
            }
          }

          const result = await organizationCollection.findOneAndUpdate(
            { _id: new mongoose.Types.ObjectId(workspaceId) },
            { $set: { logo: logoUrl } },
            { returnDocument: "after" },
          );

          if (!result) {
            throw new AppError(
              "Organisation non trouvée",
              ERROR_CODES.NOT_FOUND,
            );
          }

          // Retourner l'utilisateur avec les informations mises à jour
          const updatedUser = await User.findById(user.id);
          return updatedUser;
        } catch (error) {
          console.error("Erreur mise à jour logo:", error);
          throw new AppError(
            "Erreur lors de la mise à jour du logo",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),
  },
};

// ✅ Phase A.3 — Subscription check SÉLECTIF sur user.js (company mutations only)
// NE PAS bloquer: updateProfile, updatePassword, uploadProfilePicture, disableAccount, register, login, etc.
const COMPANY_MUTATIONS = [
  "updateCompany",
  "uploadCompanyLogo",
  "deleteCompanyLogo",
  "updateCompanyLogo",
];
COMPANY_MUTATIONS.forEach((name) => {
  const original = userResolvers.Mutation[name];
  if (original) {
    userResolvers.Mutation[name] = async (parent, args, context, info) => {
      await checkSubscriptionActive(context);
      return original(parent, args, context, info);
    };
  }
});

export default userResolvers;
