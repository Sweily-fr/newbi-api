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
// ✅ Import des wrappers RBAC
import {
  requireRead,
  requireWrite,
  requireDelete,
  requirePermission,
  withOrganization,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { syncExpenseIfNeeded } from "../services/pennylaneSyncHelper.js";

const unlinkAsync = promisify(fs.unlink);
const mkdirAsync = promisify(fs.mkdir);

// Fonction pour supprimer un fichier (local ou Cloudflare)
const deleteFile = async (file) => {
  try {
    // Vérifier si c'est une URL Cloudflare
    if (file.url && file.url.includes("r2.dev")) {
      console.log("🗑️ Suppression du fichier Cloudflare:", file.url);
      // Extraire la clé du fichier de l'URL
      // Format: https://pub-xxx.r2.dev/{key}
      const urlParts = file.url.split("/");
      const key = urlParts.slice(3).join("/");
      await cloudflareService.deleteImage(key);
      console.log("✅ Fichier Cloudflare supprimé");
    } else if (file.path) {
      // Fichier local
      console.log("🗑️ Suppression du fichier local:", file.path);
      await unlinkAsync(file.path);
      console.log("✅ Fichier local supprimé");
    }
  } catch (error) {
    console.warn("⚠️ Impossible de supprimer le fichier:", error.message);
    // Ne pas bloquer la suppression de la dépense en cas d'erreur
  }
};

// Fonction utilitaire pour vérifier si l'utilisateur est autorisé à accéder à une dépense
// ✅ Mise à jour pour supporter le contexte RBAC avec workspaceId
const checkExpenseAccess = async (expenseId, workspaceId, userId, userRole) => {
  const query = {
    _id: expenseId,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
  };

  // Les membres ne peuvent accéder qu'à leurs propres dépenses
  // Les owners, admins et accountants peuvent accéder à toutes les dépenses du workspace
  if (userRole === "member") {
    query.createdBy = userId;
  }

  const expense = await Expense.findOne(query);
  if (!expense) {
    throw new AppError(
      "Dépense non trouvée ou vous n'êtes pas autorisé à y accéder",
      ERROR_CODES.NOT_FOUND,
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
    Math.random() * 1e9,
  )}-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

  // Créer le dossier de destination s'il n'existe pas
  const uploadDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "expenses",
    userId.toString(),
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
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "expenses"
    expense: requireRead("expenses")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        return await checkExpenseAccess(id, workspaceId, user.id, userRole);
      },
    ),

    // Récupérer une liste paginée de dépenses avec filtres
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "expenses"
    expenses: requireRead("expenses")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          startDate,
          endDate,
          category,
          status,
          search,
          tags,
          page = 1,
          limit = 10,
        },
        context,
      ) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const query = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        };

        // Les membres ne voient que leurs propres dépenses
        if (userRole === "member") {
          query.createdBy = user.id;
        }

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
    ),

    // Récupérer les statistiques des dépenses
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "expenses"
    expenseStats: requireRead("expenses")(
      async (
        _,
        { workspaceId: inputWorkspaceId, startDate, endDate },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const dateQuery = {};
        if (startDate) dateQuery.$gte = new Date(startDate);
        if (endDate) dateQuery.$lte = new Date(endDate);

        const match = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
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
                            then: {
                              $concat: ["0", { $toString: "$_id.month" }],
                            },
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
    ),
  },

  Mutation: {
    // Créer une nouvelle dépense
    // ✅ Protégé par RBAC - nécessite la permission "create" sur "expenses"
    createExpense: requireWrite("expenses")(async (_, { input }, context) => {
      const { user } = context;
      const workspaceId = resolveWorkspaceId(
        input.workspaceId,
        context.workspaceId,
      );

      if (!workspaceId) {
        throw new AppError("workspaceId requis", ERROR_CODES.BAD_REQUEST);
      }

      const expenseData = {
        ...input,
        createdBy: user.id,
        workspaceId: workspaceId,
        // Gérer expenseType et assignedMember
        expenseType: input.expenseType || "ORGANIZATION",
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
              `Format de date invalide: ${input.date}. Utilisez le format YYYY-MM-DD`,
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
              `Format de date de paiement invalide: ${input.paymentDate}. Utilisez le format YYYY-MM-DD`,
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
          error.message,
        );

        if (error.name === "ValidationError") {
          const errorMessages = Object.keys(error.errors)
            .map((field) => `${field}: ${error.errors[field].message}`)
            .join(", ");

          throw new UserInputError(`Erreurs de validation: ${errorMessages}`, {
            errors: error.errors,
          });
        }
        throw error;
      }
    }),

    // Mettre à jour une dépense existante
    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "expenses"
    updateExpense: requireWrite("expenses")(
      async (_, { id, input }, context) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          input.workspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          id,
          workspaceId,
          user.id,
          userRole,
        );

        // Préparer les données de mise à jour
        const updateData = { ...input };
        delete updateData.workspaceId; // Ne pas mettre à jour le workspaceId

        // Convertir les dates
        if (input.date) updateData.date = new Date(input.date);
        if (input.paymentDate)
          updateData.paymentDate = new Date(input.paymentDate);

        // Gérer expenseType et assignedMember
        if (input.expenseType) updateData.expenseType = input.expenseType;
        if (input.assignedMember !== undefined)
          updateData.assignedMember = input.assignedMember;
        if (input.taskId !== undefined) updateData.taskId = input.taskId;

        try {
          const updatedExpense = await Expense.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true },
          );

          if (!updatedExpense) {
            throw new AppError("Dépense non trouvée", ERROR_CODES.NOT_FOUND);
          }

          // Sync Pennylane si le statut a changé vers APPROVED/PAID (fire-and-forget)
          if (input.status && input.status !== expense.status) {
            syncExpenseIfNeeded(
              updatedExpense,
              context.organizationId || workspaceId,
            ).catch((err) =>
              console.error("Erreur sync Pennylane dépense:", err),
            );
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
    ),

    // Supprimer une dépense
    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "expenses"
    deleteExpense: requireDelete("expenses")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          id,
          workspaceId,
          user.id,
          userRole,
        );

        // Supprimer les fichiers associés (locaux et Cloudflare)
        if (expense.files && expense.files.length > 0) {
          for (const file of expense.files) {
            await deleteFile(file);
          }
        }

        await Expense.findByIdAndDelete(id);
        return { success: true, message: "Dépense supprimée avec succès" };
      },
    ),

    // Supprimer plusieurs dépenses
    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "expenses"
    deleteMultipleExpenses: requireDelete("expenses")(
      async (_, { ids, workspaceId: inputWorkspaceId }, context) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        if (!ids || ids.length === 0) {
          throw new UserInputError("Aucun ID de dépense fourni");
        }

        const deletedCount = { success: 0, failed: 0 };
        const errors = [];

        for (const id of ids) {
          try {
            const expense = await checkExpenseAccess(
              id,
              workspaceId,
              user.id,
              userRole,
            );

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
    ),

    // Changer le statut d'une dépense
    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "expenses"
    changeExpenseStatus: requireWrite("expenses")(
      async (_, { id, status, workspaceId: inputWorkspaceId }, context) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          id,
          workspaceId,
          user.id,
          userRole,
        );

        const oldStatus = expense.status;
        expense.status = status;
        if (status === "PAID" && !expense.paymentDate) {
          expense.paymentDate = new Date();
        }

        await expense.save();

        // Sync Pennylane (fire-and-forget)
        if (status !== oldStatus) {
          syncExpenseIfNeeded(
            expense,
            context.organizationId || workspaceId,
          ).catch((err) =>
            console.error("Erreur sync Pennylane dépense:", err),
          );
        }

        return expense;
      },
    ),

    // Ajouter un fichier à une dépense
    // ✅ Protégé par RBAC - nécessite la permission "ocr" sur "expenses"
    addExpenseFile: requirePermission(
      "expenses",
      "ocr",
    )(
      async (
        _,
        { expenseId, input, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          expenseId,
          workspaceId,
          user.id,
          userRole,
        );

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
              "Vous devez fournir soit un fichier à uploader, soit une URL Cloudflare",
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
            { error },
          );
        }
      },
    ),

    // Supprimer un fichier d'une dépense
    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "expenses"
    removeExpenseFile: requireWrite("expenses")(
      async (
        _,
        { expenseId, fileId, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          expenseId,
          workspaceId,
          user.id,
          userRole,
        );

        // Trouver le fichier à supprimer
        const fileIndex = expense.files.findIndex(
          (file) => file._id.toString() === fileId,
        );

        if (fileIndex === -1) {
          throw new UserInputError("Fichier non trouvé");
        }

        const file = expense.files[fileIndex];

        // Supprimer le fichier (local ou Cloudflare)
        await deleteFile(file);

        // Supprimer le fichier de la dépense
        expense.files.splice(fileIndex, 1);
        await expense.save();

        return expense;
      },
    ),

    // Mettre à jour les métadonnées OCR d'une dépense
    // ✅ Protégé par RBAC - nécessite la permission "ocr" sur "expenses"
    updateExpenseOCRMetadata: requirePermission(
      "expenses",
      "ocr",
    )(
      async (
        _,
        { expenseId, metadata, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          expenseId,
          workspaceId,
          user.id,
          userRole,
        );

        // Mettre à jour les métadonnées OCR
        expense.ocrMetadata = {
          ...expense.ocrMetadata,
          ...metadata,
          invoiceDate: metadata.invoiceDate
            ? new Date(metadata.invoiceDate)
            : expense.ocrMetadata?.invoiceDate,
        };

        await expense.save();
        return expense;
      },
    ),

    // Déclencher manuellement l'analyse OCR d'un fichier
    // ✅ Protégé par RBAC - nécessite la permission "ocr" sur "expenses"
    processExpenseFileOCR: requirePermission(
      "expenses",
      "ocr",
    )(
      async (
        _,
        { expenseId, fileId, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          expenseId,
          workspaceId,
          user.id,
          userRole,
        );

        // Trouver le fichier à traiter
        const fileIndex = expense.files.findIndex(
          (file) => file._id.toString() === fileId,
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
            { error },
          );
        }
      },
    ),

    // Appliquer les données OCR aux champs de la dépense
    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "expenses"
    applyOCRDataToExpense: requireWrite("expenses")(
      async (_, { expenseId, workspaceId: inputWorkspaceId }, context) => {
        const { user, userRole } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const expense = await checkExpenseAccess(
          expenseId,
          workspaceId,
          user.id,
          userRole,
        );

        // Vérifier si des métadonnées OCR sont disponibles
        if (
          !expense.ocrMetadata ||
          Object.keys(expense.ocrMetadata).length === 0
        ) {
          throw new UserInputError(
            "Aucune donnée OCR disponible pour cette dépense",
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
    ),
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
      const user = await User.findById(expense.createdBy).lean();
      if (!user) return null;
      return { ...user, id: user._id.toString() };
    },

    // Résoudre assignedMember pour retourner null si l'objet est vide ou invalide
    assignedMember: (expense) => {
      const member = expense.assignedMember;

      // Si assignedMember n'existe pas ou est null, retourner null
      if (!member) {
        return null;
      }

      // Si assignedMember est un objet vide ou n'a pas de userId, retourner null
      if (
        typeof member === "object" &&
        (!member.userId || member.userId === "")
      ) {
        return null;
      }

      // Sinon, retourner l'objet assignedMember
      return member;
    },
  },
};

export default expenseResolvers;
