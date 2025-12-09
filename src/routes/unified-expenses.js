import express from "express";
import multer from "multer";
import { betterAuthMiddleware } from "../middlewares/better-auth.js";
import Transaction from "../models/Transaction.js";
import Expense from "../models/Expense.js";
import logger from "../utils/logger.js";
import cloudflareService from "../services/cloudflareService.js";

// Configuration multer pour l'upload de fichiers
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 Mo max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Format de fichier non supporté. Utilisez JPG, PNG, WebP ou PDF."
        )
      );
    }
  },
});

const router = express.Router();

/**
 * GET /unified-expenses
 * Récupère les dépenses unifiées (transactions bancaires négatives + dépenses manuelles)
 */
router.get("/", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const {
      workspaceId,
      page = 1,
      limit = 50,
      startDate,
      endDate,
      category,
    } = req.query;

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId requis" });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Récupération pour workspace: ${workspaceId}`
    );

    // Construire les filtres de date
    const dateFilter = {};
    if (startDate) {
      dateFilter.$gte = new Date(startDate);
    }
    if (endDate) {
      dateFilter.$lte = new Date(endDate);
    }

    // 1. Récupérer les transactions bancaires négatives (sorties d'argent)
    const transactionQuery = {
      workspaceId,
      amount: { $lt: 0 }, // Uniquement les sorties
      status: "completed",
    };

    if (Object.keys(dateFilter).length > 0) {
      transactionQuery.date = dateFilter;
    }

    if (category) {
      transactionQuery.expenseCategory = category;
    }

    // Compter d'abord pour les stats (rapide avec index)
    const bankTransactionsCount =
      await Transaction.countDocuments(transactionQuery);

    // Charger TOUTES les transactions - MongoDB gère bien avec les index
    // On utilise .lean() pour des objets JS purs (plus rapide)
    // et on sélectionne uniquement les champs nécessaires
    const bankTransactions = await Transaction.find(transactionQuery)
      .select(
        "_id externalId amount currency description expenseCategory processedAt date status type linkedExpenseId receiptFile receiptRequired metadata fromAccount provider createdAt updatedAt"
      )
      .sort({ processedAt: -1, date: -1 })
      .lean();

    logger.info(
      `[UNIFIED-EXPENSES] ${bankTransactions.length} transactions bancaires chargées`
    );

    // 2. Récupérer les dépenses manuelles NON liées à une transaction
    const expenseQuery = {
      workspaceId,
      linkedTransactionId: null, // Uniquement les dépenses non liées
      status: { $in: ["PAID", "PENDING", "APPROVED"] },
    };

    if (Object.keys(dateFilter).length > 0) {
      expenseQuery.date = dateFilter;
    }

    if (category) {
      expenseQuery.category = category;
    }

    const manualExpensesCount = await Expense.countDocuments(expenseQuery);
    const manualExpenses = await Expense.find(expenseQuery)
      .sort({ date: -1 })
      .lean();

    logger.info(
      `[UNIFIED-EXPENSES] ${manualExpenses.length}/${manualExpensesCount} dépenses manuelles chargées`
    );

    // 3. Récupérer les dépenses liées (justificatifs) pour enrichir les transactions
    const linkedExpenseIds = bankTransactions
      .filter((t) => t.linkedExpenseId)
      .map((t) => t.linkedExpenseId);

    const linkedExpenses = await Expense.find({
      _id: { $in: linkedExpenseIds },
    }).lean();

    const linkedExpensesMap = new Map(
      linkedExpenses.map((e) => [e._id.toString(), e])
    );

    // 4. Transformer et fusionner les données
    const unifiedExpenses = [];

    // Ajouter les transactions bancaires
    for (const tx of bankTransactions) {
      const linkedExpense = tx.linkedExpenseId
        ? linkedExpensesMap.get(tx.linkedExpenseId.toString())
        : null;

      unifiedExpenses.push({
        id: tx._id.toString(),
        type: "BANK_TRANSACTION",
        source: "BANK",

        // Données de base
        title: linkedExpense?.title || tx.description,
        description: tx.description,
        amount: Math.abs(tx.amount), // Montant positif pour l'affichage
        currency: tx.currency,
        // Utiliser processedAt ou metadata.bridgeTransactionDate pour la vraie date de transaction
        date:
          tx.processedAt ||
          tx.metadata?.bridgeTransactionDate ||
          tx.date ||
          tx.createdAt,

        // Catégorie (auto-catégorisation basée sur la description)
        category:
          categorizeTransaction(tx) || linkedExpense?.category || "OTHER",

        // Vendor
        vendor:
          linkedExpense?.vendor || extractVendorFromDescription(tx.description),

        // Statut justificatif (vérifie aussi receiptFile directement sur la transaction)
        hasReceipt: !!linkedExpense || !!tx.receiptFile?.url,
        receiptRequired: tx.receiptRequired !== false && !tx.receiptFile?.url,
        linkedExpenseId: tx.linkedExpenseId?.toString() || null,

        // Fichiers du justificatif (priorité au receiptFile direct, sinon fichiers de l'expense liée)
        files: tx.receiptFile?.url
          ? [tx.receiptFile]
          : linkedExpense?.files || [],

        // Justificatif direct sur la transaction
        receiptFile: tx.receiptFile || null,

        // Métadonnées
        paymentMethod: tx.type === "debit" ? "CARD" : "BANK_TRANSFER",
        status: "PAID",

        // Nom de la banque (depuis les métadonnées Bridge)
        bankName:
          tx.metadata?.bankName ||
          tx.metadata?.bank_name ||
          tx.metadata?.institutionName ||
          null,

        // Données originales pour référence
        originalTransaction: {
          id: tx._id.toString(),
          externalId: tx.externalId,
          provider: tx.provider,
          fromAccount: tx.fromAccount,
          bankName:
            tx.metadata?.bankName ||
            tx.metadata?.bank_name ||
            tx.metadata?.institutionName ||
            null,
        },

        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      });
    }

    // Ajouter les dépenses manuelles
    for (const expense of manualExpenses) {
      unifiedExpenses.push({
        id: expense._id.toString(),
        type: "MANUAL_EXPENSE",
        source: expense.source || "MANUAL",

        // Données de base
        title: expense.title,
        description: expense.description,
        amount: expense.amount,
        currency: expense.currency,
        date: expense.date,

        // Catégorie
        category: expense.category,

        // Vendor
        vendor: expense.vendor,

        // Statut justificatif
        hasReceipt: expense.files && expense.files.length > 0,
        receiptRequired: true,
        linkedExpenseId: null,

        // Fichiers
        files: expense.files || [],

        // Métadonnées
        paymentMethod: expense.paymentMethod,
        status: expense.status,

        // Notes et tags
        notes: expense.notes,
        tags: expense.tags,

        // Assignation (pour notes de frais)
        expenseType: expense.expenseType,
        assignedMember: expense.assignedMember,

        // Données OCR
        ocrMetadata: expense.ocrMetadata,

        createdAt: expense.createdAt,
        updatedAt: expense.updatedAt,
      });
    }

    // 5. Trier par date décroissante (utiliser processedAt en priorité)
    unifiedExpenses.sort((a, b) => {
      const dateA = new Date(a.date || a.processedAt);
      const dateB = new Date(b.date || b.processedAt);
      return dateB - dateA;
    });

    // 6. Pagination (si limit > 5000, retourner tout sans pagination)
    const parsedLimit = parseInt(limit);
    const parsedPage = parseInt(page);
    let paginatedExpenses;

    if (parsedLimit >= 5000) {
      // Pas de pagination, retourner tout
      paginatedExpenses = unifiedExpenses;
    } else {
      const startIndex = (parsedPage - 1) * parsedLimit;
      const endIndex = startIndex + parsedLimit;
      paginatedExpenses = unifiedExpenses.slice(startIndex, endIndex);
    }

    // 7. Statistiques
    const stats = {
      totalCount: unifiedExpenses.length,
      bankTransactionsCount: bankTransactions.length,
      manualExpensesCount: manualExpenses.length,
      withReceiptCount: unifiedExpenses.filter((e) => e.hasReceipt).length,
      withoutReceiptCount: unifiedExpenses.filter(
        (e) => !e.hasReceipt && e.type === "BANK_TRANSACTION"
      ).length,
      totalAmount: unifiedExpenses.reduce((sum, e) => sum + e.amount, 0),
    };

    logger.info(
      `[UNIFIED-EXPENSES] Retour de ${paginatedExpenses.length} dépenses sur ${unifiedExpenses.length} total`
    );

    res.json({
      success: true,
      expenses: paginatedExpenses,
      stats,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        totalCount: unifiedExpenses.length,
        hasNextPage:
          parsedLimit < 5000 &&
          parsedPage * parsedLimit < unifiedExpenses.length,
      },
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /unified-expenses/link
 * Lier un justificatif (Expense) à une transaction bancaire
 */
router.post("/link", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { transactionId, expenseId } = req.body;

    if (!transactionId || !expenseId) {
      return res
        .status(400)
        .json({ error: "transactionId et expenseId requis" });
    }

    // Mettre à jour la transaction
    const transaction = await Transaction.findByIdAndUpdate(
      transactionId,
      {
        linkedExpenseId: expenseId,
        reconciliationStatus: "matched",
        reconciliationDate: new Date(),
      },
      { new: true }
    );

    if (!transaction) {
      return res.status(404).json({ error: "Transaction non trouvée" });
    }

    // Mettre à jour la dépense
    const expense = await Expense.findByIdAndUpdate(
      expenseId,
      {
        linkedTransactionId: transactionId,
        isReconciled: true,
      },
      { new: true }
    );

    if (!expense) {
      return res.status(404).json({ error: "Dépense non trouvée" });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Lien créé: Transaction ${transactionId} <-> Expense ${expenseId}`
    );

    res.json({
      success: true,
      message: "Justificatif lié avec succès",
      transaction,
      expense,
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur link:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /unified-expenses/unlink
 * Délier un justificatif d'une transaction bancaire
 */
router.post("/unlink", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({ error: "transactionId requis" });
    }

    // Récupérer la transaction pour trouver l'expense liée
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction non trouvée" });
    }

    const expenseId = transaction.linkedExpenseId;

    // Mettre à jour la transaction
    await Transaction.findByIdAndUpdate(transactionId, {
      linkedExpenseId: null,
      reconciliationStatus: "unmatched",
      reconciliationDate: null,
    });

    // Mettre à jour la dépense si elle existe
    if (expenseId) {
      await Expense.findByIdAndUpdate(expenseId, {
        linkedTransactionId: null,
        isReconciled: false,
      });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Lien supprimé pour transaction ${transactionId}`
    );

    res.json({
      success: true,
      message: "Justificatif délié avec succès",
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur unlink:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /unified-expenses/:id/category
 * Mettre à jour la catégorie d'une transaction bancaire
 */
router.put("/:id/category", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { id } = req.params;
    const { category } = req.body;

    if (!category) {
      return res.status(400).json({ error: "category requis" });
    }

    const transaction = await Transaction.findByIdAndUpdate(
      id,
      { expenseCategory: category },
      { new: true }
    );

    if (!transaction) {
      return res.status(404).json({ error: "Transaction non trouvée" });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Catégorie mise à jour pour transaction ${id}: ${category}`
    );

    res.json({
      success: true,
      transaction,
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur update category:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /unified-expenses/:id/receipt
 * Upload un justificatif pour une transaction bancaire
 */
router.post("/:id/receipt", upload.single("file"), async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { id } = req.params;
    const { workspaceId } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Fichier requis" });
    }

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId requis" });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Upload justificatif pour transaction ${id}`
    );

    // Vérifier que la transaction existe
    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction non trouvée" });
    }

    // Upload vers Cloudflare R2
    const uploadResult = await cloudflareService.uploadImage(
      req.file.buffer,
      req.file.originalname,
      user.id,
      "receipt", // Type pour les justificatifs
      workspaceId // organizationId
    );

    logger.info(`[UNIFIED-EXPENSES] Fichier uploadé: ${uploadResult.url}`);

    // Créer un objet fichier pour stocker dans la transaction
    const receiptFile = {
      url: uploadResult.url,
      key: uploadResult.key,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: user.id,
    };

    // Mettre à jour la transaction avec le justificatif
    const updatedTransaction = await Transaction.findByIdAndUpdate(
      id,
      {
        $set: {
          receiptFile: receiptFile,
          receiptRequired: false, // Plus besoin de justificatif
        },
      },
      { new: true }
    );

    logger.info(
      `[UNIFIED-EXPENSES] Transaction ${id} mise à jour avec justificatif`
    );

    res.json({
      success: true,
      message: "Justificatif uploadé avec succès",
      receiptFile,
      transaction: updatedTransaction,
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur upload receipt:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /unified-expenses/:id/receipt
 * Supprimer le justificatif d'une transaction
 */
router.delete("/:id/receipt", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { id } = req.params;

    logger.info(
      `[UNIFIED-EXPENSES] Suppression justificatif pour transaction ${id}`
    );

    // Récupérer la transaction
    const transaction = await Transaction.findById(id);
    if (!transaction) {
      return res.status(404).json({ error: "Transaction non trouvée" });
    }

    // Supprimer le fichier de Cloudflare si présent
    if (transaction.receiptFile?.key) {
      try {
        await cloudflareService.deleteImage(
          transaction.receiptFile.key,
          cloudflareService.receiptsBucketName
        );
        logger.info(
          `[UNIFIED-EXPENSES] Fichier supprimé de Cloudflare: ${transaction.receiptFile.key}`
        );
      } catch (deleteError) {
        logger.warn(
          `[UNIFIED-EXPENSES] Erreur suppression fichier Cloudflare:`,
          deleteError
        );
      }
    }

    // Mettre à jour la transaction
    const updatedTransaction = await Transaction.findByIdAndUpdate(
      id,
      {
        $unset: { receiptFile: 1 },
        $set: { receiptRequired: true },
      },
      { new: true }
    );

    res.json({
      success: true,
      message: "Justificatif supprimé",
      transaction: updatedTransaction,
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur delete receipt:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /unified-expenses/match
 * Chercher une transaction bancaire correspondante pour un montant/date donnés
 * Utilisé après un scan OCR pour proposer un rapprochement automatique
 */
router.post("/match", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { amount, date, vendor, workspaceId } = req.body;

    if (!amount || !workspaceId) {
      return res.status(400).json({ error: "amount et workspaceId requis" });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Recherche de correspondance: ${amount}€ le ${date}`
    );

    // Parser la date (supporter les formats DD/MM/YY, DD/MM/YYYY, YYYY-MM-DD)
    let targetDate;
    if (date) {
      logger.info(`[UNIFIED-EXPENSES] Date reçue: "${date}"`);

      // Si format DD/MM/YY ou DD/MM/YYYY (format français)
      const frenchDateMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      // Si format YYYY-MM-DD (format ISO)
      const isoDateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);

      if (frenchDateMatch) {
        const day = parseInt(frenchDateMatch[1], 10);
        const month = parseInt(frenchDateMatch[2], 10) - 1; // Mois 0-indexé
        let year = parseInt(frenchDateMatch[3], 10);
        if (year < 100) year += 2000; // Convertir YY en YYYY
        // Utiliser UTC à midi pour éviter les décalages de timezone
        targetDate = new Date(Date.UTC(year, month, day, 12, 0, 0));
        logger.info(
          `[UNIFIED-EXPENSES] Date parsée (format FR DD/MM/YY): ${targetDate.toISOString()}`
        );
      } else if (isoDateMatch) {
        // Format ISO: YYYY-MM-DD - utiliser UTC pour éviter les décalages de timezone
        const year = parseInt(isoDateMatch[1], 10);
        const month = parseInt(isoDateMatch[2], 10);
        const day = parseInt(isoDateMatch[3], 10);

        // Si le mois > 12, c'est probablement YYYY-DD-MM (inversé)
        if (month > 12) {
          targetDate = new Date(Date.UTC(year, day - 1, month, 12, 0, 0));
          logger.info(
            `[UNIFIED-EXPENSES] Date parsée (format ISO inversé): ${targetDate.toISOString()}`
          );
        } else {
          targetDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
          logger.info(
            `[UNIFIED-EXPENSES] Date parsée (format ISO): ${targetDate.toISOString()}`
          );
        }
      } else {
        // Sinon, essayer le parsing standard avec ajout de T12:00:00 pour éviter les décalages
        targetDate = new Date(date + "T12:00:00Z");
        logger.info(
          `[UNIFIED-EXPENSES] Date parsée (standard): ${targetDate.toISOString()}`
        );
      }
    } else {
      targetDate = new Date();
    }

    // Vérifier que la date est valide
    if (isNaN(targetDate.getTime())) {
      logger.warn(
        `[UNIFIED-EXPENSES] Date invalide: ${date}, utilisation de la date actuelle`
      );
      targetDate = new Date();
    }

    // Tolérance de date : +/- 3 jours
    const dateMin = new Date(targetDate);
    dateMin.setDate(dateMin.getDate() - 3);
    const dateMax = new Date(targetDate);
    dateMax.setDate(dateMax.getDate() + 3);

    // Tolérance de montant : +/- 1% ou 0.50€ (pour les arrondis)
    const amountTolerance = Math.max(Math.abs(amount) * 0.01, 0.5);
    const amountMin = Math.abs(amount) - amountTolerance;
    const amountMax = Math.abs(amount) + amountTolerance;

    logger.info(`[UNIFIED-EXPENSES] Critères de recherche:`, {
      workspaceId,
      amountRange: { min: amountMin, max: amountMax },
      dateRange: { min: dateMin, max: dateMax },
      vendor,
    });

    // D'abord, vérifions combien de transactions existent pour ce workspace dans cette plage de dates
    // Note: Les transactions Bridge utilisent "processedAt" comme date, pas "date"
    const allTransactionsInRange = await Transaction.find({
      workspaceId,
      processedAt: { $gte: dateMin, $lte: dateMax },
    }).lean();

    logger.info(
      `[UNIFIED-EXPENSES] DEBUG - Toutes les transactions dans la plage de dates: ${allTransactionsInRange.length}`,
      allTransactionsInRange.slice(0, 5).map((t) => ({
        id: t._id,
        amount: t.amount,
        processedAt: t.processedAt,
        desc: t.description,
        type: t.type,
        linkedExpenseId: t.linkedExpenseId,
        hasReceiptFile: !!t.receiptFile,
      }))
    );

    // Chercher aussi les transactions avec un montant similaire (peu importe la date)
    const similarAmountTransactions = await Transaction.find({
      workspaceId,
      amount: { $lte: -amountMin, $gte: -amountMax },
    })
      .limit(5)
      .lean();

    logger.info(
      `[UNIFIED-EXPENSES] DEBUG - Transactions avec montant similaire (~${amount}€): ${similarAmountTransactions.length}`,
      similarAmountTransactions.map((t) => ({
        id: t._id,
        amount: t.amount,
        date: t.date,
        desc: t.description,
      }))
    );

    // Chercher la transaction Bouygues spécifiquement
    const bouyguesTransaction = await Transaction.findOne({
      workspaceId,
      description: { $regex: /bouygues/i },
    }).lean();

    if (bouyguesTransaction) {
      logger.info(`[UNIFIED-EXPENSES] DEBUG - Transaction Bouygues trouvée:`, {
        id: bouyguesTransaction._id,
        amount: bouyguesTransaction.amount,
        date: bouyguesTransaction.date,
        desc: bouyguesTransaction.description,
        type: bouyguesTransaction.type,
        linkedExpenseId: bouyguesTransaction.linkedExpenseId,
        hasReceiptFile: !!bouyguesTransaction.receiptFile,
      });
    } else {
      logger.info(
        `[UNIFIED-EXPENSES] DEBUG - Aucune transaction Bouygues trouvée`
      );
    }

    // Chercher les transactions bancaires correspondantes
    // Note: On cherche les transactions sans justificatif (receiptFile null ou inexistant)
    // Note: Les transactions Bridge utilisent "processedAt" comme date
    // Première recherche : avec la date
    let matchingTransactions = await Transaction.find({
      workspaceId,
      type: "debit",
      $or: [{ linkedExpenseId: null }, { linkedExpenseId: { $exists: false } }],
      $and: [
        {
          $or: [{ receiptFile: { $exists: false } }, { receiptFile: null }],
        },
      ],
      processedAt: { $gte: dateMin, $lte: dateMax },
      amount: { $lte: -amountMin, $gte: -amountMax },
    })
      .sort({ processedAt: -1 })
      .limit(10)
      .lean();

    logger.info(
      `[UNIFIED-EXPENSES] Transactions correspondantes (avec date): ${matchingTransactions.length}`
    );

    // Chercher aussi par vendor si fourni (pour compléter les résultats)
    if (vendor && matchingTransactions.length < 5) {
      const vendorKeywords = vendor
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);
      if (vendorKeywords.length > 0) {
        const vendorRegex = new RegExp(vendorKeywords.join("|"), "i");
        const vendorMatches = await Transaction.find({
          workspaceId,
          type: "debit",
          $or: [
            { linkedExpenseId: null },
            { linkedExpenseId: { $exists: false } },
          ],
          $and: [
            {
              $or: [{ receiptFile: { $exists: false } }, { receiptFile: null }],
            },
          ],
          description: { $regex: vendorRegex },
          amount: { $lte: -amountMin, $gte: -amountMax },
        })
          .sort({ processedAt: -1 })
          .limit(5)
          .lean();

        // Ajouter les nouvelles correspondances (éviter les doublons)
        const existingIds = new Set(
          matchingTransactions.map((t) => t._id.toString())
        );
        for (const tx of vendorMatches) {
          if (!existingIds.has(tx._id.toString())) {
            matchingTransactions.push(tx);
          }
        }

        logger.info(
          `[UNIFIED-EXPENSES] Transactions correspondantes (par vendor "${vendor}"): ${vendorMatches.length} nouvelles`
        );
      }
    }

    // Si toujours aucune correspondance, chercher uniquement par montant (30 derniers jours)
    if (matchingTransactions.length === 0) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      matchingTransactions = await Transaction.find({
        workspaceId,
        type: "debit",
        $or: [
          { linkedExpenseId: null },
          { linkedExpenseId: { $exists: false } },
        ],
        $and: [
          {
            $or: [{ receiptFile: { $exists: false } }, { receiptFile: null }],
          },
        ],
        processedAt: { $gte: thirtyDaysAgo },
        amount: { $lte: -amountMin, $gte: -amountMax },
      })
        .sort({ processedAt: -1 })
        .limit(10)
        .lean();

      logger.info(
        `[UNIFIED-EXPENSES] Transactions correspondantes (sans date, 30j): ${matchingTransactions.length}`,
        matchingTransactions.map((t) => ({
          id: t._id,
          amount: t.amount,
          processedAt: t.processedAt,
          desc: t.description,
        }))
      );
    }

    // Calculer un score de correspondance pour chaque transaction
    const matches = matchingTransactions.map((tx) => {
      let score = 0;

      // Score basé sur la proximité du montant (max 40 points)
      const amountDiff = Math.abs(Math.abs(tx.amount) - Math.abs(amount));
      score += Math.max(0, 40 - amountDiff * 20);

      // Score basé sur la proximité de la date (max 20 points)
      const txDate = tx.processedAt || tx.date;
      if (txDate) {
        const dateDiff =
          Math.abs(new Date(txDate) - targetDate) / (1000 * 60 * 60 * 24);
        score += Math.max(0, 20 - dateDiff * 5);
      }

      // Score basé sur la correspondance du vendor (max 40 points) - PRIORITAIRE
      if (vendor && tx.description) {
        const vendorLower = vendor.toLowerCase().replace(/[^a-z0-9]/g, "");
        const descLower = tx.description
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

        // Correspondance exacte ou partielle
        if (
          descLower.includes(vendorLower) ||
          vendorLower.includes(descLower)
        ) {
          score += 40; // Correspondance forte
        } else {
          // Chercher des mots clés communs (ex: "bouygues" dans les deux)
          const vendorWords = vendor.toLowerCase().split(/\s+/);
          const descWords = tx.description.toLowerCase().split(/\s+/);
          const commonWords = vendorWords.filter(
            (w) =>
              w.length > 3 &&
              descWords.some((d) => d.includes(w) || w.includes(d))
          );
          score += commonWords.length * 15; // 15 points par mot commun
        }
      }

      return {
        id: tx._id.toString(),
        description: tx.description,
        amount: tx.amount,
        date: tx.processedAt || tx.date,
        vendor: extractVendorFromDescription(tx.description),
        score: Math.round(score),
        confidence: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
      };
    });

    // Trier par score décroissant
    matches.sort((a, b) => b.score - a.score);

    // Meilleure correspondance
    const bestMatch =
      matches.length > 0 && matches[0].score >= 40 ? matches[0] : null;

    logger.info(
      `[UNIFIED-EXPENSES] ${matches.length} correspondances trouvées, meilleure: ${bestMatch?.score || 0} points`
    );

    res.json({
      success: true,
      bestMatch,
      allMatches: matches,
      searchCriteria: {
        amount,
        date: targetDate,
        vendor,
        dateRange: { min: dateMin, max: dateMax },
        amountRange: { min: amountMin, max: amountMax },
      },
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur match:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /unified-expenses/auto-reconcile
 * Rapprocher automatiquement un justificatif OCR avec une transaction bancaire
 */
router.post("/auto-reconcile", upload.single("file"), async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const { transactionId, workspaceId, ocrData } = req.body;
    const parsedOcrData =
      typeof ocrData === "string" ? JSON.parse(ocrData) : ocrData;

    if (!req.file) {
      return res.status(400).json({ error: "Fichier requis" });
    }

    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId requis" });
    }

    logger.info(
      `[UNIFIED-EXPENSES] Auto-reconcile pour transaction ${transactionId || "nouvelle"}`
    );

    // Upload du fichier vers Cloudflare
    const uploadResult = await cloudflareService.uploadImage(
      req.file.buffer,
      req.file.originalname,
      user.id,
      "receipt",
      workspaceId
    );

    const receiptFile = {
      url: uploadResult.url,
      key: uploadResult.key,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: user.id,
    };

    // Si un transactionId est fourni, lier directement
    if (transactionId) {
      const transaction = await Transaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({ error: "Transaction non trouvée" });
      }

      await Transaction.findByIdAndUpdate(transactionId, {
        $set: {
          receiptFile,
          receiptRequired: false,
          reconciliationStatus: "matched",
          reconciliationDate: new Date(),
        },
      });

      logger.info(
        `[UNIFIED-EXPENSES] Justificatif lié à la transaction ${transactionId}`
      );

      return res.json({
        success: true,
        action: "linked",
        message: "Justificatif lié à la transaction bancaire",
        transactionId,
        receiptFile,
      });
    }

    // Sinon, chercher une correspondance automatique
    const amount = parsedOcrData?.amount || parsedOcrData?.total;
    const date = parsedOcrData?.date;
    const vendor = parsedOcrData?.vendor || parsedOcrData?.merchant;

    if (amount) {
      // Parser la date (supporter les formats DD/MM/YY, DD/MM/YYYY, YYYY-MM-DD)
      let targetDate;
      if (date) {
        const frenchDateMatch = date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (frenchDateMatch) {
          const day = parseInt(frenchDateMatch[1], 10);
          const month = parseInt(frenchDateMatch[2], 10) - 1;
          let year = parseInt(frenchDateMatch[3], 10);
          if (year < 100) year += 2000;
          targetDate = new Date(year, month, day);
        } else {
          targetDate = new Date(date);
        }
      } else {
        targetDate = new Date();
      }
      if (isNaN(targetDate.getTime())) targetDate = new Date();

      const dateMin = new Date(targetDate);
      dateMin.setDate(dateMin.getDate() - 3);
      const dateMax = new Date(targetDate);
      dateMax.setDate(dateMax.getDate() + 3);

      const amountTolerance = Math.max(Math.abs(amount) * 0.01, 0.5);
      const amountMin = Math.abs(amount) - amountTolerance;
      const amountMax = Math.abs(amount) + amountTolerance;

      logger.info(`[UNIFIED-EXPENSES] Auto-reconcile recherche:`, {
        workspaceId,
        amount,
        amountRange: { min: -amountMax, max: -amountMin },
        dateRange: { min: dateMin, max: dateMax },
      });

      const matchingTransaction = await Transaction.findOne({
        workspaceId,
        type: "debit",
        linkedExpenseId: null,
        $or: [{ receiptFile: { $exists: false } }, { receiptFile: null }],
        processedAt: { $gte: dateMin, $lte: dateMax },
        // Les débits sont négatifs, donc on inverse la comparaison
        amount: { $lte: -amountMin, $gte: -amountMax },
      }).sort({ processedAt: -1 });

      logger.info(
        `[UNIFIED-EXPENSES] Transaction trouvée:`,
        matchingTransaction
          ? {
              id: matchingTransaction._id,
              amount: matchingTransaction.amount,
              date: matchingTransaction.date,
              desc: matchingTransaction.description,
            }
          : "Aucune"
      );

      if (matchingTransaction) {
        // Correspondance trouvée ! Lier automatiquement
        await Transaction.findByIdAndUpdate(matchingTransaction._id, {
          $set: {
            receiptFile,
            receiptRequired: false,
            reconciliationStatus: "matched",
            reconciliationDate: new Date(),
          },
        });

        logger.info(
          `[UNIFIED-EXPENSES] Rapprochement automatique: justificatif lié à ${matchingTransaction._id}`
        );

        return res.json({
          success: true,
          action: "auto-matched",
          message:
            "Justificatif automatiquement lié à une transaction bancaire",
          transactionId: matchingTransaction._id.toString(),
          matchedTransaction: {
            id: matchingTransaction._id.toString(),
            description: matchingTransaction.description,
            amount: matchingTransaction.amount,
            date: matchingTransaction.date,
          },
          receiptFile,
        });
      }
    }

    // Pas de correspondance trouvée, créer une dépense manuelle
    const newExpense = new Expense({
      workspaceId,
      userId: user.id,
      title: parsedOcrData?.vendor || parsedOcrData?.merchant || "Dépense OCR",
      amount: Math.abs(amount) || 0,
      currency: parsedOcrData?.currency || "EUR",
      date: date ? new Date(date) : new Date(),
      category: parsedOcrData?.category || "OTHER",
      vendor: vendor || null,
      status: "PAID",
      paymentMethod: "CARD",
      source: "OCR",
      files: [receiptFile],
      ocrMetadata: parsedOcrData,
      linkedTransactionId: null,
    });

    await newExpense.save();

    logger.info(
      `[UNIFIED-EXPENSES] Nouvelle dépense OCR créée: ${newExpense._id}`
    );

    res.json({
      success: true,
      action: "created",
      message: "Aucune transaction correspondante trouvée. Dépense créée.",
      expenseId: newExpense._id.toString(),
      expense: newExpense,
      receiptFile,
    });
  } catch (error) {
    logger.error("[UNIFIED-EXPENSES] Erreur auto-reconcile:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Extraire le nom du vendeur depuis la description de la transaction
 */
function extractVendorFromDescription(description) {
  if (!description) return null;

  // Nettoyer la description
  let vendor = description
    .replace(/^(CB|CARTE|VIR|VIREMENT|PRLV|PRELEVEMENT)\s*/i, "")
    .replace(/\d{2}\/\d{2}\/\d{2,4}/g, "") // Supprimer les dates
    .replace(/\*+/g, "") // Supprimer les astérisques
    .trim();

  // Prendre les premiers mots significatifs
  const words = vendor.split(/\s+/).slice(0, 3);
  return words.join(" ") || description.substring(0, 30);
}

/**
 * Catégoriser automatiquement une transaction bancaire basée sur sa description
 * Retourne une catégorie compatible avec le modèle Expense
 */
function categorizeTransaction(transaction) {
  // Si déjà catégorisée, retourner la catégorie existante
  if (transaction.expenseCategory) {
    return transaction.expenseCategory;
  }

  // Utiliser le categoryId de Bridge si disponible
  const bridgeCategoryId =
    transaction.metadata?.bridgeCategoryId || transaction.metadata?.category_id;

  // Mapping des catégories Bridge vers les catégories Expense
  const bridgeToCategoryMap = {
    // Alimentation
    270: "MEALS",
    271: "MEALS",
    272: "MEALS",
    // Transport
    280: "TRAVEL",
    281: "TRAVEL",
    282: "TRAVEL",
    283: "TRAVEL",
    284: "TRAVEL",
    // Logement
    290: "RENT",
    291: "RENT",
    292: "UTILITIES",
    293: "INSURANCE",
    // Loisirs
    300: "OTHER",
    301: "OTHER",
    302: "TRAVEL",
    303: "OTHER",
    // Santé
    310: "OTHER",
    311: "OTHER",
    312: "OTHER",
    313: "INSURANCE",
    // Shopping
    320: "OTHER",
    321: "OTHER",
    322: "HARDWARE",
    323: "OFFICE_SUPPLIES",
    // Services
    330: "SERVICES",
    331: "SUBSCRIPTIONS",
    332: "SUBSCRIPTIONS",
    333: "OTHER",
    // Impôts
    340: "TAXES",
    341: "TAXES",
    342: "TAXES",
    // Éducation
    350: "TRAINING",
    351: "TRAINING",
    352: "OFFICE_SUPPLIES",
  };

  if (bridgeCategoryId && bridgeToCategoryMap[bridgeCategoryId]) {
    return bridgeToCategoryMap[bridgeCategoryId];
  }

  // Fallback: catégorisation basée sur la description
  const description = (transaction.description || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^(cb |vir |prlv |cheque |chq |retrait |dab |tip )/i, "")
    .trim();

  // Courses et alimentation
  if (
    description.includes("carrefour") ||
    description.includes("leclerc") ||
    description.includes("auchan") ||
    description.includes("lidl") ||
    description.includes("franprix") ||
    description.includes("monoprix") ||
    description.includes("intermarche") ||
    description.includes("casino") ||
    description.includes("super u") ||
    description.includes("picard") ||
    description.includes("biocoop")
  ) {
    return "MEALS";
  }

  // Restaurants
  if (
    description.includes("restaurant") ||
    description.includes("mcdo") ||
    description.includes("mcdonald") ||
    description.includes("burger") ||
    description.includes("pizza") ||
    description.includes("sushi") ||
    description.includes("kebab") ||
    description.includes("boulangerie") ||
    description.includes("deliveroo") ||
    description.includes("uber eat") ||
    description.includes("just eat")
  ) {
    return "MEALS";
  }

  // Transport
  if (
    description.includes("sncf") ||
    description.includes("ratp") ||
    description.includes("uber") ||
    description.includes("taxi") ||
    description.includes("bolt") ||
    description.includes("blablacar") ||
    description.includes("navigo") ||
    description.includes("velib") ||
    description.includes("lime") ||
    description.includes("total") ||
    description.includes("shell") ||
    description.includes("bp ") ||
    description.includes("esso") ||
    description.includes("station") ||
    description.includes("autoroute") ||
    description.includes("peage") ||
    description.includes("parking")
  ) {
    return "TRAVEL";
  }

  // Logiciels et abonnements
  if (
    description.includes("netflix") ||
    description.includes("spotify") ||
    description.includes("amazon") ||
    description.includes("google") ||
    description.includes("apple") ||
    description.includes("microsoft") ||
    description.includes("adobe") ||
    description.includes("dropbox") ||
    description.includes("slack") ||
    description.includes("notion") ||
    description.includes("figma") ||
    description.includes("github") ||
    description.includes("aws") ||
    description.includes("heroku") ||
    description.includes("vercel") ||
    description.includes("digitalocean")
  ) {
    return "SOFTWARE";
  }

  // Télécom
  if (
    description.includes("orange") ||
    description.includes("sfr") ||
    description.includes("bouygues") ||
    description.includes("free") ||
    description.includes("sosh")
  ) {
    return "SUBSCRIPTIONS";
  }

  // Assurance
  if (
    description.includes("assurance") ||
    description.includes("maif") ||
    description.includes("macif") ||
    description.includes("axa") ||
    description.includes("allianz") ||
    description.includes("groupama")
  ) {
    return "INSURANCE";
  }

  // Loyer et charges
  if (
    description.includes("loyer") ||
    description.includes("edf") ||
    description.includes("engie") ||
    description.includes("veolia") ||
    description.includes("eau ")
  ) {
    return "UTILITIES";
  }

  // Impôts
  if (
    description.includes("impot") ||
    description.includes("dgfip") ||
    description.includes("tresor public") ||
    description.includes("urssaf")
  ) {
    return "TAXES";
  }

  // Par défaut
  return "OTHER";
}

export default router;
