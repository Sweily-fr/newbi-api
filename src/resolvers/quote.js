import mongoose from "mongoose";
import Quote from "../models/Quote.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
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
  },
  Query: {
    quote: isAuthenticated(async (_, { workspaceId, id }, { user }) => {
      const quote = await Quote.findOne({ _id: id, workspaceId })
        .populate("createdBy")
        .populate("convertedToInvoice");

      if (!quote) throw createNotFoundError("Devis");
      return quote;
    }),

    quotes: isAuthenticated(
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

    quoteStats: isAuthenticated(async (_, { workspaceId }, { user }) => {
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

    nextQuoteNumber: isAuthenticated(
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
  },

  Mutation: {
    createQuote: requireCompanyInfo(
      isAuthenticated(
        async (_, { workspaceId, input }, { user }) => {
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
        // Le préfixe n'affecte PAS la numérotation - la séquence est globale
        const forceSequentialNumber = async () => {
          console.log('🔍 [forceSequentialNumber] Searching for quotes in workspace:', workspaceId);

          // Récupérer tous les devis en statut officiel (PENDING, COMPLETED, CANCELED)
          // NE PAS filtrer par préfixe - la numérotation est globale
          const officialQuotes = await Quote.find(
            {
              status: { $in: ["PENDING", "COMPLETED", "CANCELED"] },
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

          // Formater avec des zéros à gauche (6 chiffres)
          return String(nextNumber).padStart(6, "0");
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
          // Pour les brouillons, utiliser le numéro fourni comme manualNumber pour maintenir la séquence
          if (input.status === "DRAFT") {
            number = await generateQuoteNumber(prefix, {
              isDraft: true,
              manualNumber: input.number,
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

        // Créer le devis avec les informations de l'entreprise depuis l'organisation si non fournies
        const quote = new Quote({
          ...input,
          number, // S'assurer que le numéro est défini
          prefix,
          workspaceId, // Ajouter le workspaceId
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
          ...totals, // Ajouter tous les totaux calculés
        });

        await quote.save();
        return await quote.populate("createdBy");
        }
      )
    ),

    updateQuote: requireCompanyInfo(
      isAuthenticated(async (_, { id, input }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });

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

      // Si les informations de l'entreprise ne sont pas fournies, les supprimer pour ne pas écraser les existantes
      if (!updateData.companyInfo) {
        delete updateData.companyInfo;
      }

      Object.assign(quote, updateData);
      await quote.save();
      return await quote.populate("createdBy");
      })
    ),

    deleteQuote: requireCompanyInfo(
      isAuthenticated(async (_, { id }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });

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

      await Quote.deleteOne({ _id: id, createdBy: user.id });
      return true;
      })
    ),

    changeQuoteStatus: requireCompanyInfo(
      isAuthenticated(async (_, { id, status }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });

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

      // Si le devis passe de DRAFT à PENDING, générer un nouveau numéro séquentiel
      if (quote.status === "DRAFT" && status === "PENDING") {
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
          prefix = `D-${month}${year}-`;
        }
        
        console.log('🔍 [changeQuoteStatus] DRAFT → PENDING, prefix:', prefix);

        // Sauvegarder le numéro original avant modification
        const originalDraftNumber = quote.number;

        // ÉTAPE 1 du swap: Si c'est un devis avec suffixe -DRAFT, faire le swap complet
        let finalNumber = originalDraftNumber;

        if (originalDraftNumber.endsWith("-DRAFT")) {
          const baseNumber = originalDraftNumber.replace("-DRAFT", "");

          // Vérifier s'il existe un devis avec le numéro de base
          const searchQuery = {
            number: baseNumber,
            workspaceId: quote.workspaceId,
            _id: { $ne: quote._id },
          };

          const existingQuote = await Quote.findOne(searchQuery);

          if (existingQuote) {
            // Vérifier le statut du devis existant
            if (existingQuote.status === "DRAFT") {
              // ÉTAPE 1: 000892 -> TEMP-000892
              const tempNumber1 = `TEMP-${baseNumber}`;
              await Quote.findByIdAndUpdate(existingQuote._id, {
                number: tempNumber1,
              });

              // ÉTAPE 2: Le devis actuel prend le numéro de base
              finalNumber = baseNumber;

              // ÉTAPE 3: TEMP-000892 -> 000892-DRAFT (fait après la sauvegarde)
              // On sauvegarde l'ID pour l'étape 3
              quote._swapQuoteId = existingQuote._id;
              quote._originalDraftNumber = originalDraftNumber;
            } else {
              // Générer le prochain numéro séquentiel
              finalNumber = await generateQuoteNumber(prefix, {
                workspaceId: quote.workspaceId,
                userId: user.id,
                year,
                currentQuoteId: quote._id,
              });
            }
          } else {
            // Pas de conflit, juste enlever le suffixe -DRAFT
            finalNumber = baseNumber;
          }
        } else {
          // Générer un nouveau numéro séquentiel normal
          finalNumber = await generateQuoteNumber(prefix, {
            isValidatingDraft: true,
            currentDraftNumber: originalDraftNumber,
            workspaceId: quote.workspaceId,
            userId: user.id,
            year,
            currentQuoteId: quote._id,
          });
        }
        // Utiliser une stratégie de numéro temporaire pour éviter les erreurs de clé dupliquée
        const tempNumber = `TEMP-${Date.now()}`;
        quote.number = tempNumber;
        await quote.save();

        // Mettre à jour le numéro et le préfixe du devis
        quote.number = finalNumber;
        quote.prefix = prefix;

        try {
          await quote.save();
        } catch (error) {
          throw error;
        }

        // ÉTAPE 3 du swap: Finaliser le changement TEMP-000892 -> 000892-DRAFT
        if (quote._swapQuoteId && quote._originalDraftNumber) {
          await Quote.findByIdAndUpdate(quote._swapQuoteId, {
            number: quote._originalDraftNumber, // 000892-DRAFT
          });

          // Nettoyer les propriétés temporaires
          delete quote._swapQuoteId;
          delete quote._originalDraftNumber;
        }
      }

      quote.status = status;
      await quote.save();
      return await quote.populate("createdBy");
      })
    ),

    convertQuoteToInvoice: isAuthenticated(
      async (_, { id, distribution, isDeposit, skipValidation }, { user }) => {
        const quote = await Quote.findOne({ _id: id, createdBy: user.id });

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
        const prefix = `F-${year}${month}-`;

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

          // Créer la facture à partir du devis
          const invoice = new Invoice({
            number,
            prefix,
            client: quote.client,
            // Copier les informations d'entreprise du devis en priorité, avec fallback sur l'organisation
            companyInfo: {
              // Priorité aux informations du devis, fallback sur l'organisation
              name: quote.companyInfo?.name || organization.companyName || "",
              email:
                quote.companyInfo?.email || organization.companyEmail || "",
              phone:
                quote.companyInfo?.phone || organization.companyPhone || "",
              website: quote.companyInfo?.website || organization.website || "",
              address: {
                street:
                  quote.companyInfo?.address?.street ||
                  organization.addressStreet ||
                  "",
                city:
                  quote.companyInfo?.address?.city ||
                  organization.addressCity ||
                  "",
                postalCode:
                  quote.companyInfo?.address?.postalCode ||
                  organization.addressZipCode ||
                  "",
                country:
                  quote.companyInfo?.address?.country ||
                  organization.addressCountry ||
                  "France",
              },
              // Copier les propriétés légales (priorité au devis, fallback sur l'organisation)
              siret: quote.companyInfo?.siret || organization.siret || "",
              vatNumber:
                quote.companyInfo?.vatNumber || organization.vatNumber || "",
              companyStatus:
                quote.companyInfo?.companyStatus ||
                organization.legalForm ||
                "AUTRE",
              // Autres propriétés
              logo: quote.companyInfo?.logo || organization.logo || "",
              // Copier les coordonnées bancaires du devis en priorité, sinon de l'organisation
              // Ne pas inclure bankDetails si les informations sont incomplètes
              ...(quote.companyInfo?.bankDetails?.iban &&
              quote.companyInfo?.bankDetails?.bic &&
              quote.companyInfo?.bankDetails?.bankName
                ? {
                    bankDetails: {
                      iban: quote.companyInfo.bankDetails.iban,
                      bic: quote.companyInfo.bankDetails.bic,
                      bankName: quote.companyInfo.bankDetails.bankName,
                    },
                  }
                : organization.bankIban &&
                  organization.bankBic &&
                  organization.bankName
                ? {
                    bankDetails: {
                      iban: organization.bankIban,
                      bic: organization.bankBic,
                      bankName: organization.bankName,
                    },
                  }
                : {}),
              // Copier les autres champs du devis s'ils existent
              transactionCategory: quote.companyInfo?.transactionCategory,
              vatPaymentCondition: quote.companyInfo?.vatPaymentCondition,
              capitalSocial: quote.companyInfo?.capitalSocial,
              rcs: quote.companyInfo?.rcs,
            },
            items: quote.items, // Note: les items ne sont pas répartis, ils sont tous inclus dans chaque facture
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
            customFields: quote.customFields,
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

    sendQuote: isAuthenticated(async (_, { id /* email */ }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });

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
