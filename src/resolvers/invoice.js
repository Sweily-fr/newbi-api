import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Event from "../models/Event.js";
import Client from "../models/Client.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import {
  withRBAC,
  requireWrite,
  requireRead,
  requireDelete,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  requireCompanyInfo,
  getOrganizationInfo,
} from "../middlewares/company-info-guard.js";
import { mapOrganizationToCompanyInfo } from "../utils/companyInfoMapper.js";
import { generateInvoiceNumber } from "../utils/documentNumbers.js";
import mongoose from "mongoose";
import {
  createNotFoundError,
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import logger from "../utils/logger.js";
import superPdpService from "../services/superPdpService.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import { evaluateAndRouteInvoice } from "../utils/eInvoiceRoutingHelper.js";
// import { evaluatePaymentReporting } from "../utils/eInvoiceRoutingHelper.js"; // TODO E-REPORTING
import notificationService from "../services/notificationService.js";
import { automationService } from "./clientAutomation.js";
import documentAutomationService from "../services/documentAutomationService.js";
import { syncInvoiceIfNeeded } from "../services/pennylaneSyncHelper.js";

// ✅ Ancien middleware withWorkspace supprimé - Remplacé par withRBAC de rbac.js

/**
 * Calcule les totaux d'une facture
 * @param {Array} items - Articles de la facture
 * @param {Number} discount - Remise globale
 * @param {String} discountType - Type de remise (FIXED ou PERCENTAGE)
 * @param {Object} shipping - Informations de livraison
 * @param {Boolean} isReverseCharge - Indique si la facture est soumise à l'auto-liquidation (TVA = 0)
 * @returns {Object} - Totaux calculés
 */
const calculateInvoiceTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  shipping = null,
  isReverseCharge = false,
) => {
  let totalHT = 0;
  let totalVAT = 0;

  // Calculer les totaux des articles
  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

    // Appliquer le pourcentage d'avancement pour les factures de situation
    const progressPercentage =
      item.progressPercentage !== undefined && item.progressPercentage !== null
        ? item.progressPercentage
        : 100;
    itemHT = itemHT * (progressPercentage / 100);

    // Appliquer la remise au niveau de l'item si elle existe
    if (item.discount) {
      if (
        item.discountType === "PERCENTAGE" ||
        item.discountType === "percentage"
      ) {
        // Limiter la remise à 100% maximum
        const discountPercent = Math.min(item.discount, 100);
        itemHT = itemHT * (1 - discountPercent / 100);
      } else {
        itemHT = Math.max(0, itemHT - item.discount);
      }
    }

    // Auto-liquidation : TVA = 0 si isReverseCharge = true
    const itemVAT = isReverseCharge ? 0 : itemHT * (item.vatRate / 100);
    totalHT += itemHT;
    totalVAT += itemVAT;
  });

  // Ajouter les frais de livraison si facturés
  if (shipping && shipping.billShipping) {
    const shippingHT = shipping.shippingAmountHT || 0;
    // Auto-liquidation : TVA = 0 si isReverseCharge = true
    const shippingVAT = isReverseCharge
      ? 0
      : shippingHT * (shipping.shippingVatRate / 100);

    totalHT += shippingHT;
    totalVAT += shippingVAT;
  }

  const totalTTC = totalHT + totalVAT;

  // Calculer la remise globale
  let discountAmount = 0;
  if (discount) {
    if (discountType === "PERCENTAGE" || discountType === "percentage") {
      // Limiter la remise à 100% maximum
      const discountPercent = Math.min(discount, 100);
      discountAmount = (totalHT * discountPercent) / 100;
    } else {
      discountAmount = discount;
    }
  }

  const finalTotalHT = totalHT - discountAmount;

  // Recalculer la TVA après application de la remise globale
  // La TVA doit être proportionnelle au montant final HT
  // Si finalTotalHT <= 0 (remise >= 100%), la TVA doit être 0
  // Auto-liquidation : TVA = 0 si isReverseCharge = true
  let finalTotalVAT = 0;
  if (!isReverseCharge && finalTotalHT > 0 && totalHT > 0) {
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

/**
 * Valide que la date d'émission d'une facture n'est pas antérieure
 * à la date d'émission de la dernière facture existante (non-brouillon)
 * @param {Date|String} issueDate - Date d'émission de la nouvelle facture
 * @param {String} workspaceId - ID du workspace
 * @param {String} excludeInvoiceId - ID de la facture à exclure (pour les mises à jour)
 */
const validateInvoiceIssueDate = async (
  issueDate,
  workspaceId,
  excludeInvoiceId = null,
) => {
  const query = {
    workspaceId,
    status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
  };

  // Exclure la facture en cours de modification si applicable
  if (excludeInvoiceId) {
    query._id = { $ne: excludeInvoiceId };
  }

  // Trouver la facture avec la date d'émission la plus récente
  const latestInvoice = await Invoice.findOne(query)
    .sort({ issueDate: -1 })
    .select("issueDate number prefix")
    .lean();

  if (latestInvoice) {
    const newIssueDate = new Date(issueDate);
    newIssueDate.setHours(0, 0, 0, 0);

    const latestIssueDate = new Date(latestInvoice.issueDate);
    latestIssueDate.setHours(0, 0, 0, 0);

    if (newIssueDate < latestIssueDate) {
      throw createValidationError(
        "La date d'émission ne peut pas être antérieure à celle de la dernière facture existante",
        {
          issueDate: `Une facture (${latestInvoice.prefix}${latestInvoice.number}) existe déjà avec la date du ${latestIssueDate.toLocaleDateString("fr-FR")}. La nouvelle facture doit avoir une date égale ou postérieure.`,
        },
      );
    }
  }
};

const invoiceResolvers = {
  Invoice: {
    companyInfo: async (invoice) => {
      // Pour les brouillons, toujours résoudre depuis l'organisation (données dynamiques)
      if (!invoice.status || invoice.status === "DRAFT") {
        try {
          const organization = await getOrganizationInfo(
            invoice.workspaceId.toString(),
          );
          return mapOrganizationToCompanyInfo(organization);
        } catch (error) {
          console.error(
            "[Invoice.companyInfo] Erreur résolution dynamique:",
            error.message,
          );
          if (invoice.companyInfo && invoice.companyInfo.name)
            return invoice.companyInfo;
          return {
            name: "",
            address: {
              street: "",
              city: "",
              postalCode: "",
              country: "France",
            },
          };
        }
      }
      // Pour les documents finalisés, utiliser les données embarquées (snapshot historique)
      if (invoice.companyInfo && invoice.companyInfo.name) {
        return invoice.companyInfo;
      }
      // Fallback : résoudre depuis l'organisation
      try {
        const organization = await getOrganizationInfo(
          invoice.workspaceId.toString(),
        );
        return mapOrganizationToCompanyInfo(organization);
      } catch (error) {
        console.error(
          "[Invoice.companyInfo] Erreur résolution fallback:",
          error.message,
        );
        return {
          name: "",
          address: { street: "", city: "", postalCode: "", country: "France" },
        };
      }
    },
  },

  Query: {
    invoice: requireRead("invoices")(
      async (_, { id, workspaceId }, context) => {
        const invoice = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId, // ✅ Filtrage par workspace au lieu de createdBy
        }).populate("createdBy");
        if (!invoice) throw createNotFoundError("Facture");
        return invoice;
      },
    ),

    invoices: requireRead("invoices")(
      async (
        _,
        {
          workspaceId,
          startDate,
          endDate,
          status,
          search,
          page = 1,
          limit = 10,
        },
        context,
      ) => {
        // ✅ Base query avec workspaceId
        const query = { workspaceId: workspaceId };
        const { workspace, user } = context;

        if (startDate || endDate) {
          query.createdAt = {};
          if (startDate) query.createdAt.$gte = new Date(startDate);
          if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        if (status) {
          // Si on filtre par COMPLETED, inclure aussi les factures CANCELED
          if (status === "COMPLETED") {
            query.status = { $in: ["COMPLETED", "CANCELED"] };
          } else {
            query.status = status;
          }
        }

        if (search) {
          const searchRegex = new RegExp(search, "i");
          query.$or = [
            { number: searchRegex },
            { "client.name": searchRegex },
            { "client.email": searchRegex },
          ];
        }

        // ✅ Tous les utilisateurs avec permission "view" voient les factures du workspace
        // Les viewers ont accès en lecture seule à TOUTES les ressources de l'organisation
        // (pas de filtre par createdBy pour les viewers)

        const skip = (page - 1) * limit;
        const totalCount = await Invoice.countDocuments(query);

        const invoices = await Invoice.find(query)
          .populate("createdBy")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        return {
          invoices,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      },
    ),

    invoiceStats: requireRead("invoices")(
      async (_, { workspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId, userRole } = context;

        // Base match avec workspaceId
        let matchQuery = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        };

        // ✅ Tous les utilisateurs avec permission "view" voient les stats du workspace
        // (pas de filtre par createdBy pour les viewers)

        const [stats] = await Invoice.aggregate([
          { $match: matchQuery },
          {
            $group: {
              _id: null,
              totalCount: { $sum: 1 },
              draftCount: {
                $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] },
              },
              pendingCount: {
                $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] },
              },
              completedCount: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$status", "COMPLETED"] },
                        { $eq: ["$status", "CANCELED"] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              canceledCount: {
                $sum: { $cond: [{ $eq: ["$status", "CANCELED"] }, 1, 0] },
              },
              totalAmount: { $sum: "$totalTTC" },
            },
          },
        ]);

        return (
          stats || {
            totalCount: 0,
            draftCount: 0,
            pendingCount: 0,
            completedCount: 0,
            canceledCount: 0,
            totalAmount: 0,
          }
        );
      },
    ),

    nextInvoiceNumber: requireRead("invoices")(
      async (_, { workspaceId, prefix, isDraft }, context) => {
        const { user } = context || {};
        if (!user) {
          throw new Error("User not found in context");
        }

        if (isDraft) {
          // Pour les brouillons : utiliser la même logique que pour les devis
          const userObj = await mongoose.model("User").findById(user._id);
          const customPrefix = prefix || userObj?.settings?.invoiceNumberPrefix;
          return await generateInvoiceNumber(customPrefix, {
            workspaceId: workspaceId,
            isDraft: true,
            userId: user._id,
          });
        } else {
          // Pour les factures finalisées : générer le prochain numéro séquentiel par workspace
          const userObj = await mongoose.model("User").findById(user._id);
          const customPrefix = prefix || userObj?.settings?.invoiceNumberPrefix;
          return await generateInvoiceNumber(customPrefix, {
            workspaceId: workspaceId, // ✅ Génération par workspace
            isPending: true,
          });
        }
      },
    ),

    // Rechercher les factures de situation par référence de situation
    situationInvoicesByQuoteRef: requireRead("invoices")(
      async (_, { workspaceId, purchaseOrderNumber }, context) => {
        if (!purchaseOrderNumber || purchaseOrderNumber.trim() === "") {
          console.log(
            "⚠️ Aucune référence fournie pour la recherche de factures de situation",
          );
          return [];
        }

        const reference = purchaseOrderNumber.trim();
        console.log("🔍 Recherche des factures de situation:", {
          workspaceId,
          situationReference: reference,
        });

        // Chercher uniquement dans situationReference (nouveau système)
        const invoices = await Invoice.find({
          workspaceId: workspaceId,
          invoiceType: "situation",
          situationReference: reference,
        })
          .populate("createdBy")
          .sort({ createdAt: 1 }); // Trier par date de création croissante

        console.log(
          `✅ ${invoices.length} facture(s) de situation trouvée(s) avec situationReference="${reference}"`,
        );

        return invoices;
      },
    ),

    // Récupérer les références de situation uniques (pour la recherche)
    situationReferences: requireRead("invoices")(
      async (_, { workspaceId, search }, context) => {
        console.log(
          `🔍 Recherche des références de situation pour workspace: ${workspaceId}`,
        );

        // Construire le filtre de recherche
        const matchFilter = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          invoiceType: "situation",
          situationReference: { $exists: true, $nin: [null, ""] },
        };

        // Ajouter le filtre de recherche si fourni
        if (search && search.trim() !== "") {
          matchFilter.situationReference = {
            $regex: search.trim(),
            $options: "i",
          };
        }

        // Agréger les références uniques avec la première facture pour calculer le contrat
        const references = await Invoice.aggregate([
          { $match: matchFilter },
          { $sort: { issueDate: 1, createdAt: 1 } }, // Trier par date pour avoir la première
          {
            $group: {
              _id: "$situationReference",
              count: { $sum: 1 },
              lastInvoiceDate: { $max: "$issueDate" },
              // Garder toutes les factures pour recalculer le total avec progressPercentage
              invoices: { $push: "$$ROOT" },
              // Garder la première facture pour calculer le montant du contrat
              firstInvoice: { $first: "$$ROOT" },
            },
          },
          { $sort: { lastInvoiceDate: -1 } },
          { $limit: 20 },
        ]);

        // Batch fetch: récupérer tous les devis en une seule requête au lieu de N
        const purchaseOrderNumbers = references
          .map((ref) => ref.firstInvoice?.purchaseOrderNumber)
          .filter(Boolean);

        let quotesMap = new Map();
        if (purchaseOrderNumbers.length > 0) {
          const orConditions = [];
          for (const pon of purchaseOrderNumbers) {
            if (pon.includes("-")) {
              const lastDashIndex = pon.lastIndexOf("-");
              orConditions.push({
                prefix: pon.substring(0, lastDashIndex),
                number: pon.substring(lastDashIndex + 1),
              });
            }
            orConditions.push({ number: pon });
          }
          const allQuotes = await Quote.find({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            $or: orConditions,
          }).lean();

          // Indexer par prefix-number et par number
          for (const q of allQuotes) {
            if (q.prefix) quotesMap.set(`${q.prefix}-${q.number}`, q);
            quotesMap.set(q.number, q);
          }
        }

        // Calculer les montants de manière synchrone (plus de requêtes DB dans la boucle)
        const referencesWithContract = references.map((ref) => {
          let contractTotal = 0;

          // Calculer le total TTC réel en tenant compte du progressPercentage
          let totalTTC = 0;
          if (ref.invoices && ref.invoices.length > 0) {
            ref.invoices.forEach((inv) => {
              if (inv.items && inv.items.length > 0) {
                inv.items.forEach((item) => {
                  const quantity = item.quantity || 1;
                  const unitPrice = item.unitPrice || 0;
                  const progressPercentage =
                    item.progressPercentage !== undefined &&
                    item.progressPercentage !== null
                      ? item.progressPercentage
                      : 100;
                  const vatRate = item.vatRate || 0;
                  const discount = item.discount || 0;
                  const discountType = item.discountType || "PERCENTAGE";

                  let itemHT =
                    quantity * unitPrice * (progressPercentage / 100);

                  if (discount > 0) {
                    if (discountType === "PERCENTAGE") {
                      itemHT = itemHT * (1 - Math.min(discount, 100) / 100);
                    } else {
                      itemHT = Math.max(0, itemHT - discount);
                    }
                  }

                  const itemTTC = itemHT * (1 + vatRate / 100);
                  totalTTC += itemTTC;
                });
              } else {
                totalTTC += inv.finalTotalTTC || 0;
              }
            });
          }

          // Lookup synchrone dans le map pré-chargé
          const firstInvoicePurchaseOrder =
            ref.firstInvoice?.purchaseOrderNumber;
          if (firstInvoicePurchaseOrder) {
            const quote = quotesMap.get(firstInvoicePurchaseOrder) || null;
            if (quote) {
              contractTotal = quote.finalTotalTTC || 0;
            }
          }

          if (contractTotal === 0 && ref.firstInvoice?.contractTotal) {
            contractTotal = ref.firstInvoice.contractTotal;
          }

          if (contractTotal === 0 && ref.firstInvoice?.items) {
            contractTotal = ref.firstInvoice.items.reduce((sum, item) => {
              const quantity = item.quantity || 1;
              const unitPrice = item.unitPrice || 0;
              const vatRate = item.vatRate || 0;
              const discount = item.discount || 0;
              const discountType = item.discountType || "PERCENTAGE";

              let lineTotal = quantity * unitPrice;
              if (discountType === "PERCENTAGE") {
                lineTotal = lineTotal * (1 - discount / 100);
              } else {
                lineTotal = lineTotal - discount;
              }
              lineTotal = lineTotal * (1 + vatRate / 100);

              return sum + lineTotal;
            }, 0);
          }

          return {
            reference: ref._id,
            count: ref.count,
            lastInvoiceDate: ref.lastInvoiceDate,
            totalTTC: totalTTC,
            contractTotal: contractTotal,
          };
        });

        console.log(
          `✅ ${referencesWithContract.length} référence(s) de situation trouvée(s)`,
        );
        if (referencesWithContract.length > 0) {
          console.log(
            "📋 Références:",
            referencesWithContract.map((r) => ({
              ref: r.reference,
              count: r.count,
              totalTTC: r.totalTTC,
              contractTotal: r.contractTotal,
            })),
          );
        }

        return referencesWithContract;
      },
    ),

    checkInvoiceNumberExists: requireRead("invoices")(
      async (_, { workspaceId, number, prefix, excludeId }) => {
        const query = { workspaceId, number, prefix, status: { $ne: "DRAFT" } };
        if (excludeId) {
          query._id = { $ne: excludeId };
        }
        const count = await Invoice.countDocuments(query);
        return count > 0;
      },
    ),
  },

  Mutation: {
    createInvoice: requireCompanyInfo(
      requireWrite("invoices")(
        async (_, { workspaceId: inputWorkspaceId, input }, context) => {
          const { user } = context;
          const workspaceId = resolveWorkspaceId(
            inputWorkspaceId,
            context.workspaceId,
          );

          if (!workspaceId) {
            throw new AppError(
              "Aucune organisation spécifiée.",
              ERROR_CODES.BAD_REQUEST,
            );
          }

          // ✅ Les permissions sont déjà vérifiées par requireWrite("invoices")

          // Récupérer les informations de l'organisation
          const organization = await getOrganizationInfo(workspaceId);
          if (!organization?.companyName) {
            throw new AppError(
              "Les informations de votre entreprise doivent être configurées avant de créer une facture",
              ERROR_CODES.COMPANY_INFO_REQUIRED,
            );
          }

          // Utiliser le préfixe fourni, ou celui de la dernière facture, ou générer un préfixe par défaut
          let prefix = input.prefix;

          // Validation du format du préfixe (optionnel, mais sans espaces ni caractères spéciaux)
          if (prefix && !/^[A-Za-z0-9-]*$/.test(prefix)) {
            throw createValidationError(
              "Le préfixe de facture contient des caractères non autorisés",
              {
                prefix:
                  "Le préfixe ne doit contenir que des lettres, chiffres et tirets (sans espaces ni caractères spéciaux)",
              },
            );
          }

          // Validation du format de la référence devis si fournie
          if (
            input.purchaseOrderNumber &&
            !/^[A-Za-z0-9-]*$/.test(input.purchaseOrderNumber)
          ) {
            throw createValidationError(
              "La référence devis contient des caractères non autorisés",
              {
                purchaseOrderNumber:
                  "La référence devis ne doit contenir que des lettres, chiffres et tirets (sans espaces ni caractères spéciaux)",
              },
            );
          }

          // Validation pour les factures de situation : vérifier que le total ne dépasse pas le contrat
          if (input.invoiceType === "situation" && input.purchaseOrderNumber) {
            // Calculer le montant du contrat (depuis le devis ou la première facture de situation)
            let contractTotal = 0;
            const purchaseOrderNumber = input.purchaseOrderNumber;

            // Chercher le devis associé
            if (purchaseOrderNumber.includes("-")) {
              const lastDashIndex = purchaseOrderNumber.lastIndexOf("-");
              const possiblePrefix = purchaseOrderNumber.substring(
                0,
                lastDashIndex,
              );
              const possibleNumber = purchaseOrderNumber.substring(
                lastDashIndex + 1,
              );

              const quote = await Quote.findOne({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                prefix: possiblePrefix,
                number: possibleNumber,
              });

              if (quote) {
                contractTotal = quote.finalTotalTTC || 0;
              }
            }

            if (contractTotal === 0) {
              const quote = await Quote.findOne({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                number: purchaseOrderNumber,
              });

              if (quote) {
                contractTotal = quote.finalTotalTTC || 0;
              }
            }

            // Si pas de devis, calculer depuis la première facture de situation
            if (contractTotal === 0) {
              const firstSituationInvoice = await Invoice.findOne({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                invoiceType: "situation",
                purchaseOrderNumber: purchaseOrderNumber,
              }).sort({ issueDate: 1, createdAt: 1 });

              if (firstSituationInvoice && firstSituationInvoice.items) {
                contractTotal = firstSituationInvoice.items.reduce(
                  (sum, item) => {
                    const quantity = item.quantity || 1;
                    const unitPrice = item.unitPrice || 0;
                    const vatRate = item.vatRate || 0;
                    const discount = item.discount || 0;
                    const discountType = item.discountType || "PERCENTAGE";

                    let lineTotal = quantity * unitPrice;
                    if (discountType === "PERCENTAGE") {
                      lineTotal = lineTotal * (1 - discount / 100);
                    } else {
                      lineTotal = lineTotal - discount;
                    }
                    lineTotal = lineTotal * (1 + vatRate / 100);

                    return sum + lineTotal;
                  },
                  0,
                );
              }
            }

            // Calculer le total déjà facturé pour cette référence
            const existingSituationInvoices = await Invoice.find({
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              invoiceType: "situation",
              purchaseOrderNumber: purchaseOrderNumber,
            });

            const alreadyInvoicedTotal = existingSituationInvoices.reduce(
              (sum, inv) => sum + (inv.finalTotalTTC || 0),
              0,
            );

            // Calculer le total de la nouvelle facture à partir des items (car finalTotalTTC n'est pas envoyé dans l'input)
            let newInvoiceTotal = 0;
            if (input.items && input.items.length > 0) {
              // Appliquer la remise globale si présente
              const globalDiscount = input.discount || 0;
              const globalDiscountType = input.discountType || "PERCENTAGE";

              let totalHT = 0;
              let totalVAT = 0;

              input.items.forEach((item) => {
                const quantity = parseFloat(item.quantity) || 1;
                const unitPrice = parseFloat(item.unitPrice) || 0;
                const vatRate = parseFloat(item.vatRate) || 0;
                const discount = parseFloat(item.discount) || 0;
                const discountType = item.discountType || "PERCENTAGE";
                const progressPercentage =
                  item.progressPercentage != null
                    ? parseFloat(item.progressPercentage)
                    : 100;

                // Calculer le total HT de la ligne avec avancement
                let lineHT = quantity * unitPrice * (progressPercentage / 100);

                // Appliquer la remise de ligne
                if (discount > 0) {
                  if (discountType === "PERCENTAGE") {
                    lineHT = lineHT * (1 - discount / 100);
                  } else {
                    lineHT = Math.max(0, lineHT - discount);
                  }
                }

                totalHT += lineHT;
                totalVAT += lineHT * (vatRate / 100);
              });

              // Appliquer la remise globale
              if (globalDiscount > 0) {
                if (globalDiscountType === "PERCENTAGE") {
                  const discountMultiplier = 1 - globalDiscount / 100;
                  totalHT = totalHT * discountMultiplier;
                  totalVAT = totalVAT * discountMultiplier;
                } else {
                  // Remise fixe : répartir proportionnellement sur HT et TVA
                  const totalBeforeDiscount = totalHT + totalVAT;
                  if (totalBeforeDiscount > 0) {
                    const discountRatio = Math.min(
                      1,
                      globalDiscount / totalBeforeDiscount,
                    );
                    totalHT = totalHT * (1 - discountRatio);
                    totalVAT = totalVAT * (1 - discountRatio);
                  }
                }
              }

              newInvoiceTotal = totalHT + totalVAT;
            }

            // Vérifier si le total dépasserait le contrat
            if (
              contractTotal > 0 &&
              alreadyInvoicedTotal + newInvoiceTotal > contractTotal
            ) {
              const remaining = contractTotal - alreadyInvoicedTotal;
              throw createValidationError(
                "Le montant total des factures de situation dépasserait le montant du contrat",
                {
                  situationTotal: `Montant du contrat: ${contractTotal.toFixed(2)}€. Déjà facturé: ${alreadyInvoicedTotal.toFixed(2)}€. Reste disponible: ${remaining.toFixed(2)}€. Montant de cette facture: ${newInvoiceTotal.toFixed(2)}€.`,
                },
              );
            }
          }

          if (!prefix) {
            // Chercher la dernière facture créée pour récupérer son préfixe
            const lastInvoice = await Invoice.findOne({ workspaceId })
              .sort({ createdAt: -1 })
              .select("prefix")
              .lean();

            if (lastInvoice && lastInvoice.prefix) {
              prefix = lastInvoice.prefix;
            } else {
              // Aucune facture existante, générer le préfixe par défaut
              const now = new Date();
              const year = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, "0");
              prefix = `F-${month}${year}`;
            }
          }

          // Fonction pour gérer les conflits de brouillons
          const handleDraftConflicts = async (newNumber) => {
            // Vérifier s'il existe une facture en DRAFT avec le même numéro
            const conflictingDrafts = await Invoice.find({
              prefix,
              number: newNumber,
              status: "DRAFT",
              workspaceId,
            });

            // S'il y a des factures en conflit, mettre à jour leur numéro avec le format DRAFT-numéro-timestamp
            for (const draft of conflictingDrafts) {
              const timestamp = Date.now() + Math.floor(Math.random() * 1000);
              // Extraire le numéro de base sans le préfixe DRAFT- s'il existe
              const baseNumber = newNumber.startsWith("DRAFT-")
                ? newNumber.replace("DRAFT-", "")
                : newNumber;
              const finalDraftNumber = `DRAFT-${baseNumber}-${timestamp}`;

              // Mettre à jour la facture en brouillon avec le nouveau numéro
              await Invoice.findByIdAndUpdate(draft._id, {
                number: finalDraftNumber,
              });
            }

            return newNumber;
          };

          // Logique de génération des numéros
          let number;

          if (input.status === "DRAFT") {
            // Pour les brouillons : gérer les conflits AVANT de générer le numéro
            if (input.number) {
              // Si un numéro manuel est fourni, gérer les conflits d'abord
              await handleDraftConflicts(`DRAFT-${input.number}`);
            }

            // Puis utiliser generateInvoiceNumber avec isDraft: true
            const currentUser = await mongoose
              .model("User")
              .findById(context.user._id);
            const customPrefix =
              input.prefix || currentUser?.settings?.invoiceNumberPrefix;
            number = await generateInvoiceNumber(customPrefix, {
              workspaceId,
              isDraft: true,
              userId: context.user._id,
              manualNumber: input.number, // Passer le numéro manuel s'il est fourni
            });
          } else {
            // Pour les factures finalisées (PENDING/COMPLETED) : numéro séquentiel
            if (input.number) {
              // Gérer les conflits avec les brouillons avant d'assigner le numéro
              await handleDraftConflicts(input.number);

              // Vérifier si le numéro fourni existe déjà parmi les factures finalisées
              const existingInvoice = await Invoice.findOne({
                prefix,
                number: input.number,
                status: { $ne: "DRAFT" },
                workspaceId: workspaceId,
              });

              if (existingInvoice) {
                throw new AppError(
                  `Le numéro de facture ${prefix}${input.number} existe déjà`,
                  ERROR_CODES.DUPLICATE_ERROR,
                );
              }

              number = input.number;
            } else {
              // Générer le prochain numéro séquentiel (strict, sans écart)
              const sequentialNumber = await generateInvoiceNumber(prefix, {
                workspaceId: workspaceId,
                // Plus de numéro manuel pour les factures non-brouillons - numérotation strictement séquentielle
              });

              // Gérer les conflits avec les brouillons
              await handleDraftConflicts(sequentialNumber);

              number = sequentialNumber;
            }
          }

          // Valider la date d'émission pour les factures non-brouillons
          if (input.status !== "DRAFT") {
            await validateInvoiceIssueDate(input.issueDate, workspaceId);
          }

          // Calculer les totaux avec la remise et la livraison
          const totals = calculateInvoiceTotals(
            input.items,
            input.discount,
            input.discountType,
            input.shipping,
            input.isReverseCharge,
          );

          try {
            // Vérifier si le client a une adresse de livraison différente
            const clientData = input.client;

            // Si le client a un ID, c'est un client existant - pas besoin de vérifier l'unicité de l'email
            // Seuls les nouveaux clients (sans ID) doivent être vérifiés pour éviter les doublons
            if (!clientData.id) {
              // Vérifier si un client avec cet email existe déjà dans les devis ou factures
              const existingQuote = await Quote.findOne({
                "client.email": clientData.email.toLowerCase(),
                workspaceId,
              });

              const existingInvoice = await Invoice.findOne({
                "client.email": clientData.email.toLowerCase(),
                workspaceId,
              });

              if (existingQuote || existingInvoice) {
                throw createValidationError(
                  `Un client avec l'adresse email "${clientData.email}" existe déjà. Veuillez sélectionner le client existant ou utiliser une adresse email différente.`,
                  {
                    "client.email":
                      "Cette adresse email est déjà utilisée par un autre client",
                  },
                );
              }
            }

            // Si le client a une adresse de livraison différente, s'assurer qu'elle est bien fournie
            if (
              clientData.hasDifferentShippingAddress === true &&
              !clientData.shippingAddress
            ) {
              throw createValidationError(
                "L'adresse de livraison est requise lorsque l'option \"Adresse de livraison différente\" est activée",
                {
                  "client.shippingAddress":
                    "L'adresse de livraison est requise",
                },
              );
            }

            // Log pour vérifier les champs de situation
            if (input.invoiceType === "situation") {
              console.log("📝 Création facture de situation:", {
                invoiceType: input.invoiceType,
                situationReference: input.situationReference,
                contractTotal: input.contractTotal,
                purchaseOrderNumber: input.purchaseOrderNumber,
              });
            }

            // Extraire les champs source qui n'existent pas dans le modèle Mongoose
            const { sourcePurchaseOrderId, sourceQuoteId, ...invoiceInput } =
              input;

            // Créer la facture - companyInfo uniquement pour les documents non-DRAFT
            const isDraft = !input.status || input.status === "DRAFT";
            const invoice = new Invoice({
              ...invoiceInput,
              number,
              prefix,
              companyInfo: isDraft
                ? undefined
                : mapOrganizationToCompanyInfo(organization),
              client: {
                ...input.client,
                shippingAddress: input.client.hasDifferentShippingAddress
                  ? {
                      fullName: input.client.shippingAddress?.fullName || "",
                      street: input.client.shippingAddress?.street || "",
                      city: input.client.shippingAddress?.city || "",
                      postalCode:
                        input.client.shippingAddress?.postalCode || "",
                      country: input.client.shippingAddress?.country || "",
                    }
                  : undefined,
              },
              // Lier la facture au devis source si applicable
              ...(sourceQuoteId ? { sourceQuote: sourceQuoteId } : {}),
              workspaceId: workspaceId, // ✅ Ajout automatique du workspaceId
              createdBy: user._id, // ✅ Conservé pour audit trail
              ...totals, // Ajouter tous les totaux calculés
            });

            try {
              await invoice.save();
              console.log(
                `✅ Facture sauvegardée avec succès: ${prefix}${number}`,
              );

              // Log pour les factures de situation
              if (invoice.invoiceType === "situation") {
                console.log("📊 Facture de situation sauvegardée:", {
                  id: invoice._id,
                  situationReference: invoice.situationReference,
                  contractTotal: invoice.contractTotal,
                  purchaseOrderNumber: invoice.purchaseOrderNumber,
                });
              }

              // === ROUTAGE E-INVOICING / E-REPORTING ===
              // Évaluer et router la facture si elle n'est pas un brouillon
              if (invoice.status !== "DRAFT") {
                try {
                  const routingResult = await evaluateAndRouteInvoice(
                    invoice,
                    workspaceId,
                  );
                  if (routingResult) {
                    await invoice.save();
                    logger.info(
                      `[E-INVOICE-ROUTING] Facture ${prefix}${number}: ${routingResult.flowType} - ${routingResult.reason}`,
                    );
                  }
                } catch (eInvoicingError) {
                  // Ne pas faire échouer la création de facture si le routage échoue
                  logger.error("Erreur routing e-invoicing:", eInvoicingError);
                  try {
                    invoice.eInvoiceStatus = "ERROR";
                    invoice.eInvoiceError = eInvoicingError.message;
                    await invoice.save();
                  } catch (updateError) {
                    logger.error(
                      "Erreur lors de la mise à jour du statut e-invoicing:",
                      updateError,
                    );
                  }
                }
              }
              // === FIN ENVOI SUPERPDP ===
            } catch (saveError) {
              // Gestion spécifique des erreurs de clé dupliquée MongoDB
              if (saveError.code === 11000 && saveError.keyPattern?.number) {
                throw new AppError(
                  `Un brouillon avec le numéro "${number}" existe déjà. Veuillez réessayer, le système va automatiquement renommer l'ancien brouillon.`,
                  ERROR_CODES.DUPLICATE_ERROR,
                );
              }
              throw saveError;
            }

            // Enregistrer l'activité dans le client si c'est un client existant
            if (clientData.id) {
              try {
                await Client.findByIdAndUpdate(clientData.id, {
                  $push: {
                    activity: {
                      id: new mongoose.Types.ObjectId().toString(),
                      type: "invoice_created",
                      description: `a créé la facture ${prefix}${number}`,
                      userId: user._id,
                      userName: user.name || user.email,
                      userImage: user.image || null,
                      metadata: {
                        documentType: "invoice",
                        documentId: invoice._id.toString(),
                        documentNumber: `${prefix}-${number}`,
                        status: invoice.status,
                      },
                      createdAt: new Date(),
                    },
                  },
                });
              } catch (activityError) {
                console.error(
                  "Erreur lors de l'enregistrement de l'activité:",
                  activityError,
                );
                // Ne pas faire échouer la création de facture si l'activité échoue
              }
            }

            // Créer automatiquement un événement de calendrier pour l'échéance de la facture
            if (invoice.dueDate) {
              try {
                await Event.createInvoiceDueEvent(
                  invoice,
                  user._id,
                  workspaceId,
                );
              } catch (eventError) {
                console.error(
                  "Erreur lors de la création de l'événement de calendrier:",
                  eventError,
                );
                // Ne pas faire échouer la création de facture si l'événement échoue
              }
            }

            // Vérifier si le numéro de bon de commande correspond à un devis existant
            if (input.purchaseOrderNumber) {
              // Rechercher tous les devis du workspace
              const quotes = await Quote.find({ workspaceId });

              // Trouver un devis dont le préfixe+numéro correspond au numéro de bon de commande
              const matchingQuote = quotes.find((quote) => {
                // Construire l'identifiant complet du devis (préfixe-numéro)
                const quoteFullId = `${quote.prefix}-${quote.number}`;
                const inputLower = input.purchaseOrderNumber.toLowerCase();

                // Comparer avec le numéro de bon de commande (supporte ancien format sans tiret et nouveau avec tiret)
                return (
                  quoteFullId.toLowerCase() === inputLower ||
                  `${quote.prefix}${quote.number}`.toLowerCase() === inputLower
                );
              });

              if (matchingQuote) {
                // Vérifier si le devis n'a pas déjà trop de factures liées
                const linkedInvoicesCount = matchingQuote.linkedInvoices
                  ? matchingQuote.linkedInvoices.length
                  : 0;

                if (linkedInvoicesCount < 3) {
                  // Ajouter cette facture aux factures liées du devis
                  if (!matchingQuote.linkedInvoices) {
                    matchingQuote.linkedInvoices = [];
                  }

                  // Vérifier que la facture n'est pas déjà liée
                  const alreadyLinked = matchingQuote.linkedInvoices.some(
                    (linkedInvoice) =>
                      linkedInvoice.toString() === invoice._id.toString(),
                  );

                  if (!alreadyLinked) {
                    matchingQuote.linkedInvoices.push(invoice._id);
                    await matchingQuote.save();
                  }
                }
              }
            }

            // Lier la facture au bon de commande source
            if (sourcePurchaseOrderId) {
              try {
                await PurchaseOrder.findByIdAndUpdate(sourcePurchaseOrderId, {
                  $addToSet: { linkedInvoices: invoice._id },
                });
              } catch (err) {
                console.error("Erreur lien BC→Facture:", err);
              }
            }

            // Lier la facture au devis source (si pas déjà lié par purchaseOrderNumber)
            if (sourceQuoteId) {
              try {
                const sourceQuote = await Quote.findById(sourceQuoteId);
                if (sourceQuote) {
                  const alreadyLinked = sourceQuote.linkedInvoices?.some(
                    (id) => id.toString() === invoice._id.toString(),
                  );
                  if (
                    !alreadyLinked &&
                    (!sourceQuote.linkedInvoices ||
                      sourceQuote.linkedInvoices.length < 3)
                  ) {
                    await Quote.findByIdAndUpdate(sourceQuoteId, {
                      $addToSet: { linkedInvoices: invoice._id },
                    });
                  }
                }
              } catch (err) {
                console.error("Erreur lien Devis→Facture:", err);
              }
            }

            // Automatisations documents partagés pour les brouillons (fire-and-forget)
            if (invoice.status === "DRAFT") {
              documentAutomationService
                .executeAutomations(
                  "INVOICE_DRAFT",
                  workspaceId,
                  {
                    documentId: invoice._id.toString(),
                    documentType: "invoice",
                    documentNumber: invoice.number,
                    prefix: invoice.prefix || "",
                    clientName: invoice.client?.name || "",
                    issueDate: invoice.issueDate || invoice.createdAt,
                    clientId: invoice.client?._id || invoice.clientId || null,
                  },
                  user._id.toString(),
                )
                .catch((err) =>
                  console.error(
                    "Erreur automatisation documents (draft):",
                    err,
                  ),
                );
            }

            return await invoice.populate("createdBy");
          } catch (error) {
            // Intercepter les erreurs de validation Mongoose
            console.error("Erreur lors de la création de la facture:", error);

            // Si c'est une erreur de validation Mongoose
            if (error.name === "ValidationError") {
              const validationErrors = {};

              // Transformer les erreurs Mongoose en format plus lisible
              Object.keys(error.errors).forEach((key) => {
                validationErrors[key] = error.errors[key].message;
              });

              console.error(
                "⚠️ Détails de validation Mongoose:",
                JSON.stringify(validationErrors, null, 2),
              );

              throw createValidationError(
                "La facture contient des erreurs de validation",
                validationErrors,
              );
            }

            // Si c'est une autre erreur, la propager
            throw error;
          }
        },
      ),
    ),

    updateInvoice: requireCompanyInfo(
      requireWrite("invoices")(
        async (_, { id, workspaceId: inputWorkspaceId, input }, context) => {
          const { user } = context;
          const workspaceId = resolveWorkspaceId(
            inputWorkspaceId,
            context.workspaceId,
          );

          // Rechercher la facture sans utiliser Mongoose pour éviter les validations automatiques
          const invoiceData = await Invoice.findOne({
            _id: id,
            workspaceId: workspaceId, // ✅ Vérification workspace
          }).lean();

          if (!invoiceData) {
            throw createNotFoundError("Facture");
          }

          // ✅ Vérifications de permissions granulaires
          const { userRole } = context;
          if (
            userRole === "viewer" &&
            invoiceData.createdBy.toString() !== user._id.toString()
          ) {
            throw new AppError("Permission refusée", ERROR_CODES.FORBIDDEN);
          }

          // ✅ Les permissions d'écriture sont déjà vérifiées par requireWrite("invoices")

          // Vérifier si la facture peut être modifiée (statut)
          if (
            invoiceData.status === "COMPLETED" &&
            userRole !== "admin" &&
            userRole !== "owner"
          ) {
            throw createResourceLockedError("Cette facture est verrouillée");
          }

          if (invoiceData.status === "CANCELED") {
            throw createResourceLockedError(
              "Facture",
              "une facture annulée ne peut pas être modifiée",
            );
          }

          // Vérifier si l'utilisateur tente de modifier le numéro de facture
          if (input.number && input.number !== invoiceData.number) {
            // Vérifier si des factures avec le statut PENDING ou COMPLETED existent déjà
            const pendingInvoicesCount = await Invoice.countDocuments({
              workspaceId: workspaceId,
              status: { $in: ["PENDING", "COMPLETED"] },
              number: input.number,
              prefix: invoiceData.prefix,
              _id: { $ne: id },
            });

            if (pendingInvoicesCount > 0) {
              throw new AppError(
                `Le numéro de facture ${invoiceData.prefix}${input.number} existe déjà`,
                ERROR_CODES.DUPLICATE_ERROR,
              );
            }
          }

          // Validation : empêcher le changement d'année de issueDate sur une facture finalisée
          if (
            input.issueDate &&
            invoiceData.status !== "DRAFT" &&
            invoiceData.issueDate
          ) {
            const oldYear = new Date(invoiceData.issueDate).getFullYear();
            const newYear = new Date(input.issueDate).getFullYear();
            if (oldYear !== newYear) {
              throw createValidationError(
                `Impossible de changer l'année d'émission d'une facture finalisée (${oldYear} → ${newYear}). Cela casserait la séquence de numérotation.`,
                {
                  issueDate: `L'année d'émission ne peut pas être modifiée de ${oldYear} à ${newYear} sur une facture finalisée.`,
                },
              );
            }
          }

          // Créer une copie des données d'entrée pour éviter de modifier l'original
          let updatedInput = { ...input };

          // Validation du format du préfixe si fourni
          if (
            updatedInput.prefix &&
            !/^[A-Za-z0-9-]*$/.test(updatedInput.prefix)
          ) {
            throw createValidationError(
              "Le préfixe de facture contient des caractères non autorisés",
              {
                prefix:
                  "Le préfixe ne doit contenir que des lettres, chiffres et tirets (sans espaces ni caractères spéciaux)",
              },
            );
          }

          // Validation du format de la référence devis si fournie
          if (
            updatedInput.purchaseOrderNumber &&
            !/^[A-Za-z0-9-]*$/.test(updatedInput.purchaseOrderNumber)
          ) {
            throw createValidationError(
              "La référence devis contient des caractères non autorisés",
              {
                purchaseOrderNumber:
                  "La référence devis ne doit contenir que des lettres, chiffres et tirets (sans espaces ni caractères spéciaux)",
              },
            );
          }

          // Validation pour les factures de situation : vérifier que le total ne dépasse pas le contrat
          const invoiceType =
            updatedInput.invoiceType || invoiceData.invoiceType;
          const purchaseOrderNumber =
            updatedInput.purchaseOrderNumber || invoiceData.purchaseOrderNumber;

          if (invoiceType === "situation" && purchaseOrderNumber) {
            // Calculer le montant du contrat (depuis le devis ou la première facture de situation)
            let contractTotal = 0;

            // Chercher le devis associé
            if (purchaseOrderNumber.includes("-")) {
              const lastDashIndex = purchaseOrderNumber.lastIndexOf("-");
              const possiblePrefix = purchaseOrderNumber.substring(
                0,
                lastDashIndex,
              );
              const possibleNumber = purchaseOrderNumber.substring(
                lastDashIndex + 1,
              );

              const quote = await Quote.findOne({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                prefix: possiblePrefix,
                number: possibleNumber,
              });

              if (quote) {
                contractTotal = quote.finalTotalTTC || 0;
              }
            }

            if (contractTotal === 0) {
              const quote = await Quote.findOne({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                number: purchaseOrderNumber,
              });

              if (quote) {
                contractTotal = quote.finalTotalTTC || 0;
              }
            }

            // Si pas de devis, calculer depuis la première facture de situation
            if (contractTotal === 0) {
              const firstSituationInvoice = await Invoice.findOne({
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                invoiceType: "situation",
                purchaseOrderNumber: purchaseOrderNumber,
              }).sort({ issueDate: 1, createdAt: 1 });

              if (firstSituationInvoice && firstSituationInvoice.items) {
                contractTotal = firstSituationInvoice.items.reduce(
                  (sum, item) => {
                    const quantity = item.quantity || 1;
                    const unitPrice = item.unitPrice || 0;
                    const vatRate = item.vatRate || 0;
                    const discount = item.discount || 0;
                    const discountType = item.discountType || "PERCENTAGE";

                    let lineTotal = quantity * unitPrice;
                    if (discountType === "PERCENTAGE") {
                      lineTotal = lineTotal * (1 - discount / 100);
                    } else {
                      lineTotal = lineTotal - discount;
                    }
                    lineTotal = lineTotal * (1 + vatRate / 100);

                    return sum + lineTotal;
                  },
                  0,
                );
              }
            }

            // Calculer le total déjà facturé pour cette référence (excluant la facture actuelle)
            const existingSituationInvoices = await Invoice.find({
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              invoiceType: "situation",
              purchaseOrderNumber: purchaseOrderNumber,
              _id: { $ne: id }, // Exclure la facture actuelle
            });

            const alreadyInvoicedTotal = existingSituationInvoices.reduce(
              (sum, inv) => sum + (inv.finalTotalTTC || 0),
              0,
            );

            // Calculer le total de la facture mise à jour à partir des items (car finalTotalTTC n'est pas envoyé dans l'input)
            let newInvoiceTotal = 0;
            const itemsToUse = updatedInput.items || invoiceData.items;

            if (itemsToUse && itemsToUse.length > 0) {
              // Appliquer la remise globale si présente
              const globalDiscount =
                updatedInput.discount !== undefined
                  ? updatedInput.discount
                  : invoiceData.discount || 0;
              const globalDiscountType =
                updatedInput.discountType ||
                invoiceData.discountType ||
                "PERCENTAGE";

              let totalHT = 0;
              let totalVAT = 0;

              itemsToUse.forEach((item) => {
                const quantity = parseFloat(item.quantity) || 1;
                const unitPrice = parseFloat(item.unitPrice) || 0;
                const vatRate = parseFloat(item.vatRate) || 0;
                const discount = parseFloat(item.discount) || 0;
                const discountType = item.discountType || "PERCENTAGE";
                const progressPercentage =
                  item.progressPercentage != null
                    ? parseFloat(item.progressPercentage)
                    : 100;

                // Calculer le total HT de la ligne avec avancement
                let lineHT = quantity * unitPrice * (progressPercentage / 100);

                // Appliquer la remise de ligne
                if (discount > 0) {
                  if (discountType === "PERCENTAGE") {
                    lineHT = lineHT * (1 - discount / 100);
                  } else {
                    lineHT = Math.max(0, lineHT - discount);
                  }
                }

                totalHT += lineHT;
                totalVAT += lineHT * (vatRate / 100);
              });

              // Appliquer la remise globale
              if (globalDiscount > 0) {
                if (globalDiscountType === "PERCENTAGE") {
                  const discountMultiplier = 1 - globalDiscount / 100;
                  totalHT = totalHT * discountMultiplier;
                  totalVAT = totalVAT * discountMultiplier;
                } else {
                  // Remise fixe : répartir proportionnellement sur HT et TVA
                  const totalBeforeDiscount = totalHT + totalVAT;
                  if (totalBeforeDiscount > 0) {
                    const discountRatio = Math.min(
                      1,
                      globalDiscount / totalBeforeDiscount,
                    );
                    totalHT = totalHT * (1 - discountRatio);
                    totalVAT = totalVAT * (1 - discountRatio);
                  }
                }
              }

              newInvoiceTotal = totalHT + totalVAT;
            }

            // Vérifier si le total dépasserait le contrat
            if (
              contractTotal > 0 &&
              alreadyInvoicedTotal + newInvoiceTotal > contractTotal
            ) {
              const remaining = contractTotal - alreadyInvoicedTotal;
              throw createValidationError(
                "Le montant total des factures de situation dépasserait le montant du contrat",
                {
                  situationTotal: `Montant du contrat: ${contractTotal.toFixed(2)}€. Déjà facturé: ${alreadyInvoicedTotal.toFixed(2)}€. Reste disponible: ${remaining.toFixed(2)}€. Montant de cette facture: ${newInvoiceTotal.toFixed(2)}€.`,
                },
              );
            }
          }

          // Si les items sont modifiés, recalculer les totaux
          if (updatedInput.items) {
            const totals = calculateInvoiceTotals(
              updatedInput.items,
              updatedInput.discount || invoiceData.discount,
              updatedInput.discountType || invoiceData.discountType,
              updatedInput.shipping || invoiceData.shipping,
              updatedInput.isReverseCharge !== undefined
                ? updatedInput.isReverseCharge
                : invoiceData.isReverseCharge,
            );
            updatedInput = { ...updatedInput, ...totals };
          }

          // Préparer les données à mettre à jour - SEULEMENT les champs modifiés
          const updateData = {};

          // Ne pas persister companyInfo pour les documents DRAFT
          // (le field resolver GraphQL le résout dynamiquement depuis l'organisation)

          // Mettre à jour le client si fourni
          if (updatedInput.client) {
            // Vérifier si le client a une adresse de livraison différente
            if (
              updatedInput.client.hasDifferentShippingAddress === true &&
              !updatedInput.client.shippingAddress
            ) {
              throw createValidationError(
                "L'adresse de livraison est requise lorsque l'option \"Adresse de livraison différente\" est activée",
                {
                  "client.shippingAddress":
                    "L'adresse de livraison est requise",
                },
              );
            }

            updateData.client = {
              ...invoiceData.client,
              ...updatedInput.client,
            };

            // Mettre à jour l'adresse du client si fournie
            if (updatedInput.client.address) {
              updateData.client.address = {
                ...(invoiceData.client.address || {}),
                ...updatedInput.client.address,
              };
            }

            // Mettre à jour l'adresse de livraison du client si fournie
            if (updatedInput.client.shippingAddress) {
              updateData.client.shippingAddress = {
                ...(invoiceData.client.shippingAddress || {}),
                ...updatedInput.client.shippingAddress,
              };
            }
          }

          // Gérer le lien des conditions générales
          if (updatedInput.termsAndConditionsLink !== undefined) {
            if (updatedInput.termsAndConditionsLink === "") {
              // Si une chaîne vide est fournie, supprimer le lien
              updateData.termsAndConditionsLink = null;
            } else {
              updateData.termsAndConditionsLink =
                updatedInput.termsAndConditionsLink;
            }
          }

          // Gestion spéciale de la transition DRAFT vers PENDING/COMPLETED
          if (
            invoiceData.status === "DRAFT" &&
            updatedInput.status &&
            updatedInput.status !== "DRAFT"
          ) {
            // Snapshot companyInfo à la finalisation
            if (!invoiceData.companyInfo || !invoiceData.companyInfo.name) {
              const org = await getOrganizationInfo(workspaceId);
              updateData.companyInfo = mapOrganizationToCompanyInfo(org);
            }
            // La facture passe de brouillon à finalisée : générer un nouveau numéro séquentiel
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const prefix = invoiceData.prefix || `F-${month}${year}`;

            // Utiliser generateInvoiceNumber pour générer le prochain numéro séquentiel
            // Cela garantit que le numéro est unique et suit la séquence correcte
            const newNumber = await generateInvoiceNumber(prefix, {
              workspaceId: workspaceId,
              userId: context.user._id,
              isPending: true,
            });

            // Mettre à jour le numéro et le préfixe
            updateData.number = newNumber;
            updateData.prefix = prefix;
          }

          // Fusionner toutes les autres mises à jour
          Object.keys(updatedInput).forEach((key) => {
            if (
              key !== "client" &&
              key !== "companyInfo" &&
              key !== "termsAndConditionsLink"
            ) {
              // Éviter de mettre à jour le numéro s'il n'a pas changé pour éviter l'erreur de clé dupliquée
              if (
                key === "number" &&
                updatedInput[key] === invoiceData.number
              ) {
                return; // Skip this field
              }
              // Ne JAMAIS écraser le numéro si on vient de le générer pour la transition DRAFT->PENDING
              if (
                key === "number" &&
                invoiceData.status === "DRAFT" &&
                updatedInput.status &&
                updatedInput.status !== "DRAFT"
              ) {
                return; // Skip this field car déjà géré ci-dessus avec un numéro séquentiel
              }
              // Préserver le numéro existant pour les brouillons qui restent en DRAFT
              if (
                key === "number" &&
                invoiceData.status === "DRAFT" &&
                (!updatedInput.status || updatedInput.status === "DRAFT")
              ) {
                return; // Skip this field - garder le numéro existant pour les brouillons
              }
              updateData[key] = updatedInput[key];
            }
          });

          try {
            // Désactiver temporairement les validations pour les coordonnées bancaires
            // car elles sont gérées manuellement dans le code ci-dessus
            const originalValidate = Invoice.schema.path(
              "companyInfo.bankDetails.iban",
            )?.validators;
            const originalValidateBic = Invoice.schema.path(
              "companyInfo.bankDetails.bic",
            )?.validators;
            const originalValidateBankName = Invoice.schema.path(
              "companyInfo.bankDetails.bankName",
            )?.validators;

            // Supprimer temporairement les validateurs
            if (originalValidate) {
              Invoice.schema.path("companyInfo.bankDetails.iban").validators =
                [];
            }
            if (originalValidateBic) {
              Invoice.schema.path("companyInfo.bankDetails.bic").validators =
                [];
            }
            if (originalValidateBankName) {
              Invoice.schema.path(
                "companyInfo.bankDetails.bankName",
              ).validators = [];
            }

            // Mettre à jour la facture
            const updatedInvoice = await Invoice.findOneAndUpdate(
              { _id: id, workspaceId: workspaceId },
              { $set: updateData },
              { new: true, runValidators: true },
            ).populate("createdBy");

            // Rétablir les validateurs
            if (originalValidate) {
              Invoice.schema.path("companyInfo.bankDetails.iban").validators =
                originalValidate;
            }
            if (originalValidateBic) {
              Invoice.schema.path("companyInfo.bankDetails.bic").validators =
                originalValidateBic;
            }
            if (originalValidateBankName) {
              Invoice.schema.path(
                "companyInfo.bankDetails.bankName",
              ).validators = originalValidateBankName;
            }

            if (!updatedInvoice) {
              throw createNotFoundError("Facture");
            }

            // Mettre à jour l'événement de calendrier si la date d'échéance a changé
            if (updatedInvoice.dueDate) {
              try {
                await Event.updateInvoiceEvent(updatedInvoice, user.id);
              } catch (eventError) {
                console.error(
                  "Erreur lors de la mise à jour de l'événement de calendrier:",
                  eventError,
                );
                // Ne pas faire échouer la mise à jour de facture si l'événement échoue
              }
            }

            return updatedInvoice;
          } catch (error) {
            // Intercepter les erreurs de validation Mongoose
            console.error(
              "Erreur lors de la mise à jour de la facture:",
              error,
            );

            // Si c'est une erreur de validation Mongoose
            if (error.name === "ValidationError") {
              const validationErrors = {};

              // Transformer les erreurs Mongoose en format plus lisible
              Object.keys(error.errors).forEach((key) => {
                validationErrors[key] = error.errors[key].message;
              });

              throw createValidationError(
                "La facture contient des erreurs de validation",
                validationErrors,
              );
            }

            // Si c'est une autre erreur, la propager
            throw new AppError(
              `Erreur de mise à jour: ${error.message}`,
              ERROR_CODES.VALIDATION_ERROR,
            );
          }
        },
      ),
    ),

    deleteInvoice: requireDelete("invoices")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        // ✅ Les permissions de suppression sont déjà vérifiées par requireDelete("invoices")

        const invoice = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId,
        });

        if (!invoice) {
          throw createNotFoundError("Facture");
        }

        if (invoice.status === "COMPLETED") {
          throw createResourceLockedError(
            "Impossible de supprimer une facture finalisée",
          );
        }

        // Si la facture est liée à un devis, retirer le lien du devis

        let sourceQuoteId = invoice.sourceQuote;

        // Si sourceQuote n'existe pas, chercher le devis qui contient cette facture
        if (!sourceQuoteId) {
          const quote = await Quote.findOne({ linkedInvoices: invoice._id });
          if (quote) {
            sourceQuoteId = quote._id;
            // Mettre à jour la facture avec le sourceQuote manquant
            invoice.sourceQuote = sourceQuoteId;
            await invoice.save();
          }
        }

        // Supprimer le lien du devis si un devis source a été trouvé
        if (sourceQuoteId) {
          await Quote.updateOne(
            { _id: sourceQuoteId },
            { $pull: { linkedInvoices: invoice._id } },
          );
        }

        // Supprimer l'événement de calendrier associé à la facture
        try {
          await Event.deleteInvoiceEvent(
            invoice._id,
            context.user._id,
            workspaceId,
          );
        } catch (eventError) {
          console.error(
            "Erreur lors de la suppression de l'événement de calendrier:",
            eventError,
          );
          // Ne pas faire échouer la suppression de facture si l'événement échoue
        }

        await Invoice.deleteOne({ _id: id, workspaceId: workspaceId });

        // Supprimer les événements liés
        await Event.deleteMany({
          invoiceId: id,
          workspaceId: workspaceId,
        });

        return true;
      },
    ),

    changeInvoiceStatus: requireWrite("invoices")(
      async (_, { id, workspaceId: inputWorkspaceId, status }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const invoice = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId,
        }).populate("createdBy");

        if (!invoice) {
          throw createNotFoundError("Facture");
        }

        // ✅ Vérifications de permissions
        const { userRole } = context;
        if (
          userRole === "viewer" &&
          invoice.createdBy._id.toString() !== user._id.toString()
        ) {
          throw new AppError(
            "Vous ne pouvez modifier que vos propres factures",
            ERROR_CODES.FORBIDDEN,
          );
        }

        // ✅ Les permissions d'écriture sont déjà vérifiées par requireWrite("invoices")

        // Vérifier si le changement de statut est autorisé
        if (invoice.status === status) {
          return invoice; // Aucun changement nécessaire
        }

        // Vérifier les transitions de statut autorisées
        if (
          invoice.status === "COMPLETED" ||
          invoice.status === "CANCELED" ||
          (invoice.status === "PENDING" && status === "DRAFT") ||
          (status === "DRAFT" && invoice.status !== "DRAFT")
        ) {
          throw createStatusTransitionError("Facture", invoice.status, status);
        }

        // Vérifier que la date d'émission n'est pas antérieure à celle de la dernière facture existante
        if (invoice.status === "DRAFT" && status === "PENDING") {
          await validateInvoiceIssueDate(
            invoice.issueDate,
            workspaceId,
            invoice._id,
          );
        }

        const oldStatus = invoice.status;

        // Si la facture passe de DRAFT à PENDING, snapshot companyInfo et générer un nouveau numéro séquentiel
        if (invoice.status === "DRAFT" && status === "PENDING") {
          // Snapshot companyInfo à la finalisation
          if (!invoice.companyInfo || !invoice.companyInfo.name) {
            const org = await getOrganizationInfo(workspaceId);
            invoice.companyInfo = mapOrganizationToCompanyInfo(org);
          }

          // Transaction atomique pour éviter les numéros TEMP orphelins
          const MAX_RETRIES = 3;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const session = await mongoose.startSession();
            try {
              await session.withTransaction(async () => {
                // Sauvegarder le numéro original du brouillon
                const originalDraftNumber = invoice.number;

                // D'abord changer temporairement le numéro pour éviter les conflits
                invoice.number = `TEMP-${Date.now()}`;
                await invoice.save({ session });

                // Récupérer le préfixe de la dernière facture créée (non-DRAFT)
                const lastInvoice = await Invoice.findOne(
                  {
                    workspaceId: workspaceId,
                    status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
                  },
                  null,
                  { session },
                )
                  .sort({ createdAt: -1 })
                  .select("prefix")
                  .lean();

                // Utiliser l'année de issueDate du document, pas la date serveur
                const year = (invoice.issueDate || new Date()).getFullYear();
                const month = String(
                  (invoice.issueDate || new Date()).getMonth() + 1,
                ).padStart(2, "0");

                let prefix;
                if (lastInvoice && lastInvoice.prefix) {
                  prefix = lastInvoice.prefix;
                } else {
                  prefix = `F-${month}${year}`;
                }

                console.log(
                  "🔍 [changeInvoiceStatus] DRAFT → PENDING, prefix:",
                  prefix,
                );

                const newNumber = await generateInvoiceNumber(prefix, {
                  isValidatingDraft: true,
                  currentDraftNumber: invoice.number,
                  originalDraftNumber: originalDraftNumber,
                  workspaceId: workspaceId,
                  currentInvoiceId: invoice._id,
                  session,
                });

                invoice.number = newNumber;
                invoice.prefix = prefix;
                invoice.status = status;
                await invoice.save({ session });
              });
              session.endSession();
              break; // Succès, sortir de la boucle de retry
            } catch (err) {
              session.endSession();
              if (err.code === 11000 && attempt < MAX_RETRIES - 1) {
                // Duplicate key error, réessayer
                console.log(
                  `⚠️ [changeInvoiceStatus] E11000 retry attempt ${attempt + 1}`,
                );
                continue;
              }
              throw err;
            }
          }
        } else {
          // Pour les autres transitions (pas DRAFT→PENDING)
          invoice.status = status;
          await invoice.save();
        }

        // === ROUTAGE E-INVOICING (DRAFT → PENDING) ===
        // Les factures passant de DRAFT à PENDING n'ont pas été routées à la création
        if (oldStatus === "DRAFT" && status === "PENDING") {
          try {
            const routingResult = await evaluateAndRouteInvoice(
              invoice,
              workspaceId,
            );
            if (routingResult) {
              await invoice.save();
              logger.info(
                `[E-INVOICE-ROUTING] DRAFT→PENDING ${invoice.prefix}${invoice.number}: ${routingResult.flowType} - ${routingResult.reason}`,
              );
            }
          } catch (eInvoicingError) {
            logger.error(
              "Erreur routing e-invoicing (DRAFT→PENDING):",
              eInvoicingError,
            );
          }
        }

        // Enregistrer l'activité dans le client si c'est un client existant
        if (invoice.client && invoice.client.id) {
          try {
            const statusLabels = {
              DRAFT: "Brouillon",
              PENDING: "En attente",
              COMPLETED: "Payée",
              CANCELED: "Annulée",
            };

            await Client.findByIdAndUpdate(invoice.client.id, {
              $push: {
                activity: {
                  id: new mongoose.Types.ObjectId().toString(),
                  type: "invoice_status_changed",
                  description: `a changé le statut de la facture ${invoice.prefix}${invoice.number} de "${statusLabels[oldStatus]}" à "${statusLabels[status]}"`,
                  userId: user._id,
                  userName: user.name || user.email,
                  userImage: user.image || null,
                  metadata: {
                    documentType: "invoice",
                    documentId: invoice._id.toString(),
                    documentNumber: `${invoice.prefix}-${invoice.number}`,
                    status: status,
                  },
                  createdAt: new Date(),
                },
              },
            });
          } catch (activityError) {
            console.error(
              "Erreur lors de l'enregistrement de l'activité:",
              activityError,
            );
            // Ne pas faire échouer le changement de statut si l'activité échoue
          }
        }

        // Automatisations documents partagés (fire-and-forget, ne bloque pas la réponse)
        const triggerMap = {
          PENDING: "INVOICE_SENT",
          CANCELED: "INVOICE_CANCELED",
        };
        const trigger = triggerMap[status];
        if (trigger) {
          documentAutomationService
            .executeAutomations(
              trigger,
              workspaceId,
              {
                documentId: invoice._id.toString(),
                documentType: "invoice",
                documentNumber: invoice.number,
                prefix: invoice.prefix || "",
                clientName: invoice.client?.name || "",
                issueDate: invoice.issueDate || invoice.createdAt,
                clientId: invoice.client?._id || invoice.clientId || null,
              },
              user._id.toString(),
            )
            .catch((err) =>
              console.error("Erreur automatisation documents:", err),
            );
        }

        // Sync Pennylane (fire-and-forget)
        syncInvoiceIfNeeded(invoice, workspaceId).catch((err) =>
          console.error("Erreur sync Pennylane:", err),
        );

        return await invoice.populate("createdBy");
      },
    ),

    markInvoiceAsPaid: requireWrite("invoices")(
      async (
        _,
        { id, workspaceId: inputWorkspaceId, paymentDate },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const invoice = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId,
        }).populate("createdBy");

        if (!invoice) {
          throw createNotFoundError("Facture");
        }

        // ✅ Vérifications de permissions
        const { userRole } = context;
        if (
          userRole === "viewer" &&
          invoice.createdBy._id.toString() !== user._id.toString()
        ) {
          throw new AppError(
            "Vous ne pouvez modifier que vos propres factures",
            ERROR_CODES.FORBIDDEN,
          );
        }

        // ✅ Les permissions d'écriture sont déjà vérifiées par requireWrite("invoices")

        // Vérifier si la facture peut être marquée comme payée
        if (invoice.status === "DRAFT") {
          throw createStatusTransitionError(
            "Facture",
            invoice.status,
            "COMPLETED",
            "Une facture en brouillon ne peut pas être marquée comme payée",
          );
        }

        if (invoice.status === "CANCELED") {
          throw createStatusTransitionError(
            "Facture",
            invoice.status,
            "COMPLETED",
            "Une facture annulée ne peut pas être marquée comme payée",
          );
        }

        if (invoice.status === "COMPLETED") {
          // La facture est déjà marquée comme payée, vérifier si la date de paiement est différente
          if (
            invoice.paymentDate &&
            new Date(invoice.paymentDate).toISOString() ===
              new Date(paymentDate).toISOString()
          ) {
            return invoice; // Aucun changement nécessaire
          }
        }

        // Mettre à jour le statut et la date de paiement
        invoice.status = "COMPLETED";
        invoice.paymentDate = new Date(paymentDate);
        await invoice.save();

        // TODO E-REPORTING: Décommenter quand l'API SuperPDP e-reporting sera disponible
        // try {
        //   if (evaluatePaymentReporting(invoice, new Date(paymentDate))) {
        //     await invoice.save();
        //     logger.info(`[E-INVOICE-ROUTING] E-reporting payment pour ${invoice.prefix}${invoice.number}`);
        //   }
        // } catch (eReportingError) {
        //   logger.error("Erreur e-reporting payment:", eReportingError);
        // }

        // Envoyer la notification "Paiement reçu" si activée
        try {
          await notificationService.sendPaymentReceivedNotification({
            userId: user._id,
            invoice: invoice.toObject(),
            paymentDate: new Date(paymentDate),
          });
        } catch (notifError) {
          console.error(
            "Erreur lors de l'envoi de la notification:",
            notifError,
          );
          // Ne pas faire échouer la mutation si la notification échoue
        }

        // Exécuter les automatisations CRM si le client est lié
        if (invoice.client && invoice.client.id) {
          try {
            const clientId = invoice.client.id;

            // Vérifier si c'est la première facture payée
            const isFirstInvoice = await automationService.isFirstPaidInvoice(
              clientId,
              workspaceId,
              invoice._id,
            );

            // Exécuter les automatisations FIRST_INVOICE_PAID
            if (isFirstInvoice) {
              await automationService.executeAutomations(
                "FIRST_INVOICE_PAID",
                workspaceId,
                clientId,
                {
                  isFirstInvoice: true,
                  amount: invoice.finalTotalTTC,
                  invoiceId: invoice._id.toString(),
                },
              );
            }

            // Exécuter les automatisations INVOICE_PAID (pour toutes les factures)
            await automationService.executeAutomations(
              "INVOICE_PAID",
              workspaceId,
              clientId,
              {
                isFirstInvoice,
                amount: invoice.finalTotalTTC,
                invoiceId: invoice._id.toString(),
              },
            );
          } catch (automationError) {
            console.error(
              "Erreur lors de l'exécution des automatisations CRM:",
              automationError,
            );
            // Ne pas faire échouer la mutation si les automatisations échouent
          }
        }

        // Automatisations documents partagés (fire-and-forget, ne bloque pas la réponse)
        documentAutomationService
          .executeAutomations(
            "INVOICE_PAID",
            workspaceId,
            {
              documentId: invoice._id.toString(),
              documentType: "invoice",
              documentNumber: invoice.number,
              prefix: invoice.prefix || "",
              clientName: invoice.client?.name || "",
              issueDate: invoice.issueDate || invoice.createdAt,
              clientId: invoice.client?._id || invoice.clientId || null,
            },
            user._id.toString(),
          )
          .catch((err) =>
            console.error("Erreur automatisation documents (paid):", err),
          );

        // Sync Pennylane (fire-and-forget)
        syncInvoiceIfNeeded(invoice, workspaceId).catch((err) =>
          console.error("Erreur sync Pennylane (paid):", err),
        );

        return await invoice.populate("createdBy");
      },
    ),

    sendInvoice: requireWrite("invoices")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const invoice = await Invoice.findOne({ _id: id, workspaceId });

        if (!invoice) {
          throw createNotFoundError("Facture");
        }

        // Ici, vous pourriez implémenter la logique d'envoi d'email
        // Pour l'instant, nous simulons un succès
        // TODO: Implémenter l'envoi réel de la facture par email

        return true;
      },
    ),

    createLinkedInvoice: requireWrite("invoices")(
      async (
        _,
        { quoteId, amount, isDeposit, workspaceId: inputWorkspaceId },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        // Validation et conversion explicite du montant
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
          throw createValidationError("Montant invalide", {
            amount: "Le montant doit être un nombre positif",
          });
        }

        // Vérifier que le devis existe et appartient au workspace
        const quote = await Quote.findOne({ _id: quoteId, workspaceId });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        // Vérifier les informations de l'organisation
        const linkedInvoiceOrg = await getOrganizationInfo(workspaceId);
        if (!linkedInvoiceOrg?.companyName) {
          throw new AppError(
            "Vous devez configurer les informations de votre entreprise avant de créer une facture",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        // Vérifier que le devis est accepté
        if (quote.status !== "COMPLETED") {
          throw createValidationError(
            "Seuls les devis acceptés peuvent être convertis en factures liées",
            {
              status: "Le devis doit être accepté pour créer une facture liée",
            },
          );
        }

        // Vérifier le nombre de factures déjà liées (max 3)
        const linkedInvoicesCount = quote.linkedInvoices
          ? quote.linkedInvoices.length
          : 0;
        if (linkedInvoicesCount >= 3) {
          throw createValidationError("Limite de factures liées atteinte", {
            linkedInvoices: "Un devis ne peut avoir plus de 3 factures liées",
          });
        }

        // Calculer le montant total déjà facturé et vérifier les acomptes
        let totalInvoiced = 0;
        let hasDeposit = false;
        if (quote.linkedInvoices && quote.linkedInvoices.length > 0) {
          const existingInvoices = await Invoice.find({
            _id: { $in: quote.linkedInvoices },
            workspaceId: workspaceId,
          });
          totalInvoiced = existingInvoices.reduce(
            (sum, inv) => sum + (inv.finalTotalTTC || 0),
            0,
          );
          hasDeposit = existingInvoices.some((inv) => inv.isDeposit === true);
        }

        // Vérifier qu'il n'y a qu'un seul acompte
        if (isDeposit && hasDeposit) {
          throw createValidationError("Acompte déjà existant", {
            isDeposit: "Un devis ne peut avoir qu'un seul acompte",
          });
        }

        // Vérifier que le montant ne dépasse pas le total du devis
        const remainingAmount = quote.finalTotalTTC - totalInvoiced;

        if (numericAmount > remainingAmount) {
          console.error("Erreur de validation - Montant trop élevé:", {
            amount: numericAmount,
            remainingAmount,
            difference: numericAmount - remainingAmount,
          });
          throw createValidationError("Montant de facture invalide", {
            amount: `Le montant ne peut pas dépasser le reste à facturer (${remainingAmount.toFixed(
              2,
            )}€)`,
          });
        }

        // Si c'est la dernière facture possible (3ème facture OU reste exactement ce montant),
        // le montant doit être exactement égal au reste à facturer
        const isLastPossibleInvoice =
          linkedInvoicesCount === 2 || remainingAmount === numericAmount;
        if (linkedInvoicesCount === 2 && numericAmount !== remainingAmount) {
          throw createValidationError(
            "Montant de la dernière facture invalide",
            {
              amount: `La dernière facture liée doit être exactement égale au reste à facturer (${remainingAmount.toFixed(
                2,
              )}€)`,
            },
          );
        }

        // Générer le numéro de facture avec un préfixe de facture (pas celui du devis)
        const now = new Date();
        const prefix = `F-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
        const number = await generateInvoiceNumber(prefix, {
          isDraft: true,
          workspaceId: workspaceId,
        });

        // Calculer le prix HT pour obtenir le montant TTC exact
        // Si numericAmount = 120€ TTC avec 20% TVA, alors HT = 120 / 1.20 = 100€
        const vatRate = 20;
        const unitPriceHT = numericAmount / (1 + vatRate / 100);

        // Utiliser les paramètres par défaut de facture (organisation), pas ceux du devis
        const org = linkedInvoiceOrg;

        // Créer la facture avec les paramètres par défaut de facture (pas ceux du devis)
        const invoice = new Invoice({
          number,
          prefix,
          purchaseOrderNumber: `${quote.prefix}-${quote.number}`, // Référence au devis
          isDeposit,
          status: "DRAFT",
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 jours par défaut
          client: quote.client,
          companyInfo: undefined, // Draft - résolu dynamiquement via le field resolver
          sourceQuote: quote._id,

          // Créer un article unique avec le montant spécifié
          items: [
            {
              description: isDeposit
                ? `Acompte sur devis ${quote.prefix}-${quote.number}`
                : numericAmount >= remainingAmount - 0.01
                  ? `Facture sur devis ${quote.prefix}-${quote.number}`
                  : `Facture partielle sur devis ${quote.prefix}-${quote.number}`,
              quantity: 1,
              unitPrice: unitPriceHT,
              vatRate: vatRate,
              unit: "forfait",
              discount: 0,
              discountType: "FIXED",
              details: "",
              vatExemptionText: "",
            },
          ],

          // Paramètres par défaut de FACTURE (depuis l'organisation), pas ceux du devis
          headerNotes:
            org?.invoiceHeaderNotes || org?.documentHeaderNotes || "",
          footerNotes:
            org?.invoiceFooterNotes || org?.documentFooterNotes || "",
          termsAndConditions:
            org?.invoiceTermsAndConditions ||
            org?.documentTermsAndConditions ||
            "",
          termsAndConditionsLinkTitle: "",
          termsAndConditionsLink: "",

          // Apparence par défaut de facture
          appearance: {
            textColor:
              org?.invoiceTextColor || org?.documentTextColor || "#000000",
            headerTextColor:
              org?.invoiceHeaderTextColor ||
              org?.documentHeaderTextColor ||
              "#ffffff",
            headerBgColor:
              org?.invoiceHeaderBgColor ||
              org?.documentHeaderBgColor ||
              "#5b50FF",
          },
          showBankDetails: org?.showBankDetails || false,
          clientPositionRight: org?.invoiceClientPositionRight || false,

          discount: 0,
          discountType: "FIXED",
          customFields: [],
          createdBy: user._id, // ✅ Conservé pour audit trail
          workspaceId: workspaceId, // ✅ Ajout du workspaceId
        });

        // Calculer les totaux
        const totals = calculateInvoiceTotals(
          invoice.items,
          invoice.discount,
          invoice.discountType,
          invoice.shipping,
          invoice.isReverseCharge,
        );
        Object.assign(invoice, totals);

        // Vérifier que le montant TTC final correspond exactement au montant demandé
        // (avec une tolérance de 0.01€ pour les erreurs d'arrondi)
        if (Math.abs(invoice.finalTotalTTC - numericAmount) > 0.01) {
          console.warn(
            `Différence de montant détectée: demandé=${numericAmount}, calculé=${invoice.finalTotalTTC}`,
          );
          // Forcer le montant exact si nécessaire
          invoice.finalTotalTTC = numericAmount;
        }
        // Nettoyer les coordonnées bancaires si elles sont invalides
        if (invoice.companyInfo && invoice.companyInfo.bankDetails) {
          const { iban, bic, bankName } = invoice.companyInfo.bankDetails;

          // Si l'un des champs est vide ou manquant, supprimer complètement bankDetails
          if (!iban || !bic || !bankName) {
            delete invoice.companyInfo.bankDetails;
          }
        }

        // Sauvegarder la facture
        await invoice.save();

        // Ajouter la facture aux factures liées du devis
        if (!quote.linkedInvoices) {
          quote.linkedInvoices = [];
        }
        quote.linkedInvoices.push(invoice._id);
        await quote.save();

        // Retourner la facture et le devis mis à jour
        const populatedInvoice = await invoice.populate("createdBy");
        const updatedQuote = await Quote.findById(quote._id).populate({
          path: "linkedInvoices",
          select: "id number status finalTotalTTC isDeposit",
        });

        return {
          invoice: populatedInvoice,
          quote: updatedQuote,
        };
      },
    ),

    deleteLinkedInvoice: requireDelete("invoices")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );

        const invoice = await Invoice.findOne({ _id: id, workspaceId });

        if (!invoice) {
          throw createNotFoundError("Facture liée");
        }

        // Vérifier que c'est bien une facture liée à un devis
        let sourceQuoteId = invoice.sourceQuote;

        if (!sourceQuoteId) {
          // Essayer de trouver le devis qui contient cette facture dans ses linkedInvoices

          const quoteWithInvoice = await Quote.findOne({
            linkedInvoices: invoice._id,
            workspaceId,
          });

          if (quoteWithInvoice) {
            sourceQuoteId = quoteWithInvoice._id;

            // Mettre à jour la facture avec le sourceQuote manquant
            await Invoice.updateOne(
              { _id: invoice._id },
              { sourceQuote: sourceQuoteId },
            );
          } else {
            throw createValidationError("Facture non liée", {
              invoice: "Cette facture n'est pas liée à un devis",
            });
          }
        }

        // Vérifier que la facture peut être supprimée
        if (invoice.status === "COMPLETED" || invoice.status === "CANCELED") {
          throw createResourceLockedError(
            "Facture liée",
            `une facture ${
              invoice.status === "COMPLETED" ? "terminée" : "annulée"
            } ne peut pas être supprimée`,
          );
        }

        // Retirer la facture de la liste des factures liées du devis

        await Quote.updateOne(
          { _id: sourceQuoteId },
          { $pull: { linkedInvoices: invoice._id } },
        );

        // Supprimer la facture
        await Invoice.deleteOne({ _id: id, workspaceId });

        return true;
      },
    ),
  },
};

export default invoiceResolvers;
