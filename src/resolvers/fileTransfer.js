import { ApolloError, UserInputError } from "apollo-server-express";
import FileTransfer from "../models/FileTransfer.js";
import { isAuthenticated } from "../middlewares/auth.js";
import {
  saveUploadedFile,
  saveBase64File,
  generateShareLink,
  generateAccessKey,
  calculateExpiryDate,
  deleteFile,
} from "../utils/fileTransferUtils.js";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
import constants from "../utils/constants.js";
const { BASE_URL } = constants;

// Taille maximale autorisée (100 GB en octets)
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024;

export default {
  Query: {
    // Obtenir les transferts de fichiers de l'utilisateur connecté avec pagination
    myFileTransfers: isAuthenticated(
      async (_, { page = 1, limit = 10 }, { user }) => {
        try {
          // S'assurer que page et limit sont des nombres positifs
          const validPage = Math.max(1, page);
          const validLimit = Math.max(1, Math.min(100, limit)); // Limiter à 100 éléments maximum par page
          const skip = (validPage - 1) * validLimit;

          // Compter le nombre total d'éléments pour la pagination
          const totalItems = await FileTransfer.find({
            userId: user.id,
            status: { $ne: "deleted" },
          }).countDocuments();

          // Récupérer les transferts de fichiers avec pagination
          const fileTransfers = await FileTransfer.find({
            userId: user.id,
            status: { $ne: "deleted" },
          })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(validLimit);

          // Calculer les métadonnées de pagination
          const totalPages = Math.ceil(totalItems / validLimit);
          const hasNextPage = validPage < totalPages;

          // Retourner l'objet paginé
          return {
            items: fileTransfers,
            totalItems,
            currentPage: validPage,
            totalPages,
            hasNextPage,
          };
        } catch (error) {
          console.error(
            "Erreur lors de la récupération des transferts de fichiers:",
            error
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la récupération des transferts de fichiers.",
            "FILE_TRANSFER_FETCH_ERROR"
          );
        }
      }
    ),

    // Obtenir les informations d'un transfert de fichiers par son ID
    fileTransferById: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          _id: id,
          userId: user.id,
          status: { $ne: "deleted" },
        });

        if (!fileTransfer) {
          throw new UserInputError("Transfert de fichiers non trouvé");
        }

        return fileTransfer;
      } catch (error) {
        if (error instanceof UserInputError) {
          throw error;
        }

        console.error(
          "Erreur lors de la récupération du transfert de fichiers:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la récupération du transfert de fichiers.",
          "FILE_TRANSFER_FETCH_ERROR"
        );
      }
    }),

    // Obtenir les informations d'un transfert de fichiers par son lien de partage et sa clé d'accès
    getFileTransferByLink: async (_, { shareLink, accessKey }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          shareLink,
          accessKey,
          status: "active",
        });

        if (!fileTransfer) {
          return {
            success: false,
            message: "Lien de partage invalide ou expiré",
            fileTransfer: null,
          };
        }

        // Vérifier si le transfert est expiré
        if (fileTransfer.isExpired()) {
          return {
            success: false,
            message: "Ce lien de partage a expiré",
            fileTransfer: null,
          };
        }

        // Préparer les informations de paiement
        const paymentInfo = {
          isPaymentRequired: fileTransfer.isPaymentRequired,
          paymentAmount: fileTransfer.paymentAmount,
          paymentCurrency: fileTransfer.paymentCurrency,
          isPaid: fileTransfer.isPaid,
          checkoutUrl: null,
        };

        // Pour l'affichage frontend, utiliser isPaid pour indiquer si ce transfert a été payé
        // La vérification d'accès individuel se fait dans le contrôleur d'autorisation
        const isAccessible = fileTransfer.isAccessible();

        // Préparer les informations du transfert avec URLs de téléchargement
        const filesWithDownloadUrls = fileTransfer.files.map((file) => ({
          ...file.toObject(),
          id: file._id.toString(), // Assurer que l'ID est présent
          downloadUrl:
            file.storageType === "r2" ? file.filePath : file.filePath,
        }));

        const fileTransferInfo = {
          id: fileTransfer.id,
          files: filesWithDownloadUrls,
          totalSize: fileTransfer.totalSize,
          expiryDate: fileTransfer.expiryDate,
          isPaymentRequired: fileTransfer.isPaymentRequired,
          paymentAmount: fileTransfer.paymentAmount,
          paymentCurrency: fileTransfer.paymentCurrency,
          isPaid: fileTransfer.isPaid,
          status: fileTransfer.status,
          downloadCount: fileTransfer.downloadCount,
          paymentInfo,
          isAccessible,
        };

        return {
          success: true,
          message: isAccessible
            ? "Transfert de fichiers accessible"
            : "Paiement requis pour accéder aux fichiers",
          fileTransfer: fileTransferInfo,
        };
      } catch (error) {
        console.error(
          "Erreur lors de la récupération du transfert de fichiers:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la récupération du transfert de fichiers.",
          "FILE_TRANSFER_FETCH_ERROR"
        );
      }
    },
  },

  Mutation: {
    // Créer un nouveau transfert de fichiers
    createFileTransfer: isAuthenticated(
      async (_, { files, input = {} }, { user }) => {
        try {
          // Vérifier que des fichiers ont été fournis
          if (!files || files.length === 0) {
            throw new UserInputError("Aucun fichier fourni");
          }

          // Extraire les options du transfert
          const {
            isPaymentRequired = false,
            paymentAmount = 0,
            paymentCurrency = "EUR",
            recipientEmail,
          } = input;

          // Vérifier les options de paiement
          if (isPaymentRequired && (!paymentAmount || paymentAmount <= 0)) {
            throw new UserInputError("Montant de paiement invalide");
          }

          // Générer le lien de partage et la clé d'accès
          const shareLink = generateShareLink();
          const accessKey = generateAccessKey();

          // Calculer la date d'expiration (48 heures)
          const expiryDate = calculateExpiryDate();

          // Sauvegarder les fichiers
          const uploadedFiles = [];
          let totalSize = 0;

          for (const file of files) {
            const fileData = await saveUploadedFile(file, user.id);
            uploadedFiles.push(fileData);
            totalSize += fileData.size;
          }

          // Vérifier la taille totale
          if (totalSize > MAX_FILE_SIZE) {
            // Supprimer les fichiers téléchargés
            for (const file of uploadedFiles) {
              deleteFile(file.filePath);
            }

            throw new UserInputError(
              "La taille totale des fichiers dépasse la limite de 100 GB"
            );
          }

          // Créer le transfert de fichiers
          const fileTransfer = new FileTransfer({
            userId: user.id,
            files: uploadedFiles,
            totalSize,
            shareLink,
            accessKey,
            expiryDate,
            isPaymentRequired,
            paymentAmount: isPaymentRequired ? paymentAmount : 0,
            paymentCurrency,
            recipientEmail,
          });

          await fileTransfer.save();

          return {
            success: true,
            message: "Transfert de fichiers créé avec succès",
            fileTransfer,
            shareLink,
            accessKey,
          };
        } catch (error) {
          if (error instanceof UserInputError) {
            throw error;
          }

          console.error(
            "Erreur lors de la création du transfert de fichiers:",
            error
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la création du transfert de fichiers.",
            "FILE_TRANSFER_CREATION_ERROR"
          );
        }
      }
    ),

    // Supprimer un transfert de fichiers
    deleteFileTransfer: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          _id: id,
          userId: user.id,
        });

        if (!fileTransfer) {
          throw new UserInputError("Transfert de fichiers non trouvé");
        }

        // Marquer comme supprimé plutôt que de supprimer réellement
        fileTransfer.status = "deleted";
        await fileTransfer.save();

        // Supprimer les fichiers physiquement (optionnel, peut être fait par un job de nettoyage)
        for (const file of fileTransfer.files) {
          deleteFile(file.filePath);
        }

        return true;
      } catch (error) {
        if (error instanceof UserInputError) {
          throw error;
        }

        console.error(
          "Erreur lors de la suppression du transfert de fichiers:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la suppression du transfert de fichiers.",
          "FILE_TRANSFER_DELETION_ERROR"
        );
      }
    }),

    // Créer un nouveau transfert de fichiers avec des fichiers en base64
    createFileTransferBase64: isAuthenticated(
      async (_, { files, input = {} }, { user }) => {
        try {
          // Vérifier que des fichiers ont été fournis
          if (!files || files.length === 0) {
            throw new UserInputError("Aucun fichier fourni");
          }

          // Extraire les options du transfert
          const {
            expiryDays = 2, // 48 heures par défaut
            isPaymentRequired = false,
            paymentAmount = 0,
            paymentCurrency = "EUR",
            recipientEmail,
          } = input;

          // Vérifier les valeurs
          if (expiryDays <= 0) {
            throw new UserInputError(
              "La durée d'expiration doit être supérieure à 0"
            );
          }

          if (isPaymentRequired && paymentAmount <= 0) {
            throw new UserInputError(
              "Le montant du paiement doit être supérieur à 0"
            );
          }

          // Sauvegarder les fichiers
          const uploadedFiles = [];
          let totalSize = 0;

          for (const file of files) {
            const fileData = await saveBase64File(file, user.id);
            uploadedFiles.push(fileData);
            totalSize += fileData.size;
          }

          // Vérifier la taille totale
          if (totalSize > MAX_FILE_SIZE) {
            // Supprimer les fichiers téléchargés
            for (const file of uploadedFiles) {
              deleteFile(file.filePath);
            }

            throw new UserInputError(
              `La taille totale des fichiers dépasse la limite autorisée (${
                MAX_FILE_SIZE / (1024 * 1024 * 1024)
              } GB)`
            );
          }

          // Générer le lien de partage et la clé d'accès
          const shareLink = generateShareLink();
          const accessKey = generateAccessKey();
          const expiryDate = calculateExpiryDate(expiryDays);

          // Créer le transfert de fichiers
          const fileTransfer = new FileTransfer({
            userId: user.id,
            files: uploadedFiles,
            totalSize,
            shareLink,
            accessKey,
            expiryDate,
            isPaymentRequired,
            paymentAmount: isPaymentRequired ? paymentAmount : 0,
            paymentCurrency: isPaymentRequired ? paymentCurrency : "EUR",
            isPaid: false,
            status: "active",
            recipientEmail,
            downloadLink: `${shareLink}-${Date.now()}`, // Ajout d'un downloadLink unique pour éviter l'erreur d'index
          });

          await fileTransfer.save();

          return {
            success: true,
            message: "Transfert de fichiers créé avec succès",
            fileTransfer,
            shareLink,
            accessKey,
          };
        } catch (error) {
          if (error instanceof UserInputError) {
            throw error;
          }

          console.error(
            "Erreur lors de la création du transfert de fichiers (base64):",
            error
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la création du transfert de fichiers.",
            "FILE_TRANSFER_CREATION_ERROR"
          );
        }
      }
    ),

    // Générer un lien de paiement pour un transfert de fichiers
    generateFileTransferPaymentLink: async (_, { shareLink, accessKey }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          shareLink,
          accessKey,
          status: "active",
          isPaymentRequired: true,
          isPaid: false,
        });

        if (!fileTransfer) {
          return {
            success: false,
            message: "Transfert de fichiers non trouvé ou paiement non requis",
            checkoutUrl: null,
          };
        }

        // Vérifier si le transfert est expiré
        if (fileTransfer.isExpired()) {
          return {
            success: false,
            message: "Ce lien de partage a expiré",
            checkoutUrl: null,
          };
        }

        // Créer une session de paiement Stripe
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: fileTransfer.paymentCurrency.toLowerCase(),
                product_data: {
                  name: "Accès aux fichiers partagés",
                  description: `Accès à ${fileTransfer.files.length} fichier(s) partagé(s)`,
                },
                unit_amount: Math.round(fileTransfer.paymentAmount * 100), // Stripe utilise les centimes
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${BASE_URL}/file-transfer/success?share=${shareLink}&key=${accessKey}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${BASE_URL}/file-transfer/cancel?share=${shareLink}&key=${accessKey}`,
          metadata: {
            fileTransferId: fileTransfer.id,
            shareLink,
            accessKey,
          },
        });

        return {
          success: true,
          message: "Lien de paiement généré avec succès",
          checkoutUrl: session.url,
        };
      } catch (error) {
        console.error(
          "Erreur lors de la génération du lien de paiement:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la génération du lien de paiement.",
          "PAYMENT_LINK_GENERATION_ERROR"
        );
      }
    },
  },
};
