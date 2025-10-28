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
import cloudflareService from "../services/cloudflareService.js";

const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

// Fonction pour supprimer un fichier (local ou Cloudflare)
const deleteFile = async (file) => {
  try {
    // Vérifier si c'est une URL Cloudflare
    if (file.url && file.url.includes('r2.dev')) {
      console.log('🗑️ Suppression du fichier Cloudflare:', file.url);
      // Extraire la clé du fichier de l'URL
      // Format: https://pub-xxx.r2.dev/{key}
      const urlParts = file.url.split('/');
      const key = urlParts.slice(3).join('/');
      await cloudflareService.deleteImage(key);
      console.log('✅ Fichier Cloudflare supprimé');
    } else if (file.path) {
      // Fichier local
      console.log('🗑️ Suppression du fichier local:', file.path);
      await unlinkAsync(file.path);
      console.log('✅ Fichier local supprimé');
    }
  } catch (error) {
    console.warn('⚠️ Impossible de supprimer le fichier:', error.message);
    // Ne pas bloquer la suppression de la dépense en cas d'erreur
  }
};

// Fonction utilitaire pour vérifier si l'utilisateur est autorisé à accéder à une dépense
const checkExpenseAccess = async (expenseId, userId) => {
  const expense = await Expense.findOne({ _id: expenseId, createdBy: userId });
  if (!expense) {
    throw new ForbiddenError(
      "Vous n'êtes pas autorisé à accéder à cette dépense"
    );
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
    expense: async (_, { id }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      return await checkExpenseAccess(id, user.id);
    },

    // Récupérer une liste paginée de dépenses avec filtres
    expenses: async (
      _,
      {
        startDate,
        endDate,
        category,
        status,
        search,
        tags,
        page = 1,
        limit = 10,
      },
      { user }
    ) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const query = { 
        createdBy: user.id 
      };

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
    },

    // Récupérer les statistiques des dépenses
    expenseStats: async (_, { startDate, endDate }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const dateQuery = {};
      if (startDate) dateQuery.$gte = new Date(startDate);
      if (endDate) dateQuery.$lte = new Date(endDate);

      const match = { 
        createdBy: new mongoose.Types.ObjectId(user.id) 
      };
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
    },
  },

  Mutation: {
    // Créer une nouvelle dépense
    createExpense: async (_, { input }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");
      if (!input.workspaceId) throw new UserInputError("workspaceId requis");

      const expenseData = {
        ...input,
        createdBy: user.id,
        workspaceId: input.workspaceId,
        // Gérer expenseType et assignedMember
        expenseType: input.expenseType || 'ORGANIZATION',
        assignedMember: input.assignedMember || null,
        taskId: input.taskId || null,
      };

      // Convertir les dates avec gestion du format français
      if (input.date) {
        // Vérifier si c'est déjà au format ISO (YYYY-MM-DD)
        if (/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          const dateObj = new Date(input.date + "T12:00:00.000Z"); // Utiliser midi UTC pour éviter les problèmes de timezone
          expenseData.date = dateObj;
        } else {
          // Essayer de parser d'autres formats
          const parsedDate = new Date(input.date);
          if (isNaN(parsedDate.getTime())) {
            throw new UserInputError(
              `Format de date invalide: ${input.date}. Utilisez le format YYYY-MM-DD`
            );
          }
          expenseData.date = parsedDate;
        }
      }

      // Gérer paymentDate seulement si elle est fournie et valide
      if (input.paymentDate && input.paymentDate.trim() !== "") {
        if (/^\d{4}-\d{2}-\d{2}$/.test(input.paymentDate)) {
          const paymentDateObj = new Date(input.paymentDate + "T12:00:00.000Z");

          expenseData.paymentDate = paymentDateObj;
        } else {
          const parsedPaymentDate = new Date(input.paymentDate);
          if (isNaN(parsedPaymentDate.getTime())) {
            throw new UserInputError(
              `Format de date de paiement invalide: ${input.paymentDate}. Utilisez le format YYYY-MM-DD`
            );
          }
          expenseData.paymentDate = parsedPaymentDate;
        }
      } else {
        // Ne pas inclure paymentDate si elle est vide ou non fournie
        delete expenseData.paymentDate;
      }

      try {
        const expense = new Expense(expenseData);
        await expense.save();
        return expense;
      } catch (error) {
        console.error(
          "createExpense resolver - message erreur:",
          error.message
        );

        if (error.name === "ValidationError") {
          // Object.keys(error.errors).forEach((field) => {
          //   console.error(`  - ${field}: ${error.errors[field].message}`);
          // });

          // Créer un message d'erreur plus détaillé
          const errorMessages = Object.keys(error.errors)
            .map((field) => `${field}: ${error.errors[field].message}`)
            .join(", ");

          throw new UserInputError(`Erreurs de validation: ${errorMessages}`, {
            errors: error.errors,
          });
        }
        throw error;
      }
    },

    // Mettre à jour une dépense existante
    updateExpense: async (_, { id, input }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      await checkExpenseAccess(id, user.id);
      
      // Préparer les données de mise à jour
      const updateData = { ...input };
      
      // Convertir les dates
      if (input.date) updateData.date = new Date(input.date);
      if (input.paymentDate) updateData.paymentDate = new Date(input.paymentDate);
      
      // Gérer expenseType et assignedMember
      if (input.expenseType) updateData.expenseType = input.expenseType;
      if (input.assignedMember !== undefined) updateData.assignedMember = input.assignedMember;
      if (input.taskId !== undefined) updateData.taskId = input.taskId;

      try {
        // Utiliser findByIdAndUpdate au lieu de save() pour éviter les problèmes de détection de modifications
        const updatedExpense = await Expense.findByIdAndUpdate(
          id,
          { $set: updateData },
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
    },

    // Supprimer une dépense
    deleteExpense: async (_, { id }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(id, user.id);

      // Supprimer les fichiers associés (locaux et Cloudflare)
      if (expense.files && expense.files.length > 0) {
        for (const file of expense.files) {
          await deleteFile(file);
        }
      }

      await Expense.findByIdAndDelete(id);
      return { success: true, message: "Dépense supprimée avec succès" };
    },

    // Supprimer plusieurs dépenses
    deleteMultipleExpenses: async (_, { ids }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      if (!ids || ids.length === 0) {
        throw new UserInputError("Aucun ID de dépense fourni");
      }

      const deletedCount = { success: 0, failed: 0 };
      const errors = [];

      for (const id of ids) {
        try {
          const expense = await checkExpenseAccess(id, user.id);

          // Supprimer les fichiers associés (locaux et Cloudflare)
          if (expense.files && expense.files.length > 0) {
            for (const file of expense.files) {
              await deleteFile(file);
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
        message: `${deletedCount.success} dépense(s) supprimée(s) avec succès${
          deletedCount.failed > 0 ? `, ${deletedCount.failed} échec(s)` : ""
        }`,
        errors,
      };
    },

    // Changer le statut d'une dépense
    changeExpenseStatus: async (_, { id, status }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(id, user.id);

      expense.status = status;
      if (status === "PAID" && !expense.paymentDate) {
        expense.paymentDate = new Date();
      }

      await expense.save();
      return expense;
    },

    // Ajouter un fichier à une dépense
    addExpenseFile: async (_, { expenseId, input }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(expenseId, user.id);

      try {
        let fileData;

        // Cas 1: Fichier déjà uploadé sur Cloudflare
        if (input.cloudflareUrl) {
          fileData = {
            id: new mongoose.Types.ObjectId(),
            filename: input.fileName || "document.pdf",
            originalFilename: input.fileName || "document.pdf",
            mimetype: input.mimeType || "application/pdf",
            path: input.cloudflareUrl, // Utiliser l'URL Cloudflare comme path
            url: input.cloudflareUrl,
            size: input.fileSize || 1, // Taille par défaut à 1 pour éviter l'erreur de validation
            ocrProcessed: !!input.ocrData,
            ocrData: input.ocrData ? JSON.parse(input.ocrData) : null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        // Cas 2: Fichier à uploader normalement
        else if (input.file) {
          fileData = await saveUploadedFile(input.file, user.id);
        }
        // Cas 3: Aucun fichier fourni
        else {
          throw new UserInputError(
            "Vous devez fournir soit un fichier à uploader, soit une URL Cloudflare"
          );
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
        if (
          fileData.ocrData &&
          (!expense.ocrMetadata ||
            Object.keys(expense.ocrMetadata).length === 0)
        ) {
          const ocrData = fileData.ocrData;
          expense.ocrMetadata = {
            vendorName: ocrData.vendorName || "",
            vendorAddress: ocrData.vendorAddress || "",
            vendorVatNumber: ocrData.vendorVatNumber || "",
            invoiceNumber: ocrData.invoiceNumber || "",
            invoiceDate: ocrData.invoiceDate
              ? new Date(ocrData.invoiceDate)
              : null,
            totalAmount: ocrData.totalAmount || 0,
            vatAmount: ocrData.vatAmount || 0,
            currency: ocrData.currency || "EUR",
            confidenceScore: ocrData.confidenceScore || 0,
            rawExtractedText: ocrData.rawExtractedText || "",
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
    },

    // Supprimer un fichier d'une dépense
    removeExpenseFile: async (_, { expenseId, fileId }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(expenseId, user.id);

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
    },

    // Mettre à jour les métadonnées OCR d'une dépense
    updateExpenseOCRMetadata: async (_, { expenseId, metadata }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(expenseId, user.id);

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
    },

    // Déclencher manuellement l'analyse OCR d'un fichier
    processExpenseFileOCR: async (_, { expenseId, fileId }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(expenseId, user.id);

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
    },

    // Appliquer les données OCR aux champs de la dépense
    applyOCRDataToExpense: async (_, { expenseId }, { user }) => {
      if (!user) throw new ForbiddenError("Vous devez être connecté");

      const expense = await checkExpenseAccess(expenseId, user.id);

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
    },
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
    
    // Résoudre assignedMember pour retourner null si l'objet est vide ou invalide
    assignedMember: (expense) => {
      const member = expense.assignedMember;
      
      // Si assignedMember n'existe pas ou est null, retourner null
      if (!member) {
        return null;
      }
      
      // Si assignedMember est un objet vide ou n'a pas de userId, retourner null
      if (typeof member === 'object' && (!member.userId || member.userId === '')) {
        return null;
      }
      
      // Sinon, retourner l'objet assignedMember
      return member;
    },
  },
};

export default expenseResolvers;
