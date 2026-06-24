import mongoose from "mongoose";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import {
  archiveDocumentPdf,
  documentUrl,
} from "../utils/documentArchiveHelper.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import Client from "../models/Client.js";
import SignatureRequest from "../models/SignatureRequest.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import {
  withRBAC,
  requireWrite,
  requireRead,
  requireDelete,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  generateQuoteNumber,
  generateInvoiceNumber,
} from "../utils/documentNumbers.js";
import {
  createNotFoundError,
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import {
  requireCompanyInfo,
  getOrganizationInfo,
} from "../middlewares/company-info-guard.js";
import { mapOrganizationToCompanyInfo } from "../utils/companyInfoMapper.js";
import documentAutomationService from "../services/documentAutomationService.js";
import { syncQuoteIfNeeded } from "../services/pennylaneSyncHelper.js";

// Fonction utilitaire pour calculer les totaux avec remise et livraison
export const calculateQuoteTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  shipping = null,
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

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

    const itemVAT = itemHT * (item.vatRate / 100);
    totalHT += itemHT;
    totalVAT += itemVAT;
  });

  // Ajouter les frais de livraison si facturés
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

const quoteResolvers = {
  Quote: {
    companyInfo: async (quote) => {
      // Pour les brouillons, toujours résoudre depuis l'organisation (données dynamiques)
      if (!quote.status || quote.status === "DRAFT") {
        try {
          const organization = await getOrganizationInfo(
            quote.workspaceId.toString(),
          );
          return mapOrganizationToCompanyInfo(organization);
        } catch (error) {
          console.error(
            "[Quote.companyInfo] Erreur résolution dynamique:",
            error.message,
          );
          if (quote.companyInfo && quote.companyInfo.name)
            return quote.companyInfo;
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
      if (quote.companyInfo && quote.companyInfo.name) {
        return quote.companyInfo;
      }
      // Fallback : résoudre depuis l'organisation
      try {
        const organization = await getOrganizationInfo(
          quote.workspaceId.toString(),
        );
        return mapOrganizationToCompanyInfo(organization);
      } catch (error) {
        console.error(
          "[Quote.companyInfo] Erreur résolution fallback:",
          error.message,
        );
        return {
          name: "",
          address: { street: "", city: "", postalCode: "", country: "France" },
        };
      }
    },
    client: async (quote) => {
      // Pour les brouillons, résoudre depuis la collection Client (données à jour)
      if ((!quote.status || quote.status === "DRAFT") && quote.client?.id) {
        try {
          const freshClient = await Client.findById(quote.client.id);
          if (freshClient) {
            return {
              id: freshClient._id.toString(),
              name: freshClient.name,
              email: freshClient.email,
              address: freshClient.address,
              type: freshClient.type,
              siret: freshClient.siret,
              vatNumber: freshClient.vatNumber,
              isInternational: freshClient.isInternational,
              firstName: freshClient.firstName,
              lastName: freshClient.lastName,
              hasDifferentShippingAddress:
                freshClient.hasDifferentShippingAddress,
              shippingAddress: freshClient.shippingAddress,
            };
          }
        } catch (error) {
          console.error(
            "[Quote.client] Erreur résolution dynamique:",
            error.message,
          );
        }
      }
      // Pour les documents finalisés ou en fallback, utiliser le snapshot embarqué
      return quote.client;
    },
    createdBy: async (quote) => {
      if (!quote.createdBy) return null;
      if (typeof quote.createdBy === "object" && quote.createdBy._id) {
        return quote.createdBy;
      }
      return await User.findById(quote.createdBy);
    },
    convertedToInvoice: async (quote) => {
      if (!quote.convertedToInvoice) return null;
      return await Invoice.findById(quote.convertedToInvoice);
    },
    linkedInvoices: async (quote) => {
      if (quote.linkedInvoices && quote.linkedInvoices.length > 0) {
        return await Invoice.find({
          _id: { $in: quote.linkedInvoices },
        });
      } else if (quote.convertedToInvoice) {
        const invoice = await Invoice.findById(quote.convertedToInvoice);
        return invoice ? [invoice] : [];
      }
      return [];
    },
    // Vrai si une facture existante a été créée via un bon de commande issu de ce devis
    hasPurchaseOrderInvoices: async (quote) => {
      const purchaseOrders = await PurchaseOrder.find({
        sourceQuoteId: quote._id,
        linkedInvoices: { $exists: true, $ne: [] },
      }).select("linkedInvoices");
      if (purchaseOrders.length === 0) return false;
      const invoiceIds = purchaseOrders.flatMap((po) => po.linkedInvoices);
      return !!(await Invoice.exists({ _id: { $in: invoiceIds } }));
    },
    // Calculer le total des factures de situation liées à ce devis
    situationInvoicedTotal: async (quote) => {
      const quoteRef = quote.prefix
        ? `${quote.prefix}-${quote.number}`
        : quote.number;

      // Utiliser aggregation pipeline pour calculer le total côté MongoDB
      const result = await Invoice.aggregate([
        {
          $match: {
            workspaceId: quote.workspaceId,
            invoiceType: "situation",
            purchaseOrderNumber: quoteRef,
          },
        },
        { $limit: 1000 },
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$_id",
            finalTotalTTC: { $first: "$finalTotalTTC" },
            hasItems: {
              $sum: { $cond: [{ $ifNull: ["$items", false] }, 1, 0] },
            },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$finalTotalTTC" },
          },
        },
      ]);

      return result[0]?.total || 0;
    },
  },
  Query: {
    // URL d'aperçu du devis archivé (R2) — null si brouillon / pas archivé
    quoteDocumentUrl: requireRead("quotes")(
      async (_, { workspaceId: inputWorkspaceId, quoteId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return documentUrl({
          Model: Quote,
          docType: "quote",
          draftStatus: "DRAFT",
          workspaceId,
          docId: quoteId,
        });
      },
    ),
    quote: requireRead("quotes")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const quote = await Quote.findOne({ _id: id, workspaceId })
          .populate("createdBy")
          .populate("convertedToInvoice");

        if (!quote) throw createNotFoundError("Devis");
        return quote;
      },
    ),

    quotes: requireRead("quotes")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          startDate,
          endDate,
          status,
          search,
          page = 1,
          limit = 10,
        },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
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
        const totalCount = await Quote.countDocuments(query);

        const quotes = await Quote.find(query)
          .populate("createdBy")
          .populate("convertedToInvoice")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        console.log(
          "📋 [QUOTES RESOLVER] Devis récupérés:",
          quotes.map((q) => ({
            id: q.id,
            number: q.number,
            createdBy: q.createdBy?.id,
          })),
        );

        return {
          quotes,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      },
    ),

    quoteStats: requireRead("quotes")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const [stats] = await Quote.aggregate([
          { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId) } },
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
                $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
              },
              canceledCount: {
                $sum: { $cond: [{ $eq: ["$status", "CANCELED"] }, 1, 0] },
              },
              totalAmount: { $sum: "$finalTotalTTC" },
              convertedCount: {
                $sum: {
                  $cond: [{ $ifNull: ["$convertedToInvoice", false] }, 1, 0],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              totalCount: 1,
              draftCount: 1,
              pendingCount: 1,
              canceledCount: 1,
              completedCount: 1,
              totalAmount: 1,
              conversionRate: {
                $cond: [
                  { $eq: ["$completedCount", 0] },
                  0,
                  { $divide: ["$convertedCount", "$completedCount"] },
                ],
              },
            },
          },
        ]);

        // Créer un objet avec des valeurs par défaut
        const defaultStats = {
          totalCount: 0,
          draftCount: 0,
          pendingCount: 0,
          canceledCount: 0,
          completedCount: 0,
          totalAmount: 0,
          conversionRate: 0,
        };

        // Si stats existe, s'assurer que tous les champs requis sont définis et non null
        if (stats) {
          // Remplacer toutes les valeurs null par 0
          Object.keys(defaultStats).forEach((key) => {
            if (stats[key] === null || stats[key] === undefined) {
              stats[key] = 0;
            }
          });
          return stats;
        }

        return defaultStats;
      },
    ),

    quoteBalances: requireRead("quotes")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wid = new mongoose.Types.ObjectId(workspaceId);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Agrégation des devis créés sur Newbi
        const [quoteStats] = await Quote.aggregate([
          { $match: { workspaceId: wid } },
          {
            $group: {
              _id: null,
              totalQuoted: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["PENDING", "COMPLETED", "IMPORTED"]] },
                    {
                      $ifNull: ["$finalTotalHT", { $ifNull: ["$totalHT", 0] }],
                    },
                    0,
                  ],
                },
              },
              totalAccepted: {
                $sum: {
                  $cond: [
                    { $eq: ["$status", "COMPLETED"] },
                    {
                      $ifNull: ["$finalTotalHT", { $ifNull: ["$totalHT", 0] }],
                    },
                    0,
                  ],
                },
              },
              pendingAmount: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["PENDING", "IMPORTED"]] },
                    {
                      $ifNull: ["$finalTotalHT", { $ifNull: ["$totalHT", 0] }],
                    },
                    0,
                  ],
                },
              },
              pendingCount: {
                $sum: {
                  $cond: [{ $in: ["$status", ["PENDING", "IMPORTED"]] }, 1, 0],
                },
              },
            },
          },
        ]);

        // Les soldes ne comptent que les vrais devis. Un import validé est
        // désormais représenté par un vrai devis (statut IMPORTED puis
        // COMPLETED/CANCELED) : on ne compte donc plus la collection
        // ImportedQuote, sous peine de double comptage et de montants fantômes
        // persistants après suppression du devis.
        const q = quoteStats || {
          totalQuoted: 0,
          totalAccepted: 0,
          pendingAmount: 0,
          pendingCount: 0,
        };

        return {
          totalQuoted: q.totalQuoted,
          totalAccepted: q.totalAccepted,
          pendingAmount: q.pendingAmount,
          pendingCount: q.pendingCount,
        };
      },
    ),

    nextQuoteNumber: requireRead("quotes")(
      async (
        _,
        { workspaceId: inputWorkspaceId, prefix, autoNumbering },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wsId = new mongoose.Types.ObjectId(workspaceId);
        const query = { workspaceId: wsId };

        if (!autoNumbering && prefix) {
          query.prefix = prefix;
        }

        const allQuotes = await Quote.find(query, { number: 1 }).lean();

        let maxNumber = 0;
        for (const q of allQuotes) {
          if (q.number && /^\d+$/.test(q.number)) {
            const num = parseInt(q.number, 10);
            if (num > maxNumber) maxNumber = num;
          }
        }
        return String(maxNumber + 1).padStart(4, "0");
      },
    ),

    // Récupérer un devis par son numéro (pour les factures de situation)
    quoteByNumber: requireRead("quotes")(
      async (_, { workspaceId: inputWorkspaceId, number }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        console.log("📋 [quoteByNumber] Recherche devis:", {
          workspaceId,
          number,
        });

        if (!number || number.trim() === "") {
          return null;
        }

        // Rechercher le devis par son numéro complet (prefix-number ou juste number)
        const trimmedNumber = number.trim();

        // Essayer de trouver avec le numéro exact
        let quote = await Quote.findOne({
          workspaceId,
          $or: [
            { number: trimmedNumber },
            // Si le numéro contient un tiret, essayer de matcher prefix-number
            {
              $expr: {
                $eq: [{ $concat: ["$prefix", "-", "$number"] }, trimmedNumber],
              },
            },
          ],
        }).populate("createdBy");

        console.log(
          "📋 [quoteByNumber] Première recherche:",
          quote
            ? {
                id: quote.id,
                number: quote.number,
                prefix: quote.prefix,
                finalTotalTTC: quote.finalTotalTTC,
              }
            : null,
        );

        // Si pas trouvé, essayer de parser le numéro (ex: "D-122024-000001" -> prefix="D-122024", number="000001")
        if (!quote && trimmedNumber.includes("-")) {
          const lastDashIndex = trimmedNumber.lastIndexOf("-");
          const possiblePrefix = trimmedNumber.substring(0, lastDashIndex);
          const possibleNumber = trimmedNumber.substring(lastDashIndex + 1);

          console.log("📋 [quoteByNumber] Parsing:", {
            possiblePrefix,
            possibleNumber,
          });

          quote = await Quote.findOne({
            workspaceId,
            prefix: possiblePrefix,
            number: possibleNumber,
          }).populate("createdBy");

          console.log(
            "📋 [quoteByNumber] Deuxième recherche:",
            quote
              ? {
                  id: quote.id,
                  number: quote.number,
                  prefix: quote.prefix,
                  finalTotalTTC: quote.finalTotalTTC,
                }
              : null,
          );
        }

        return quote;
      },
    ),

    checkQuoteNumberExists: requireRead("quotes")(
      async (
        _,
        { workspaceId: inputWorkspaceId, number, prefix, excludeId },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const query = { workspaceId, number, prefix, status: { $ne: "DRAFT" } };
        if (excludeId) {
          query._id = { $ne: excludeId };
        }
        const count = await Quote.countDocuments(query);
        return count > 0;
      },
    ),
  },

  Mutation: {
    // Archive le PDF du devis (généré côté frontend) sur R2
    archiveQuotePdf: requireWrite("quotes")(
      async (_, { workspaceId: inputWorkspaceId, quoteId, file }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return archiveDocumentPdf({
          Model: Quote,
          docType: "quote",
          draftStatus: "DRAFT",
          workspaceId,
          docId: quoteId,
          file,
        });
      },
    ),
    createQuote: requireCompanyInfo(
      requireWrite("quotes")(
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

          console.log("🔍 [createQuote] Input received:", {
            prefix: input.prefix,
            number: input.number,
            status: input.status,
          });

          // Utiliser le préfixe fourni, ou celui du dernier devis, ou 'D' par défaut
          let prefix = input.prefix;

          if (!prefix) {
            // Chercher le dernier devis créé pour récupérer son préfixe
            const lastQuote = await Quote.findOne({ workspaceId })
              .sort({ createdAt: -1 })
              .select("prefix")
              .lean();

            if (lastQuote && lastQuote.prefix) {
              prefix = lastQuote.prefix;
            } else {
              // Aucun devis existant, utiliser le préfixe par défaut
              const now = new Date();
              const year = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, "0");
              prefix = `D-${month}${year}`;
            }
          }

          // === Génération du numéro (style Pennylane) ===
          // Règles légales (Art. 242 nonies A CGI) : unicité, chronologie, continuité.
          //   - Compteur atomique (DocumentCounter) pour éviter toute race condition
          //   - Numéro manuel autorisé UNIQUEMENT avant le 1er devis finalisé du préfixe
          //     (équivalent Pennylane : "le compteur ne peut plus être modifié après la 1ère facture")
          //   - Brouillons hors séquence (numéros DRAFT-timestamp indépendants)
          // Le numéro est régénéré à chaque tentative dans la boucle de retry (cf. save plus bas).

          // Renomme les brouillons qui entreraient en conflit avec le numéro séquentiel généré
          const handleDraftConflicts = async (newNumber) => {
            const conflictingDrafts = await Quote.find({
              prefix,
              number: newNumber,
              status: "DRAFT",
              workspaceId,
            });
            if (conflictingDrafts.length === 0) return;
            const bulkOps = conflictingDrafts.map((draft) => ({
              updateOne: {
                filter: { _id: draft._id },
                update: {
                  $set: {
                    number: `${newNumber}-${Date.now()}${Math.floor(Math.random() * 1000)}`,
                  },
                },
              },
            }));
            await Quote.bulkWrite(bulkOps);
          };

          const isDraft = !input.status || input.status === "DRAFT";

          // Verrou Pennylane : un numéro manuel n'est accepté que s'il n'existe encore
          // aucun devis finalisé pour ce préfixe (1er document du compteur).
          let allowManualNumber = false;
          if (input.number && !isDraft) {
            const firstFinalizedForPrefix = await Quote.findOne({
              workspaceId,
              prefix,
              status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
            }).lean();
            allowManualNumber = !firstFinalizedForPrefix;
            if (allowManualNumber && !/^\d{1,6}$/.test(input.number)) {
              throw new AppError(
                "Le numéro de devis doit contenir entre 1 et 6 chiffres",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
          }

          // Fonction unifiée appelée à chaque tentative de save (retry loop plus bas)
          // Padding 4 chiffres = aligné avec les hooks frontend (useQuoteNumber)
          const generateNumber = async () => {
            if (allowManualNumber) {
              return String(parseInt(input.number, 10)).padStart(4, "0");
            }
            return await generateQuoteNumber(prefix, {
              isDraft,
              workspaceId,
              userId: user.id,
            });
          };

          // Récupérer les informations de l'organisation
          const organization = await getOrganizationInfo(workspaceId);

          if (!organization?.companyName) {
            throw new AppError(
              "Les informations de votre entreprise doivent être configurées avant de créer un devis",
              ERROR_CODES.COMPANY_INFO_REQUIRED,
            );
          }

          // Calculer les totaux avec la remise et la livraison
          const totals = calculateQuoteTotals(
            input.items,
            input.discount,
            input.discountType,
            input.shipping,
          );

          // Vérifier si le client a une adresse de livraison différente
          const clientData = input.client;

          // Si le client a un ID, c'est un client existant - pas besoin de vérifier l'unicité de l'email
          // Seuls les nouveaux clients (sans ID) doivent être vérifiés pour éviter les doublons
          if (!clientData.id) {
            // Vérifier si un client avec cet email existe déjà dans les devis ou factures
            const existingQuote = await Quote.findOne({
              "client.email": clientData.email.toLowerCase(),
              workspaceId,
              createdBy: user.id,
            });

            const existingInvoice = await Invoice.findOne({
              "client.email": clientData.email.toLowerCase(),
              workspaceId,
              createdBy: user.id,
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
                "client.shippingAddress": "L'adresse de livraison est requise",
              },
            );
          }

          // Générer automatiquement le nom pour les clients particuliers si nécessaire
          if (
            clientData.type === "INDIVIDUAL" &&
            (!clientData.name || clientData.name.trim() === "")
          ) {
            if (clientData.firstName && clientData.lastName) {
              clientData.name = `${clientData.firstName} ${clientData.lastName}`;
            } else {
              // Fallback si les champs firstName/lastName sont manquants
              clientData.name = clientData.email
                ? `Client ${clientData.email}`
                : "Client Particulier";
            }
          }

          // Création avec retry sur E11000 : si le numéro entre en collision
          // (race condition, index legacy résiduel, ou brouillon conflictuel),
          // on régénère via le compteur atomique et on retente. Max 5 tentatives.
          const MAX_SAVE_RETRIES = 5;
          let quote;
          let number;
          for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
            number = await generateNumber();
            await handleDraftConflicts(number);

            quote = new Quote({
              ...input,
              number,
              prefix,
              workspaceId,
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
              appearance: input.appearance || {
                textColor: "#000000",
                headerTextColor: "#ffffff",
                headerBgColor: "#1d1d1b",
              },
              createdBy: user.id,
              ...totals,
            });

            try {
              await quote.save();
              break;
            } catch (err) {
              const isDuplicateKey =
                err && (err.code === 11000 || err.code === 11001);
              if (!isDuplicateKey) throw err;
              // Numéro manuel rejeté : ne pas retry indéfiniment, remonter une erreur claire
              if (allowManualNumber) {
                throw new AppError(
                  "Ce numéro de devis est déjà utilisé",
                  ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER,
                );
              }
              if (attempt === MAX_SAVE_RETRIES) {
                console.error(
                  "[createQuote] Échec après retries E11000:",
                  err.keyValue,
                );
                throw new AppError(
                  "Impossible de générer un numéro de devis unique. Veuillez réessayer.",
                  ERROR_CODES.INTERNAL_ERROR,
                );
              }
              console.warn(
                `[createQuote] Conflit E11000 tentative ${attempt}/${MAX_SAVE_RETRIES}, retry:`,
                err.keyValue,
              );
            }
          }

          // Enregistrer l'activité dans le client si c'est un client existant
          if (clientData.id) {
            try {
              await Client.findByIdAndUpdate(clientData.id, {
                $push: {
                  activity: {
                    id: new mongoose.Types.ObjectId().toString(),
                    type: "quote_created",
                    description: `a créé le devis ${prefix}${number}`,
                    userId: user._id,
                    userName: user.name || user.email,
                    userImage: user.image || null,
                    metadata: {
                      documentType: "quote",
                      documentId: quote._id.toString(),
                      documentNumber: `${prefix}-${number}`,
                      status: quote.status,
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
              // Ne pas faire échouer la création de devis si l'activité échoue
            }
          }

          // Automatisations documents partagés pour les brouillons (fire-and-forget)
          if (quote.status === "DRAFT") {
            documentAutomationService
              .executeAutomations(
                "QUOTE_DRAFT",
                workspaceId,
                {
                  documentId: quote._id.toString(),
                  documentType: "quote",
                  documentNumber: quote.number,
                  prefix: quote.prefix || "",
                  clientName: quote.client?.name || "",
                  issueDate: quote.issueDate || quote.createdAt,
                  clientId: quote.client?._id || quote.clientId || null,
                },
                user._id.toString(),
              )
              .catch((err) =>
                console.error(
                  "Erreur automatisation documents (quote draft):",
                  err,
                ),
              );
          }

          return await quote.populate("createdBy");
        },
      ),
    ),

    updateQuote: requireCompanyInfo(
      requireWrite("quotes")(async (_, { id, input }, context) => {
        const { user, workspaceId } = context;
        // ✅ FIX: Utiliser workspaceId au lieu de createdBy pour permettre aux membres de l'org de voir/modifier
        const quote = await Quote.findOne({
          _id: id,
          workspaceId: workspaceId,
        });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        if (quote.status === "COMPLETED") {
          throw createResourceLockedError(
            "Devis",
            "un devis terminé ne peut pas être modifié",
          );
        }

        if (quote.status === "IMPORTED") {
          throw createResourceLockedError(
            "Devis",
            "un devis importé ne peut pas être modifié",
          );
        }

        if (quote.convertedToInvoice) {
          throw createResourceLockedError(
            "Devis",
            "un devis converti en facture ne peut pas être modifié",
          );
        }

        // Validation : empêcher le changement d'année de issueDate sur un devis finalisé
        if (input.issueDate && quote.status !== "DRAFT" && quote.issueDate) {
          const oldYear = new Date(quote.issueDate).getFullYear();
          const newYear = new Date(input.issueDate).getFullYear();
          if (oldYear !== newYear) {
            throw createValidationError(
              `Impossible de changer l'année d'émission d'un devis finalisé (${oldYear} → ${newYear}). Cela casserait la séquence de numérotation.`,
              {
                issueDate: `L'année d'émission ne peut pas être modifiée de ${oldYear} à ${newYear} sur un devis finalisé.`,
              },
            );
          }
        }

        // Vérifier si un nouveau numéro est fourni
        if (input.number && input.number !== quote.number) {
          // Vérifier si le numéro fourni existe déjà
          const existingQuote = await Quote.findOne({
            number: input.number,
            _id: { $ne: id }, // Exclure le devis actuel de la recherche
          });

          if (existingQuote) {
            throw new AppError(
              "Ce numéro de devis est déjà utilisé",
              ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER,
            );
          }
        }

        // Si des items sont fournis, recalculer les totaux
        if (input.items) {
          const totals = calculateQuoteTotals(
            input.items,
            input.discount !== undefined ? input.discount : quote.discount,
            input.discountType || quote.discountType,
            input.shipping !== undefined ? input.shipping : quote.shipping,
          );
          input = { ...input, ...totals };
        }

        // Préparer les données à mettre à jour
        let updateData = { ...input };

        // Vérifier si le client a une adresse de livraison différente
        if (
          updateData.client &&
          updateData.client.hasDifferentShippingAddress === true &&
          !updateData.client.shippingAddress
        ) {
          throw createValidationError(
            "L'adresse de livraison est requise lorsque l'option \"Adresse de livraison différente\" est activée",
            { "client.shippingAddress": "L'adresse de livraison est requise" },
          );
        }

        // Ne pas persister companyInfo pour les documents DRAFT
        delete updateData.companyInfo;

        // Pour les brouillons, rafraîchir les données client depuis la collection Client
        if (
          (!quote.status || quote.status === "DRAFT") &&
          (updateData.client?.id || quote.client?.id)
        ) {
          const clientId = updateData.client?.id || quote.client?.id;
          try {
            const freshClient = await Client.findById(clientId);
            if (freshClient) {
              updateData.client = {
                id: freshClient._id.toString(),
                type: freshClient.type,
                name: freshClient.name,
                firstName: freshClient.firstName,
                lastName: freshClient.lastName,
                email: freshClient.email,
                address: freshClient.address,
                hasDifferentShippingAddress:
                  freshClient.hasDifferentShippingAddress,
                shippingAddress: freshClient.shippingAddress,
                isInternational: freshClient.isInternational,
                siret: freshClient.siret,
                vatNumber: freshClient.vatNumber,
              };
            }
          } catch (error) {
            console.error(
              "[updateQuote] Erreur rafraîchissement client:",
              error.message,
            );
          }
        }

        // Gérer la transition DRAFT → PENDING : générer automatiquement le numéro séquentiel
        if (quote.status === "DRAFT" && updateData.status === "PENDING") {
          // Snapshot companyInfo à la finalisation
          if (!quote.companyInfo || !quote.companyInfo.name) {
            const org = await getOrganizationInfo(quote.workspaceId);
            updateData.companyInfo = mapOrganizationToCompanyInfo(org);
          }

          // Snapshot client à la finalisation (si pas déjà rafraîchi)
          const clientId = updateData.client?.id || quote.client?.id;
          if (clientId && !updateData.client) {
            try {
              const freshClient = await Client.findById(clientId);
              if (freshClient) {
                updateData.client = {
                  id: freshClient._id.toString(),
                  type: freshClient.type,
                  name: freshClient.name,
                  firstName: freshClient.firstName,
                  lastName: freshClient.lastName,
                  email: freshClient.email,
                  address: freshClient.address,
                  hasDifferentShippingAddress:
                    freshClient.hasDifferentShippingAddress,
                  shippingAddress: freshClient.shippingAddress,
                  isInternational: freshClient.isInternational,
                  siret: freshClient.siret,
                  vatNumber: freshClient.vatNumber,
                };
              }
            } catch (error) {
              console.error(
                "[updateQuote] Erreur snapshot client à la finalisation:",
                error.message,
              );
            }
          }
          console.log("🔍 [updateQuote] DRAFT → PENDING transition detected");
          console.log("🔍 [updateQuote] Current number:", quote.number);
          console.log("🔍 [updateQuote] Input number:", input.number);
          console.log("🔍 [updateQuote] Input prefix:", input.prefix);

          try {
            // Si le numéro ou le prefix ne sont pas fournis dans l'input, générer automatiquement
            if (!input.number || !input.prefix) {
              // Récupérer le préfixe du dernier devis créé (non-DRAFT)
              const lastQuote = await Quote.findOne({
                workspaceId: quote.workspaceId,
                status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
              })
                .sort({ createdAt: -1 })
                .select("prefix")
                .lean();

              // Définir l'année et la date pour les fonctions de génération de numéro
              const now = new Date();
              const year = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, "0");

              let prefix;
              if (lastQuote && lastQuote.prefix) {
                // Utiliser le préfixe du dernier devis
                prefix = lastQuote.prefix;
              } else {
                // Aucun devis existant, utiliser le préfixe par défaut
                prefix = `D-${month}${year}`;
              }

              console.log("🔍 [updateQuote] Using prefix:", prefix);

              // Générer le prochain numéro séquentiel
              const newNumber = await generateQuoteNumber(prefix, {
                isValidatingDraft: true,
                currentDraftNumber: quote.number,
                workspaceId: quote.workspaceId,
                userId: user.id,
                currentQuoteId: quote._id,
              });

              console.log("✅ [updateQuote] Generated new number:", newNumber);

              // Mettre à jour le numéro et le préfixe
              updateData.number = newNumber;
              updateData.prefix = prefix;
            }
          } catch (error) {
            console.error(
              "❌ [updateQuote] Error generating quote number:",
              error,
            );
            throw new AppError(
              "Erreur lors de la génération du numéro de devis",
              ERROR_CODES.INTERNAL_ERROR,
            );
          }
        }

        Object.assign(quote, updateData);
        await quote.save();
        return await quote.populate("createdBy");
      }),
    ),

    deleteQuote: requireCompanyInfo(
      requireDelete("quotes")(async (_, { id }, context) => {
        const { user, workspaceId } = context;
        // ✅ FIX: Utiliser workspaceId au lieu de createdBy
        const quote = await Quote.findOne({
          _id: id,
          workspaceId: workspaceId,
        });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        // Les devis issus d'un import (préfixe vide) restent supprimables quel
        // que soit leur statut, y compris une fois acceptés (COMPLETED).
        const isImportedOrigin = !quote.prefix && Boolean(quote.number);

        if (quote.status === "COMPLETED" && !isImportedOrigin) {
          throw createResourceLockedError(
            "Devis",
            "un devis terminé ne peut pas être supprimé",
          );
        }

        if (quote.convertedToInvoice) {
          throw createResourceLockedError(
            "Devis",
            "un devis converti en facture ne peut pas être supprimé",
          );
        }

        await Quote.deleteOne({ _id: id, workspaceId: workspaceId });
        return true;
      }),
    ),

    changeQuoteStatus: requireCompanyInfo(
      requireWrite("quotes")(async (_, { id, status }, context) => {
        const { user } = context;
        const workspaceId = context.workspaceId || context.organizationId;
        // ✅ FIX: Utiliser workspaceId au lieu de createdBy
        const quote = await Quote.findOne({
          _id: id,
          workspaceId: workspaceId,
        });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        if (quote.convertedToInvoice) {
          throw createResourceLockedError("Devis", "converti en facture");
        }

        // Vérification des transitions de statut autorisées
        const allowedTransitions = {
          DRAFT: ["PENDING"],
          PENDING: ["COMPLETED", "DRAFT", "CANCELED"],
          COMPLETED: [],
          CANCELED: [],
          // Un devis importé ne peut qu'être accepté ou refusé (pas d'édition).
          IMPORTED: ["COMPLETED", "CANCELED"],
        };

        if (!allowedTransitions[quote.status].includes(status)) {
          throw createStatusTransitionError("Devis", quote.status, status);
        }

        // Un devis natif (PENDING) ne peut être accepté que si le CLIENT l'a signé
        // (SES ou QES_otp = « bon pour accord »). Le QES automatique est un cachet de
        // la société et ne vaut pas acceptation. Les devis importés (IMPORTED) restent
        // acceptables manuellement sans signature.
        if (status === "COMPLETED" && quote.status === "PENDING") {
          const clientSignature = await SignatureRequest.findOne({
            documentType: "quote",
            documentId: quote._id,
            signatureType: { $ne: "QES_automatic" },
            status: "DONE",
          });

          if (!clientSignature) {
            throw createValidationError(
              "Ce devis doit être signé par le client avant de pouvoir être accepté. Envoyez-le pour signature : il sera accepté automatiquement une fois signé.",
            );
          }
        }

        const oldStatus = quote.status;

        // Si le devis passe de DRAFT à PENDING, snapshot companyInfo + client et générer un nouveau numéro séquentiel
        if (quote.status === "DRAFT" && status === "PENDING") {
          // Snapshot companyInfo à la finalisation
          if (!quote.companyInfo || !quote.companyInfo.name) {
            const org = await getOrganizationInfo(workspaceId);
            quote.companyInfo = mapOrganizationToCompanyInfo(org);
          }

          // Snapshot client à la finalisation (données à jour depuis la collection Client)
          if (quote.client?.id) {
            try {
              const freshClient = await Client.findById(quote.client.id);
              if (freshClient) {
                quote.client = {
                  id: freshClient._id.toString(),
                  type: freshClient.type,
                  name: freshClient.name,
                  firstName: freshClient.firstName,
                  lastName: freshClient.lastName,
                  email: freshClient.email,
                  address: freshClient.address,
                  hasDifferentShippingAddress:
                    freshClient.hasDifferentShippingAddress,
                  shippingAddress: freshClient.shippingAddress,
                  isInternational: freshClient.isInternational,
                  siret: freshClient.siret,
                  vatNumber: freshClient.vatNumber,
                };
              }
            } catch (error) {
              console.error(
                "[changeQuoteStatus] Erreur snapshot client:",
                error.message,
              );
            }
          }

          // Transaction atomique pour éviter les numéros TEMP orphelins
          const MAX_RETRIES = 3;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const session = await mongoose.startSession();
            try {
              await session.withTransaction(async () => {
                // Récupérer le préfixe du dernier devis créé (non-DRAFT)
                const lastQuote = await Quote.findOne(
                  {
                    workspaceId: quote.workspaceId,
                    status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
                  },
                  null,
                  { session },
                )
                  .sort({ createdAt: -1 })
                  .select("prefix")
                  .lean();

                // Utiliser l'année de issueDate du document, pas la date serveur
                const year = (quote.issueDate || new Date()).getFullYear();
                const month = String(
                  (quote.issueDate || new Date()).getMonth() + 1,
                ).padStart(2, "0");

                let prefix;
                if (lastQuote && lastQuote.prefix) {
                  prefix = lastQuote.prefix;
                } else {
                  prefix = `D-${month}${year}`;
                }

                console.log(
                  "🔍 [changeQuoteStatus] DRAFT → PENDING, prefix:",
                  prefix,
                );

                const originalDraftNumber = quote.number;
                let finalNumber = originalDraftNumber;
                let swapQuoteId = null;
                let swapOriginalNumber = null;

                if (originalDraftNumber.endsWith("-DRAFT")) {
                  const baseNumber = originalDraftNumber.replace("-DRAFT", "");

                  const existingQuote = await Quote.findOne(
                    {
                      number: baseNumber,
                      workspaceId: quote.workspaceId,
                      _id: { $ne: quote._id },
                    },
                    null,
                    { session },
                  );

                  if (existingQuote) {
                    if (existingQuote.status === "DRAFT") {
                      await Quote.findByIdAndUpdate(
                        existingQuote._id,
                        {
                          number: `TEMP-${baseNumber}`,
                        },
                        { session },
                      );
                      finalNumber = baseNumber;
                      swapQuoteId = existingQuote._id;
                      swapOriginalNumber = originalDraftNumber;
                    } else {
                      finalNumber = await generateQuoteNumber(prefix, {
                        workspaceId: quote.workspaceId,
                        userId: user.id,
                        currentQuoteId: quote._id,
                        session,
                      });
                    }
                  } else {
                    finalNumber = baseNumber;
                  }
                } else {
                  finalNumber = await generateQuoteNumber(prefix, {
                    isValidatingDraft: true,
                    currentDraftNumber: originalDraftNumber,
                    workspaceId: quote.workspaceId,
                    userId: user.id,
                    currentQuoteId: quote._id,
                    session,
                  });
                }

                // Numéro temporaire pour éviter les erreurs de clé dupliquée
                quote.number = `TEMP-${Date.now()}`;
                await quote.save({ session });

                // Mettre à jour avec le numéro final
                quote.number = finalNumber;
                quote.prefix = prefix;
                quote.status = status;
                await quote.save({ session });

                // ÉTAPE 3 du swap si nécessaire
                if (swapQuoteId && swapOriginalNumber) {
                  await Quote.findByIdAndUpdate(
                    swapQuoteId,
                    {
                      number: swapOriginalNumber,
                    },
                    { session },
                  );
                }
              });
              session.endSession();
              break;
            } catch (err) {
              session.endSession();
              if (err.code === 11000 && attempt < MAX_RETRIES - 1) {
                console.log(
                  `⚠️ [changeQuoteStatus] E11000 retry attempt ${attempt + 1}`,
                );
                continue;
              }
              throw err;
            }
          }
        } else {
          quote.status = status;
          await quote.save();
        }

        // Enregistrer l'activité dans le client si c'est un client existant
        if (quote.client && quote.client.id) {
          try {
            const statusLabels = {
              DRAFT: "Brouillon",
              PENDING: "En attente",
              COMPLETED: "Accepté",
              CANCELED: "Refusé",
            };

            await Client.findByIdAndUpdate(quote.client.id, {
              $push: {
                activity: {
                  id: new mongoose.Types.ObjectId().toString(),
                  type: "quote_status_changed",
                  description: `a changé le statut du devis ${quote.prefix}-${quote.number} de "${statusLabels[oldStatus]}" à "${statusLabels[status]}"`,
                  userId: user._id,
                  userName: user.name || user.email,
                  userImage: user.image || null,
                  metadata: {
                    documentType: "quote",
                    documentId: quote._id.toString(),
                    documentNumber: `${quote.prefix}-${quote.number}`,
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
          PENDING: "QUOTE_SENT",
          COMPLETED: "QUOTE_ACCEPTED",
          CANCELED: "QUOTE_CANCELED",
        };
        const docTrigger = triggerMap[status];
        if (docTrigger) {
          documentAutomationService
            .executeAutomations(
              docTrigger,
              workspaceId,
              {
                documentId: quote._id.toString(),
                documentType: "quote",
                documentNumber: quote.number,
                prefix: quote.prefix || "",
                clientName: quote.client?.name || "",
                issueDate: quote.issueDate || quote.createdAt,
                clientId: quote.client?._id || quote.clientId || null,
              },
              user._id.toString(),
            )
            .catch((err) =>
              console.error("Erreur automatisation documents (devis):", err),
            );
        }

        // Sync Pennylane (fire-and-forget) — devis accepté → Pennylane Quotes
        if (status === "COMPLETED") {
          syncQuoteIfNeeded(quote, context.organizationId || workspaceId).catch(
            (err) => console.error("Erreur sync Pennylane devis:", err),
          );
        }

        return await quote.populate("createdBy");
      }),
    ),

    convertQuoteToInvoice: requireWrite("quotes")(
      async (_, { id, distribution, isDeposit, skipValidation }, context) => {
        const { user, workspaceId } = context;
        // ✅ FIX: Utiliser workspaceId au lieu de createdBy
        const quote = await Quote.findOne({
          _id: id,
          workspaceId: workspaceId,
        });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        if (quote.status !== "COMPLETED") {
          throw new AppError(
            "Seuls les devis terminés peuvent être convertis en factures",
            ERROR_CODES.RESOURCE_LOCKED,
            {
              resource: "Devis",
              requiredStatus: "COMPLETED",
              currentStatus: quote.status,
            },
          );
        }

        // Montant total du devis
        const quoteAmount = quote.finalTotalTTC;

        // Calculer le montant total des factures déjà liées au devis
        let existingInvoicesTotalAmount = 0;
        let validLinkedInvoices = [];

        if (quote.linkedInvoices && quote.linkedInvoices.length > 0) {
          // Récupérer toutes les factures déjà liées au devis qui existent encore
          const existingInvoices = await Invoice.find({
            _id: { $in: quote.linkedInvoices },
          });

          // Mettre à jour la liste des factures liées valides
          validLinkedInvoices = existingInvoices.map((invoice) => invoice._id);

          // Nettoyer la liste des factures liées en supprimant les références aux factures qui n'existent plus
          if (validLinkedInvoices.length !== quote.linkedInvoices.length) {
            quote.linkedInvoices = validLinkedInvoices;
            await quote.save();
          }

          // Calculer le montant total des factures existantes
          existingInvoicesTotalAmount = existingInvoices.reduce(
            (sum, invoice) => sum + invoice.finalTotalTTC,
            0,
          );

          // Montant total des factures existantes: ${existingInvoicesTotalAmount}€
        }

        // Pour la rétrocompatibilité, vérifier aussi convertedToInvoice
        if (quote.convertedToInvoice) {
          // Vérifier si la facture référencée dans convertedToInvoice existe toujours
          const convertedInvoiceExists = await Invoice.exists({
            _id: quote.convertedToInvoice,
          });

          if (!convertedInvoiceExists) {
            // Si la facture n'existe plus, réinitialiser le champ convertedToInvoice
            quote.convertedToInvoice = null;
            await quote.save();
          } else if (
            !quote.linkedInvoices?.includes(quote.convertedToInvoice)
          ) {
            throw createResourceLockedError(
              "Devis",
              "déjà converti en facture",
            );
          }
        }

        // Empêcher la double facturation : si un bon de commande issu de ce devis
        // a déjà été converti en facture, le devis ne peut plus être facturé directement
        const purchaseOrdersWithInvoices = await PurchaseOrder.find({
          sourceQuoteId: quote._id,
          workspaceId,
          linkedInvoices: { $exists: true, $ne: [] },
        }).select("linkedInvoices");

        if (purchaseOrdersWithInvoices.length > 0) {
          const poInvoiceIds = purchaseOrdersWithInvoices.flatMap(
            (po) => po.linkedInvoices,
          );
          const poInvoiceExists = await Invoice.exists({
            _id: { $in: poInvoiceIds },
          });

          if (poInvoiceExists) {
            throw new AppError(
              "Ce devis a déjà été facturé via un bon de commande. Impossible de le convertir directement en facture.",
              ERROR_CODES.RESOURCE_LOCKED,
              {
                resource: "Devis",
                reason: "ALREADY_INVOICED_VIA_PURCHASE_ORDER",
              },
            );
          }
        }

        // Utiliser le préfixe standard pour les factures (F-AAAAMM-)
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const prefix = `F-${year}${month}`;

        // Par défaut, créer une seule facture pour le montant total
        const invoiceDistribution = distribution || [100];
        const invoiceCount = invoiceDistribution.length;

        // Calculer le pourcentage déjà utilisé par les factures existantes
        let existingInvoicesPercentage = 0;

        if (existingInvoicesTotalAmount > 0 && quoteAmount > 0) {
          existingInvoicesPercentage =
            (existingInvoicesTotalAmount / quoteAmount) * 100;
        }

        // Vérifier que la somme des pourcentages est bien égale à 100%
        const newInvoicesPercentage = invoiceDistribution.reduce(
          (sum, percent) => sum + percent,
          0,
        );
        const totalPercentage =
          existingInvoicesPercentage + newInvoicesPercentage;

        // Si skipValidation est true (pour les factures d'acompte), on ignore cette vérification
        if (!skipValidation && Math.abs(totalPercentage - 100) > 0.01) {
          // Tolérance pour les erreurs d'arrondi
          // Ne pas ajuster automatiquement, respecter le choix de l'utilisateur
          // Vérifier simplement que le total ne dépasse pas 100%
          if (totalPercentage > 100.01) {
            throw new AppError(
              `La somme des pourcentages de répartition (${newInvoicesPercentage.toFixed(
                2,
              )}% + ${existingInvoicesPercentage.toFixed(
                2,
              )}% déjà facturé) ne peut pas dépasser 100% (actuellement ${totalPercentage.toFixed(
                2,
              )}%)`,
              ERROR_CODES.INVALID_INPUT,
              {
                existingPercentage: existingInvoicesPercentage,
                newPercentage: newInvoicesPercentage,
                total: totalPercentage,
              },
            );
          }

          // Si le total est inférieur à 100%, c'est acceptable
          // L'utilisateur pourra créer d'autres factures plus tard pour atteindre 100%
        }

        // Cette section a été déplacée plus haut

        // Récupérer les informations de l'organisation en utilisant la fonction utilitaire
        const organization = await getOrganizationInfo(quote.workspaceId);

        // Vérifier que le nom de l'entreprise est défini
        if (
          !organization.companyName ||
          organization.companyName.trim() === ""
        ) {
          throw new AppError(
            "Le nom de votre entreprise doit être défini dans les paramètres de l'organisation avant de créer une facture",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        // Vérifier les informations légales requises selon le statut juridique
        const legalForm = organization.legalForm || "AUTRE";
        const requiredForVATStatuses = [
          "SARL",
          "SAS",
          "EURL",
          "SASU",
          "SA",
          "SNC",
          "SCOP",
        ];

        if (requiredForVATStatuses.includes(legalForm)) {
          if (!organization.vatNumber || organization.vatNumber.trim() === "") {
            throw new AppError(
              `Le numéro de TVA est obligatoire pour le statut juridique "${legalForm}". Veuillez compléter les informations légales de votre entreprise dans les paramètres de l'organisation.`,
              ERROR_CODES.VALIDATION_ERROR,
              {
                field: "vatNumber",
                legalForm: legalForm,
                requiredFields: ["vatNumber"],
              },
            );
          }

          if (!organization.siret || organization.siret.trim() === "") {
            throw new AppError(
              `Le numéro SIRET est obligatoire pour le statut juridique "${legalForm}". Veuillez compléter les informations légales de votre entreprise dans les paramètres de l'organisation.`,
              ERROR_CODES.VALIDATION_ERROR,
              {
                field: "siret",
                legalForm: legalForm,
                requiredFields: ["siret"],
              },
            );
          }
        }

        // Créer les factures selon la répartition
        const createdInvoices = [];
        let mainInvoice = null;
        let newInvoicesTotalAmount = 0;

        // Calculer le montant restant disponible pour de nouvelles factures
        const remainingAmount = quoteAmount - existingInvoicesTotalAmount;

        if (remainingAmount <= 0) {
          throw new AppError(
            `Le montant total des factures existantes (${existingInvoicesTotalAmount.toFixed(
              2,
            )}€) a déjà atteint ou dépassé le montant du devis (${quoteAmount.toFixed(
              2,
            )}€)`,
            ERROR_CODES.RESOURCE_LOCKED,
            {
              resource: "Devis",
              quoteAmount,
              existingInvoicesTotalAmount,
              remainingAmount,
            },
          );
        }

        // Montant restant disponible pour de nouvelles factures: ${remainingAmount.toFixed(2)}€

        for (let i = 0; i < invoiceCount; i++) {
          // Générer un nouveau numéro de facture avec ce préfixe au moment de la création
          // Cela garantit que le numéro est séquentiel par rapport aux autres factures déjà créées
          // Utiliser la logique DRAFT-ID pour gérer les conflits avec les brouillons existants
          const number = await generateInvoiceNumber(prefix, {
            isDraft: true, // Les factures créées depuis un devis sont toujours des brouillons
            workspaceId: quote.workspaceId,
            userId: user.id,
          });

          // Calculer les montants en fonction du pourcentage
          const percentage = invoiceDistribution[i] / 100;
          const totalHT = quote.totalHT * percentage;
          const totalVAT = quote.totalVAT * percentage;
          const totalTTC = quote.totalTTC * percentage;
          const finalTotalHT = quote.finalTotalHT * percentage;
          const finalTotalTTC = quote.finalTotalTTC * percentage;
          const discountAmount = quote.discountAmount * percentage;

          // Ajouter au montant total des nouvelles factures
          newInvoicesTotalAmount += finalTotalTTC;

          // Déterminer s'il s'agit d'une facture d'acompte
          const isInvoiceDeposit = isDeposit === true;

          // Convertir les sous-documents Mongoose en objets simples pour une copie correcte
          const quoteObj = quote.toObject();

          // Créer la facture à partir du devis (en DRAFT, pas de companyInfo embarqué)
          const invoice = new Invoice({
            number,
            prefix,
            client: quoteObj.client,
            companyInfo: undefined, // Draft - résolu dynamiquement via le field resolver
            items: quoteObj.items, // Note: les items ne sont pas répartis, ils sont tous inclus dans chaque facture
            status: "DRAFT", // Toujours créer en brouillon pour permettre les modifications
            issueDate: new Date(),
            dueDate: new Date(new Date().setDate(new Date().getDate() + 30)), // Date d'échéance par défaut à 30 jours
            headerNotes: quote.headerNotes,
            footerNotes: quote.footerNotes,
            termsAndConditions: quote.termsAndConditions,
            termsAndConditionsLinkTitle: quote.termsAndConditionsLinkTitle,
            termsAndConditionsLink: quote.termsAndConditionsLink,
            purchaseOrderNumber: `${quote.prefix}-${quote.number}`, // Définir le numéro de bon de commande avec le préfixe et le numéro du devis
            discount: quote.discount,
            discountType: quote.discountType,
            customFields: quoteObj.customFields,
            totalHT,
            totalVAT,
            totalTTC,
            finalTotalHT,
            finalTotalTTC,
            discountAmount,
            workspaceId: quote.workspaceId, // Copier le workspaceId depuis le devis
            createdBy: user.id,
            sourceQuote: quote._id, // Référence vers le devis source
            isDeposit: isInvoiceDeposit, // Marquer comme facture d'acompte si spécifié
            isReverseCharge: quote.isReverseCharge || false, // Copier l'auto-liquidation depuis le devis
            shipping: quoteObj.shipping, // Copier les informations de livraison depuis le devis
            appearance: quoteObj.appearance, // Copier l'apparence du document
            clientPositionRight: quote.clientPositionRight || false,
            showBankDetails: quote.showBankDetails || false,
            retenueGarantie: quote.retenueGarantie || 0,
            escompte: quote.escompte || 0,
            // Ajouter une note appropriée selon le type de facture
            notes: isInvoiceDeposit
              ? `Facture d'acompte (${invoiceDistribution[i]}% du montant total)`
              : invoiceCount > 1
                ? `Facture partielle ${i + 1}/${invoiceCount} (${
                    invoiceDistribution[i]
                  }% du montant total)`
                : "",
          });

          // Nettoyer les coordonnées bancaires si elles sont invalides
          if (invoice.companyInfo && invoice.companyInfo.bankDetails) {
            const { iban, bic, bankName } = invoice.companyInfo.bankDetails;

            // Si l'un des champs est vide ou manquant, supprimer complètement bankDetails
            if (!iban || !bic || !bankName) {
              delete invoice.companyInfo.bankDetails;
            }
          }

          await invoice.save();
          createdInvoices.push(invoice);

          // La première facture est considérée comme la facture principale
          if (i === 0) {
            mainInvoice = invoice;
          }
        }

        // Vérifier que le montant total des nouvelles factures ne dépasse pas le montant restant
        if (newInvoicesTotalAmount > remainingAmount + 0.01) {
          // Tolérance pour les erreurs d'arrondi
          // Supprimer les factures créées car elles dépassent le montant disponible
          for (const invoice of createdInvoices) {
            await Invoice.deleteOne({ _id: invoice._id });
          }

          throw new AppError(
            `Le montant total des nouvelles factures (${newInvoicesTotalAmount.toFixed(
              2,
            )}€) dépasse le montant restant disponible (${remainingAmount.toFixed(
              2,
            )}€)`,
            ERROR_CODES.INVALID_INPUT,
            {
              quoteAmount,
              existingInvoicesTotalAmount,
              remainingAmount,
              newInvoicesTotalAmount,
            },
          );
        }

        // Montant total des nouvelles factures: ${newInvoicesTotalAmount.toFixed(2)}€
        // Montant total de toutes les factures: ${(existingInvoicesTotalAmount + newInvoicesTotalAmount).toFixed(2)}€ / ${quoteAmount.toFixed(2)}€

        // Mettre à jour le devis avec la référence à la facture principale créée
        quote.convertedToInvoice = mainInvoice._id;

        // Ajouter toutes les factures à la liste des factures liées
        if (!quote.linkedInvoices) {
          quote.linkedInvoices = [];
        }

        for (const invoice of createdInvoices) {
          quote.linkedInvoices.push(invoice._id);
        }

        await quote.save();

        // Retourner la facture principale
        return await mainInvoice.populate("createdBy");
      },
    ),

    sendQuote: requireWrite("quotes")(
      async (_, { id /* email */ }, context) => {
        const { user, workspaceId } = context;
        // ✅ FIX: Utiliser workspaceId au lieu de createdBy
        const quote = await Quote.findOne({
          _id: id,
          workspaceId: workspaceId,
        });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        // Ici, vous pourriez implémenter la logique d'envoi d'email
        // Pour l'instant, nous simulons un succès
        // TODO: Implémenter l'envoi réel du devis par email

        return true;
      },
    ),
  },
};

export default quoteResolvers;
