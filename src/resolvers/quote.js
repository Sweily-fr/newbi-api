import mongoose from "mongoose";
import Quote from "../models/Quote.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import Client from "../models/Client.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import { withRBAC, requireWrite, requireRead, requireDelete } from "../middlewares/rbac.js";
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
import { requireCompanyInfo, getOrganizationInfo } from "../middlewares/company-info-guard.js";
import { mapOrganizationToCompanyInfo } from "../utils/companyInfoMapper.js";
import documentAutomationService from "../services/documentAutomationService.js";

// Fonction utilitaire pour calculer les totaux avec remise et livraison
const calculateQuoteTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  shipping = null
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

    // Appliquer la remise au niveau de l'item si elle existe
    if (item.discount) {
      if (item.discountType === "PERCENTAGE" || item.discountType === "percentage") {
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
      if (!quote.status || quote.status === 'DRAFT') {
        try {
          const organization = await getOrganizationInfo(quote.workspaceId.toString());
          return mapOrganizationToCompanyInfo(organization);
        } catch (error) {
          console.error('[Quote.companyInfo] Erreur résolution dynamique:', error.message);
          if (quote.companyInfo && quote.companyInfo.name) return quote.companyInfo;
          return { name: '', address: { street: '', city: '', postalCode: '', country: 'France' } };
        }
      }
      // Pour les documents finalisés, utiliser les données embarquées (snapshot historique)
      if (quote.companyInfo && quote.companyInfo.name) {
        return quote.companyInfo;
      }
      // Fallback : résoudre depuis l'organisation
      try {
        const organization = await getOrganizationInfo(quote.workspaceId.toString());
        return mapOrganizationToCompanyInfo(organization);
      } catch (error) {
        console.error('[Quote.companyInfo] Erreur résolution fallback:', error.message);
        return { name: '', address: { street: '', city: '', postalCode: '', country: 'France' } };
      }
    },
    createdBy: async (quote) => {
      return await User.findById(quote.createdBy);
    },
    convertedToInvoice: async (quote) => {
      if (!quote.convertedToInvoice) return null;
      return await Invoice.findById(quote.convertedToInvoice);
    },
    linkedInvoices: async (quote) => {
      // Trouver toutes les factures liées à ce devis
      // Cela inclut la facture principale (convertedToInvoice) et potentiellement d'autres factures
      // comme des factures d'acompte, etc.
      if (quote.linkedInvoices && quote.linkedInvoices.length > 0) {
        // Si le champ linkedInvoices est déjà rempli, utiliser ces références
        return await Invoice.find({ _id: { $in: quote.linkedInvoices } });
      } else if (quote.convertedToInvoice) {
        // Pour la compatibilité avec les anciens devis qui n'ont que convertedToInvoice
        const invoice = await Invoice.findById(quote.convertedToInvoice);
        return invoice ? [invoice] : [];
      }

      return [];
    },
    // Calculer le total des factures de situation liées à ce devis
    situationInvoicedTotal: async (quote) => {
      // Construire la référence complète du devis
      const quoteRef = quote.prefix ? `${quote.prefix}-${quote.number}` : quote.number;
      
      // Chercher toutes les factures de situation avec cette référence
      const situationInvoices = await Invoice.find({
        workspaceId: quote.workspaceId,
        invoiceType: 'situation',
        purchaseOrderNumber: quoteRef
      });
      
      // Calculer le total en tenant compte du progressPercentage
      // (recalcul à la volée pour les factures existantes qui n'ont pas le bon finalTotalTTC)
      const total = situationInvoices.reduce((sum, inv) => {
        // Calculer le total TTC réel en tenant compte du progressPercentage
        let invoiceTotal = 0;
        if (inv.items && inv.items.length > 0) {
          inv.items.forEach(item => {
            const quantity = item.quantity || 1;
            const unitPrice = item.unitPrice || 0;
            const progressPercentage = item.progressPercentage !== undefined && item.progressPercentage !== null 
              ? item.progressPercentage 
              : 100;
            const vatRate = item.vatRate || 0;
            const discount = item.discount || 0;
            const discountType = item.discountType || 'PERCENTAGE';
            
            let itemHT = quantity * unitPrice * (progressPercentage / 100);
            
            // Appliquer la remise
            if (discount > 0) {
              if (discountType === 'PERCENTAGE') {
                itemHT = itemHT * (1 - Math.min(discount, 100) / 100);
              } else {
                itemHT = Math.max(0, itemHT - discount);
              }
            }
            
            // Ajouter la TVA
            const itemTTC = itemHT * (1 + vatRate / 100);
            invoiceTotal += itemTTC;
          });
        } else {
          // Fallback sur finalTotalTTC si pas d'items
          invoiceTotal = inv.finalTotalTTC || 0;
        }
        
        return sum + invoiceTotal;
      }, 0);
      
      return total;
    },
  },
  Query: {
    quote: requireRead("quotes")(async (_, { workspaceId, id }, context) => {
      const { user } = context;
      const quote = await Quote.findOne({ _id: id, workspaceId })
        .populate("createdBy")
        .populate("convertedToInvoice");

      if (!quote) throw createNotFoundError("Devis");
      return quote;
    }),

    quotes: requireRead("quotes")(
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
          }))
        );

        return {
          quotes,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      }
    ),

    quoteStats: requireRead("quotes")(async (_, { workspaceId }, context) => {
      const { user } = context;
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
    }),

    nextQuoteNumber: requireRead("quotes")(
      async (_, { workspaceId, prefix }, { user }) => {
        // Récupérer le préfixe personnalisé de l'utilisateur ou utiliser le format par défaut
        const userObj = await mongoose.model("User").findById(user.id);
        const customPrefix = prefix || userObj?.settings?.quoteNumberPrefix;
        return await generateQuoteNumber(customPrefix, {
          userId: user.id,
          workspaceId,
        });
      }
    ),

    // Récupérer un devis par son numéro (pour les factures de situation)
    quoteByNumber: requireRead("quotes")(
      async (_, { workspaceId, number }, context) => {
        console.log('📋 [quoteByNumber] Recherche devis:', { workspaceId, number });
        
        if (!number || number.trim() === '') {
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
            { $expr: { $eq: [{ $concat: ["$prefix", "-", "$number"] }, trimmedNumber] } }
          ]
        }).populate('createdBy');

        console.log('📋 [quoteByNumber] Première recherche:', quote ? { id: quote.id, number: quote.number, prefix: quote.prefix, finalTotalTTC: quote.finalTotalTTC } : null);

        // Si pas trouvé, essayer de parser le numéro (ex: "D-122024-000001" -> prefix="D-122024", number="000001")
        if (!quote && trimmedNumber.includes('-')) {
          const lastDashIndex = trimmedNumber.lastIndexOf('-');
          const possiblePrefix = trimmedNumber.substring(0, lastDashIndex);
          const possibleNumber = trimmedNumber.substring(lastDashIndex + 1);
          
          console.log('📋 [quoteByNumber] Parsing:', { possiblePrefix, possibleNumber });
          
          quote = await Quote.findOne({
            workspaceId,
            prefix: possiblePrefix,
            number: possibleNumber
          }).populate('createdBy');
          
          console.log('📋 [quoteByNumber] Deuxième recherche:', quote ? { id: quote.id, number: quote.number, prefix: quote.prefix, finalTotalTTC: quote.finalTotalTTC } : null);
        }

        return quote;
      }
    ),
  },

  Mutation: {
    createQuote: requireCompanyInfo(
      requireWrite("quotes")(
        async (_, { workspaceId: inputWorkspaceId, input }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // ✅ FIX: Valider que le workspaceId correspond au contexte
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

        console.log('🔍 [createQuote] Input received:', { prefix: input.prefix, number: input.number, status: input.status });
        
        // Utiliser le préfixe fourni, ou celui du dernier devis, ou 'D' par défaut
        let prefix = input.prefix;
        
        if (!prefix) {
          // Chercher le dernier devis créé pour récupérer son préfixe
          const lastQuote = await Quote.findOne({ workspaceId })
            .sort({ createdAt: -1 })
            .select('prefix')
            .lean();
          
          if (lastQuote && lastQuote.prefix) {
            prefix = lastQuote.prefix;
          } else {
            // Aucun devis existant, utiliser le préfixe par défaut
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            prefix = `D-${month}${year}`;
          }
        }

        // Fonction pour forcer un numéro séquentiel pour les devis en PENDING
        // Vérifie tous les numéros existants et trouve le premier trou disponible
        // La séquence est PAR PRÉFIXE - chaque préfixe a sa propre numérotation
        const forceSequentialNumber = async () => {
          console.log('🔍 [forceSequentialNumber] Searching for quotes in workspace:', workspaceId, 'with prefix:', prefix);

          // Récupérer tous les devis en statut officiel (PENDING, COMPLETED, CANCELED)
          // IMPORTANT: Filtrer par préfixe pour avoir une séquence par préfixe
          const officialQuotes = await Quote.find(
            {
              status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
              prefix, // Filtrage par préfixe
              workspaceId,
              createdBy: user.id,
              // Ne considérer que les numéros sans suffixe
              number: { $regex: /^\d+$/ },
            },
            { number: 1 }
          )
            .sort({ number: 1 })
            .lean(); // Tri croissant

          console.log('🔍 [forceSequentialNumber] Found quotes:', officialQuotes.length);
          console.log('🔍 [forceSequentialNumber] Quote numbers:', officialQuotes.map(q => q.number));

          // Si aucun devis officiel n'existe, commencer à 1
          if (officialQuotes.length === 0) {
            console.log('⚠️ [forceSequentialNumber] No quotes found, returning 000001');
            return "000001";
          }

          // Convertir les numéros en entiers et trier
          const numbers = officialQuotes
            .map((q) => parseInt(q.number, 10))
            .sort((a, b) => a - b);

          // Prendre le plus grand numéro et ajouter 1
          const maxNumber = Math.max(...numbers);
          const nextNumber = maxNumber + 1;

          console.log('✅ [forceSequentialNumber] Max number:', maxNumber, '→ Next number:', nextNumber);

          // Formater avec des zéros à gauche (4 chiffres)
          return String(nextNumber).padStart(4, "0");
        };

        // Si le statut est PENDING, vérifier d'abord s'il existe des devis en DRAFT
        // qui pourraient entrer en conflit avec le numéro qui sera généré
        const handleDraftConflicts = async (newNumber) => {
          // Vérifier s'il existe un devis en DRAFT avec le même numéro
          const conflictingDrafts = await Quote.find({
            prefix,
            number: newNumber,
            status: "DRAFT",
            workspaceId,
            createdBy: user.id,
          });

          // S'il y a des devis en conflit, mettre à jour leur numéro
          for (const draft of conflictingDrafts) {
            // Utiliser le format DRAFT-ID avec timestamp
            const timestamp = Date.now() + Math.floor(Math.random() * 1000);
            const finalDraftNumber = `${newNumber}-${timestamp}`;

            // Mettre à jour le devis en brouillon avec le nouveau numéro
            await Quote.findByIdAndUpdate(draft._id, {
              number: finalDraftNumber,
            });
          }

          return newNumber;
        };

        // Vérifier si c'est le premier devis de l'utilisateur
        const firstQuote = await Quote.findOne({
          createdBy: user.id,
          status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
        });

        let number;

        // Logique de génération du numéro
        if (input.number && firstQuote === null) {
          // C'est le premier devis, on peut accepter le numéro fourni
          // Vérifier que le numéro est valide
          if (!/^\d{1,6}$/.test(input.number)) {
            throw new AppError(
              "Le numéro de devis doit contenir entre 1 et 6 chiffres",
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Pour les brouillons, utiliser generateQuoteNumber pour gérer les conflits
          if (input.status === "DRAFT") {
            number = await generateQuoteNumber(prefix, {
              isDraft: true,
              manualNumber: input.number,
              workspaceId,
              userId: user.id,
            });
          } else {
            // Pour les devis non-brouillons, vérifier l'unicité
            const existingQuote = await Quote.findOne({
              number: input.number,
              workspaceId,
              createdBy: user.id,
            });

            if (existingQuote) {
              throw new AppError(
                "Ce numéro de devis est déjà utilisé",
                ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER
              );
            }

            number = input.number;
          }
        } else if (input.number) {
          // Ce n'est pas le premier devis
          // Pour les brouillons, IGNORER le numéro fourni et générer un timestamp unique
          if (input.status === "DRAFT") {
            number = await generateQuoteNumber(prefix, {
              isDraft: true,
              // Ne pas passer manualNumber pour les brouillons - utiliser timestamp
              workspaceId,
              userId: user.id,
            });
            console.log('✅ [createQuote] Generated number for DRAFT:', number);
          } else if (input.status === "PENDING") {
            number = await forceSequentialNumber();
            console.log('✅ [createQuote] Generated number for PENDING:', number);
          } else {
            // Pour les autres statuts, générer un numéro séquentiel
            number = await generateQuoteNumber(prefix, {
              workspaceId,
              userId: user.id,
            });
            console.log('✅ [createQuote] Generated number for other status:', number);
          }
        } else {
          // Aucun numéro fourni, on en génère un nouveau
          if (input.status === "PENDING") {
            // Pour les devis PENDING, on force un numéro séquentiel
            number = await forceSequentialNumber();
          } else {
            // Pour les brouillons, on génère un numéro standard
            number = await generateQuoteNumber(prefix, {
              isDraft: true,
              workspaceId,
              userId: user.id,
            });
          }
        }

        // Gérer les conflits avec les devis en DRAFT
        number = await handleDraftConflicts(number);

        // Récupérer les informations de l'organisation
        const organization = await getOrganizationInfo(workspaceId);
        
        if (!organization?.companyName) {
          throw new AppError(
            "Les informations de votre entreprise doivent être configurées avant de créer un devis",
            ERROR_CODES.COMPANY_INFO_REQUIRED
          );
        }

        // Calculer les totaux avec la remise et la livraison
        const totals = calculateQuoteTotals(
          input.items,
          input.discount,
          input.discountType,
          input.shipping
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
              }
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
            { "client.shippingAddress": "L'adresse de livraison est requise" }
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

        // Créer le devis - companyInfo uniquement pour les documents non-DRAFT
        const isDraft = !input.status || input.status === 'DRAFT';
        const quote = new Quote({
          ...input,
          number, // S'assurer que le numéro est défini
          prefix,
          workspaceId, // Ajouter le workspaceId
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
          ...totals, // Ajouter tous les totaux calculés
        });

        await quote.save();
        
        // Enregistrer l'activité dans le client si c'est un client existant
        if (clientData.id) {
          try {
            await Client.findByIdAndUpdate(clientData.id, {
              $push: {
                activity: {
                  id: new mongoose.Types.ObjectId().toString(),
                  type: 'quote_created',
                  description: `a créé le devis ${prefix}${number}`,
                  userId: user._id,
                  userName: user.name || user.email,
                  userImage: user.image || null,
                  metadata: {
                    documentType: 'quote',
                    documentId: quote._id.toString(),
                    documentNumber: `${prefix}${number}`,
                    status: quote.status
                  },
                  createdAt: new Date()
                }
              }
            });
          } catch (activityError) {
            console.error('Erreur lors de l\'enregistrement de l\'activité:', activityError);
            // Ne pas faire échouer la création de devis si l'activité échoue
          }
        }
        
        // Automatisations documents partagés pour les brouillons (fire-and-forget)
        if (quote.status === 'DRAFT') {
          documentAutomationService.executeAutomations('QUOTE_DRAFT', workspaceId, {
            documentId: quote._id.toString(),
            documentType: 'quote',
            documentNumber: quote.number,
            prefix: quote.prefix || '',
            clientName: quote.client?.name || '',
          }, user._id.toString()).catch(err => console.error('Erreur automatisation documents (quote draft):', err));
        }

        return await quote.populate("createdBy");
        }
      )
    ),

    updateQuote: requireCompanyInfo(
      requireWrite("quotes")(async (_, { id, input }, context) => {
      const { user, workspaceId } = context;
      // ✅ FIX: Utiliser workspaceId au lieu de createdBy pour permettre aux membres de l'org de voir/modifier
      const quote = await Quote.findOne({ _id: id, workspaceId: workspaceId });

      if (!quote) {
        throw createNotFoundError("Devis");
      }

      if (quote.status === "COMPLETED") {
        throw createResourceLockedError(
          "Devis",
          "un devis terminé ne peut pas être modifié"
        );
      }

      if (quote.convertedToInvoice) {
        throw createResourceLockedError(
          "Devis",
          "un devis converti en facture ne peut pas être modifié"
        );
      }

      // Validation : empêcher le changement d'année de issueDate sur un devis finalisé
      if (
        input.issueDate &&
        quote.status !== "DRAFT" &&
        quote.issueDate
      ) {
        const oldYear = new Date(quote.issueDate).getFullYear();
        const newYear = new Date(input.issueDate).getFullYear();
        if (oldYear !== newYear) {
          throw createValidationError(
            `Impossible de changer l'année d'émission d'un devis finalisé (${oldYear} → ${newYear}). Cela casserait la séquence de numérotation.`,
            { issueDate: `L'année d'émission ne peut pas être modifiée de ${oldYear} à ${newYear} sur un devis finalisé.` }
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
            ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER
          );
        }
      }

      // Si des items sont fournis, recalculer les totaux
      if (input.items) {
        const totals = calculateQuoteTotals(
          input.items,
          input.discount !== undefined ? input.discount : quote.discount,
          input.discountType || quote.discountType,
          input.shipping !== undefined ? input.shipping : quote.shipping
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
          { "client.shippingAddress": "L'adresse de livraison est requise" }
        );
      }

      // Ne pas persister companyInfo pour les documents DRAFT
      delete updateData.companyInfo;

      // Gérer la transition DRAFT → PENDING : générer automatiquement le numéro séquentiel
      if (quote.status === "DRAFT" && updateData.status === "PENDING") {
        // Snapshot companyInfo à la finalisation
        if (!quote.companyInfo || !quote.companyInfo.name) {
          const org = await getOrganizationInfo(quote.workspaceId);
          updateData.companyInfo = mapOrganizationToCompanyInfo(org);
        }
        console.log('🔍 [updateQuote] DRAFT → PENDING transition detected');
        console.log('🔍 [updateQuote] Current number:', quote.number);
        console.log('🔍 [updateQuote] Input number:', input.number);
        console.log('🔍 [updateQuote] Input prefix:', input.prefix);
        
        try {
          // Si le numéro ou le prefix ne sont pas fournis dans l'input, générer automatiquement
          if (!input.number || !input.prefix) {
            // Récupérer le préfixe du dernier devis créé (non-DRAFT)
            const lastQuote = await Quote.findOne({
              workspaceId: quote.workspaceId,
              status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] }
            })
              .sort({ createdAt: -1 })
              .select('prefix')
              .lean();
            
            // Définir l'année et la date pour les fonctions de génération de numéro
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            
            let prefix;
            if (lastQuote && lastQuote.prefix) {
              // Utiliser le préfixe du dernier devis
              prefix = lastQuote.prefix;
            } else {
              // Aucun devis existant, utiliser le préfixe par défaut
              prefix = `D-${month}${year}`;
            }
            
            console.log('🔍 [updateQuote] Using prefix:', prefix);
            
            // Générer le prochain numéro séquentiel
            const newNumber = await generateQuoteNumber(prefix, {
              isValidatingDraft: true,
              currentDraftNumber: quote.number,
              workspaceId: quote.workspaceId,
              userId: user.id,
              year,
              currentQuoteId: quote._id,
            });
            
            console.log('✅ [updateQuote] Generated new number:', newNumber);
            
            // Mettre à jour le numéro et le préfixe
            updateData.number = newNumber;
            updateData.prefix = prefix;
          }
        } catch (error) {
          console.error('❌ [updateQuote] Error generating quote number:', error);
          throw new AppError(
            'Erreur lors de la génération du numéro de devis',
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }

      Object.assign(quote, updateData);
      await quote.save();
      return await quote.populate("createdBy");
      })
    ),

    deleteQuote: requireCompanyInfo(
      requireDelete("quotes")(async (_, { id }, context) => {
      const { user, workspaceId } = context;
      // ✅ FIX: Utiliser workspaceId au lieu de createdBy
      const quote = await Quote.findOne({ _id: id, workspaceId: workspaceId });

      if (!quote) {
        throw createNotFoundError("Devis");
      }

      if (quote.status === "COMPLETED") {
        throw createResourceLockedError(
          "Devis",
          "un devis terminé ne peut pas être supprimé"
        );
      }

      if (quote.convertedToInvoice) {
        throw createResourceLockedError(
          "Devis",
          "un devis converti en facture ne peut pas être supprimé"
        );
      }

      await Quote.deleteOne({ _id: id, workspaceId: workspaceId });
      return true;
      })
    ),

    changeQuoteStatus: requireCompanyInfo(
      requireWrite("quotes")(async (_, { id, status }, context) => {
      const { user, workspaceId } = context;
      // ✅ FIX: Utiliser workspaceId au lieu de createdBy
      const quote = await Quote.findOne({ _id: id, workspaceId: workspaceId });

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
      };

      if (!allowedTransitions[quote.status].includes(status)) {
        throw createStatusTransitionError("Devis", quote.status, status);
      }

      const oldStatus = quote.status;

      // Si le devis passe de DRAFT à PENDING, snapshot companyInfo et générer un nouveau numéro séquentiel
      if (quote.status === "DRAFT" && status === "PENDING") {
        // Snapshot companyInfo à la finalisation
        if (!quote.companyInfo || !quote.companyInfo.name) {
          const org = await getOrganizationInfo(workspaceId);
          quote.companyInfo = mapOrganizationToCompanyInfo(org);
        }

        // Transaction atomique pour éviter les numéros TEMP orphelins
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          const session = await mongoose.startSession();
          try {
            await session.withTransaction(async () => {
              // Récupérer le préfixe du dernier devis créé (non-DRAFT)
              const lastQuote = await Quote.findOne({
                workspaceId: quote.workspaceId,
                status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] }
              }, null, { session })
                .sort({ createdAt: -1 })
                .select('prefix')
                .lean();

              // Utiliser l'année de issueDate du document, pas la date serveur
              const year = (quote.issueDate || new Date()).getFullYear();
              const month = String((quote.issueDate || new Date()).getMonth() + 1).padStart(2, '0');

              let prefix;
              if (lastQuote && lastQuote.prefix) {
                prefix = lastQuote.prefix;
              } else {
                prefix = `D-${month}${year}`;
              }

              console.log('🔍 [changeQuoteStatus] DRAFT → PENDING, prefix:', prefix);

              const originalDraftNumber = quote.number;
              let finalNumber = originalDraftNumber;
              let swapQuoteId = null;
              let swapOriginalNumber = null;

              if (originalDraftNumber.endsWith("-DRAFT")) {
                const baseNumber = originalDraftNumber.replace("-DRAFT", "");

                const existingQuote = await Quote.findOne({
                  number: baseNumber,
                  workspaceId: quote.workspaceId,
                  _id: { $ne: quote._id },
                }, null, { session });

                if (existingQuote) {
                  if (existingQuote.status === "DRAFT") {
                    await Quote.findByIdAndUpdate(existingQuote._id, {
                      number: `TEMP-${baseNumber}`,
                    }, { session });
                    finalNumber = baseNumber;
                    swapQuoteId = existingQuote._id;
                    swapOriginalNumber = originalDraftNumber;
                  } else {
                    finalNumber = await generateQuoteNumber(prefix, {
                      workspaceId: quote.workspaceId,
                      userId: user.id,
                      year,
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
                  year,
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
                await Quote.findByIdAndUpdate(swapQuoteId, {
                  number: swapOriginalNumber,
                }, { session });
              }
            });
            session.endSession();
            break;
          } catch (err) {
            session.endSession();
            if (err.code === 11000 && attempt < MAX_RETRIES - 1) {
              console.log(`⚠️ [changeQuoteStatus] E11000 retry attempt ${attempt + 1}`);
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
            'DRAFT': 'Brouillon',
            'PENDING': 'En attente',
            'COMPLETED': 'Accepté',
            'CANCELED': 'Refusé'
          };
          
          await Client.findByIdAndUpdate(quote.client.id, {
            $push: {
              activity: {
                id: new mongoose.Types.ObjectId().toString(),
                type: 'quote_status_changed',
                description: `a changé le statut du devis ${quote.prefix}${quote.number} de "${statusLabels[oldStatus]}" à "${statusLabels[status]}"`,
                userId: user._id,
                userName: user.name || user.email,
                userImage: user.image || null,
                metadata: {
                  documentType: 'quote',
                  documentId: quote._id.toString(),
                  documentNumber: `${quote.prefix}${quote.number}`,
                  status: status
                },
                createdAt: new Date()
              }
            }
          });
        } catch (activityError) {
          console.error('Erreur lors de l\'enregistrement de l\'activité:', activityError);
          // Ne pas faire échouer le changement de statut si l'activité échoue
        }
      }

      // Automatisations documents partagés (fire-and-forget, ne bloque pas la réponse)
      const triggerMap = { PENDING: 'QUOTE_SENT', COMPLETED: 'QUOTE_ACCEPTED', CANCELED: 'QUOTE_CANCELED' };
      const docTrigger = triggerMap[status];
      if (docTrigger) {
        documentAutomationService.executeAutomations(docTrigger, workspaceId, {
          documentId: quote._id.toString(),
          documentType: 'quote',
          documentNumber: quote.number,
          prefix: quote.prefix || '',
          clientName: quote.client?.name || '',
        }, user._id.toString()).catch(err => console.error('Erreur automatisation documents (devis):', err));
      }

      return await quote.populate("createdBy");
      })
    ),

    convertQuoteToInvoice: requireWrite("quotes")(
      async (_, { id, distribution, isDeposit, skipValidation }, context) => {
        const { user, workspaceId } = context;
        // ✅ FIX: Utiliser workspaceId au lieu de createdBy
        const quote = await Quote.findOne({ _id: id, workspaceId: workspaceId });

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
            }
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
            0
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
              "déjà converti en facture"
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

        // Vérifier que le nombre de factures à créer + les factures existantes ne dépasse pas 3
        const validLinkedInvoicesCount = validLinkedInvoices.length;
        if (validLinkedInvoicesCount + invoiceCount > 3) {
          throw new AppError(
            `Un devis ne peut pas avoir plus de 3 factures liées (${validLinkedInvoicesCount} existante(s) + ${invoiceCount} à créer)`,
            ERROR_CODES.RESOURCE_LOCKED,
            {
              resource: "Devis",
              maxInvoices: 3,
              currentCount: validLinkedInvoicesCount,
              requestedCount: invoiceCount,
            }
          );
        }

        // Calculer le pourcentage déjà utilisé par les factures existantes
        let existingInvoicesPercentage = 0;

        if (existingInvoicesTotalAmount > 0 && quoteAmount > 0) {
          existingInvoicesPercentage =
            (existingInvoicesTotalAmount / quoteAmount) * 100;
        }

        // Vérifier que la somme des pourcentages est bien égale à 100%
        const newInvoicesPercentage = invoiceDistribution.reduce(
          (sum, percent) => sum + percent,
          0
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
                2
              )}% + ${existingInvoicesPercentage.toFixed(
                2
              )}% déjà facturé) ne peut pas dépasser 100% (actuellement ${totalPercentage.toFixed(
                2
              )}%)`,
              ERROR_CODES.INVALID_INPUT,
              {
                existingPercentage: existingInvoicesPercentage,
                newPercentage: newInvoicesPercentage,
                total: totalPercentage,
              }
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
            ERROR_CODES.VALIDATION_ERROR
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
              }
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
              }
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
              2
            )}€) a déjà atteint ou dépassé le montant du devis (${quoteAmount.toFixed(
              2
            )}€)`,
            ERROR_CODES.RESOURCE_LOCKED,
            {
              resource: "Devis",
              quoteAmount,
              existingInvoicesTotalAmount,
              remainingAmount,
            }
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
            purchaseOrderNumber: `${quote.prefix}${quote.number}`, // Définir le numéro de bon de commande avec le préfixe et le numéro du devis
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
              2
            )}€) dépasse le montant restant disponible (${remainingAmount.toFixed(
              2
            )}€)`,
            ERROR_CODES.INVALID_INPUT,
            {
              quoteAmount,
              existingInvoicesTotalAmount,
              remainingAmount,
              newInvoicesTotalAmount,
            }
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
      }
    ),

    sendQuote: requireWrite("quotes")(async (_, { id /* email */ }, context) => {
      const { user, workspaceId } = context;
      // ✅ FIX: Utiliser workspaceId au lieu de createdBy
      const quote = await Quote.findOne({ _id: id, workspaceId: workspaceId });

      if (!quote) {
        throw createNotFoundError("Devis");
      }

      // Ici, vous pourriez implémenter la logique d'envoi d'email
      // Pour l'instant, nous simulons un succès
      // TODO: Implémenter l'envoi réel du devis par email

      return true;
    }),
  },
};

export default quoteResolvers;
