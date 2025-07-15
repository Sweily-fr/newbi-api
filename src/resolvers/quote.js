const mongoose = require('mongoose');
const Quote = require('../models/Quote');
const Invoice = require('../models/Invoice');
const User = require('../models/User');
const { isAuthenticated } = require('../middlewares/auth');
const { generateQuoteNumber, generateInvoiceNumber } = require('../utils/documentNumbers');
const { 
  createNotFoundError, 
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES
} = require('../utils/errors');

// Fonction utilitaire pour calculer les totaux avec remise
const calculateQuoteTotals = (items, discount = 0, discountType = 'FIXED') => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach(item => {
    let itemHT = item.quantity * item.unitPrice;
    
    // Appliquer la remise au niveau de l'item si elle existe
    if (item.discount) {
      if (item.discountType === 'PERCENTAGE') {
        itemHT = itemHT * (1 - (item.discount / 100));
      } else {
        itemHT = Math.max(0, itemHT - item.discount);
      }
    }
    
    const itemVAT = itemHT * (item.vatRate / 100);
    totalHT += itemHT;
    totalVAT += itemVAT;
  });

  const totalTTC = totalHT + totalVAT;

  let discountAmount = 0;
  if (discount) {
    if (discountType === 'PERCENTAGE') {
      discountAmount = (totalHT * discount) / 100;
    } else {
      discountAmount = discount;
    }
  }

  const finalTotalHT = totalHT - discountAmount;
  const finalTotalTTC = finalTotalHT + totalVAT;

  return {
    totalHT,
    totalVAT,
    totalTTC,
    finalTotalHT,
    finalTotalTTC,
    discountAmount
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
    }
  },
  Query: {
    quote: isAuthenticated(async (_, { id }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id })
        .populate('createdBy')
        .populate('convertedToInvoice');
      if (!quote) throw createNotFoundError('Devis');
      return quote;
    }),

    quotes: isAuthenticated(async (_, { startDate, endDate, status, search, page = 1, limit = 10 }, { user }) => {
      const query = { createdBy: user.id };

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      if (status) query.status = status;

      if (search) {
        const searchRegex = new RegExp(search, 'i');
        query.$or = [
          { 'number': searchRegex },
          { 'client.name': searchRegex },
          { 'client.email': searchRegex }
        ];
      }

      const skip = (page - 1) * limit;
      const totalCount = await Quote.countDocuments(query);
      
      const quotes = await Quote.find(query)
        .populate('createdBy')
        .populate('convertedToInvoice')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      return {
        quotes,
        totalCount,
        hasNextPage: totalCount > skip + limit
      };
    }),

    quoteStats: isAuthenticated(async (_, __, { user }) => {
      const [stats] = await Quote.aggregate([
        { $match: { createdBy: new mongoose.Types.ObjectId(user.id) } },
        {
          $group: {
            _id: null,
            totalCount: { $sum: 1 },
            draftCount: {
              $sum: { $cond: [{ $eq: ['$status', 'DRAFT'] }, 1, 0] }
            },
            pendingCount: {
              $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] }
            },
            completedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] }
            },
            canceledCount: {
              $sum: { $cond: [{ $eq: ['$status', 'CANCELED'] }, 1, 0] }
            },
            totalAmount: { $sum: '$finalTotalTTC' },
            convertedCount: {
              $sum: { $cond: [{ $ifNull: ['$convertedToInvoice', false] }, 1, 0] }
            }
          }
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
                { $eq: ['$completedCount', 0] },
                0,
                { $divide: ['$convertedCount', '$completedCount'] }
              ]
            }
          }
        }
      ]);

      console.log('Stats from MongoDB:', stats);

      // Créer un objet avec des valeurs par défaut
      const defaultStats = {
        totalCount: 0,
        draftCount: 0,
        pendingCount: 0,
        canceledCount: 0,
        completedCount: 0,
        totalAmount: 0,
        conversionRate: 0
      };

      // Si stats existe, s'assurer que tous les champs requis sont définis et non null
      if (stats) {
        // Remplacer toutes les valeurs null par 0
        Object.keys(defaultStats).forEach(key => {
          if (stats[key] === null || stats[key] === undefined) {
            stats[key] = 0;
          }
        });
        console.log('Processed stats:', stats);
        return stats;
      }

      console.log('Using default stats');
      return defaultStats;
    }),

    nextQuoteNumber: isAuthenticated(async (_, { prefix }, { user }) => {
      // Récupérer le préfixe personnalisé de l'utilisateur ou utiliser le format par défaut
      const userObj = await mongoose.model('User').findById(user.id);
      const customPrefix = prefix || userObj?.settings?.quoteNumberPrefix;
      return await generateQuoteNumber(customPrefix, { userId: user.id });
    })
  },

  Mutation: {
    createQuote: isAuthenticated(async (_, { input }, { user }) => {
      // Utiliser le préfixe fourni ou 'D' par défaut
      const prefix = input.prefix || 'D';
      
      // Fonction pour forcer un numéro séquentiel pour les devis en PENDING
      // À partir du dernier numéro le plus grand, sans combler les trous
      const forceSequentialNumber = async () => {
        // Récupérer tous les devis en statut officiel (PENDING, COMPLETED, CANCELED)
        const pendingQuotes = await Quote.find({
          prefix,
          status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
          createdBy: user.id,
          // Ne considérer que les numéros sans suffixe
          number: { $regex: /^\d+$/ }
        }, { number: 1 }).sort({ number: -1 }).limit(1).lean(); // Tri décroissant et limite à 1 pour obtenir le plus grand
        
        let nextNumber;
        
        if (pendingQuotes.length === 0) {
          // Si aucun devis officiel n'existe, commencer à 1
          nextNumber = '000001';
        } else {
          // Récupérer le dernier numéro (le plus grand)
          const lastNumber = parseInt(pendingQuotes[0].number);
          
          // Incrémenter de 1 et formater
          nextNumber = String(lastNumber + 1).padStart(6, '0');
        }
        
        return nextNumber;
      };
      
      // Si le statut est PENDING, vérifier d'abord s'il existe des devis en DRAFT 
      // qui pourraient entrer en conflit avec le numéro qui sera généré
      const handleDraftConflicts = async (newNumber) => {
        // Vérifier s'il existe un devis en DRAFT avec le même numéro
        const conflictingDrafts = await Quote.find({
          prefix,
          number: newNumber,
          status: 'DRAFT',
          createdBy: user.id
        });
        
        // S'il y a des devis en conflit, mettre à jour leur numéro
        for (const draft of conflictingDrafts) {
          // Ajouter le suffixe -DRAFT au numéro existant
          const newDraftNumber = `${newNumber}-DRAFT`;
          
          // Vérifier que le nouveau numéro n'existe pas déjà
          const existingWithNewNumber = await Quote.findOne({
            prefix,
            number: newDraftNumber,
            createdBy: user.id
          });
          
          // Si le numéro existe déjà, générer un numéro unique avec timestamp
          const finalDraftNumber = existingWithNewNumber 
            ? `DRAFT-${Date.now().toString().slice(-6)}` 
            : newDraftNumber;
          
          // Mettre à jour le devis en brouillon avec le nouveau numéro
          await Quote.findByIdAndUpdate(draft._id, { number: finalDraftNumber });
          console.log(`Devis en brouillon mis à jour avec le numéro ${finalDraftNumber}`);
        }
        
        return newNumber;
      };
      
      // Vérifier si un numéro a été fourni
      let number;
      if (input.number) {
        // Vérifier si le numéro fourni existe déjà
        const existingQuote = await Quote.findOne({ 
          number: input.number,
          createdBy: user.id 
        });
        if (existingQuote) {
          // Si le numéro existe déjà, générer un nouveau numéro
          number = await generateQuoteNumber(prefix, { userId: user.id });
        } else {
          // Sinon, utiliser le numéro fourni
          number = input.number;
          
          // Si le statut est PENDING, vérifier que le numéro est valide et forcer un numéro séquentiel si nécessaire
          if (input.status === 'PENDING') {
            // Vérifier si le numéro fourni est valide pour un devis PENDING
            const existingPendingOrCompleted = await Quote.findOne({
              prefix,
              number,
              status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
              createdBy: user.id
            });
            
            if (existingPendingOrCompleted) {
              // Si le numéro existe déjà pour un devis à encaisser, forcer un numéro séquentiel
              number = await forceSequentialNumber();
            } else {
              // Vérifier si le numéro fourni est supérieur au dernier numéro le plus grand + 1
              const lastQuote = await Quote.findOne({
                prefix,
                status: { $in: ['PENDING', 'COMPLETED', 'CANCELED'] },
                createdBy: user.id,
                number: { $regex: /^\d+$/ }
              }, { number: 1 }).sort({ number: -1 }).limit(1).lean();
              
              // Si des devis existent, vérifier que le numéro fourni est valide
              if (lastQuote) {
                const lastNumber = parseInt(lastQuote.number);
                const providedNumber = parseInt(number);
                
                // Si le numéro fourni n'est pas le suivant après le dernier
                if (providedNumber !== lastNumber + 1) {
                  // Forcer un numéro séquentiel à partir du dernier
                  number = await forceSequentialNumber();
                }
              }
            }
            
            // Gérer les conflits avec les devis en DRAFT
            number = await handleDraftConflicts(number);
          }
        }
      } else {
        // Générer un nouveau numéro
        // Si le statut est PENDING, forcer un numéro strictement séquentiel
        if (input.status === 'PENDING') {
          // Forcer un numéro séquentiel sans écarts
          number = await forceSequentialNumber();
          // Gérer les conflits avec les devis en DRAFT
          number = await handleDraftConflicts(number);
        } else {
          number = await generateQuoteNumber(prefix, { userId: user.id });
        }
      }
      
      const userWithCompany = await User.findById(user.id).select('company');
      if (!userWithCompany?.company) {
        throw new AppError(
          'Les informations de votre entreprise doivent être configurées avant de créer un devis',
          ERROR_CODES.COMPANY_INFO_REQUIRED
        );
      }

      // Calculer les totaux avec la remise
      const totals = calculateQuoteTotals(
        input.items,
        input.discount,
        input.discountType
      );
      
      // Vérifier si le client a une adresse de livraison différente
      const clientData = input.client;
      
      // Si le client a un ID, c'est un client existant - pas besoin de vérifier l'unicité de l'email
      // Seuls les nouveaux clients (sans ID) doivent être vérifiés pour éviter les doublons
      if (!clientData.id) {
        // Vérifier si un client avec cet email existe déjà dans les devis ou factures
        const existingQuote = await Quote.findOne({
          'client.email': clientData.email.toLowerCase(),
          createdBy: user.id
        });
        
        const existingInvoice = await Invoice.findOne({
          'client.email': clientData.email.toLowerCase(),
          createdBy: user.id
        });
        
        if (existingQuote || existingInvoice) {
          throw createValidationError(
            `Un client avec l'adresse email "${clientData.email}" existe déjà. Veuillez sélectionner le client existant ou utiliser une adresse email différente.`,
            { 'client.email': 'Cette adresse email est déjà utilisée par un autre client' }
          );
        }
      }
      
      // Si le client a une adresse de livraison différente, s'assurer qu'elle est bien fournie
      if (clientData.hasDifferentShippingAddress === true && !clientData.shippingAddress) {
        throw createValidationError(
          'L\'adresse de livraison est requise lorsque l\'option "Adresse de livraison différente" est activée',
          { 'client.shippingAddress': 'L\'adresse de livraison est requise' }
        );
      }
      
      // Générer automatiquement le nom pour les clients particuliers si nécessaire
      if (clientData.type === 'INDIVIDUAL' && (!clientData.name || clientData.name.trim() === '')) {
        if (clientData.firstName && clientData.lastName) {
          clientData.name = `${clientData.firstName} ${clientData.lastName}`;
        } else {
          // Fallback si les champs firstName/lastName sont manquants
          clientData.name = clientData.email ? `Client ${clientData.email}` : 'Client Particulier';
        }
      }
      
      // Créer le devis avec les informations de l'entreprise du profil utilisateur si non fournies
      const quote = new Quote({
        ...input,
        number, // S'assurer que le numéro est défini
        prefix,
        companyInfo: input.companyInfo || userWithCompany.company,
        createdBy: user.id,
        ...totals // Ajouter tous les totaux calculés
      });
      
      await quote.save();
      return await quote.populate('createdBy');
    }),

    updateQuote: isAuthenticated(async (_, { id, input }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });
      
      if (!quote) {
        throw createNotFoundError('Devis');
      }

      if (quote.status === 'COMPLETED') {
        throw createResourceLockedError('Devis', 'un devis terminé ne peut pas être modifié');
      }

      if (quote.convertedToInvoice) {
        throw createResourceLockedError('Devis', 'un devis converti en facture ne peut pas être modifié');
      }

      // Vérifier si un nouveau numéro est fourni
      if (input.number && input.number !== quote.number) {
        // Vérifier si le numéro fourni existe déjà
        const existingQuote = await Quote.findOne({ 
          number: input.number,
          _id: { $ne: id } // Exclure le devis actuel de la recherche
        });
        
        if (existingQuote) {
          throw new AppError(
            'Ce numéro de devis est déjà utilisé',
            ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER
          );
        }
      }

      // Si des items sont fournis, recalculer les totaux
      if (input.items) {
        const totals = calculateQuoteTotals(
          input.items,
          input.discount !== undefined ? input.discount : quote.discount,
          input.discountType || quote.discountType
        );
        input = { ...input, ...totals };
      }

      // Préparer les données à mettre à jour
      let updateData = { ...input };
      
      // Vérifier si le client a une adresse de livraison différente
      if (updateData.client && updateData.client.hasDifferentShippingAddress === true && !updateData.client.shippingAddress) {
        throw createValidationError(
          'L\'adresse de livraison est requise lorsque l\'option "Adresse de livraison différente" est activée',
          { 'client.shippingAddress': 'L\'adresse de livraison est requise' }
        );
      }
      
      // Si les informations de l'entreprise ne sont pas fournies, les supprimer pour ne pas écraser les existantes
      if (!updateData.companyInfo) {
        delete updateData.companyInfo;
      }
      
      Object.assign(quote, updateData);
      await quote.save();
      return await quote.populate('createdBy');
    }),

    deleteQuote: isAuthenticated(async (_, { id }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });
      
      if (!quote) {
        throw createNotFoundError('Devis');
      }

      if (quote.status === 'COMPLETED') {
        throw createResourceLockedError('Devis', 'un devis terminé ne peut pas être supprimé');
      }

      if (quote.convertedToInvoice) {
        throw createResourceLockedError('Devis', 'un devis converti en facture ne peut pas être supprimé');
      }

      await Quote.deleteOne({ _id: id, createdBy: user.id });
      return true;
    }),

    changeQuoteStatus: isAuthenticated(async (_, { id, status }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });
      
      if (!quote) {
        throw createNotFoundError('Devis');
      }

      if (quote.convertedToInvoice) {
        throw createResourceLockedError('Devis', 'converti en facture');
      }

      // Vérification des transitions de statut autorisées
      const allowedTransitions = {
        DRAFT: ['PENDING'],
        PENDING: ['COMPLETED', 'DRAFT', 'CANCELED'],
        COMPLETED: [],
        CANCELED: []
      };

      if (!allowedTransitions[quote.status].includes(status)) {
        throw createStatusTransitionError('Devis', quote.status, status);
      }

      // Si le devis passe de DRAFT à PENDING, générer un nouveau numéro séquentiel
      if (quote.status === 'DRAFT' && status === 'PENDING') {
        // Conserver l'ancien préfixe ou utiliser le préfixe standard
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const prefix = quote.prefix || `D-${year}${month}-`;
        
        // Générer un nouveau numéro séquentiel par rapport aux devis PENDING/COMPLETED/CANCELED
        const { generateQuoteNumber } = require('../utils/documentNumbers');
        const newNumber = await generateQuoteNumber(prefix, {
          manualNumber: quote.number,
          isPending: true,
          userId: user.id
        });
        
        // Vérifier si un autre devis en brouillon existe avec ce numéro
        const conflictingDraft = await Quote.findOne({
          _id: { $ne: quote._id },
          prefix,
          number: newNumber,
          status: 'DRAFT',
          createdBy: user.id
        });
        
        if (conflictingDraft) {
          // Générer un nouveau numéro pour le devis en conflit
          // Trouver le dernier numéro de brouillon avec ce préfixe
          const lastDraftNumber = await Quote.findOne({
            prefix,
            status: 'DRAFT',
            createdBy: user.id
          }).sort({ number: -1 });
          
          // Générer un nouveau numéro pour le brouillon en conflit
          let newDraftNumber;
          if (lastDraftNumber) {
            // Ajouter un suffixe -DRAFT au numéro existant
            newDraftNumber = `${newNumber}-DRAFT`;
          } else {
            newDraftNumber = `DRAFT-${Math.floor(Math.random() * 10000)}`;
          }
          
          // Vérifier que le nouveau numéro n'existe pas déjà
          const existingWithNewNumber = await Quote.findOne({
            prefix,
            number: newDraftNumber,
            createdBy: user.id
          });
          
          if (existingWithNewNumber) {
            // Si le numéro existe déjà, ajouter un timestamp
            newDraftNumber = `DRAFT-${Date.now().toString().slice(-6)}`;
          }
          
          // Mettre à jour le devis en conflit
          conflictingDraft.number = newDraftNumber;
          await conflictingDraft.save();
        }
        
        // Mettre à jour le numéro du devis actuel
        quote.number = newNumber;
      }

      quote.status = status;
      await quote.save();
      return await quote.populate('createdBy');
    }),

    convertQuoteToInvoice: isAuthenticated(async (_, { id, distribution, isDeposit, skipValidation }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });
      
      if (!quote) {
        throw createNotFoundError('Devis');
      }

      if (quote.status !== 'COMPLETED') {
        throw new AppError(
          'Seuls les devis terminés peuvent être convertis en factures',
          ERROR_CODES.RESOURCE_LOCKED,
          { resource: 'Devis', requiredStatus: 'COMPLETED', currentStatus: quote.status }
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
          _id: { $in: quote.linkedInvoices }
        });
        
        // Mettre à jour la liste des factures liées valides
        validLinkedInvoices = existingInvoices.map(invoice => invoice._id);
        
        // Nettoyer la liste des factures liées en supprimant les références aux factures qui n'existent plus
        if (validLinkedInvoices.length !== quote.linkedInvoices.length) {
          quote.linkedInvoices = validLinkedInvoices;
          await quote.save();
        }
        
        // Calculer le montant total des factures existantes
        existingInvoicesTotalAmount = existingInvoices.reduce((sum, invoice) => sum + invoice.finalTotalTTC, 0);
        
        // Montant total des factures existantes: ${existingInvoicesTotalAmount}€
      }
      
      // Pour la rétrocompatibilité, vérifier aussi convertedToInvoice
      if (quote.convertedToInvoice) {
        // Vérifier si la facture référencée dans convertedToInvoice existe toujours
        const convertedInvoiceExists = await Invoice.exists({ _id: quote.convertedToInvoice });
        
        if (!convertedInvoiceExists) {
          // Si la facture n'existe plus, réinitialiser le champ convertedToInvoice
          quote.convertedToInvoice = null;
          await quote.save();
        } else if (!quote.linkedInvoices?.includes(quote.convertedToInvoice)) {
          throw createResourceLockedError('Devis', 'déjà converti en facture');
        }
      }

      // Utiliser le préfixe standard pour les factures (F-AAAAMM-)
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
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
          { resource: 'Devis', maxInvoices: 3, currentCount: validLinkedInvoicesCount, requestedCount: invoiceCount }
        );
      }
      
      // Calculer le pourcentage déjà utilisé par les factures existantes
      let existingInvoicesPercentage = 0;
      
      if (existingInvoicesTotalAmount > 0 && quoteAmount > 0) {
        existingInvoicesPercentage = (existingInvoicesTotalAmount / quoteAmount) * 100;
      }
      
      // Vérifier que la somme des pourcentages est bien égale à 100%
      const newInvoicesPercentage = invoiceDistribution.reduce((sum, percent) => sum + percent, 0);
      const totalPercentage = existingInvoicesPercentage + newInvoicesPercentage;
      
      // Si skipValidation est true (pour les factures d'acompte), on ignore cette vérification
      if (!skipValidation && Math.abs(totalPercentage - 100) > 0.01) { // Tolérance pour les erreurs d'arrondi
        // Ne pas ajuster automatiquement, respecter le choix de l'utilisateur
        // Vérifier simplement que le total ne dépasse pas 100%
        if (totalPercentage > 100.01) {
          throw new AppError(
            `La somme des pourcentages de répartition (${newInvoicesPercentage.toFixed(2)}% + ${existingInvoicesPercentage.toFixed(2)}% déjà facturé) ne peut pas dépasser 100% (actuellement ${totalPercentage.toFixed(2)}%)`,
            ERROR_CODES.INVALID_INPUT,
            { existingPercentage: existingInvoicesPercentage, newPercentage: newInvoicesPercentage, total: totalPercentage }
          );
        }
        
        // Si le total est inférieur à 100%, c'est acceptable
        // L'utilisateur pourra créer d'autres factures plus tard pour atteindre 100%
      }
      
      // Cette section a été déplacée plus haut
      
      // Créer les factures selon la répartition
      const createdInvoices = [];
      let mainInvoice = null;
      let newInvoicesTotalAmount = 0;
      
      // Calculer le montant restant disponible pour de nouvelles factures
      const remainingAmount = quoteAmount - existingInvoicesTotalAmount;
      
      if (remainingAmount <= 0) {
        throw new AppError(
          `Le montant total des factures existantes (${existingInvoicesTotalAmount.toFixed(2)}€) a déjà atteint ou dépassé le montant du devis (${quoteAmount.toFixed(2)}€)`,
          ERROR_CODES.RESOURCE_LOCKED,
          { resource: 'Devis', quoteAmount, existingInvoicesTotalAmount, remainingAmount }
        );
      }
      
      // Montant restant disponible pour de nouvelles factures: ${remainingAmount.toFixed(2)}€
      
      for (let i = 0; i < invoiceCount; i++) {
        // Générer un nouveau numéro de facture avec ce préfixe au moment de la création
        // Cela garantit que le numéro est séquentiel par rapport aux autres factures déjà créées
        const number = await generateInvoiceNumber(prefix);
        
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
          companyInfo: quote.companyInfo,
          items: quote.items, // Note: les items ne sont pas répartis, ils sont tous inclus dans chaque facture
          status: 'DRAFT', // Toujours créer en brouillon pour permettre les modifications
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
          createdBy: user.id,
          isDeposit: isInvoiceDeposit, // Marquer comme facture d'acompte si spécifié
          // Ajouter une note appropriée selon le type de facture
          notes: isInvoiceDeposit 
            ? `Facture d'acompte (${invoiceDistribution[i]}% du montant total)` 
            : invoiceCount > 1 
              ? `Facture partielle ${i+1}/${invoiceCount} (${invoiceDistribution[i]}% du montant total)` 
              : ''
        });
        
        await invoice.save();
        createdInvoices.push(invoice);
        
        // La première facture est considérée comme la facture principale
        if (i === 0) {
          mainInvoice = invoice;
        }
      }
      
      // Vérifier que le montant total des nouvelles factures ne dépasse pas le montant restant
      if (newInvoicesTotalAmount > remainingAmount + 0.01) { // Tolérance pour les erreurs d'arrondi
        // Supprimer les factures créées car elles dépassent le montant disponible
        for (const invoice of createdInvoices) {
          await Invoice.deleteOne({ _id: invoice._id });
        }
        
        throw new AppError(
          `Le montant total des nouvelles factures (${newInvoicesTotalAmount.toFixed(2)}€) dépasse le montant restant disponible (${remainingAmount.toFixed(2)}€)`,
          ERROR_CODES.INVALID_INPUT,
          { quoteAmount, existingInvoicesTotalAmount, remainingAmount, newInvoicesTotalAmount }
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
      return await mainInvoice.populate('createdBy');
    }),

    sendQuote: isAuthenticated(async (_, { id, /* email */ }, { user }) => {
      const quote = await Quote.findOne({ _id: id, createdBy: user.id });
      
      if (!quote) {
        throw createNotFoundError('Devis');
      }

      // Ici, vous pourriez implémenter la logique d'envoi d'email
      // Pour l'instant, nous simulons un succès
      // TODO: Implémenter l'envoi réel du devis par email
      
      return true;
    })
  }
};

module.exports = quoteResolvers;
