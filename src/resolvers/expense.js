import Expense from "../models/Expense.js";
import {
  UserInputError,
  ForbiddenError,
  ApolloError,
} from "apollo-server-express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { processFileWithOCR } from "../utils/ocrProcessor.js";
import { isAuthenticated } from "../middlewares/auth.js";
import {
  isWorkspaceMember,
  requireWorkspacePermission,
} from "../middlewares/workspace.js";
import {
  createNotFoundError,
  createResourceLockedError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";

const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

/**
 * Wrapper pour les resolvers workspace
 * Remplace isAuthenticated par la vérification workspace
 */
const withWorkspace = (resolver, requiredPermission = "read") => {
  return async (parent, args, context, info) => {
    try {
      // Extraire workspaceId des arguments ou du contexte
      const workspaceId = args.workspaceId || context.workspaceId;

      if (!workspaceId) {
        throw new AppError("workspaceId requis", ERROR_CODES.BAD_REQUEST);
      }

      // Vérifier l'appartenance au workspace
      const workspaceContext = await isWorkspaceMember(
        context.req,
        workspaceId,
        context.user
      );

      // Vérifier les permissions spécifiques
      if (requiredPermission !== "read") {
        requireWorkspacePermission(requiredPermission)(workspaceContext);
      }

      // Enrichir le contexte avec les informations workspace
      const enrichedContext = {
        ...context,
        ...workspaceContext,
      };

      // Exécuter le resolver avec le contexte enrichi
      return await resolver(parent, args, enrichedContext, info);
    } catch (error) {
      console.error(
        `Erreur dans withWorkspace pour ${resolver.name}:`,
        error.message
      );
      throw error;
    }
  };
};

// Fonction utilitaire pour vérifier si l'utilisateur est autorisé à accéder à une dépense
const checkExpenseAccess = async (expenseId, workspaceId) => {
  const expense = await Expense.findOne({ _id: expenseId, workspaceId });
  if (!expense) {
    throw createNotFoundError("Dépense");
  }
  return expense;
};

// Fonction pour enregistrer un fichier téléchargé
const saveUploadedFile = async (file, userId) => {
  const { createReadStream, filename, mimetype } = await file;
  const stream = createReadStream();

  // Créer un nom de fichier unique
  const uniqueFilename = `${Date.now()}-${Math.round(
    Math.random() * 1e9
  )}-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

  // Créer le dossier de destination s'il n'existe pas
  const uploadDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "expenses",
    userId.toString()
  );
  await mkdirAsync(uploadDir, { recursive: true });

  const filePath = path.join(uploadDir, uniqueFilename);
  const fileUrl = `/uploads/expenses/${userId.toString()}/${uniqueFilename}`;

  // Écrire le fichier
  const writeStream = fs.createWriteStream(filePath);

  // Retourner une promesse qui résout lorsque le fichier est écrit
  return new Promise((resolve, reject) => {
    stream
      .pipe(writeStream)
      .on("finish", async () => {
        // Obtenir la taille du fichier
        const stats = fs.statSync(filePath);

        resolve({
          filename: uniqueFilename,
          originalFilename: filename,
          mimetype,
          path: filePath,
          size: stats.size,
          url: fileUrl,
          ocrProcessed: false,
          ocrData: null,
        });
      })
      .on("error", (error) => {
        // Supprimer le fichier partiellement écrit en cas d'erreur
        fs.unlink(filePath, () => {
          reject(error);
        });
      });
  });
};

const expenseResolvers = {
  Query: {
    // Récupérer une dépense par son ID
    expense: withWorkspace(async (_, { id, workspaceId }, context) => {
      return await checkExpenseAccess(id, workspaceId);
    }),

    // Récupérer une liste paginée de dépenses avec filtres
    expenses: withWorkspace(async (
      _,
      {
        workspaceId,
        startDate,
        endDate,
        category,
        status,
        search,
        tags,
        page = 1,
        limit = 10,
      },
      context
    ) => {
      const query = { workspaceId };

      // Appliquer les filtres de date
      if (startDate || endDate) {
        query.date = {};
        if (startDate) query.date.$gte = new Date(startDate);
        if (endDate) query.date.$lte = new Date(endDate);
      }

      // Filtre par catégorie
      if (category) query.category = category;

      // Filtre par statut
      if (status) query.status = status;

      // Filtre par tags
      if (tags && tags.length > 0) {
        query.tags = { $in: tags };
      }

      // Recherche textuelle
      if (search) {
        query.$or = [
          { title: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { vendor: { $regex: search, $options: "i" } },
          { invoiceNumber: { $regex: search, $options: "i" } },
        ];
      }

      // Calculer le nombre total de résultats
      const totalCount = await Expense.countDocuments(query);

      // Récupérer les dépenses paginées
      const expenses = await Expense.find(query)
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);

      return {
        expenses,
        totalCount,
        hasNextPage: page * limit < totalCount,
      };
    }),

    // Récupérer les statistiques des dépenses
    expenseStats: withWorkspace(async (_, { workspaceId, startDate, endDate }, context) => {
      const dateQuery = {};
      if (startDate) dateQuery.$gte = new Date(startDate);
      if (endDate) dateQuery.$lte = new Date(endDate);

      const match = { workspaceId: new mongoose.Types.ObjectId(workspaceId) };
      if (startDate || endDate) match.date = dateQuery;

      // Aggrégation pour obtenir les statistiques
      const stats = await Expense.aggregate([
        { $match: match },
        {
          $facet: {
            // Statistiques globales
            totalStats: [
              {
                $group: {
                  _id: null,
                  totalAmount: { $sum: "$amount" },
                  totalCount: { $sum: 1 },
                },
              },
            ],
            // Statistiques par catégorie
            categoryStats: [
              {
                $group: {
                  _id: "$category",
                  amount: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
              { $sort: { amount: -1 } },
            ],
            // Statistiques par mois
            monthStats: [
              {
                $group: {
                  _id: {
                    year: { $year: "$date" },
                    month: { $month: "$date" },
                  },
                  amount: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
              {
                $project: {
                  _id: 0,
                  month: {
                    $concat: [
                      { $toString: "$_id.year" },
                      "-",
                      {
                        $cond: {
                          if: { $lt: ["$_id.month", 10] },
                          then: { $concat: ["0", { $toString: "$_id.month" }] },
                          else: { $toString: "$_id.month" },
                        },
                      },
                    ],
                  },
                  amount: 1,
                  count: 1,
                },
              },
              { $sort: { month: 1 } },
            ],
            // Statistiques par statut
            statusStats: [
              {
                $group: {
                  _id: "$status",
                  amount: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ]);

      const totalStats = stats[0].totalStats[0] || {
        totalAmount: 0,
        totalCount: 0,
      };

      return {
        totalAmount: totalStats.totalAmount || 0,
        totalCount: totalStats.totalCount || 0,
        byCategory: stats[0].categoryStats.map((stat) => ({
          category: stat._id,
          amount: stat.amount,
          count: stat.count,
        })),
        byMonth: stats[0].monthStats.map((stat) => ({
          month: stat.month,
          amount: stat.amount,
          count: stat.count,
        })),
        byStatus: stats[0].statusStats.map((stat) => ({
          status: stat._id,
          amount: stat.amount,
          count: stat.count,
        })),
      };
    }),
  },

  Mutation: {
    // Créer une nouvelle dépense
    createExpense: withWorkspace(async (_, { input }, context) => {
      const { workspaceId, user } = context;

      const expenseData = {
        ...input,
        workspaceId,
        createdBy: user.id,
      };

      // Convertir les dates
      if (input.date) expenseData.date = new Date(input.date);
      if (input.paymentDate)
        expenseData.paymentDate = new Date(input.paymentDate);

      try {
        const expense = new Expense(expenseData);
        await expense.save();
        return expense;
      } catch (error) {
        if (error.name === "ValidationError") {
          throw new UserInputError("Données de dépense invalides", {
            errors: error.errors,
          });
        }
        throw error;
      }
    }),

    // Mettre à jour une dépense existante
    updateExpense: withWorkspace(async (_, { id, input }, context) => {
      const { workspaceId } = context;

      await checkExpenseAccess(id, workspaceId);

      // Log pour déboguer
      console.log("updateExpense - input reçu:", JSON.stringify(input));
      console.log("updateExpense - champs disponibles:", Object.keys(input));

      // Convertir les dates
      if (input.date) input.date = new Date(input.date);
      if (input.paymentDate) input.paymentDate = new Date(input.paymentDate);

      try {
        // Utiliser findByIdAndUpdate au lieu de save() pour éviter les problèmes de détection de modifications
        const updatedExpense = await Expense.findByIdAndUpdate(
          id,
          { $set: input },
          { new: true, runValidators: true }
        );

        if (!updatedExpense) {
          throw new UserInputError("Dépense non trouvée");
        }

        return updatedExpense;
      } catch (error) {
        if (error.name === "ValidationError") {
          throw new UserInputError("Données de dépense invalides", {
            errors: error.errors,
          });
        }
        throw error;
      }
    }),

    // Supprimer une dépense
    deleteExpense: withWorkspace(async (_, { id }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(id, workspaceId);

      // Supprimer les fichiers associés
      if (expense.files && expense.files.length > 0) {
        for (const file of expense.files) {
          try {
            await unlinkAsync(file.path);
          } catch (error) {
            console.warn(
              `Impossible de supprimer le fichier ${file.path}:`,
              error
            );
          }
        }
      }

      await Expense.findByIdAndDelete(id);
      return { success: true, message: "Dépense supprimée avec succès" };
    }),

    // Supprimer plusieurs dépenses
    deleteMultipleExpenses: withWorkspace(async (_, { ids }, context) => {
      const { workspaceId } = context;

      if (!ids || ids.length === 0) {
        throw new UserInputError("Aucun ID de dépense fourni");
      }

      const deletedCount = { success: 0, failed: 0 };
      const errors = [];

      for (const id of ids) {
        try {
          const expense = await checkExpenseAccess(id, user.id);

          // Supprimer les fichiers associés
          if (expense.files && expense.files.length > 0) {
            for (const file of expense.files) {
              try {
                await unlinkAsync(file.path);
              } catch (error) {
                console.warn(
                  `Impossible de supprimer le fichier ${file.path}:`,
                  error
                );
              }
            }
          }

          await Expense.findByIdAndDelete(id);
          deletedCount.success++;
        } catch (error) {
          deletedCount.failed++;
          errors.push({ id, error: error.message });
        }
      }

      return {
        success: deletedCount.failed === 0,
        deletedCount: deletedCount.success,
        failedCount: deletedCount.failed,
        message: `${deletedCount.success} dépense(s) supprimée(s) avec succès${deletedCount.failed > 0 ? `, ${deletedCount.failed} échec(s)` : ''}`,
        errors
      };
    }),

    // Changer le statut d'une dépense
    changeExpenseStatus: withWorkspace(async (_, { id, status }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(id, workspaceId);

      expense.status = status;
      if (status === "PAID" && !expense.paymentDate) {
        expense.paymentDate = new Date();
      }

      await expense.save();
      return expense;
    }),

    // Ajouter un fichier à une dépense
    addExpenseFile: withWorkspace(async (_, { expenseId, input }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(expenseId, workspaceId);

      try {
        let fileData;
        
        // Cas 1: Fichier déjà uploadé sur Cloudflare
        if (input.cloudflareUrl) {
          fileData = {
            id: new mongoose.Types.ObjectId(),
            filename: input.fileName || 'document.pdf',
            originalFilename: input.fileName || 'document.pdf',
            mimetype: input.mimeType || 'application/pdf',
            path: input.cloudflareUrl, // Utiliser l'URL Cloudflare comme path
            url: input.cloudflareUrl,
            size: input.fileSize || 0,
            ocrProcessed: !!input.ocrData,
            ocrData: input.ocrData ? JSON.parse(input.ocrData) : null,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          console.log('✅ Fichier Cloudflare ajouté:', {
            url: input.cloudflareUrl,
            fileName: input.fileName,
            hasOcrData: !!input.ocrData
          });
        } 
        // Cas 2: Fichier à uploader normalement
        else if (input.file) {
          fileData = await saveUploadedFile(input.file, user.id);
        } 
        // Cas 3: Aucun fichier fourni
        else {
          throw new UserInputError("Vous devez fournir soit un fichier à uploader, soit une URL Cloudflare");
        }

        // Traiter le fichier avec OCR si demandé ET si ce n'est pas déjà fait
        if (input.processOCR && !fileData.ocrProcessed && input.file) {
          try {
            const ocrResult = await processFileWithOCR(fileData.path);
            fileData.ocrProcessed = true;
            fileData.ocrData = ocrResult;

            // Mettre à jour les métadonnées OCR de la dépense si c'est la première fois
            if (
              !expense.ocrMetadata ||
              Object.keys(expense.ocrMetadata).length === 0
            ) {
              expense.ocrMetadata = {
                vendorName: ocrResult.vendorName,
                vendorAddress: ocrResult.vendorAddress,
                vendorVatNumber: ocrResult.vendorVatNumber,
                invoiceNumber: ocrResult.invoiceNumber,
                invoiceDate: ocrResult.invoiceDate
                  ? new Date(ocrResult.invoiceDate)
                  : null,
                totalAmount: ocrResult.totalAmount,
                vatAmount: ocrResult.vatAmount,
                currency: ocrResult.currency,
                confidenceScore: ocrResult.confidenceScore,
                rawExtractedText: ocrResult.rawExtractedText,
              };
            }
          } catch (ocrError) {
            console.error("Erreur lors du traitement OCR:", ocrError);
            // Ne pas bloquer l'ajout du fichier en cas d'erreur OCR
          }
        }
        
        // Si nous avons des données OCR déjà traitées (cas Cloudflare), les utiliser
        if (fileData.ocrData && (!expense.ocrMetadata || Object.keys(expense.ocrMetadata).length === 0)) {
          const ocrData = fileData.ocrData;
          expense.ocrMetadata = {
            vendorName: ocrData.vendorName || '',
            vendorAddress: ocrData.vendorAddress || '',
            vendorVatNumber: ocrData.vendorVatNumber || '',
            invoiceNumber: ocrData.invoiceNumber || '',
            invoiceDate: ocrData.invoiceDate ? new Date(ocrData.invoiceDate) : null,
            totalAmount: ocrData.totalAmount || 0,
            vatAmount: ocrData.vatAmount || 0,
            currency: ocrData.currency || 'EUR',
            confidenceScore: ocrData.confidenceScore || 0,
            rawExtractedText: ocrData.rawExtractedText || '',
          };
        }

        // Ajouter le fichier à la dépense
        expense.files.push(fileData);
        await expense.save();

        return expense;
      } catch (error) {
        throw new ApolloError(
          "Erreur lors de l'ajout du fichier",
          "FILE_UPLOAD_ERROR",
          { error }
        );
      }
    }),

    // Supprimer un fichier d'une dépense
    removeExpenseFile: withWorkspace(async (_, { expenseId, fileId }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(expenseId, workspaceId);

      // Trouver le fichier à supprimer
      const fileIndex = expense.files.findIndex(
        (file) => file._id.toString() === fileId
      );

      if (fileIndex === -1) {
        throw new UserInputError("Fichier non trouvé");
      }

      const file = expense.files[fileIndex];

      // Supprimer le fichier du système de fichiers
      try {
        await unlinkAsync(file.path);
      } catch (error) {
        console.error(
          `Erreur lors de la suppression du fichier ${file.path}:`,
          error
        );
      }

      // Supprimer le fichier de la dépense
      expense.files.splice(fileIndex, 1);
      await expense.save();

      return expense;
    }),

    // Mettre à jour les métadonnées OCR d'une dépense
    updateExpenseOCRMetadata: withWorkspace(async (_, { expenseId, metadata }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(expenseId, workspaceId);

      // Mettre à jour les métadonnées OCR
      expense.ocrMetadata = {
        ...expense.ocrMetadata,
        ...metadata,
        invoiceDate: metadata.invoiceDate
          ? new Date(metadata.invoiceDate)
          : expense.ocrMetadata.invoiceDate,
      };

      await expense.save();
      return expense;
    }),

    // Déclencher manuellement l'analyse OCR d'un fichier
    processExpenseFileOCR: withWorkspace(async (_, { expenseId, fileId }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(expenseId, workspaceId);

      // Trouver le fichier à traiter
      const fileIndex = expense.files.findIndex(
        (file) => file._id.toString() === fileId
      );

      if (fileIndex === -1) {
        throw new UserInputError("Fichier non trouvé");
      }

      const file = expense.files[fileIndex];

      try {
        // Traiter le fichier avec OCR
        const ocrResult = await processFileWithOCR(file.path);

        // Mettre à jour les données OCR du fichier
        expense.files[fileIndex].ocrProcessed = true;
        expense.files[fileIndex].ocrData = ocrResult;

        // Mettre à jour les métadonnées OCR de la dépense
        expense.ocrMetadata = {
          vendorName: ocrResult.vendorName,
          vendorAddress: ocrResult.vendorAddress,
          vendorVatNumber: ocrResult.vendorVatNumber,
          invoiceNumber: ocrResult.invoiceNumber,
          invoiceDate: ocrResult.invoiceDate
            ? new Date(ocrResult.invoiceDate)
            : null,
          totalAmount: ocrResult.totalAmount,
          vatAmount: ocrResult.vatAmount,
          currency: ocrResult.currency,
          confidenceScore: ocrResult.confidenceScore,
          rawExtractedText: ocrResult.rawExtractedText,
        };

        await expense.save();
        return expense;
      } catch (error) {
        throw new ApolloError(
          "Erreur lors du traitement OCR",
          "OCR_PROCESSING_ERROR",
          { error }
        );
      }
    }),

    // Appliquer les données OCR aux champs de la dépense
    applyOCRDataToExpense: withWorkspace(async (_, { expenseId }, context) => {
      const { workspaceId } = context;

      const expense = await checkExpenseAccess(expenseId, workspaceId);

      // Vérifier si des métadonnées OCR sont disponibles
      if (
        !expense.ocrMetadata ||
        Object.keys(expense.ocrMetadata).length === 0
      ) {
        throw new UserInputError(
          "Aucune donnée OCR disponible pour cette dépense"
        );
      }

      // Appliquer les données OCR aux champs de la dépense
      if (expense.ocrMetadata.vendorName) {
        expense.vendor = expense.ocrMetadata.vendorName;
      }

      if (expense.ocrMetadata.vendorVatNumber) {
        expense.vendorVatNumber = expense.ocrMetadata.vendorVatNumber;
      }

      if (expense.ocrMetadata.invoiceNumber) {
        expense.invoiceNumber = expense.ocrMetadata.invoiceNumber;
      }

      if (expense.ocrMetadata.invoiceDate) {
        expense.date = expense.ocrMetadata.invoiceDate;
      }

      if (expense.ocrMetadata.totalAmount) {
        expense.amount = expense.ocrMetadata.totalAmount;
      }

      if (expense.ocrMetadata.vatAmount) {
        expense.vatAmount = expense.ocrMetadata.vatAmount;

        // Calculer le taux de TVA si possible
        if (expense.amount > 0) {
          expense.vatRate =
            (expense.vatAmount / (expense.amount - expense.vatAmount)) * 100;
        }
      }

      if (expense.ocrMetadata.currency) {
        expense.currency = expense.ocrMetadata.currency;
      }

      await expense.save();
      return expense;
    }),
  },

  // Résolveurs de type
  Expense: {
    createdBy: async (expense, _, context) => {
      // Vérifier si les loaders sont disponibles
      if (context.loaders && context.loaders.userLoader) {
        return context.loaders.userLoader.load(expense.createdBy);
      }

      // Si les loaders ne sont pas disponibles, utiliser une méthode alternative
      const User = (await import("../models/User.js")).default;
      return User.findById(expense.createdBy);
    },
  },
};

export default expenseResolvers;
