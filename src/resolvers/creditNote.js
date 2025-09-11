import CreditNote from '../models/CreditNote.js';
import Invoice from '../models/Invoice.js';
import User from '../models/User.js';
import Event from '../models/Event.js';
import { isAuthenticated } from '../middlewares/better-auth.js';
import { requireCompanyInfo } from '../middlewares/company-info-guard.js';
import { generateCreditNoteNumber } from '../utils/documentNumbers.js';
import mongoose from 'mongoose';
import {
  createNotFoundError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from '../utils/errors.js';

// const requiredPermission = 'MANAGE_INVOICES'; // TODO: Implement permission system

/**
 * Wrapper pour les resolvers nécessitant un workspace
 */
const withWorkspace = (resolver) => {
  return isAuthenticated(async (parent, args, context, info) => {
    try {
      const workspaceId = args.workspaceId || context.workspaceId;
      if (!workspaceId)
        throw new AppError('workspaceId requis', ERROR_CODES.BAD_REQUEST);

      const workspace = {
        id: workspaceId,
        role: 'owner',
        permissions: {
          canRead: true,
          canWrite: true,
          canDelete: true,
          canAdmin: true,
        },
      };

      context.workspace = workspace;
      context.workspaceId = workspaceId;

      return await resolver(parent, args, context, info);
    } catch (error) {
      console.error('Erreur dans withWorkspace:', error);
      throw error;
    }
  });
};

/**
 * Calcule les totaux d'un avoir
 */
const calculateCreditNoteTotals = (items, discount = 0, discountType = 'FIXED') => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach(item => {
    const itemTotal = item.quantity * item.unitPrice;
    const itemDiscount = item.discount || 0;
    const itemDiscountType = item.discountType || 'FIXED';
    
    let itemTotalAfterDiscount = itemTotal;
    if (itemDiscountType === 'PERCENTAGE') {
      itemTotalAfterDiscount = itemTotal * (1 - itemDiscount / 100);
    } else {
      itemTotalAfterDiscount = itemTotal - itemDiscount;
    }
    
    totalHT += itemTotalAfterDiscount;
    totalVAT += itemTotalAfterDiscount * (item.vatRate / 100);
  });

  // Appliquer la remise globale
  let finalTotalHT = totalHT;
  if (discountType === 'PERCENTAGE') {
    finalTotalHT = totalHT * (1 - discount / 100);
  } else {
    finalTotalHT = totalHT - discount;
  }

  // Recalculer la TVA après remise globale
  const finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
  const finalTotalTTC = finalTotalHT + finalTotalVAT;

  // Les avoirs ont des montants négatifs
  return {
    totalHT: -Math.abs(totalHT),
    totalVAT: -Math.abs(totalVAT),
    totalTTC: -Math.abs(totalHT + totalVAT),
    finalTotalHT: -Math.abs(finalTotalHT),
    finalTotalTTC: -Math.abs(finalTotalTTC),
  };
};

