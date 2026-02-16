import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Quote from "../models/Quote.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import { requireWrite, requireRead, requireDelete } from "../middlewares/rbac.js";
import {
  generatePurchaseOrderNumber,
  generateInvoiceNumber,
} from "../utils/documentNumbers.js";
import {
  createNotFoundError,
  createResourceLockedError,
  createStatusTransitionError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import { requireCompanyInfo, getOrganizationInfo } from "../middlewares/company-info-guard.js";

// Fonction utilitaire pour calculer les totaux
const calculatePurchaseOrderTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  shipping = null
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

    if (item.discount) {
      if (item.discountType === "PERCENTAGE" || item.discountType === "percentage") {
        const discountPercent = Math.min(item.discount, 100);
        itemHT = itemHT * (1 - discountPercent / 100);
      } else {
        itemHT = Math.max(0, itemHT - item.discount);
      }
    }

    const itemVAT = itemHT * (item.vatRate / 100);
    totalHT += itemHT;
    totalVAT += itemVAT;
  });

  if (shipping && shipping.billShipping) {
    const shippingHT = shipping.shippingAmountHT || 0;
    const shippingVAT = shippingHT * (shipping.shippingVatRate / 100);
    totalHT += shippingHT;
    totalVAT += shippingVAT;
  }

  const totalTTC = totalHT + totalVAT;

  let discountAmount = 0;
  if (discount) {
    if (discountType === "PERCENTAGE" || discountType === "percentage") {
      const discountPercent = Math.min(discount, 100);
      discountAmount = (totalHT * discountPercent) / 100;
    } else {
      discountAmount = discount;
    }
  }

  const finalTotalHT = totalHT - discountAmount;

  let finalTotalVAT = 0;
  if (finalTotalHT > 0 && totalHT > 0) {
    finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
  }
  const finalTotalTTC = finalTotalHT + finalTotalVAT;

  return {
    totalHT,
    totalVAT,
    totalTTC,
    finalTotalHT,
    finalTotalVAT,
    finalTotalTTC,
    discountAmount,
  };
};

