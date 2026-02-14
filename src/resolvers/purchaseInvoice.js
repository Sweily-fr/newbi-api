import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import mongoose from "mongoose";
import cloudflareService from "../services/cloudflareService.js";
import {
  requireRead,
  requireWrite,
  requireDelete,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

const checkAccess = async (id, workspaceId) => {
  const doc = await PurchaseInvoice.findOne({
    _id: id,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
  });
  if (!doc) {
    throw new AppError(
      "Facture d'achat non trouvée",
      ERROR_CODES.NOT_FOUND
    );
  }
  return doc;
};

const resolveWorkspaceId = (inputWorkspaceId, contextWorkspaceId) => {
  if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
    throw new AppError(
      "Organisation invalide.",
      ERROR_CODES.FORBIDDEN
    );
  }
  return inputWorkspaceId || contextWorkspaceId;
};

const purchaseInvoiceResolvers = {
  Query: {
    purchaseInvoice: requireRead("expenses")(
      async (_, { id }, context) => {
        const workspaceId = resolveWorkspaceId(null, context.workspaceId);
        return await checkAccess(id, workspaceId);
      }
    ),

    purchaseInvoices: requireRead("expenses")(
      async (_, args, context) => {
        const workspaceId = resolveWorkspaceId(args.workspaceId, context.workspaceId);
        const {
          page = 1, limit = 20, search, status, category, supplierId,
          startDate, endDate, dueDateStart, dueDateEnd,
          minAmount, maxAmount, hasFile,
          sortField = "issueDate", sortOrder = "DESC",
        } = args;

        const query = { workspaceId: new mongoose.Types.ObjectId(workspaceId) };

        if (status) query.status = status;
        if (category) query.category = category;
        if (supplierId) query.supplierId = new mongoose.Types.ObjectId(supplierId);

        if (startDate || endDate) {
          query.issueDate = {};
          if (startDate) query.issueDate.$gte = new Date(startDate);
          if (endDate) query.issueDate.$lte = new Date(endDate);
        }

        if (dueDateStart || dueDateEnd) {
          query.dueDate = {};
          if (dueDateStart) query.dueDate.$gte = new Date(dueDateStart);
          if (dueDateEnd) query.dueDate.$lte = new Date(dueDateEnd);
        }

        if (minAmount !== undefined || maxAmount !== undefined) {
          query.amountTTC = {};
          if (minAmount !== undefined) query.amountTTC.$gte = minAmount;
          if (maxAmount !== undefined) query.amountTTC.$lte = maxAmount;
        }

        if (hasFile === true) {
          query["files.0"] = { $exists: true };
        } else if (hasFile === false) {
          query.files = { $size: 0 };
        }

        if (search) {
          query.$or = [
            { supplierName: { $regex: search, $options: "i" } },
            { invoiceNumber: { $regex: search, $options: "i" } },
          ];
          const numSearch = parseFloat(search);
          if (!isNaN(numSearch)) {
            query.$or.push({ amountTTC: numSearch });
          }
        }

        const sort = {};
        sort[sortField] = sortOrder === "ASC" ? 1 : -1;

        const skip = (page - 1) * limit;
        const [items, totalCount] = await Promise.all([
          PurchaseInvoice.find(query).sort(sort).skip(skip).limit(limit).lean(),
          PurchaseInvoice.countDocuments(query),
        ]);

        return {
          items,
          totalCount,
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit) || 1,
          hasNextPage: page * limit < totalCount,
        };
      }
    ),

    purchaseInvoiceStats: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
        const wId = new mongoose.Types.ObjectId(workspaceId);

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

        const [toPay, overdue, paidThisMonth, totalThisMonth] = await Promise.all([
          PurchaseInvoice.aggregate([
            { $match: { workspaceId: wId, status: { $in: ["TO_PAY", "OVERDUE"] } } },
            { $group: { _id: null, total: { $sum: "$amountTTC" }, count: { $sum: 1 } } },
          ]),
          PurchaseInvoice.aggregate([
            { $match: { workspaceId: wId, status: "OVERDUE" } },
            { $group: { _id: null, total: { $sum: "$amountTTC" }, count: { $sum: 1 } } },
          ]),
          PurchaseInvoice.aggregate([
            {
              $match: {
                workspaceId: wId,
                status: "PAID",
                paymentDate: { $gte: startOfMonth, $lte: endOfMonth },
              },
            },
            { $group: { _id: null, total: { $sum: "$amountTTC" }, count: { $sum: 1 } } },
          ]),
          PurchaseInvoice.aggregate([
            {
              $match: {
                workspaceId: wId,
                issueDate: { $gte: startOfMonth, $lte: endOfMonth },
              },
            },
            { $group: { _id: null, total: { $sum: "$amountTTC" }, count: { $sum: 1 } } },
          ]),
        ]);

        return {
          totalToPay: toPay[0]?.total || 0,
          totalToPayCount: toPay[0]?.count || 0,
          totalOverdue: overdue[0]?.total || 0,
          totalOverdueCount: overdue[0]?.count || 0,
          paidThisMonth: paidThisMonth[0]?.total || 0,
          paidThisMonthCount: paidThisMonth[0]?.count || 0,
          totalThisMonth: totalThisMonth[0]?.total || 0,
          totalThisMonthCount: totalThisMonth[0]?.count || 0,
        };
      }
    ),

    purchaseInvoiceReconciliationMatches: requireRead("expenses")(
      async (_, { purchaseInvoiceId }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(purchaseInvoiceId, workspaceId);

        // Import Transaction model dynamically to avoid circular deps
        const Transaction = mongoose.model("Transaction");

        const amountRange = 0.05;
        const dateRange = 15 * 24 * 60 * 60 * 1000; // 15 days

        const query = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          amount: {
            $gte: -(invoice.amountTTC * (1 + amountRange)),
            $lte: -(invoice.amountTTC * (1 - amountRange)),
          },
          reconciliationStatus: { $ne: "matched" },
        };

        if (invoice.issueDate) {
          const refDate = invoice.dueDate || invoice.issueDate;
          query.date = {
            $gte: new Date(refDate.getTime() - dateRange),
            $lte: new Date(refDate.getTime() + dateRange),
          };
        }

        const transactions = await Transaction.find(query)
          .sort({ date: -1 })
          .limit(10)
          .lean();

        return transactions.map((t) => {
          let confidence = 0.5;
          const amountDiff = Math.abs(Math.abs(t.amount) - invoice.amountTTC) / invoice.amountTTC;
          if (amountDiff < 0.001) confidence += 0.3;
          else if (amountDiff < 0.02) confidence += 0.2;

          if (t.description && invoice.supplierName) {
            const desc = t.description.toLowerCase();
            const name = invoice.supplierName.toLowerCase();
            if (desc.includes(name) || name.includes(desc)) confidence += 0.2;
          }

          return {
            transactionId: t._id.toString(),
            amount: Math.abs(t.amount),
            date: t.date?.toISOString(),
            description: t.description,
            confidence: Math.min(confidence, 1),
          };
        });
      }
    ),

    supplier: requireRead("expenses")(
      async (_, { id }, context) => {
        const supplier = await Supplier.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(context.workspaceId),
        });
        if (!supplier) throw new AppError("Fournisseur non trouvé", ERROR_CODES.NOT_FOUND);
        return supplier;
      }
    ),

    suppliers: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId, page = 1, limit = 50, search }, context) => {
        const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
        const query = { workspaceId: new mongoose.Types.ObjectId(workspaceId) };

        if (search) {
          query.name = { $regex: search, $options: "i" };
        }

        const skip = (page - 1) * limit;
        const [items, totalCount] = await Promise.all([
          Supplier.find(query).sort({ name: 1 }).skip(skip).limit(limit).lean(),
          Supplier.countDocuments(query),
        ]);

        return {
          items,
          totalCount,
          currentPage: page,
          totalPages: Math.ceil(totalCount / limit) || 1,
        };
      }
    ),
  },

  Mutation: {
    createPurchaseInvoice: requireWrite("expenses")(
      async (_, { input }, context) => {
        const workspaceId = resolveWorkspaceId(input.workspaceId, context.workspaceId);

        const invoice = new PurchaseInvoice({
          ...input,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          createdBy: context.user.id,
        });

        // Auto-create supplier if not linked
        if (!input.supplierId && input.supplierName) {
          let supplier = await Supplier.findOne({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            name: { $regex: `^${input.supplierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: "i" },
          });

          if (!supplier) {
            supplier = await Supplier.create({
              name: input.supplierName,
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              createdBy: context.user.id,
              defaultCategory: input.category || "OTHER",
            });
          }
          invoice.supplierId = supplier._id;
        }

        await invoice.save();
        return invoice;
      }
    ),

    updatePurchaseInvoice: requireWrite("expenses")(
      async (_, { id, input }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(id, workspaceId);

        Object.keys(input).forEach((key) => {
          if (input[key] !== undefined) {
            invoice[key] = input[key];
          }
        });

        // Auto-detect overdue
        if (invoice.dueDate && new Date(invoice.dueDate) < new Date() && invoice.status === "TO_PAY") {
          invoice.status = "OVERDUE";
        }

        await invoice.save();
        return invoice;
      }
    ),

    deletePurchaseInvoice: requireDelete("expenses")(
      async (_, { id }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(id, workspaceId);

        // Delete files from Cloudflare
        for (const file of invoice.files || []) {
          try {
            if (file.url && file.url.includes("r2.dev")) {
              const urlParts = file.url.split("/");
              const key = urlParts.slice(3).join("/");
              await cloudflareService.deleteImage(key);
            }
          } catch (err) {
            console.warn("⚠️ Impossible de supprimer le fichier:", err.message);
          }
        }

        await PurchaseInvoice.deleteOne({ _id: id });
        return { success: true, message: "Facture d'achat supprimée" };
      }
    ),

    addPurchaseInvoiceFile: requireWrite("expenses")(
      async (_, { purchaseInvoiceId, input }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(purchaseInvoiceId, workspaceId);

        let fileData;

        if (input.cloudflareUrl) {
          // File already uploaded to Cloudflare
          fileData = {
            filename: input.fileName || "document",
            originalFilename: input.fileName || "document",
            mimetype: input.mimeType || "application/pdf",
            path: input.cloudflareUrl,
            size: input.fileSize || 0,
            url: input.cloudflareUrl,
            ocrProcessed: !!input.ocrData,
            ocrData: input.ocrData || null,
          };
        } else if (input.file) {
          // Upload file to Cloudflare
          const { createReadStream, filename, mimetype } = await input.file;
          const stream = createReadStream();
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);

          const uniqueFilename = `purchase-invoices/${workspaceId}/${Date.now()}-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
          const uploadResult = await cloudflareService.uploadImage(buffer, uniqueFilename, mimetype);

          fileData = {
            filename: uniqueFilename,
            originalFilename: filename,
            mimetype,
            path: uploadResult.key || uniqueFilename,
            size: buffer.length,
            url: uploadResult.url,
            ocrProcessed: false,
            ocrData: null,
          };
        } else {
          throw new AppError("Aucun fichier fourni", ERROR_CODES.VALIDATION_ERROR);
        }

        invoice.files.push(fileData);

        // Apply OCR data if provided
        if (input.ocrData) {
          const ocr = typeof input.ocrData === "string" ? JSON.parse(input.ocrData) : input.ocrData;
          if (ocr.supplierName) invoice.ocrMetadata.supplierName = ocr.supplierName;
          if (ocr.invoiceNumber) invoice.ocrMetadata.invoiceNumber = ocr.invoiceNumber;
          if (ocr.invoiceDate) invoice.ocrMetadata.invoiceDate = new Date(ocr.invoiceDate);
          if (ocr.dueDate) invoice.ocrMetadata.dueDate = new Date(ocr.dueDate);
          if (ocr.amountHT) invoice.ocrMetadata.amountHT = ocr.amountHT;
          if (ocr.amountTVA) invoice.ocrMetadata.amountTVA = ocr.amountTVA;
          if (ocr.vatRate) invoice.ocrMetadata.vatRate = ocr.vatRate;
          if (ocr.amountTTC) invoice.ocrMetadata.amountTTC = ocr.amountTTC;
          if (ocr.iban) invoice.ocrMetadata.iban = ocr.iban;
          if (ocr.bic) invoice.ocrMetadata.bic = ocr.bic;
          if (ocr.confidenceScore) invoice.ocrMetadata.confidenceScore = ocr.confidenceScore;
        }

        await invoice.save();
        return invoice;
      }
    ),

    removePurchaseInvoiceFile: requireWrite("expenses")(
      async (_, { purchaseInvoiceId, fileId }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(purchaseInvoiceId, workspaceId);

        const file = invoice.files.id(fileId);
        if (!file) throw new AppError("Fichier non trouvé", ERROR_CODES.NOT_FOUND);

        // Delete from Cloudflare
        try {
          if (file.url && file.url.includes("r2.dev")) {
            const urlParts = file.url.split("/");
            const key = urlParts.slice(3).join("/");
            await cloudflareService.deleteImage(key);
          }
        } catch (err) {
          console.warn("⚠️ Impossible de supprimer le fichier:", err.message);
        }

        invoice.files.pull(fileId);
        await invoice.save();
        return invoice;
      }
    ),

    markPurchaseInvoiceAsPaid: requireWrite("expenses")(
      async (_, { id, paymentDate, paymentMethod }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(id, workspaceId);

        invoice.status = "PAID";
        invoice.paymentDate = paymentDate ? new Date(paymentDate) : new Date();
        if (paymentMethod) invoice.paymentMethod = paymentMethod;

        await invoice.save();
        return invoice;
      }
    ),

    bulkUpdatePurchaseInvoiceStatus: requireWrite("expenses")(
      async (_, { ids, status }, context) => {
        const workspaceId = new mongoose.Types.ObjectId(context.workspaceId);
        const updateData = { status };
        if (status === "PAID") {
          updateData.paymentDate = new Date();
        }

        const result = await PurchaseInvoice.updateMany(
          { _id: { $in: ids }, workspaceId },
          { $set: updateData }
        );

        return {
          success: true,
          updatedCount: result.modifiedCount,
          message: `${result.modifiedCount} facture(s) mise(s) à jour`,
        };
      }
    ),

    bulkDeletePurchaseInvoices: requireDelete("expenses")(
      async (_, { ids }, context) => {
        const workspaceId = new mongoose.Types.ObjectId(context.workspaceId);

        const invoices = await PurchaseInvoice.find({ _id: { $in: ids }, workspaceId });

        // Delete files
        for (const inv of invoices) {
          for (const file of inv.files || []) {
            try {
              if (file.url && file.url.includes("r2.dev")) {
                const urlParts = file.url.split("/");
                const key = urlParts.slice(3).join("/");
                await cloudflareService.deleteImage(key);
              }
            } catch (err) {
              console.warn("⚠️ Erreur suppression fichier:", err.message);
            }
          }
        }

        const result = await PurchaseInvoice.deleteMany({ _id: { $in: ids }, workspaceId });

        return {
          success: true,
          updatedCount: result.deletedCount,
          message: `${result.deletedCount} facture(s) supprimée(s)`,
        };
      }
    ),

    bulkCategorizePurchaseInvoices: requireWrite("expenses")(
      async (_, { ids, category }, context) => {
        const workspaceId = new mongoose.Types.ObjectId(context.workspaceId);

        const result = await PurchaseInvoice.updateMany(
          { _id: { $in: ids }, workspaceId },
          { $set: { category } }
        );

        return {
          success: true,
          updatedCount: result.modifiedCount,
          message: `${result.modifiedCount} facture(s) catégorisée(s)`,
        };
      }
    ),

    reconcilePurchaseInvoice: requireWrite("expenses")(
      async (_, { purchaseInvoiceId, transactionIds }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(purchaseInvoiceId, workspaceId);

        const Transaction = mongoose.model("Transaction");

        // Verify transactions belong to workspace
        const txCount = await Transaction.countDocuments({
          _id: { $in: transactionIds },
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (txCount !== transactionIds.length) {
          throw new AppError("Certaines transactions sont introuvables", ERROR_CODES.NOT_FOUND);
        }

        invoice.linkedTransactionIds = transactionIds.map(
          (id) => new mongoose.Types.ObjectId(id)
        );
        invoice.isReconciled = true;
        invoice.status = "PAID";
        invoice.paymentDate = invoice.paymentDate || new Date();

        // Mark transactions as matched
        await Transaction.updateMany(
          { _id: { $in: transactionIds } },
          { $set: { reconciliationStatus: "matched" } }
        );

        await invoice.save();
        return invoice;
      }
    ),

    unreconcilePurchaseInvoice: requireWrite("expenses")(
      async (_, { purchaseInvoiceId }, context) => {
        const workspaceId = context.workspaceId;
        const invoice = await checkAccess(purchaseInvoiceId, workspaceId);

        if (invoice.linkedTransactionIds?.length) {
          const Transaction = mongoose.model("Transaction");
          await Transaction.updateMany(
            { _id: { $in: invoice.linkedTransactionIds } },
            { $set: { reconciliationStatus: "unmatched" } }
          );
        }

        invoice.linkedTransactionIds = [];
        invoice.isReconciled = false;

        await invoice.save();
        return invoice;
      }
    ),

    createSupplier: requireWrite("expenses")(
      async (_, { input }, context) => {
        const workspaceId = resolveWorkspaceId(input.workspaceId, context.workspaceId);

        const supplier = new Supplier({
          name: input.name,
          email: input.email,
          phone: input.phone,
          siret: input.siret,
          vatNumber: input.vatNumber,
          address: {
            street: input.street,
            city: input.city,
            postalCode: input.postalCode,
            country: input.country,
          },
          iban: input.iban,
          bic: input.bic,
          defaultCategory: input.defaultCategory,
          notes: input.notes,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          createdBy: context.user.id,
        });

        await supplier.save();
        return supplier;
      }
    ),

    updateSupplier: requireWrite("expenses")(
      async (_, { id, input }, context) => {
        const supplier = await Supplier.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(context.workspaceId),
        });
        if (!supplier) throw new AppError("Fournisseur non trouvé", ERROR_CODES.NOT_FOUND);

        Object.keys(input).forEach((key) => {
          if (["street", "city", "postalCode", "country"].includes(key)) {
            if (!supplier.address) supplier.address = {};
            supplier.address[key] = input[key];
          } else if (input[key] !== undefined) {
            supplier[key] = input[key];
          }
        });

        await supplier.save();
        return supplier;
      }
    ),

    deleteSupplier: requireDelete("expenses")(
      async (_, { id }, context) => {
        const supplier = await Supplier.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(context.workspaceId),
        });
        if (!supplier) throw new AppError("Fournisseur non trouvé", ERROR_CODES.NOT_FOUND);

        await Supplier.deleteOne({ _id: id });
        return { success: true, message: "Fournisseur supprimé" };
      }
    ),

    mergeSuppliers: requireWrite("expenses")(
      async (_, { targetId, sourceIds }, context) => {
        const workspaceId = new mongoose.Types.ObjectId(context.workspaceId);

        const target = await Supplier.findOne({ _id: targetId, workspaceId });
        if (!target) throw new AppError("Fournisseur cible non trouvé", ERROR_CODES.NOT_FOUND);

        // Update all purchase invoices to point to target
        await PurchaseInvoice.updateMany(
          { supplierId: { $in: sourceIds }, workspaceId },
          { $set: { supplierId: targetId, supplierName: target.name } }
        );

        // Delete source suppliers
        await Supplier.deleteMany({ _id: { $in: sourceIds }, workspaceId });

        return target;
      }
    ),
  },

  PurchaseInvoiceFile: {
    id: (parent) => parent._id?.toString() || parent.id,
  },

  PurchaseInvoice: {
    id: (parent) => parent._id?.toString() || parent.id,
    supplier: async (parent) => {
      if (!parent.supplierId) return null;
      return await Supplier.findById(parent.supplierId).lean();
    },
    createdBy: async (parent) => {
      const User = mongoose.model("User");
      return await User.findById(parent.createdBy).lean();
    },
  },

  Supplier: {
    id: (parent) => parent._id?.toString() || parent.id,
    invoiceCount: async (parent) => {
      return await PurchaseInvoice.countDocuments({ supplierId: parent._id });
    },
    totalAmount: async (parent) => {
      const result = await PurchaseInvoice.aggregate([
        { $match: { supplierId: parent._id } },
        { $group: { _id: null, total: { $sum: "$amountTTC" } } },
      ]);
      return result[0]?.total || 0;
    },
  },
};

export default purchaseInvoiceResolvers;