const creditNoteResolvers = {
  Query: {
    creditNote: withWorkspace(async (parent, { id, workspaceId }) => {
      const creditNote = await CreditNote.findOne({
        _id: id,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      }).populate('originalInvoice');

      if (!creditNote) {
        throw createNotFoundError('Avoir non trouvé');
      }

      return creditNote;
    }),

    creditNotes: withWorkspace(async (parent, args) => {
      const {
        workspaceId,
        startDate,
        endDate,
        status,
        search,
        page = 1,
        limit = 10,
      } = args;

      const query = {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      };

      // Filtres de date
      if (startDate || endDate) {
        query.issueDate = {};
        if (startDate) query.issueDate.$gte = new Date(startDate);
        if (endDate) query.issueDate.$lte = new Date(endDate);
      }

      // Filtre par statut
      if (status) {
        query.status = status;
      }

      // Recherche textuelle
      if (search) {
        query.$or = [
          { number: { $regex: search, $options: 'i' } },
          { 'client.name': { $regex: search, $options: 'i' } },
          { reason: { $regex: search, $options: 'i' } },
        ];
      }

      const skip = (page - 1) * limit;
      const totalCount = await CreditNote.countDocuments(query);
      const creditNotes = await CreditNote.find(query)
        .populate('originalInvoice')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      return {
        creditNotes,
        totalCount,
        hasNextPage: totalCount > skip + limit,
      };
    }),

    creditNotesByInvoice: withWorkspace(async (parent, { invoiceId, workspaceId }) => {
      const creditNotes = await CreditNote.find({
        originalInvoice: new mongoose.Types.ObjectId(invoiceId),
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      })
        .populate('originalInvoice')
        .sort({ createdAt: -1 });

      return creditNotes;
    }),

    creditNoteStats: withWorkspace(async (parent, { workspaceId }) => {
      const stats = await CreditNote.aggregate([
        {
          $match: {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          },
        },
        {
          $group: {
            _id: null,
            totalCount: { $sum: 1 },
            createdCount: {
              $sum: { $cond: [{ $eq: ['$status', 'CREATED'] }, 1, 0] },
            },
            totalAmount: { $sum: '$finalTotalTTC' },
          },
        },
      ]);

      return stats[0] || {
        totalCount: 0,
        createdCount: 0,
        totalAmount: 0,
      };
    }),

    nextCreditNoteNumber: withWorkspace(async (parent, { workspaceId, prefix, isDraft }) => {
      const number = await generateCreditNoteNumber(prefix, {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        isDraft: isDraft || false,
      });
      return number;
    }),
  },

  Mutation: {
    createCreditNote: requireCompanyInfo(
      withWorkspace(async (parent, { workspaceId, input }, context) => {
        try {
          // Vérifier que la facture originale existe
          const originalInvoice = await Invoice.findOne({
            _id: input.originalInvoiceId,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (!originalInvoice) {
            throw createNotFoundError('Facture originale non trouvée');
          }

          // Vérifier que la facture est en attente, terminée ou annulée
          if (!['PENDING', 'COMPLETED', 'CANCELED'].includes(originalInvoice.status)) {
            throw createValidationError(
              'Un avoir ne peut être créé que pour une facture en attente, terminée ou annulée'
            );
          }

          // Générer le numéro d'avoir
          const number = await generateCreditNoteNumber(input.prefix, {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            isDraft: false,
            manualNumber: input.number,
          });

          // Calculer les totaux
          const totals = calculateCreditNoteTotals(
            input.items,
            input.discount,
            input.discountType
          );

          // Créer l'avoir
          const creditNote = new CreditNote({
            ...input,
            number,
            status: 'CREATED',
            originalInvoice: originalInvoice._id,
            originalInvoiceNumber: originalInvoice.number,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            createdBy: new mongoose.Types.ObjectId(context.user.id),
            ...totals,
          });

          await creditNote.save();

          // Créer un événement
          await Event.create({
            title: `Avoir créé: ${creditNote.prefix}${creditNote.number}`,
            description: `Avoir ${creditNote.prefix}${creditNote.number} créé pour la facture ${originalInvoice.prefix}${originalInvoice.number} - ${creditNote.client.name} - ${creditNote.finalTotalTTC}€`,
            start: new Date(),
            end: new Date(),
            allDay: true,
            color: 'blue',
            type: 'CREDIT_NOTE_CREATED',
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            userId: new mongoose.Types.ObjectId(context.user.id),
          });

          return await CreditNote.findById(creditNote._id).populate('originalInvoice');
        } catch (error) {
          console.error('Erreur lors de la création de l\'avoir:', error);
          throw error;
        }
      })
    ),

    updateCreditNote: requireCompanyInfo(
      withWorkspace(async (parent, { id, workspaceId, input }, context) => {
        try {
          const creditNote = await CreditNote.findOne({
            _id: id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (!creditNote) {
            throw createNotFoundError('Avoir non trouvé');
          }

          // Les avoirs avec statut CREATED peuvent toujours être modifiés

          // Calculer les nouveaux totaux si les items ont changé
          let totals = {};
          if (input.items) {
            totals = calculateCreditNoteTotals(
              input.items,
              input.discount || creditNote.discount,
              input.discountType || creditNote.discountType
            );
          }

          // Mettre à jour l'avoir
          Object.assign(creditNote, input, totals);
          await creditNote.save();

          // Créer un événement
          await Event.create({
            type: 'CREDIT_NOTE_UPDATED',
            entityType: 'CreditNote',
            entityId: creditNote._id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            userId: new mongoose.Types.ObjectId(context.user.id),
            metadata: {
              creditNoteNumber: creditNote.number,
            },
          });

          return await CreditNote.findById(creditNote._id).populate('originalInvoice');
        } catch (error) {
          console.error('Erreur lors de la mise à jour de l\'avoir:', error);
          throw error;
        }
      })
    ),

    deleteCreditNote: requireCompanyInfo(
      withWorkspace(async (parent, { id, workspaceId }, context) => {
        try {
          const creditNote = await CreditNote.findOne({
            _id: id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (!creditNote) {
            throw createNotFoundError('Avoir non trouvé');
          }

          // Les avoirs avec statut CREATED peuvent toujours être supprimés

          await CreditNote.findByIdAndDelete(id);

          // Créer un événement
          await Event.create({
            type: 'CREDIT_NOTE_DELETED',
            entityType: 'CreditNote',
            entityId: creditNote._id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            userId: new mongoose.Types.ObjectId(context.user.id),
            metadata: {
              creditNoteNumber: creditNote.number,
            },
          });

          return true;
        } catch (error) {
          console.error('Erreur lors de la suppression de l\'avoir:', error);
          throw error;
        }
      })
    ),

    // changeCreditNoteStatus mutation removed - credit notes only have CREATED status
  },

  CreditNote: {
    createdBy: async (creditNote) => {
      return await User.findById(creditNote.createdBy);
    },
  },
};

export default creditNoteResolvers;