const purchaseOrderResolvers = {
  PurchaseOrder: {
    createdBy: async (po) => {
      return await User.findById(po.createdBy);
    },
    sourceQuote: async (po) => {
      if (!po.sourceQuoteId) return null;
      return await Quote.findById(po.sourceQuoteId);
    },
    linkedInvoices: async (po) => {
      if (po.linkedInvoices && po.linkedInvoices.length > 0) {
        return await Invoice.find({ _id: { $in: po.linkedInvoices } });
      }
      return [];
    },
  },

  Query: {
    purchaseOrder: requireRead("purchaseOrders")(async (_, { workspaceId, id }, context) => {
      const po = await PurchaseOrder.findOne({ _id: id, workspaceId })
        .populate("createdBy");

      if (!po) throw createNotFoundError("Bon de commande");
      return po;
    }),

    purchaseOrders: requireRead("purchaseOrders")(
      async (
        _,
        { workspaceId, startDate, endDate, status, search, page = 1, limit = 10 },
        { user }
      ) => {
        const query = { workspaceId };

        if (startDate || endDate) {
          query.createdAt = {};
          if (startDate) query.createdAt.$gte = new Date(startDate);
          if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        if (status) query.status = status;

        if (search) {
          const searchRegex = new RegExp(search, "i");
          query.$or = [
            { number: searchRegex },
            { "client.name": searchRegex },
            { "client.email": searchRegex },
          ];
        }

        const skip = (page - 1) * limit;
        const totalCount = await PurchaseOrder.countDocuments(query);

        const purchaseOrders = await PurchaseOrder.find(query)
          .populate("createdBy")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        return {
          purchaseOrders,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      }
    ),

    purchaseOrderStats: requireRead("purchaseOrders")(async (_, { workspaceId }, context) => {
      const [stats] = await PurchaseOrder.aggregate([
        { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId) } },
        {
          $group: {
            _id: null,
            totalCount: { $sum: 1 },
            draftCount: {
              $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] },
            },
            confirmedCount: {
              $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] },
            },
            inProgressCount: {
              $sum: { $cond: [{ $eq: ["$status", "IN_PROGRESS"] }, 1, 0] },
            },
            deliveredCount: {
              $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, 1, 0] },
            },
            canceledCount: {
              $sum: { $cond: [{ $eq: ["$status", "CANCELED"] }, 1, 0] },
            },
            totalAmount: { $sum: "$finalTotalTTC" },
          },
        },
        {
          $project: {
            _id: 0,
            totalCount: 1,
            draftCount: 1,
            confirmedCount: 1,
            inProgressCount: 1,
            deliveredCount: 1,
            canceledCount: 1,
            totalAmount: 1,
          },
        },
      ]);

      const defaultStats = {
        totalCount: 0,
        draftCount: 0,
        confirmedCount: 0,
        inProgressCount: 0,
        deliveredCount: 0,
        canceledCount: 0,
        totalAmount: 0,
      };

      if (stats) {
        Object.keys(defaultStats).forEach((key) => {
          if (stats[key] === null || stats[key] === undefined) {
            stats[key] = 0;
          }
        });
        return stats;
      }

      return defaultStats;
    }),

    nextPurchaseOrderNumber: requireRead("purchaseOrders")(
      async (_, { workspaceId, prefix }, { user }) => {
        return await generatePurchaseOrderNumber(prefix, {
          userId: user.id,
          workspaceId,
        });
      }
    ),
  },

  Mutation: {
    createPurchaseOrder: requireCompanyInfo(
      requireWrite("purchaseOrders")(
        async (_, { workspaceId: inputWorkspaceId, input }, context) => {
          const { user, workspaceId: contextWorkspaceId } = context;

          if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
            throw new AppError(
              "Organisation invalide. Vous n'avez pas accès à cette organisation.",
              ERROR_CODES.FORBIDDEN
            );
          }
          const workspaceId = inputWorkspaceId || contextWorkspaceId;

          if (!workspaceId) {
            throw new AppError(
              "Aucune organisation spécifiée.",
              ERROR_CODES.BAD_REQUEST
            );
          }

          // Déterminer le préfixe
          let prefix = input.prefix;
          if (!prefix) {
            const lastPO = await PurchaseOrder.findOne({ workspaceId })
              .sort({ createdAt: -1 })
              .select('prefix')
              .lean();

            if (lastPO && lastPO.prefix) {
              prefix = lastPO.prefix;
            } else {
              const now = new Date();
              const year = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, '0');
              prefix = `BC-${year}${month}`;
            }
          }

          // Générer le numéro
          let number;
          if (input.status === "DRAFT") {
            number = await generatePurchaseOrderNumber(prefix, {
              isDraft: true,
              workspaceId,
              userId: user.id,
            });
          } else {
            number = await generatePurchaseOrderNumber(prefix, {
              workspaceId,
              userId: user.id,
            });
          }

          // Récupérer les informations de l'organisation
          const organization = await getOrganizationInfo(workspaceId);

          if (!organization?.companyName) {
            throw new AppError(
              "Les informations de votre entreprise doivent être configurées avant de créer un bon de commande",
              ERROR_CODES.COMPANY_INFO_REQUIRED
            );
          }

          // Calculer les totaux
          const totals = calculatePurchaseOrderTotals(
            input.items,
            input.discount,
            input.discountType,
            input.shipping
          );

          const clientData = input.client;
          if (
            clientData.type === "INDIVIDUAL" &&
            (!clientData.name || clientData.name.trim() === "")
          ) {
            if (clientData.firstName && clientData.lastName) {
              clientData.name = `${clientData.firstName} ${clientData.lastName}`;
            } else {
              clientData.name = clientData.email
                ? `Client ${clientData.email}`
                : "Client Particulier";
            }
          }

          const purchaseOrder = new PurchaseOrder({
            ...input,
            number,
            prefix,
            workspaceId,
            companyInfo: input.companyInfo || {
              name: organization.companyName || "",
              email: organization.companyEmail || "",
              phone: organization.companyPhone || "",
              website: organization.website || "",
              address: {
                street: organization.addressStreet || "",
                city: organization.addressCity || "",
                postalCode: organization.addressZipCode || "",
                country: organization.addressCountry || "France",
              },
              siret: organization.siret || "",
              vatNumber: organization.vatNumber || "",
              companyStatus: organization.legalForm || "AUTRE",
              logo: organization.logo || "",
              ...(organization.bankIban && organization.bankBic && organization.bankName
                ? {
                    bankDetails: {
                      iban: organization.bankIban,
                      bic: organization.bankBic,
                      bankName: organization.bankName,
                    },
                  }
                : {}),
              transactionCategory: organization.activityCategory,
              vatPaymentCondition: organization.fiscalRegime,
              capitalSocial: organization.capitalSocial,
              rcs: organization.rcs,
            },
            client: {
              ...input.client,
              shippingAddress: input.client.hasDifferentShippingAddress
                ? {
                    fullName: input.client.shippingAddress?.fullName || "",
                    street: input.client.shippingAddress?.street || "",
                    city: input.client.shippingAddress?.city || "",
                    postalCode: input.client.shippingAddress?.postalCode || "",
                    country: input.client.shippingAddress?.country || "",
                  }
                : undefined,
            },
            appearance: input.appearance || {
              textColor: "#000000",
              headerTextColor: "#ffffff",
              headerBgColor: "#1d1d1b",
            },
            createdBy: user.id,
            ...totals,
          });

          await purchaseOrder.save();
          return await purchaseOrder.populate("createdBy");
        }
      )
    ),

    updatePurchaseOrder: requireCompanyInfo(
      requireWrite("purchaseOrders")(async (_, { id, workspaceId: inputWorkspaceId, input }, context) => {
        const { user, workspaceId } = context;
        const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

        if (!po) {
          throw createNotFoundError("Bon de commande");
        }

        if (po.status === "DELIVERED") {
          throw createResourceLockedError(
            "Bon de commande",
            "un bon de commande livré ne peut pas être modifié"
          );
        }

        // Si des items sont fournis, recalculer les totaux
        if (input.items) {
          const totals = calculatePurchaseOrderTotals(
            input.items,
            input.discount !== undefined ? input.discount : po.discount,
            input.discountType || po.discountType,
            input.shipping !== undefined ? input.shipping : po.shipping
          );
          input = { ...input, ...totals };
        }

        let updateData = { ...input };

        if (!updateData.companyInfo) {
          delete updateData.companyInfo;
        }

        Object.assign(po, updateData);
        await po.save();
        return await po.populate("createdBy");
      })
    ),

    deletePurchaseOrder: requireCompanyInfo(
      requireDelete("purchaseOrders")(async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

        if (!po) {
          throw createNotFoundError("Bon de commande");
        }

        if (po.status === "DELIVERED") {
          throw createResourceLockedError(
            "Bon de commande",
            "un bon de commande livré ne peut pas être supprimé"
          );
        }

        if (po.linkedInvoices && po.linkedInvoices.length > 0) {
          throw createResourceLockedError(
            "Bon de commande",
            "un bon de commande avec des factures liées ne peut pas être supprimé"
          );
        }

        await PurchaseOrder.deleteOne({ _id: id, workspaceId });
        return true;
      })
    ),

    changePurchaseOrderStatus: requireCompanyInfo(
      requireWrite("purchaseOrders")(async (_, { id, workspaceId: inputWorkspaceId, status }, context) => {
        const { user, workspaceId } = context;
        const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

        if (!po) {
          throw createNotFoundError("Bon de commande");
        }

        const allowedTransitions = {
          DRAFT: ["CONFIRMED"],
          CONFIRMED: ["IN_PROGRESS", "CANCELED"],
          IN_PROGRESS: ["DELIVERED", "CANCELED"],
          DELIVERED: [],
          CANCELED: [],
        };

        if (!allowedTransitions[po.status]?.includes(status)) {
          throw createStatusTransitionError("Bon de commande", po.status, status);
        }

        // Si transition DRAFT → CONFIRMED, générer un numéro séquentiel
        if (po.status === "DRAFT" && status === "CONFIRMED") {
          let prefix = po.prefix;
          if (!prefix) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            prefix = `BC-${year}${month}`;
          }

          const newNumber = await generatePurchaseOrderNumber(prefix, {
            workspaceId: po.workspaceId,
            userId: user.id,
          });

          // Utiliser un numéro temporaire pour éviter les conflits d'unicité
          const tempNumber = `TEMP-${Date.now()}`;
          po.number = tempNumber;
          await po.save();

          po.number = newNumber;
          po.prefix = prefix;
        }

        po.status = status;
        await po.save();
        return await po.populate("createdBy");
      })
    ),

    convertQuoteToPurchaseOrder: requireWrite("purchaseOrders")(
      async (_, { quoteId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const quote = await Quote.findOne({ _id: quoteId, workspaceId });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        if (quote.status !== "COMPLETED") {
          throw new AppError(
            "Seuls les devis acceptés peuvent être convertis en bon de commande",
            ERROR_CODES.RESOURCE_LOCKED
          );
        }

        const organization = await getOrganizationInfo(workspaceId);

        // Générer le préfixe et le numéro
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const prefix = `BC-${year}${month}`;

        const number = await generatePurchaseOrderNumber(prefix, {
          isDraft: true,
          workspaceId,
          userId: user.id,
        });

        const purchaseOrder = new PurchaseOrder({
          number,
          prefix,
          client: quote.client,
          companyInfo: quote.companyInfo,
          items: quote.items,
          status: "DRAFT",
          issueDate: new Date(),
          validUntil: quote.validUntil || null,
          headerNotes: quote.headerNotes,
          footerNotes: quote.footerNotes,
          termsAndConditions: quote.termsAndConditions,
          termsAndConditionsLinkTitle: quote.termsAndConditionsLinkTitle,
          termsAndConditionsLink: quote.termsAndConditionsLink,
          discount: quote.discount,
          discountType: quote.discountType,
          customFields: quote.customFields,
          totalHT: quote.totalHT,
          totalVAT: quote.totalVAT,
          totalTTC: quote.totalTTC,
          finalTotalHT: quote.finalTotalHT,
          finalTotalVAT: quote.finalTotalVAT,
          finalTotalTTC: quote.finalTotalTTC,
          discountAmount: quote.discountAmount,
          workspaceId,
          createdBy: user.id,
          sourceQuoteId: quote._id,
          appearance: quote.appearance,
          shipping: quote.shipping,
          isReverseCharge: quote.isReverseCharge || false,
          clientPositionRight: quote.clientPositionRight || false,
          showBankDetails: quote.showBankDetails || false,
          retenueGarantie: quote.retenueGarantie || 0,
          escompte: quote.escompte || 0,
        });

        await purchaseOrder.save();
        return await purchaseOrder.populate("createdBy");
      }
    ),

    convertPurchaseOrderToInvoice: requireWrite("purchaseOrders")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

        if (!po) {
          throw createNotFoundError("Bon de commande");
        }

        if (!["CONFIRMED", "IN_PROGRESS", "DELIVERED"].includes(po.status)) {
          throw new AppError(
            "Seuls les bons de commande confirmés, en cours ou livrés peuvent être convertis en facture",
            ERROR_CODES.RESOURCE_LOCKED
          );
        }

        const organization = await getOrganizationInfo(workspaceId);

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const invoicePrefix = `F-${year}${month}`;

        const invoiceNumber = await generateInvoiceNumber(invoicePrefix, {
          isDraft: true,
          workspaceId,
          userId: user.id,
        });

        const invoice = new Invoice({
          number: invoiceNumber,
          prefix: invoicePrefix,
          client: po.client,
          companyInfo: po.companyInfo,
          items: po.items,
          status: "DRAFT",
          issueDate: new Date(),
          dueDate: new Date(new Date().setDate(new Date().getDate() + 30)),
          headerNotes: po.headerNotes,
          footerNotes: po.footerNotes,
          termsAndConditions: po.termsAndConditions,
          termsAndConditionsLinkTitle: po.termsAndConditionsLinkTitle,
          termsAndConditionsLink: po.termsAndConditionsLink,
          purchaseOrderNumber: `${po.prefix}${po.number}`,
          discount: po.discount,
          discountType: po.discountType,
          customFields: po.customFields,
          totalHT: po.totalHT,
          totalVAT: po.totalVAT,
          totalTTC: po.totalTTC,
          finalTotalHT: po.finalTotalHT,
          finalTotalVAT: po.finalTotalVAT,
          finalTotalTTC: po.finalTotalTTC,
          discountAmount: po.discountAmount,
          workspaceId,
          createdBy: user.id,
          isReverseCharge: po.isReverseCharge || false,
        });

        await invoice.save();

        // Lier la facture au bon de commande
        if (!po.linkedInvoices) {
          po.linkedInvoices = [];
        }
        po.linkedInvoices.push(invoice._id);
        await po.save();

        return await invoice.populate("createdBy");
      }
    ),

    sendPurchaseOrder: requireWrite("purchaseOrders")(async (_, { id, workspaceId: inputWorkspaceId, email }, context) => {
      const { user, workspaceId } = context;
      const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

      if (!po) {
        throw createNotFoundError("Bon de commande");
      }

      // TODO: Implémenter l'envoi réel par email
      return true;
    }),
  },
};

export default purchaseOrderResolvers;
