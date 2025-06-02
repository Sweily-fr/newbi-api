const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Invoice = require('../models/Invoice');
const User = require('../models/User');
const { isAuthenticated } = require('../middlewares/auth');
const { generatePurchaseOrderNumber, generateInvoiceNumber } = require('../utils/documentNumbers');
const { 
  createNotFoundError, 
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES
} = require('../utils/errors');

// Fonction utilitaire pour calculer les totaux avec remise
// Note: Cette fonction est utilisée indirectement par le modèle PurchaseOrder via le pre-save hook
// et pourrait être utilisée directement dans les résolveurs si nécessaire

const purchaseOrderResolvers = {
  PurchaseOrder: {
    createdBy: async (purchaseOrder) => {
      return await User.findById(purchaseOrder.createdBy);
    },
    convertedToInvoice: async (purchaseOrder) => {
      if (!purchaseOrder.convertedToInvoice) return null;
      return await Invoice.findById(purchaseOrder.convertedToInvoice);
    },
    linkedInvoices: async (purchaseOrder) => {
      // Trouver toutes les factures liées à ce bon de commande
      // Cela inclut la facture principale (convertedToInvoice) et potentiellement d'autres factures
      // comme des factures d'acompte, etc.
      if (purchaseOrder.linkedInvoices && purchaseOrder.linkedInvoices.length > 0) {
        // Si le champ linkedInvoices est déjà rempli, utiliser ces références
        return await Invoice.find({ _id: { $in: purchaseOrder.linkedInvoices } });
      } else if (purchaseOrder.convertedToInvoice) {
        // Pour la compatibilité avec les anciens bons de commande qui n'ont que convertedToInvoice
        const invoice = await Invoice.findById(purchaseOrder.convertedToInvoice);
        return invoice ? [invoice] : [];
      }
      
      return [];
    }
  },
  Query: {
    purchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      const purchaseOrder = await PurchaseOrder.findOne({ _id: id, createdBy: user.id })
        .populate('createdBy')
        .populate('convertedToInvoice');
      if (!purchaseOrder) throw createNotFoundError('Bon de commande');
      return purchaseOrder;
    }),

    purchaseOrders: isAuthenticated(async (_, { startDate, endDate, status, search, page = 1, limit = 10 }, { user }) => {
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
      const totalCount = await PurchaseOrder.countDocuments(query);
      
      const purchaseOrders = await PurchaseOrder.find(query)
        .populate('createdBy')
        .populate('convertedToInvoice')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      return {
        purchaseOrders,
        totalCount,
        hasNextPage: totalCount > skip + limit
      };
    }),

    purchaseOrderStats: isAuthenticated(async (_, __, { user }) => {
      const [stats] = await PurchaseOrder.aggregate([
        { $match: { createdBy: new mongoose.Types.ObjectId(user.id) } },
        {
          $group: {
            _id: null,
            totalCount: { $sum: 1 },
            draftCount: {
              $sum: {
                $cond: [{ $eq: ['$status', 'DRAFT'] }, 1, 0]
              }
            },
            pendingCount: {
              $sum: {
                $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0]
              }
            },
            canceledCount: {
              $sum: {
                $cond: [{ $eq: ['$status', 'CANCELED'] }, 1, 0]
              }
            },
            completedCount: {
              $sum: {
                $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0]
              }
            },
            totalAmount: {
              $sum: '$finalTotalTTC'
            },
            // Taux de conversion: nombre de bons de commande convertis en facture / nombre total de bons de commande complétés
            convertedCount: {
              $sum: {
                $cond: [{ $ne: ['$convertedToInvoice', null] }, 1, 0]
              }
            }
          }
        },
        {
          $addFields: {
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

      if (stats) {
        // S'assurer que toutes les propriétés existent
        Object.keys(defaultStats).forEach(key => {
          if (stats[key] === undefined) {
            stats[key] = 0;
          }
        });
        return stats;
      }

      return defaultStats;
    }),

    nextPurchaseOrderNumber: isAuthenticated(async (_, { prefix }, { user }) => {
      // Récupérer le préfixe personnalisé de l'utilisateur ou utiliser le format par défaut
      const userObj = await mongoose.model('User').findById(user.id);
      const customPrefix = prefix || userObj?.settings?.purchaseOrderNumberPrefix;
      return await generatePurchaseOrderNumber(customPrefix, { userId: user.id });
    })
  },
  Mutation: {
    createPurchaseOrder: isAuthenticated(async (_, { input }, { user }) => {
      // Utiliser le préfixe fourni ou 'BC' par défaut
      const prefix = input.prefix || 'BC';
      
      // Fonction pour forcer un numéro séquentiel pour les bons de commande en PENDING
      // À partir du dernier numéro le plus grand, sans combler les trous
      const forceSequentialNumber = async () => {
        // Trouver le dernier bon de commande avec le préfixe spécifié
        const lastPurchaseOrder = await PurchaseOrder.findOne({
          prefix,
          createdBy: user.id,
          status: { $in: ['PENDING', 'COMPLETED'] }
        }).sort({ number: -1 });
        
        if (lastPurchaseOrder) {
          // Extraire le numéro et l'incrémenter
          const lastNumber = parseInt(lastPurchaseOrder.number, 10);
          if (!isNaN(lastNumber)) {
            return String(lastNumber + 1).padStart(lastPurchaseOrder.number.length, '0');
          }
        }
        
        // Si aucun bon de commande existant ou si le numéro n'est pas un nombre, commencer à 1
        return '001';
      };
      
      // Si le statut est PENDING, vérifier d'abord s'il existe des bons de commande en DRAFT 
      // qui pourraient entrer en conflit avec le numéro qui sera généré
      const handleDraftConflicts = async (newNumber) => {
        // Vérifier si un bon de commande en DRAFT existe déjà avec ce numéro
        const existingDraft = await PurchaseOrder.findOne({
          prefix,
          number: newNumber,
          status: 'DRAFT',
          createdBy: user.id
        });
        
        if (existingDraft) {
          // Si un brouillon existe avec ce numéro, trouver le prochain numéro disponible
          // en vérifiant tous les bons de commande (DRAFT, PENDING, COMPLETED)
          const allPurchaseOrders = await PurchaseOrder.find({
            prefix,
            createdBy: user.id
          }).sort({ number: -1 });
          
          if (allPurchaseOrders.length > 0) {
            // Trouver le plus grand numéro parmi tous les bons de commande
            const highestNumber = Math.max(...allPurchaseOrders
              .map(po => parseInt(po.number, 10))
              .filter(num => !isNaN(num)));
            
            return String(highestNumber + 1).padStart(newNumber.length, '0');
          }
        }
        
        return newNumber;
      };
      
      // Vérifier si un numéro a été fourni
      let number;
      if (input.number) {
        // Vérifier si le numéro fourni existe déjà
        const existingPurchaseOrder = await PurchaseOrder.findOne({ 
          number: input.number,
          createdBy: user.id 
        });
        if (existingPurchaseOrder) {
          // Si le numéro existe déjà, générer un nouveau numéro
          number = await generatePurchaseOrderNumber(prefix, { userId: user.id });
        } else {
          // Sinon, utiliser le numéro fourni
          number = input.number;
          
          // Si le statut est PENDING, vérifier que le numéro est valide et forcer un numéro séquentiel si nécessaire
          if (input.status === 'PENDING') {
            // Vérifier si le numéro fourni est valide pour un bon de commande PENDING
            const existingPendingOrCompleted = await PurchaseOrder.findOne({
              prefix,
              number,
              status: { $in: ['PENDING', 'COMPLETED'] },
              createdBy: user.id
            });
            
            if (existingPendingOrCompleted) {
              // Si le numéro existe déjà pour un bon de commande à encaisser, forcer un numéro séquentiel
              number = await forceSequentialNumber();
            } else {
              // Vérifier si le numéro fourni est supérieur au dernier numéro le plus grand + 1
              const lastPurchaseOrder = await PurchaseOrder.findOne({
                prefix,
                status: { $in: ['PENDING', 'COMPLETED'] },
                createdBy: user.id
              }).sort({ number: -1 });
              
              if (lastPurchaseOrder) {
                const lastNumber = parseInt(lastPurchaseOrder.number, 10);
                const currentNumber = parseInt(number, 10);
                
                if (!isNaN(lastNumber) && !isNaN(currentNumber) && currentNumber <= lastNumber) {
                  // Si le numéro fourni est inférieur ou égal au dernier numéro, forcer un numéro séquentiel
                  number = await forceSequentialNumber();
                }
              }
            }
            
            // Gérer les conflits avec les bons de commande en DRAFT
            number = await handleDraftConflicts(number);
          }
        }
      } else {
        // Si aucun numéro n'a été fourni, générer un nouveau numéro
        number = await generatePurchaseOrderNumber(prefix, { userId: user.id });
      }
      
      // Créer le bon de commande avec les données fournies
      const purchaseOrderData = {
        ...input,
        prefix,
        number,
        createdBy: user.id
      };
      
      // Si aucune information d'entreprise n'est fournie, utiliser les informations de l'utilisateur
      if (!purchaseOrderData.companyInfo) {
        const userObj = await User.findById(user.id);
        if (userObj && userObj.companyInfo) {
          purchaseOrderData.companyInfo = userObj.companyInfo;
        }
      }
      
      // Créer le bon de commande
      const purchaseOrder = new PurchaseOrder(purchaseOrderData);
      await purchaseOrder.save();
      
      return await purchaseOrder.populate('createdBy');
    }),
    
    updatePurchaseOrder: isAuthenticated(async (_, { id, input }, { user }) => {
      // Trouver le bon de commande existant
      const purchaseOrder = await PurchaseOrder.findOne({ _id: id, createdBy: user.id });
      if (!purchaseOrder) throw createNotFoundError('Bon de commande');
      
      // Vérifier si le bon de commande peut être modifié
      if (purchaseOrder.status === 'COMPLETED') {
        throw createResourceLockedError('Bon de commande', 'complété');
      }
      
      // Mettre à jour les champs fournis
      Object.keys(input).forEach(key => {
        purchaseOrder[key] = input[key];
      });
      
      // Sauvegarder les modifications
      await purchaseOrder.save();
      
      return await purchaseOrder.populate('createdBy');
    }),
    
    deletePurchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      // Vérifier si le bon de commande existe
      const purchaseOrder = await PurchaseOrder.findOne({ _id: id, createdBy: user.id });
      if (!purchaseOrder) throw createNotFoundError('Bon de commande');
      
      // Vérifier si le bon de commande peut être supprimé
      if (purchaseOrder.status === 'COMPLETED') {
        throw createResourceLockedError('Bon de commande', 'complété');
      }
      
      // Vérifier si le bon de commande a été converti en facture
      if (purchaseOrder.convertedToInvoice) {
        throw createResourceLockedError('Bon de commande', 'converti en facture');
      }
      
      // Supprimer le bon de commande
      await PurchaseOrder.deleteOne({ _id: id });
      
      return true;
    }),
    
    changePurchaseOrderStatus: isAuthenticated(async (_, { id, status }, { user }) => {
      // Vérifier si le bon de commande existe
      const purchaseOrder = await PurchaseOrder.findOne({ _id: id, createdBy: user.id });
      if (!purchaseOrder) throw createNotFoundError('Bon de commande');
      
      // Vérifier les transitions de statut valides
      const currentStatus = purchaseOrder.status;
      
      // Règles de transition:
      // DRAFT -> PENDING, CANCELED
      // PENDING -> COMPLETED, CANCELED
      // COMPLETED -> (aucun changement autorisé)
      // CANCELED -> DRAFT, PENDING
      
      const validTransitions = {
        DRAFT: ['PENDING', 'CANCELED'],
        PENDING: ['COMPLETED', 'CANCELED'],
        COMPLETED: [],
        CANCELED: ['DRAFT', 'PENDING']
      };
      
      if (!validTransitions[currentStatus].includes(status)) {
        throw createStatusTransitionError('Bon de commande', currentStatus, status);
      }
      
      // Mettre à jour le statut
      purchaseOrder.status = status;
      await purchaseOrder.save();
      
      return await purchaseOrder.populate('createdBy');
    }),
    
    convertPurchaseOrderToInvoice: isAuthenticated(async (_, { id, distribution = [100], isDeposit = false, skipValidation = false }, { user }) => {
      // Vérifier si le bon de commande existe
      const purchaseOrder = await PurchaseOrder.findOne({ _id: id, createdBy: user.id });
      if (!purchaseOrder) throw createNotFoundError('Bon de commande');
      
      // Vérifier si le bon de commande peut être converti
      if (purchaseOrder.status !== 'COMPLETED' && !skipValidation) {
        throw createValidationError('Le bon de commande doit être complété avant de pouvoir être converti en facture');
      }
      
      // Vérifier si le bon de commande a déjà été converti en facture
      if (purchaseOrder.convertedToInvoice && !skipValidation) {
        throw createResourceLockedError('Bon de commande', 'déjà converti en facture');
      }
      
      // Récupérer les factures existantes liées à ce bon de commande
      const existingInvoices = purchaseOrder.linkedInvoices && purchaseOrder.linkedInvoices.length > 0
        ? await Invoice.find({ _id: { $in: purchaseOrder.linkedInvoices } })
        : [];
      
      // Calculer le montant total des factures existantes
      const existingInvoicesTotalAmount = existingInvoices.reduce((total, invoice) => {
        return total + invoice.finalTotalTTC;
      }, 0);
      
      // Calculer le montant total du bon de commande
      const quoteAmount = purchaseOrder.finalTotalTTC;
      
      // Calculer le montant restant disponible pour de nouvelles factures
      const remainingAmount = Math.max(0, quoteAmount - existingInvoicesTotalAmount);
      
      // Vérifier si la distribution est valide
      const invoiceDistribution = distribution || [100];
      const invoiceCount = invoiceDistribution.length;
      
      // Vérifier que la somme des pourcentages est égale à 100%
      const totalPercentage = invoiceDistribution.reduce((sum, percent) => sum + percent, 0);
      if (Math.abs(totalPercentage - 100) > 0.01 && !skipValidation) { // Tolérance pour les erreurs d'arrondi
        throw createValidationError(`La somme des pourcentages de distribution doit être égale à 100% (actuellement ${totalPercentage}%)`);
      }
      
      // Calculer le montant total des nouvelles factures
      const newInvoicesTotalAmount = (remainingAmount * totalPercentage) / 100;
      
      // Générer un numéro de facture
      const userObj = await User.findById(user.id);
      const prefix = userObj?.settings?.invoiceNumberPrefix || 'F';
      const number = await generateInvoiceNumber(prefix, { userId: user.id });
      
      // Créer les factures selon la distribution
      const createdInvoices = [];
      let mainInvoice = null;
      
      for (let i = 0; i < invoiceCount; i++) {
        // Calculer le pourcentage de cette facture
        const invoicePercentage = invoiceDistribution[i];
        
        // Calculer les totaux pour cette facture
        const totalHT = purchaseOrder.totalHT * (invoicePercentage / 100);
        const totalVAT = purchaseOrder.totalVAT * (invoicePercentage / 100);
        const totalTTC = purchaseOrder.totalTTC * (invoicePercentage / 100);
        const finalTotalHT = purchaseOrder.finalTotalHT * (invoicePercentage / 100);
        const finalTotalTTC = purchaseOrder.finalTotalTTC * (invoicePercentage / 100);
        const discountAmount = purchaseOrder.discountAmount * (invoicePercentage / 100);
        
        const isInvoiceDeposit = isDeposit === true;
        
        // Créer la facture à partir du bon de commande
        const invoice = new Invoice({
          number,
          prefix,
          client: purchaseOrder.client,
          companyInfo: purchaseOrder.companyInfo,
          items: purchaseOrder.items, // Note: les items ne sont pas répartis, ils sont tous inclus dans chaque facture
          status: 'DRAFT', // Toujours créer en brouillon pour permettre les modifications
          issueDate: new Date(),
          dueDate: new Date(new Date().setDate(new Date().getDate() + 30)), // Date d'échéance par défaut à 30 jours
          headerNotes: purchaseOrder.headerNotes,
          footerNotes: purchaseOrder.footerNotes,
          termsAndConditions: purchaseOrder.termsAndConditions,
          termsAndConditionsLinkTitle: purchaseOrder.termsAndConditionsLinkTitle,
          termsAndConditionsLink: purchaseOrder.termsAndConditionsLink,
          purchaseOrderNumber: `${purchaseOrder.prefix}${purchaseOrder.number}`, // Définir le numéro de bon de commande
          discount: purchaseOrder.discount,
          discountType: purchaseOrder.discountType,
          customFields: purchaseOrder.customFields,
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
      if (newInvoicesTotalAmount > remainingAmount + 0.01 && !skipValidation) { // Tolérance pour les erreurs d'arrondi
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
      
      // Mettre à jour le bon de commande avec la référence à la facture principale créée
      purchaseOrder.convertedToInvoice = mainInvoice._id;
      
      // Ajouter toutes les factures à la liste des factures liées
      if (!purchaseOrder.linkedInvoices) {
        purchaseOrder.linkedInvoices = [];
      }
      
      for (const invoice of createdInvoices) {
        purchaseOrder.linkedInvoices.push(invoice._id);
      }
      
      await purchaseOrder.save();

      // Retourner la facture principale
      return await mainInvoice.populate('createdBy');
    }),

    sendPurchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      const purchaseOrder = await PurchaseOrder.findOne({ _id: id, createdBy: user.id });
      
      if (!purchaseOrder) {
        throw createNotFoundError('Bon de commande');
      }

      // Ici, vous pourriez implémenter la logique d'envoi d'email
      // Pour l'instant, nous simulons un succès
      // TODO: Implémenter l'envoi réel du bon de commande par email
      
      return true;
    })
  }
};

module.exports = purchaseOrderResolvers;
