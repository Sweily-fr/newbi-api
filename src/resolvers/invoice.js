import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
import Quote from '../models/Quote.js';
import { isAuthenticated } from '../middlewares/auth.js';
import { requireCompanyInfo } from '../middlewares/company-info-guard.js';
import { generateInvoiceNumber } from '../utils/documentNumbers.js';
import mongoose from 'mongoose';
import { 
  createNotFoundError, 
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES
} from '../utils/errors.js';

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

    nextInvoiceNumber: isAuthenticated(async (_, { prefix, isDraft }, { user }) => {
      if (isDraft) {
        // Pour les brouillons : retourner un numéro aléatoire temporaire
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 1000);
        return `DRAFT-${timestamp}-${random}`;
      } else {
        // Pour les factures finalisées : générer le prochain numéro séquentiel
        const userObj = await mongoose.model('User').findById(user.id);
        const customPrefix = prefix || userObj?.settings?.invoiceNumberPrefix;
        return await generateInvoiceNumber(customPrefix, { userId: user.id, isPending: true });
      }
    })
  },

  Mutation: {
    createInvoice: requireCompanyInfo(isAuthenticated(async (_, { input }, { user }) => {
      // Récupérer les informations actuelles de l'entreprise de l'utilisateur
      const userWithCompany = await User.findById(user.id);
      if (!userWithCompany || !userWithCompany.company) {
        throw new Error('Informations d\'entreprise non configurées');
      }
      
      // Debug: Vérifier les données de l'entreprise récupérées
      console.log('Données entreprise récupérées:', {
        hasCompany: !!userWithCompany.company,
        hasBankDetails: !!(userWithCompany.company && userWithCompany.company.bankDetails),
        bankDetails: userWithCompany.company?.bankDetails
      });

      // Utiliser le préfixe fourni ou générer un préfixe par défaut
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const prefix = input.prefix || `F-${year}${month}-`;

      // Fonction utilitaire pour générer un numéro aléatoire unique pour les brouillons
      const generateDraftNumber = () => {
        const timestamp = Date.now().toString().slice(-6);
        const random = Math.floor(Math.random() * 1000);
        return `DRAFT-${timestamp}-${random}`;
      };
      
      // Logique simplifiée de génération des numéros
      let number;
      
      if (input.status === 'DRAFT') {
        // Pour les brouillons : toujours un numéro aléatoire temporaire
        number = generateDraftNumber();
      } else {
        // Pour les factures finalisées (PENDING/COMPLETED) : numéro séquentiel
        if (input.number) {
          // Vérifier si le numéro fourni existe déjà parmi les factures finalisées
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
        } else {
          // Générer le prochain numéro séquentiel
          number = await generateInvoiceNumber(prefix, { userId: user.id, isPending: true });
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
    })),
    
    updateInvoice: requireCompanyInfo(isAuthenticated(async (_, { id, input }, { user }) => {
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

      // Préparer les données à mettre à jour - SEULEMENT les champs modifiés
      const updateData = {};
      
      // Mettre à jour les informations de l'entreprise si fournies
      if (updatedInput.companyInfo) {
        // Créer une copie des données de l'entreprise pour la mise à jour
        updateData.companyInfo = {
          ...invoiceData.companyInfo,
          ...updatedInput.companyInfo
        };
        
        // Gestion spéciale des coordonnées bancaires
        if (updatedInput.companyInfo.bankDetails === null) {
          // Si bankDetails est explicitement null, le supprimer complètement
          delete updateData.companyInfo.bankDetails;
        } else if (updatedInput.companyInfo.bankDetails) {
          // Si bankDetails est fourni, vérifier que tous les champs requis sont présents
          const { iban, bic, bankName } = updatedInput.companyInfo.bankDetails;
          
          // Si l'un des champs est vide ou manquant, supprimer complètement bankDetails
          if (!iban || !bic || !bankName) {
            delete updateData.companyInfo.bankDetails;
          }
        }
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
          ...invoiceData.client,
          ...updatedInput.client
        };
        
        // Mettre à jour l'adresse du client si fournie
        if (updatedInput.client.address) {
          updateData.client.address = {
            ...(invoiceData.client.address || {}),
            ...updatedInput.client.address
          };
        }
        
        // Mettre à jour l'adresse de livraison du client si fournie
        if (updatedInput.client.shippingAddress) {
          updateData.client.shippingAddress = {
            ...(invoiceData.client.shippingAddress || {}),
            ...updatedInput.client.shippingAddress
          };
        }
      }
      
      // Gérer le lien des conditions générales
      if (updatedInput.termsAndConditionsLink !== undefined) {
        if (updatedInput.termsAndConditionsLink === '') {
          // Si une chaîne vide est fournie, supprimer le lien
          updateData.termsAndConditionsLink = null;
        } else {
          updateData.termsAndConditionsLink = updatedInput.termsAndConditionsLink;
        }
      }
      
      // Gestion spéciale de la transition DRAFT vers PENDING/COMPLETED
      if (invoiceData.status === 'DRAFT' && updatedInput.status && updatedInput.status !== 'DRAFT') {
        // La facture passe de brouillon à finalisée : générer un nouveau numéro séquentiel
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const prefix = invoiceData.prefix || `F-${year}${month}-`;
        
        // Générer le prochain numéro séquentiel (remplace tout numéro DRAFT existant)
        // Trouver le dernier numéro utilisé pour cet utilisateur
        const lastInvoice = await Invoice.findOne({
          createdBy: user.id,
          status: { $in: ['PENDING', 'COMPLETED'] },
          number: { $regex: /^\d{6}$/ }, // Seulement les numéros numériques
          $expr: { $eq: [{ $year: '$issueDate' }, year] }
        }).sort({ number: -1 });
        
        let nextNumber = 1;
        if (lastInvoice && lastInvoice.number) {
          nextNumber = parseInt(lastInvoice.number) + 1;
        }
        
        // Vérifier que ce numéro n'existe pas déjà et l'incrémenter si nécessaire
        let attempts = 0;
        let newNumber;
        let numberExists = true;
        
        while (numberExists && attempts < 50) {
          attempts++;
          newNumber = String(nextNumber).padStart(6, '0');
          
          // Vérifier si ce numéro existe déjà pour cet utilisateur
          const existingInvoice = await Invoice.findOne({
            number: newNumber,
            createdBy: user.id,
            _id: { $ne: invoiceData._id } // Exclure la facture actuelle
          });
          
          if (!existingInvoice) {
            numberExists = false;
          } else {
            console.log(`⚠️ Numéro ${newNumber} déjà utilisé, tentative ${attempts}/50`);
            nextNumber++; // Incrémenter pour la prochaine tentative
          }
        }
        
        if (numberExists) {
          throw new Error(`Impossible de générer un numéro unique après ${attempts} tentatives`);
        }
        
        updateData.number = newNumber;
        updateData.prefix = prefix;
        
        console.log(`🔄 Transition DRAFT->PENDING: Ancien numéro "${invoiceData.number}" remplacé par "${updateData.number}"`);
      }
      
      // Fusionner toutes les autres mises à jour
      Object.keys(updatedInput).forEach(key => {
        if (key !== 'client' && key !== 'companyInfo' && key !== 'termsAndConditionsLink') {
          // Éviter de mettre à jour le numéro s'il n'a pas changé pour éviter l'erreur de clé dupliquée
          if (key === 'number' && updatedInput[key] === invoiceData.number) {
            return; // Skip this field
          }
          // Ne JAMAIS écraser le numéro si on vient de le générer pour la transition DRAFT->PENDING
          if (key === 'number' && invoiceData.status === 'DRAFT' && updatedInput.status && updatedInput.status !== 'DRAFT') {
            console.log(`⚠️  Ignoré le numéro "${updatedInput[key]}" du frontend car transition DRAFT->PENDING détectée`);
            return; // Skip this field car déjà géré ci-dessus avec un numéro séquentiel
          }
          // Préserver le numéro existant pour les brouillons qui restent en DRAFT
          if (key === 'number' && invoiceData.status === 'DRAFT' && (!updatedInput.status || updatedInput.status === 'DRAFT')) {
            return; // Skip this field - garder le numéro existant pour les brouillons
          }
          updateData[key] = updatedInput[key];
        }
      });
      
      try {
        // Désactiver temporairement les validations pour les coordonnées bancaires
        // car elles sont gérées manuellement dans le code ci-dessus
        const originalValidate = Invoice.schema.path('companyInfo.bankDetails.iban')?.validators;
        const originalValidateBic = Invoice.schema.path('companyInfo.bankDetails.bic')?.validators;
        const originalValidateBankName = Invoice.schema.path('companyInfo.bankDetails.bankName')?.validators;
        
        // Supprimer temporairement les validateurs
        if (originalValidate) {
          Invoice.schema.path('companyInfo.bankDetails.iban').validators = [];
        }
        if (originalValidateBic) {
          Invoice.schema.path('companyInfo.bankDetails.bic').validators = [];
        }
        if (originalValidateBankName) {
          Invoice.schema.path('companyInfo.bankDetails.bankName').validators = [];
        }
        
        // Mettre à jour la facture
        const updatedInvoice = await Invoice.findOneAndUpdate(
          { _id: id, createdBy: user.id },
          { $set: updateData },
          { new: true, runValidators: true }
        ).populate('createdBy');
        
        // Rétablir les validateurs
        if (originalValidate) {
          Invoice.schema.path('companyInfo.bankDetails.iban').validators = originalValidate;
        }
        if (originalValidateBic) {
          Invoice.schema.path('companyInfo.bankDetails.bic').validators = originalValidateBic;
        }
        if (originalValidateBankName) {
          Invoice.schema.path('companyInfo.bankDetails.bankName').validators = originalValidateBankName;
        }
        
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
    })),

    deleteInvoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id });
      
      if (!invoice) {
        throw createNotFoundError('Facture');
      }
      
      if (invoice.status === 'COMPLETED' || invoice.status === 'CANCELED') {
        throw createResourceLockedError('Facture', `une facture ${invoice.status === 'COMPLETED' ? 'terminée' : 'annulée'} ne peut pas être supprimée`);
      }
      
      // Si la facture est liée à un devis, retirer le lien du devis

      let sourceQuoteId = invoice.sourceQuote;
      
      // Si sourceQuote n'existe pas, chercher le devis qui contient cette facture
      if (!sourceQuoteId) {
        console.log(`Facture ${invoice.number} sans sourceQuote, recherche du devis lié...`);
        const quote = await Quote.findOne({ linkedInvoices: invoice._id });
        if (quote) {
          console.log(`Devis trouvé: ${quote.number}`);
          sourceQuoteId = quote._id;
          // Mettre à jour la facture avec le sourceQuote manquant
          invoice.sourceQuote = sourceQuoteId;
          await invoice.save();
        }
      }
      
      // Supprimer le lien du devis si un devis source a été trouvé
      if (sourceQuoteId) {
        console.log(`Suppression du lien entre la facture ${invoice.number} et le devis`);
        await Quote.updateOne(
          { _id: sourceQuoteId },
          { $pull: { linkedInvoices: invoice._id } }
        );
      }
      
      await Invoice.deleteOne({ _id: id, createdBy: user.id });
      console.log(`Facture ${invoice.number} supprimée avec succès`);
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
        console.log(`🔄 Transition DRAFT->PENDING: Ancien numéro "${invoice.number}"`);
        
        // Générer un nouveau numéro séquentiel avec retry logic
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const prefix = `F-${year}${month}-`;
        
        let newNumber;
        let attempts = 0;
        const maxAttempts = 10;
        
        while (attempts < maxAttempts) {
          attempts++;
          
          // Générer le numéro de base
          const baseNumber = await generateInvoiceNumber(prefix, {
            isPending: true,
            userId: user.id
          });
          
          // Incrémenter le numéro si ce n'est pas la première tentative
          const numberPart = parseInt(baseNumber, 10);
          const incrementedNumber = String(numberPart + attempts - 1).padStart(6, '0');
          
          // Vérifier si ce numéro existe déjà
          const existingInvoice = await Invoice.findOne({
            $expr: {
              $and: [
                { $eq: ['$number', incrementedNumber] },
                { $eq: ['$createdBy', user.id] },
                { $eq: [{ $year: '$issueDate' }, year] }
              ]
            }
          });
          
          if (!existingInvoice) {
            newNumber = incrementedNumber;
            console.log(`✅ Numéro unique trouvé: "${newNumber}" après ${attempts} tentative(s)`);
            break;
          } else {
            console.log(`⚠️ Numéro ${incrementedNumber} déjà utilisé, tentative ${attempts}/${maxAttempts}`);
          }
        }
        
        if (!newNumber) {
          throw new Error('Impossible de générer un numéro unique après ' + maxAttempts + ' tentatives');
        }
        
        // Mettre à jour le numéro et le préfixe de la facture
        invoice.number = newNumber;
        invoice.prefix = prefix;
        
        console.log(`🔄 Transition DRAFT->PENDING: Ancien numéro "${invoice.number}" remplacé par "${newNumber}"`);
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
    }),

    createLinkedInvoice: isAuthenticated(async (_, { quoteId, amount, isDeposit }, { user }) => {
      console.log('Création de facture liée - Paramètres reçus:', { quoteId, amount, isDeposit, userId: user.id });
      
      // Validation et conversion explicite du montant
      const numericAmount = parseFloat(amount);
      if (isNaN(numericAmount) || numericAmount <= 0) {
        throw createValidationError(
          'Montant invalide',
          { amount: 'Le montant doit être un nombre positif' }
        );
      }
      
      console.log('Montant converti:', { original: amount, converted: numericAmount });
      
      // Vérifier que le devis existe et appartient à l'utilisateur
      const quote = await Quote.findOne({ _id: quoteId, createdBy: user.id });
      
      if (!quote) {
        throw createNotFoundError('Devis');
      }

      // Récupérer les informations actuelles de l'entreprise
      const userWithCompany = await User.findById(user.id);
      if (!userWithCompany.company) {
        throw new AppError(
          'Vous devez configurer les informations de votre entreprise avant de créer une facture',
          ERROR_CODES.VALIDATION_ERROR
        );
      }
      
      // Debug: Vérifier les données de l'entreprise dans createLinkedInvoice
      console.log('Données entreprise dans createLinkedInvoice:', {
        hasCompany: !!userWithCompany.company,
        companyName: userWithCompany.company?.name,
        siret: userWithCompany.company?.siret,
        vatNumber: userWithCompany.company?.vatNumber,
        companyStatus: userWithCompany.company?.companyStatus,
        hasBankDetails: !!(userWithCompany.company && userWithCompany.company.bankDetails),
        bankDetails: userWithCompany.company?.bankDetails
      });

      // Vérifier que le devis est accepté
      if (quote.status !== 'COMPLETED') {
        throw createValidationError(
          'Seuls les devis acceptés peuvent être convertis en factures liées',
          { status: 'Le devis doit être accepté pour créer une facture liée' }
        );
      }

      // Vérifier le nombre de factures déjà liées (max 3)
      const linkedInvoicesCount = quote.linkedInvoices ? quote.linkedInvoices.length : 0;
      if (linkedInvoicesCount >= 3) {
        throw createValidationError(
          'Limite de factures liées atteinte',
          { linkedInvoices: 'Un devis ne peut avoir plus de 3 factures liées' }
        );
      }

      // Calculer le montant total déjà facturé et vérifier les acomptes
      let totalInvoiced = 0;
      let hasDeposit = false;
      if (quote.linkedInvoices && quote.linkedInvoices.length > 0) {
        const existingInvoices = await Invoice.find({
          _id: { $in: quote.linkedInvoices },
          createdBy: user.id
        });
        console.log('Factures existantes trouvées:', existingInvoices.map(inv => ({
          id: inv._id,
          number: inv.number,
          finalTotalTTC: inv.finalTotalTTC,
          isDeposit: inv.isDeposit
        })));
        totalInvoiced = existingInvoices.reduce((sum, inv) => sum + (inv.finalTotalTTC || 0), 0);
        hasDeposit = existingInvoices.some(inv => inv.isDeposit === true);
      }

      // Vérifier qu'il n'y a qu'un seul acompte
      if (isDeposit && hasDeposit) {
        throw createValidationError(
          'Acompte déjà existant',
          { isDeposit: 'Un devis ne peut avoir qu\'un seul acompte' }
        );
      }

      // Vérifier que le montant ne dépasse pas le total du devis
      const remainingAmount = quote.finalTotalTTC - totalInvoiced;
      
      console.log('Validation du montant:', {
        quoteFinalTotalTTC: quote.finalTotalTTC,
        totalInvoiced,
        remainingAmount,
        requestedAmount: numericAmount,
        isDeposit,
        linkedInvoicesCount: quote.linkedInvoices ? quote.linkedInvoices.length : 0
      });
      
      if (numericAmount > remainingAmount) {
        console.error('Erreur de validation - Montant trop élevé:', {
          amount: numericAmount,
          remainingAmount,
          difference: numericAmount - remainingAmount
        });
        throw createValidationError(
          'Montant de facture invalide',
          { amount: `Le montant ne peut pas dépasser le reste à facturer (${remainingAmount.toFixed(2)}€)` }
        );
      }

      // Si c'est la dernière facture possible (3ème facture OU reste exactement ce montant),
      // le montant doit être exactement égal au reste à facturer
      const isLastPossibleInvoice = linkedInvoicesCount === 2 || remainingAmount === numericAmount;
      if (linkedInvoicesCount === 2 && numericAmount !== remainingAmount) {
        throw createValidationError(
          'Montant de la dernière facture invalide',
          { amount: `La dernière facture liée doit être exactement égale au reste à facturer (${remainingAmount.toFixed(2)}€)` }
        );
      }

      // Générer le numéro de facture
      const prefix = quote.prefix || 'F';
      const number = await generateInvoiceNumber(prefix, {
        isDraft: true,
        userId: user.id
      });

      // Calculer le prix HT pour obtenir le montant TTC exact
      // Si numericAmount = 120€ TTC avec 20% TVA, alors HT = 120 / 1.20 = 100€
      const vatRate = 20;
      const unitPriceHT = numericAmount / (1 + vatRate / 100);

      // Créer la facture avec les données du devis
      const invoice = new Invoice({
        number,
        prefix,
        purchaseOrderNumber: `${quote.prefix}${quote.number}`, // Référence au devis
        isDeposit,
        status: 'DRAFT',
        issueDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 jours par défaut
        client: quote.client,
        // S'assurer que les champs SIRET et numéro de TVA sont correctement copiés depuis les informations de l'utilisateur
        companyInfo: {
          // Copier les propriétés de base de l'entreprise
          name: userWithCompany.company.name || '',
          email: userWithCompany.company.email || '',
          phone: userWithCompany.company.phone || '',
          website: userWithCompany.company.website || '',
          address: userWithCompany.company.address || {},
          // Copier les propriétés légales au premier niveau comme attendu par le schéma companyInfoSchema
          siret: userWithCompany.company.siret || '',
          vatNumber: userWithCompany.company.vatNumber || '',
          companyStatus: userWithCompany.company.companyStatus || 'AUTRE',
          // Autres propriétés si nécessaire
          logo: userWithCompany.company.logo || '',
          // Copier les coordonnées bancaires si elles existent
          bankDetails: userWithCompany.company.bankDetails || {}
        },
        sourceQuote: quote._id,
        
        // Créer un article unique avec le montant spécifié
        items: [{
          description: isDeposit ? `Acompte sur devis ${quote.prefix}${quote.number}` : `Facture partielle sur devis ${quote.prefix}${quote.number}`,
          quantity: 1,
          unitPrice: unitPriceHT,
          vatRate: vatRate,
          unit: 'forfait',
          discount: 0,
          discountType: 'FIXED',
          details: '',
          vatExemptionText: ''
        }],
        
        headerNotes: quote.headerNotes || '',
        footerNotes: quote.footerNotes || '',
        termsAndConditions: quote.termsAndConditions || '',
        termsAndConditionsLinkTitle: quote.termsAndConditionsLinkTitle || '',
        termsAndConditionsLink: quote.termsAndConditionsLink || '',
        
        discount: 0,
        discountType: 'FIXED',
        customFields: quote.customFields || [],
        createdBy: user.id
      });

      // Calculer les totaux
      const totals = calculateInvoiceTotals(invoice.items, invoice.discount, invoice.discountType);
      Object.assign(invoice, totals);
      
      // Vérifier que le montant TTC final correspond exactement au montant demandé
      // (avec une tolérance de 0.01€ pour les erreurs d'arrondi)
      if (Math.abs(invoice.finalTotalTTC - numericAmount) > 0.01) {
        console.warn(`Différence de montant détectée: demandé=${numericAmount}, calculé=${invoice.finalTotalTTC}`);
        // Forcer le montant exact si nécessaire
        invoice.finalTotalTTC = numericAmount;
      }

      // Debug: Vérifier les coordonnées bancaires avant nettoyage
      console.log('Coordonnées bancaires avant nettoyage:', {
        hasBankDetails: !!(invoice.companyInfo && invoice.companyInfo.bankDetails),
        bankDetails: invoice.companyInfo?.bankDetails
      });

      // Nettoyer les coordonnées bancaires si elles sont invalides
      if (invoice.companyInfo && invoice.companyInfo.bankDetails) {
        const { iban, bic, bankName } = invoice.companyInfo.bankDetails;
        console.log('Vérification des champs bancaires:', { iban: !!iban, bic: !!bic, bankName: !!bankName });
        
        // Si l'un des champs est vide ou manquant, supprimer complètement bankDetails
        if (!iban || !bic || !bankName) {
          console.log('Suppression des coordonnées bancaires invalides');
          delete invoice.companyInfo.bankDetails;
        }
      }

      console.log('Coordonnées bancaires après nettoyage:', {
        hasBankDetails: !!(invoice.companyInfo && invoice.companyInfo.bankDetails),
        bankDetails: invoice.companyInfo?.bankDetails
      });

      // Sauvegarder la facture
      await invoice.save();

      // Ajouter la facture aux factures liées du devis
      if (!quote.linkedInvoices) {
        quote.linkedInvoices = [];
      }
      quote.linkedInvoices.push(invoice._id);
      await quote.save();

      // Retourner la facture et le devis mis à jour
      const populatedInvoice = await invoice.populate('createdBy');
      const updatedQuote = await Quote.findById(quote._id).populate({
        path: 'linkedInvoices',
        select: 'id number status finalTotalTTC isDeposit'
      });

      return {
        invoice: populatedInvoice,
        quote: updatedQuote
      };
    }),

    deleteLinkedInvoice: isAuthenticated(async (_, { id }, { user }) => {
      console.log('Tentative de suppression de facture liée:', { invoiceId: id, userId: user.id });
      
      const invoice = await Invoice.findOne({ _id: id, createdBy: user.id });
      
      if (!invoice) {
        console.log('Facture non trouvée:', { invoiceId: id, userId: user.id });
        throw createNotFoundError('Facture liée');
      }
      
      console.log('Facture trouvée:', {
        id: invoice._id,
        number: invoice.number,
        status: invoice.status,
        sourceQuote: invoice.sourceQuote,
        hasSourceQuote: !!invoice.sourceQuote
      });
      
      // Vérifier que c'est bien une facture liée à un devis
      let sourceQuoteId = invoice.sourceQuote;
      
      if (!sourceQuoteId) {
        console.log('Facture sans sourceQuote, recherche dans les devis...');
        
        // Essayer de trouver le devis qui contient cette facture dans ses linkedInvoices
  
        const quoteWithInvoice = await Quote.findOne({
          linkedInvoices: invoice._id,
          createdBy: user.id
        });
        
        if (quoteWithInvoice) {
          console.log('Devis source trouvé via linkedInvoices:', {
            quoteId: quoteWithInvoice._id,
            quoteNumber: `${quoteWithInvoice.prefix}${quoteWithInvoice.number}`
          });
          sourceQuoteId = quoteWithInvoice._id;
          
          // Mettre à jour la facture avec le sourceQuote manquant
          await Invoice.updateOne(
            { _id: invoice._id },
            { sourceQuote: sourceQuoteId }
          );
          console.log('sourceQuote mis à jour pour la facture');
        } else {
          console.log('Erreur: Facture sans sourceQuote et non trouvée dans les devis:', {
            invoiceId: invoice._id,
            number: invoice.number,
            purchaseOrderNumber: invoice.purchaseOrderNumber
          });
          throw createValidationError(
            'Facture non liée',
            { invoice: 'Cette facture n\'est pas liée à un devis' }
          );
        }
      }
      
      // Vérifier que la facture peut être supprimée
      if (invoice.status === 'COMPLETED' || invoice.status === 'CANCELED') {
        throw createResourceLockedError(
          'Facture liée', 
          `une facture ${invoice.status === 'COMPLETED' ? 'terminée' : 'annulée'} ne peut pas être supprimée`
        );
      }
      
      // Retirer la facture de la liste des factures liées du devis

      await Quote.updateOne(
        { _id: sourceQuoteId },
        { $pull: { linkedInvoices: invoice._id } }
      );
      
      console.log('Facture retirée de la liste des factures liées du devis:', {
        quoteId: sourceQuoteId,
        invoiceId: invoice._id
      });
      
      // Supprimer la facture
      await Invoice.deleteOne({ _id: id, createdBy: user.id });
      
      console.log('Facture liée supprimée avec succès:', {
        invoiceId: id,
        invoiceNumber: invoice.number,
        quoteId: sourceQuoteId
      });
      
      return true;
    })
  }
};

export default invoiceResolvers;
