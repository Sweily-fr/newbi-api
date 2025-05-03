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
              $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] }
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
        totalAmount: 0
      };
    }),

    nextInvoiceNumber: isAuthenticated(async (_, { prefix }, { user }) => {
      const customPrefix = prefix || 'F';
      return generateInvoiceNumber(customPrefix, { userId: user.id });
    })
  },

  Mutation: {
    createInvoice: isAuthenticated(async (_, { input }, { user }) => {
      // Utiliser le préfixe fourni ou 'F' par défaut
      const prefix = input.prefix || 'F';
      console.log(`Création de facture pour l'utilisateur ${user.id} avec préfixe ${prefix}`);
      
      // Si le statut est PENDING, vérifier d'abord s'il existe des factures en DRAFT 
      // qui pourraient entrer en conflit avec le numéro qui sera généré
      const handleDraftConflicts = async (newNumber) => {
        // Vérifier s'il existe une facture en DRAFT avec le même numéro
        const conflictingDrafts = await Invoice.find({
          prefix,
          number: newNumber,
          status: 'DRAFT',
          createdBy: user.id
        });
        
        // S'il y a des factures en conflit, mettre à jour leur numéro
        for (const draft of conflictingDrafts) {
          // Ajouter le suffixe -DRAFT au numéro existant
          const newDraftNumber = `${newNumber}-DRAFT`;
          
          // Vérifier que le nouveau numéro n'existe pas déjà
          const existingWithNewNumber = await Invoice.findOne({
            prefix,
            number: newDraftNumber,
            createdBy: user.id
          });
          
          // Si le numéro existe déjà, générer un numéro unique avec timestamp
          const finalDraftNumber = existingWithNewNumber 
            ? `DRAFT-${Date.now().toString().slice(-6)}` 
            : newDraftNumber;
          
          // Mettre à jour la facture en brouillon avec le nouveau numéro
          await Invoice.findByIdAndUpdate(draft._id, { number: finalDraftNumber });
          console.log(`Facture en brouillon mise à jour avec le numéro ${finalDraftNumber}`);
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
            number: input.number,
            createdBy: user.id,
            $expr: { $eq: [{ $year: '$issueDate' }, new Date().getFullYear()] }
          });
          console.log(`Vérification du numéro ${input.number}: ${existingInvoice ? 'Existe déjà' : 'N\'existe pas'}`);
          
          if (existingInvoice) {
            // Si le numéro existe déjà, générer un nouveau numéro
            console.log(`Le numéro ${input.number} existe déjà, génération d'un nouveau numéro`);
            number = await generateInvoiceNumber(prefix, { userId: user.id });
          } else {
            // Si le statut est PENDING, utiliser la nouvelle fonctionnalité
            if (input.status === 'PENDING') {
              number = await generateInvoiceNumber(prefix, {
                manualNumber: input.number,
                isPending: true,
                userId: user.id
              });
              
              // Gérer les conflits avec les factures en DRAFT
              number = await handleDraftConflicts(number);
            } else {
              // Sinon, utiliser le numéro fourni
              number = input.number;
            }
          }
        } else {
          // Générer un nouveau numéro pour les factures non-brouillons
          number = await generateInvoiceNumber(prefix, { userId: user.id });
          
          // Si le statut est PENDING, gérer les conflits avec les factures en DRAFT
          if (input.status === 'PENDING') {
            number = await handleDraftConflicts(number);
          }
        }
      } else if (input.number) {
        // Si c'est un brouillon mais qu'un numéro est fourni, le valider
        const existingInvoice = await Invoice.findOne({ 
          number: input.number,
          createdBy: user.id,
          $expr: { $eq: [{ $year: '$issueDate' }, new Date().getFullYear()] }
        });
        
        console.log(`Vérification du numéro de brouillon ${input.number}: ${existingInvoice ? 'Existe déjà' : 'N\'existe pas'}`);
        
        if (existingInvoice) {
          console.log(`Erreur: Le numéro ${input.number} existe déjà pour l'utilisateur ${user.id}`);
          throw new AppError(
            'Ce numéro de facture est déjà utilisé',
            ERROR_CODES.DUPLICATE_RESOURCE
          );
        }
        number = input.number;
      }
      // Pour les brouillons sans numéro fourni, on laisse number undefined
      
      const userWithCompany = await User.findById(user.id).select('company');
      if (!userWithCompany?.company) {
        throw new AppError(
          'Les informations de votre entreprise doivent être configurées avant de créer une facture',
          ERROR_CODES.COMPANY_INFO_REQUIRED
        );
      }

      // Calculer les totaux avec la remise
      const totals = calculateInvoiceTotals(
        input.items,
        input.discount,
        input.discountType
      );

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
        
        // Chercher un devis dont la concaténation du préfixe et du numéro correspond exactement au numéro de bon de commande
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
            // Ajouter la facture à la liste des factures liées au devis
            if (!matchingQuote.linkedInvoices) {
              matchingQuote.linkedInvoices = [];
            }
            
            // Éviter les doublons
            if (!matchingQuote.linkedInvoices.includes(invoice._id)) {
              matchingQuote.linkedInvoices.push(invoice._id);
              
              // Si le devis n'a pas encore été converti en facture, définir cette facture comme la facture principale
              if (!matchingQuote.convertedToInvoice) {
                matchingQuote.convertedToInvoice = invoice._id;
                // Le devis a été converti en facture
              } else {
                // La facture a été liée au devis
              }
              
              await matchingQuote.save();
            }
          } else {
            // Le devis a déjà 3 factures liées, impossible d'en ajouter davantage
          }
        } else {
          // Aucun devis trouvé correspondant au numéro de bon de commande
        }
      }
      
      return await invoice.populate('createdBy');
    }),

    updateInvoice: isAuthenticated(async (_, { id, input }, { user }) => {
      // Rechercher la facture sans utiliser Mongoose pour éviter les validations automatiques
      const invoiceData = await Invoice.findOne({ _id: id, createdBy: user.id }).lean();
      
      if (!invoiceData) {
        throw createNotFoundError('Facture');
      }

      if (invoiceData.status === 'COMPLETED') {
        throw createResourceLockedError('Facture', 'une facture terminée ne peut pas être modifiée');
      }
      
      // Vérifier si l'utilisateur tente de modifier le numéro de facture
      if (input.number && input.number !== invoiceData.number) {
        // Vérifier si des factures avec le statut PENDING ou COMPLETED existent déjà
        const pendingInvoicesCount = await Invoice.countDocuments({
          createdBy: user.id,
          status: { $in: ['PENDING', 'COMPLETED'] }
        });
        
        if (pendingInvoicesCount > 0) {
          throw new AppError(
            'Vous ne pouvez pas modifier le numéro de facture car des factures en attente ou terminées existent déjà',
            ERROR_CODES.RESOURCE_LOCKED
          );
        }
        
        // Vérifier si le nouveau numéro existe déjà
        const existingInvoice = await Invoice.findOne({
          _id: { $ne: id },
          number: input.number
        });
        
        if (existingInvoice) {
          throw new AppError(
            'Ce numéro de facture est déjà utilisé',
            ERROR_CODES.DUPLICATE_RESOURCE
          );
        }
      }

      // Si des items sont fournis, recalculer les totaux
      if (input.items) {
        const totals = calculateInvoiceTotals(
          input.items,
          input.discount !== undefined ? input.discount : invoiceData.discount,
          input.discountType || invoiceData.discountType
        );
        input = { ...input, ...totals };
      }

      // Préparer les données à mettre à jour
      const updateData = { ...invoiceData };
      
      // Mettre à jour les informations de l'entreprise si fournies
      if (input.companyInfo) {
        updateData.companyInfo = {
          ...updateData.companyInfo,
          ...input.companyInfo
        };
      }

      // Mettre à jour les informations du client si fournies
      if (input.client) {
        // Préserver le type de client
        const clientType = input.client.type || updateData.client.type;
        
        updateData.client = {
          ...updateData.client,
          ...input.client,
          type: clientType
        };
        
        // Si c'est un particulier, s'assurer que les champs d'entreprise sont définis
        if (clientType === 'INDIVIDUAL') {
          updateData.client.siret = 'N/A-INDIVIDUAL';
          updateData.client.vatNumber = 'N/A-INDIVIDUAL';
        }
      }

      // Traiter le lien des conditions générales
      if (input.termsAndConditionsLink !== undefined) {
        if (input.termsAndConditionsLink === '') {
          updateData.termsAndConditionsLink = null;
        } else if (input.termsAndConditionsLink && !input.termsAndConditionsLink.startsWith('http')) {
          updateData.termsAndConditionsLink = 'https://' + input.termsAndConditionsLink;
        } else {
          updateData.termsAndConditionsLink = input.termsAndConditionsLink;
        }
      }
      
      // Fusionner toutes les autres mises à jour
      Object.keys(input).forEach(key => {
        if (key !== 'client' && key !== 'companyInfo' && key !== 'termsAndConditionsLink') {
          updateData[key] = input[key];
        }
      });
      
      try {
        // Utiliser updateOne pour contourner les validations de Mongoose
        const result = await Invoice.updateOne(
          { _id: id },
          { $set: updateData },
          { runValidators: false }
        );
        
        if (result.modifiedCount === 0) {
          throw new AppError('Aucune modification n\'a été effectuée', ERROR_CODES.VALIDATION_ERROR);
        }
        
        // Récupérer la facture mise à jour
        const updatedInvoice = await Invoice.findById(id).populate('createdBy');
        return updatedInvoice;
      } catch (error) {
        console.error('Erreur lors de la mise à jour de la facture:', error);
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

      if (invoice.status === 'COMPLETED') {
        throw createResourceLockedError('Facture', 'une facture terminée ne peut pas être supprimée');
      }

      await Invoice.deleteOne({ _id: id });
      return true;
    }),

    changeInvoiceStatus: isAuthenticated(async (_, { id, status }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id });
      
      if (!invoice) {
        throw createNotFoundError('Facture');
      }

      // Vérifier si le changement de statut est valide
      const validTransitions = {
        'DRAFT': ['PENDING', 'COMPLETED'],
        'PENDING': ['DRAFT', 'COMPLETED'],
        'COMPLETED': [] // Une facture terminée ne peut pas changer de statut
      };

      if (!validTransitions[invoice.status].includes(status)) {
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
            'La date d\'\u00e9mission ne peut pas \u00eatre ant\u00e9rieure \u00e0 la date actuelle pour une facture en statut \'PENDING\'',
            { issueDate: 'La date d\'\u00e9mission doit \u00eatre \u00e9gale ou post\u00e9rieure \u00e0 la date actuelle' }
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
