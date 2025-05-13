const Invoice = require('../models/Invoice');
const User = require('../models/User');
const Quote = require('../models/Quote');
const { isAuthenticated } = require('../middlewares/auth');
const { generateInvoiceNumber } = require('../utils/documentNumbers');
const mongoose = require('mongoose');
const { 
  createNotFoundError, 
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES
} = require('../utils/errors');

// Fonction utilitaire pour calculer les totaux avec remise
const calculateInvoiceTotals = (items, discount = 0, discountType = 'FIXED') => {
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

const invoiceResolvers = {
  Query: {
    invoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id }).populate('createdBy');
      if (!invoice) throw createNotFoundError('Facture');
      return invoice;
    }),

    invoices: isAuthenticated(async (_, { startDate, endDate, status, search, page = 1, limit = 10 }, { user }) => {
      const query = { createdBy: user.id };

      if (startDate || endDate) {
        query.createdAt = {};
        if (startDate) query.createdAt.$gte = new Date(startDate);
        if (endDate) query.createdAt.$lte = new Date(endDate);
      }

      if (status) {
        // Si on filtre par COMPLETED, inclure aussi les factures CANCELED
        if (status === 'COMPLETED') {
          query.status = { $in: ['COMPLETED', 'CANCELED'] };
        } else {
          query.status = status;
        }
      }

      if (search) {
        const searchRegex = new RegExp(search, 'i');
        query.$or = [
          { 'number': searchRegex },
          { 'client.name': searchRegex },
          { 'client.email': searchRegex }
        ];
      }

      const skip = (page - 1) * limit;
      const totalCount = await Invoice.countDocuments(query);
      
      const invoices = await Invoice.find(query)
        .populate('createdBy')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      return {
        invoices,
        totalCount,
        hasNextPage: totalCount > skip + limit
      };
    }),

    invoiceStats: isAuthenticated(async (_, __, { user }) => {
      const [stats] = await Invoice.aggregate([
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
              $sum: { $cond: [{ $or: [{ $eq: ['$status', 'COMPLETED'] }, { $eq: ['$status', 'CANCELED'] }] }, 1, 0] }
            },
            canceledCount: {
              $sum: { $cond: [{ $eq: ['$status', 'CANCELED'] }, 1, 0] }
            },
            totalAmount: { $sum: '$totalTTC' }
          }
        }
      ]);

      return stats || {
        totalCount: 0,
        draftCount: 0,
        pendingCount: 0,
        completedCount: 0,
        canceledCount: 0,
        totalAmount: 0
      };
    }),

    nextInvoiceNumber: isAuthenticated(async (_, { prefix }, { user }) => {
      // Récupérer le préfixe personnalisé de l'utilisateur ou utiliser le format par défaut
      const userObj = await mongoose.model('User').findById(user.id);
      const customPrefix = prefix || userObj?.settings?.invoiceNumberPrefix;
      return await generateInvoiceNumber(customPrefix, { userId: user.id });
    })
  },

  Mutation: {
    createInvoice: isAuthenticated(async (_, { input }, { user }) => {
      // Récupérer les informations de l'entreprise de l'utilisateur
      const userWithCompany = await User.findById(user.id);
      if (!userWithCompany.company) {
        throw new AppError(
          'Vous devez configurer les informations de votre entreprise avant de créer une facture',
          ERROR_CODES.VALIDATION_ERROR
        );
      }

      // Utiliser le préfixe fourni ou générer un préfixe par défaut
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const prefix = input.prefix || `F-${year}${month}-`;

      // Si le statut est PENDING, vérifier d'abord s'il existe des factures en DRAFT 
      // qui pourraient entrer en conflit avec le numéro qui sera généré
      const handleDraftConflicts = async (newNumber) => {
        // Vérifier si une autre facture en brouillon existe avec ce numéro
        const conflictingDraft = await Invoice.findOne({
          prefix,
          number: newNumber,
          status: 'DRAFT',
          createdBy: user.id
        });
        
        if (conflictingDraft) {
          // Au lieu de modifier le préfixe, générer un nouveau numéro pour la facture en conflit
          // Trouver le dernier numéro de brouillon avec ce préfixe
          const lastDraftNumber = await Invoice.findOne({
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
          const existingWithNewNumber = await Invoice.findOne({
            prefix,
            number: newDraftNumber,
            createdBy: user.id
          });
          
          if (existingWithNewNumber) {
            // Si le numéro existe déjà, ajouter un timestamp
            newDraftNumber = `DRAFT-${Date.now().toString().slice(-6)}`;
          }
          
          // Mettre à jour la facture en conflit
          conflictingDraft.number = newDraftNumber;
          await conflictingDraft.save();
        }
        
        return newNumber;
      };
      
      // Vérifier si un numéro a été fourni ou si le statut n'est pas DRAFT
      let number;
      if (input.status !== 'DRAFT') {
        // Si le statut n'est pas DRAFT, un numéro est requis
        if (input.number) {
          // Vérifier si le numéro fourni existe déjà
          const existingInvoice = await Invoice.findOne({ 
            prefix, 
            number: input.number,
            status: { $ne: 'DRAFT' },
            createdBy: user.id 
          });
          
          if (existingInvoice) {
            throw new AppError(
              `Le numéro de facture ${prefix}${input.number} existe déjà`,
              ERROR_CODES.DUPLICATE_ERROR
            );
          }
          
          number = input.number;
          
          // Si le statut est PENDING, gérer les conflits avec les factures en DRAFT
          if (input.status === 'PENDING') {
            number = await handleDraftConflicts(number);
          }
        }
      } else if (input.number) {
        // Si c'est un brouillon mais qu'un numéro est fourni, le valider
        const existingInvoice = await Invoice.findOne({ 
          prefix, 
          number: input.number,
          createdBy: user.id,
          _id: { $ne: input.id } // Exclure la facture en cours de modification
        });
        
        if (existingInvoice) {
          // Si le numéro existe déjà, générer un nouveau numéro
          number = `DRAFT-${Date.now().toString().slice(-6)}`;
        } else {
          // Sinon, utiliser le numéro fourni
          number = input.number;
        }
      } else {
        // Si aucun numéro n'est fourni et que c'est un brouillon, générer un numéro temporaire
        const lastDraftInvoice = await Invoice.findOne({ 
          status: 'DRAFT',
          createdBy: user.id 
        }).sort({ createdAt: -1 });
        
        if (lastDraftInvoice && lastDraftInvoice.number && lastDraftInvoice.number.startsWith('DRAFT-')) {
          // Extraire le numéro du dernier brouillon
          const lastDraftNumber = parseInt(lastDraftInvoice.number.replace('DRAFT-', ''), 10);
          if (!isNaN(lastDraftNumber)) {
            number = `DRAFT-${lastDraftNumber + 1}`;
          } else {
            number = `DRAFT-1`;
          }
        } else {
          number = `DRAFT-1`;
        }
      }

      // Calculer les totaux avec la remise
      const totals = calculateInvoiceTotals(
        input.items,
        input.discount,
        input.discountType
      );
      
      try {
        // Vérifier si le client a une adresse de livraison différente
        const clientData = input.client;
        
        // Si le client a une adresse de livraison différente, s'assurer qu'elle est bien fournie
        if (clientData.hasDifferentShippingAddress === true && !clientData.shippingAddress) {
          throw createValidationError(
            'L\'adresse de livraison est requise lorsque l\'option "Adresse de livraison différente" est activée',
            { 'client.shippingAddress': 'L\'adresse de livraison est requise' }
          );
        }
        
        // Create invoice with company info from user's profile if not provided
        const invoice = new Invoice({
          ...input,
          number,
          prefix,
          companyInfo: input.companyInfo || userWithCompany.company,
          createdBy: user.id,
          ...totals // Ajouter tous les totaux calculés
        });
        
        await invoice.save();
        
        // Vérifier si le numéro de bon de commande correspond à un devis existant
        if (input.purchaseOrderNumber) {
          // Rechercher tous les devis de l'utilisateur
          const quotes = await Quote.find({ createdBy: user.id });
          
          // Trouver un devis dont le préfixe+numéro correspond au numéro de bon de commande
          const matchingQuote = quotes.find(quote => {
            // Construire l'identifiant complet du devis (préfixe + numéro)
            const quoteFullId = `${quote.prefix}${quote.number}`;
            
            // Comparer avec le numéro de bon de commande (insensible à la casse)
            return quoteFullId.toLowerCase() === input.purchaseOrderNumber.toLowerCase();
          });
          
          if (matchingQuote) {
            // Vérifier si le devis n'a pas déjà trop de factures liées
            const linkedInvoicesCount = matchingQuote.linkedInvoices ? matchingQuote.linkedInvoices.length : 0;
            
            if (linkedInvoicesCount < 3) {
              // Ajouter cette facture aux factures liées du devis
              if (!matchingQuote.linkedInvoices) {
                matchingQuote.linkedInvoices = [];
              }
              
              // Vérifier que la facture n'est pas déjà liée
              const alreadyLinked = matchingQuote.linkedInvoices.some(
                linkedInvoice => linkedInvoice.toString() === invoice._id.toString()
              );
              
              if (!alreadyLinked) {
                matchingQuote.linkedInvoices.push(invoice._id);
                await matchingQuote.save();
              }
            }
          }
        }
        
        return await invoice.populate('createdBy');
      } catch (error) {
        // Intercepter les erreurs de validation Mongoose
        console.error('Erreur lors de la création de la facture:', error);
        
        // Si c'est une erreur de validation Mongoose
        if (error.name === 'ValidationError') {
          const validationErrors = {};
          
          // Transformer les erreurs Mongoose en format plus lisible
          Object.keys(error.errors).forEach(key => {
            validationErrors[key] = error.errors[key].message;
          });
          
          throw createValidationError(
            'La facture contient des erreurs de validation',
            validationErrors
          );
        }
        
        // Si c'est une autre erreur, la propager
        throw error;
      }
    }),
    
    updateInvoice: isAuthenticated(async (_, { id, input }, { user }) => {
      // Rechercher la facture sans utiliser Mongoose pour éviter les validations automatiques
      const invoiceData = await Invoice.findOne({ 
        _id: id, 
        createdBy: user.id 
      }).lean();
      
      if (!invoiceData) {
        throw createNotFoundError('Facture');
      }
      
      // Vérifier si la facture peut être modifiée (statut)
      if (invoiceData.status === 'COMPLETED' || invoiceData.status === 'CANCELED') {
        throw createResourceLockedError('Facture', `une facture ${invoiceData.status === 'COMPLETED' ? 'terminée' : 'annulée'} ne peut pas être modifiée`);
      }
      
      // Vérifier si l'utilisateur tente de modifier le numéro de facture
      if (input.number && input.number !== invoiceData.number) {
        // Vérifier si des factures avec le statut PENDING ou COMPLETED existent déjà
        const pendingInvoicesCount = await Invoice.countDocuments({
          createdBy: user.id,
          status: { $in: ['PENDING', 'COMPLETED'] },
          number: input.number,
          prefix: invoiceData.prefix,
          _id: { $ne: id }
        });
        
        if (pendingInvoicesCount > 0) {
          throw new AppError(
            `Le numéro de facture ${invoiceData.prefix}${input.number} existe déjà`,
            ERROR_CODES.DUPLICATE_ERROR
          );
        }
      }
      
      // Créer une copie des données d'entrée pour éviter de modifier l'original
      let updatedInput = { ...input };
      
      // Si les items sont modifiés, recalculer les totaux
      if (updatedInput.items) {
        const totals = calculateInvoiceTotals(
          updatedInput.items,
          updatedInput.discount || invoiceData.discount,
          updatedInput.discountType || invoiceData.discountType
        );
        updatedInput = { ...updatedInput, ...totals };
      }

      // Préparer les données à mettre à jour
      const updateData = { ...invoiceData };
      
      // Mettre à jour les informations de l'entreprise si fournies
      if (updatedInput.companyInfo) {
        updateData.companyInfo = {
          ...updateData.companyInfo,
          ...updatedInput.companyInfo
        };
      }
      
      // Mettre à jour le client si fourni
      if (updatedInput.client) {
        // Vérifier si le client a une adresse de livraison différente
        if (updatedInput.client.hasDifferentShippingAddress === true && !updatedInput.client.shippingAddress) {
          throw createValidationError(
            'L\'adresse de livraison est requise lorsque l\'option "Adresse de livraison différente" est activée',
            { 'client.shippingAddress': 'L\'adresse de livraison est requise' }
          );
        }
        
        updateData.client = {
          ...updateData.client,
          ...updatedInput.client
        };
        
        // Mettre à jour l'adresse du client si fournie
        if (updatedInput.client.address) {
          updateData.client.address = {
            ...(updateData.client.address || {}),
            ...updatedInput.client.address
          };
        }
        
        // Mettre à jour l'adresse de livraison du client si fournie
        if (updatedInput.client.shippingAddress) {
          updateData.client.shippingAddress = {
            ...(updateData.client.shippingAddress || {}),
            ...updatedInput.client.shippingAddress
          };
        }
      }
      
      // Gérer le lien des conditions générales
      if (updatedInput.termsAndConditionsLink !== undefined) {
        if (updatedInput.termsAndConditionsLink === '') {
          // Si une chaîne vide est fournie, supprimer le lien
          delete updateData.termsAndConditionsLink;
        } else {
          updateData.termsAndConditionsLink = updatedInput.termsAndConditionsLink;
        }
      }
      
      // Fusionner toutes les autres mises à jour
      Object.keys(updatedInput).forEach(key => {
        if (key !== 'client' && key !== 'companyInfo' && key !== 'termsAndConditionsLink') {
          updateData[key] = updatedInput[key];
        }
      });
      
      try {
        // Mettre à jour la facture en utilisant findOneAndUpdate pour éviter les validations
        const updatedInvoice = await Invoice.findOneAndUpdate(
          { _id: id, createdBy: user.id },
          { $set: updateData },
          { new: true, runValidators: true }
        ).populate('createdBy');
        
        if (!updatedInvoice) {
          throw createNotFoundError('Facture');
        }
        
        return updatedInvoice;
      } catch (error) {
        // Intercepter les erreurs de validation Mongoose
        console.error('Erreur lors de la mise à jour de la facture:', error);
        
        // Si c'est une erreur de validation Mongoose
        if (error.name === 'ValidationError') {
          const validationErrors = {};
          
          // Transformer les erreurs Mongoose en format plus lisible
          Object.keys(error.errors).forEach(key => {
            validationErrors[key] = error.errors[key].message;
          });
          
          throw createValidationError(
            'La facture contient des erreurs de validation',
            validationErrors
          );
        }
        
        // Si c'est une autre erreur, la propager
        throw new AppError(
          `Erreur de mise à jour: ${error.message}`,
          ERROR_CODES.VALIDATION_ERROR
        );
      }
    }),

    deleteInvoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id });
      
      if (!invoice) {
        throw createNotFoundError('Facture');
      }
      
      if (invoice.status === 'COMPLETED' || invoice.status === 'CANCELED') {
        throw createResourceLockedError('Facture', `une facture ${invoice.status === 'COMPLETED' ? 'terminée' : 'annulée'} ne peut pas être supprimée`);
      }
      
      await Invoice.deleteOne({ _id: id, createdBy: user.id });
      return true;
    }),

    changeInvoiceStatus: isAuthenticated(async (_, { id, status }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id }).populate('createdBy');
      
      if (!invoice) {
        throw createNotFoundError('Facture');
      }
      
      // Vérifier si le changement de statut est autorisé
      if (invoice.status === status) {
        return invoice; // Aucun changement nécessaire
      }
      
      // Vérifier les transitions de statut autorisées
      if (
        (invoice.status === 'COMPLETED' || invoice.status === 'CANCELED') ||
        (invoice.status === 'PENDING' && status === 'DRAFT') ||
        (status === 'DRAFT' && invoice.status !== 'DRAFT')
      ) {
        throw createStatusTransitionError('Facture', invoice.status, status);
      }
      
      // Vérifier que la date d'émission n'est pas inférieure à la date actuelle lors du passage de DRAFT à PENDING
      if (invoice.status === 'DRAFT' && status === 'PENDING') {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Réinitialiser l'heure pour comparer uniquement les dates
        
        const issueDate = new Date(invoice.issueDate);
        issueDate.setHours(0, 0, 0, 0);
        
        if (issueDate < today) {
          throw createValidationError(
            'La date d\'émission ne peut pas être antérieure à la date actuelle pour une facture en statut \'PENDING\'',
            { issueDate: 'La date d\'émission doit être égale ou postérieure à la date actuelle' }
          );
        }
      }

      // Si la facture passe de DRAFT à PENDING, générer un nouveau numéro séquentiel
      if (invoice.status === 'DRAFT' && status === 'PENDING') {
        // Conserver l'ancien préfixe ou utiliser le préfixe standard
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const prefix = invoice.prefix || `F-${year}${month}-`;
        
        // Toujours générer un nouveau numéro séquentiel par rapport aux factures PENDING/COMPLETED
        // Nous passons quand même le numéro actuel comme manualNumber au cas où ce serait la première facture
        const newNumber = await generateInvoiceNumber(prefix, {
          manualNumber: invoice.number,
          isPending: true,
          userId: user.id
        });
        
        // Vérifier si une autre facture en brouillon existe avec ce numéro
        const conflictingDraft = await Invoice.findOne({
          _id: { $ne: invoice._id },
          prefix,
          number: newNumber,
          status: 'DRAFT',
          createdBy: user.id
        });
        
        if (conflictingDraft) {
          // Au lieu de modifier le préfixe, générer un nouveau numéro pour la facture en conflit
          // Trouver le dernier numéro de brouillon avec ce préfixe
          const lastDraftNumber = await Invoice.findOne({
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
          const existingWithNewNumber = await Invoice.findOne({
            prefix,
            number: newDraftNumber,
            createdBy: user.id
          });
          
          if (existingWithNewNumber) {
            // Si le numéro existe déjà, ajouter un timestamp
            newDraftNumber = `DRAFT-${Date.now().toString().slice(-6)}`;
          }
          
          // Mettre à jour la facture en conflit
          conflictingDraft.number = newDraftNumber;
          await conflictingDraft.save();
        }
        
        // Mettre à jour le numéro de la facture actuelle
        invoice.number = newNumber;
      }

      invoice.status = status;
      await invoice.save();

      return await invoice.populate('createdBy');
    }),

    markInvoiceAsPaid: isAuthenticated(async (_, { id, paymentDate }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id }).populate('createdBy');
      
      if (!invoice) {
        throw createNotFoundError('Facture');
      }
      
      // Vérifier si la facture peut être marquée comme payée
      if (invoice.status === 'DRAFT') {
        throw createStatusTransitionError('Facture', invoice.status, 'COMPLETED', 'Une facture en brouillon ne peut pas être marquée comme payée');
      }
      
      if (invoice.status === 'CANCELED') {
        throw createStatusTransitionError('Facture', invoice.status, 'COMPLETED', 'Une facture annulée ne peut pas être marquée comme payée');
      }
      
      if (invoice.status === 'COMPLETED') {
        // La facture est déjà marquée comme payée, vérifier si la date de paiement est différente
        if (invoice.paymentDate && new Date(invoice.paymentDate).toISOString() === new Date(paymentDate).toISOString()) {
          return invoice; // Aucun changement nécessaire
        }
      }
      
      // Mettre à jour le statut et la date de paiement
      invoice.status = 'COMPLETED';
      invoice.paymentDate = new Date(paymentDate);
      await invoice.save();
      
      return await invoice.populate('createdBy');
    }),

    sendInvoice: isAuthenticated(async (_, { id, /* email */ }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id });
      
      if (!invoice) {
        throw createNotFoundError('Facture');
      }

      // Ici, vous pourriez implémenter la logique d'envoi d'email
      // Pour l'instant, nous simulons un succès
      // TODO: Implémenter l'envoi réel de la facture par email
      
      return true;
    })
  }
};

module.exports = invoiceResolvers;
