/**
 * ========================================
 * EXEMPLE D'INTÉGRATION RBAC DANS LES RESOLVERS
 * ========================================
 * 
 * Ce fichier montre comment utiliser le middleware RBAC
 * dans les resolvers GraphQL pour les factures
 */

import Invoice from "../models/Invoice.js";
import {
  withRBAC,
  requireRead,
  requireWrite,
  requireDelete,
  requirePermission,
  withOrganization,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

/**
 * ========================================
 * QUERIES
 * ========================================
 */

const invoiceResolvers = {
  Query: {
    /**
     * Récupérer toutes les factures de l'organisation
     * Permission requise: "view" sur "invoices"
     */
    invoices: requireRead("invoices")(async (parent, args, context) => {
      const { workspaceId, userRole, user } = context;
      
      // Construire la query de base
      const query = { workspaceId };
      
      // Si l'utilisateur est "member", il ne voit que ses propres factures
      // (sauf si on veut que les members voient toutes les factures)
      if (userRole === "member" && args.onlyMine) {
        query.createdBy = user._id;
      }
      
      // Récupérer les factures avec pagination
      const invoices = await Invoice.find(query)
        .sort({ createdAt: -1 })
        .limit(args.limit || 20)
        .skip(args.offset || 0);
      
      return invoices;
    }),
    
    /**
     * Récupérer une facture spécifique
     * Permission requise: "view" sur "invoices"
     */
    invoice: requireRead("invoices")(async (parent, args, context) => {
      const { workspaceId, userRole, user } = context;
      
      const invoice = await Invoice.findOne({
        _id: args.id,
        workspaceId,
      });
      
      if (!invoice) {
        throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
      }
      
      // Si member, vérifier qu'il est le créateur
      if (userRole === "member" && invoice.createdBy.toString() !== user._id.toString()) {
        throw new AppError(
          "Vous n'avez pas accès à cette facture",
          ERROR_CODES.FORBIDDEN
        );
      }
      
      return invoice;
    }),
    
    /**
     * Statistiques des factures
     * Permission requise: "view" sur "invoices"
     */
    invoiceStats: requireRead("invoices")(async (parent, args, context) => {
      const { workspaceId, userRole, user } = context;
      
      // Query de base
      const matchQuery = { workspaceId };
      
      // Si member, filtrer par créateur
      if (userRole === "member") {
        matchQuery.createdBy = user._id;
      }
      
      // Agrégation pour les statistiques
      const stats = await Invoice.aggregate([
        { $match: matchQuery },
        {
          $group: {
            _id: null,
            totalInvoices: { $sum: 1 },
            totalAmount: { $sum: "$finalTotalTTC" },
            paidAmount: {
              $sum: {
                $cond: [{ $eq: ["$status", "COMPLETED"] }, "$finalTotalTTC", 0],
              },
            },
          },
        },
      ]);
      
      return stats[0] || { totalInvoices: 0, totalAmount: 0, paidAmount: 0 };
    }),
  },
  
  /**
   * ========================================
   * MUTATIONS
   * ========================================
   */
  Mutation: {
    /**
     * Créer une nouvelle facture
     * Permission requise: "create" sur "invoices"
     */
    createInvoice: requireWrite("invoices")(async (parent, args, context) => {
      const { workspaceId, user } = context;
      
      // Créer la facture avec le workspaceId et le créateur
      const invoice = await Invoice.create({
        ...args.input,
        workspaceId,
        createdBy: user._id,
      });
      
      return {
        success: true,
        message: "Facture créée avec succès",
        invoice,
      };
    }),
    
    /**
     * Mettre à jour une facture
     * Permission requise: "edit" sur "invoices"
     * 
     * Note: Les members peuvent seulement éditer leurs propres factures
     */
    updateInvoice: requirePermission("invoices", "edit")(async (parent, args, context) => {
      const { workspaceId, userRole, user } = context;
      
      // Récupérer la facture existante
      const invoice = await Invoice.findOne({
        _id: args.id,
        workspaceId,
      });
      
      if (!invoice) {
        throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
      }
      
      // Si member, vérifier qu'il est le créateur
      if (userRole === "member" && invoice.createdBy.toString() !== user._id.toString()) {
        throw new AppError(
          "Vous ne pouvez modifier que vos propres factures",
          ERROR_CODES.FORBIDDEN
        );
      }
      
      // Mettre à jour la facture
      Object.assign(invoice, args.input);
      await invoice.save();
      
      return {
        success: true,
        message: "Facture mise à jour avec succès",
        invoice,
      };
    }),
    
    /**
     * Supprimer une facture
     * Permission requise: "delete" sur "invoices"
     * 
     * Note: Seuls owner et admin peuvent supprimer
     */
    deleteInvoice: requireDelete("invoices")(async (parent, args, context) => {
      const { workspaceId } = context;
      
      const invoice = await Invoice.findOneAndDelete({
        _id: args.id,
        workspaceId,
      });
      
      if (!invoice) {
        throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
      }
      
      return {
        success: true,
        message: "Facture supprimée avec succès",
      };
    }),
    
    /**
     * Marquer une facture comme payée
     * Permission requise: "mark-paid" sur "invoices"
     * 
     * Note: owner, admin et accountant peuvent marquer comme payé
     */
    markInvoiceAsPaid: requirePermission("invoices", "mark-paid")(
      async (parent, args, context) => {
        const { workspaceId } = context;
        
        const invoice = await Invoice.findOne({
          _id: args.id,
          workspaceId,
        });
        
        if (!invoice) {
          throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
        }
        
        invoice.status = "COMPLETED";
        invoice.paidAt = new Date();
        await invoice.save();
        
        return {
          success: true,
          message: "Facture marquée comme payée",
          invoice,
        };
      }
    ),
    
    /**
     * Approuver une facture (validation)
     * Permission requise: "approve" sur "invoices"
     * 
     * Note: Seuls owner et admin peuvent approuver
     */
    approveInvoice: requirePermission("invoices", "approve")(
      async (parent, args, context) => {
        const { workspaceId, user } = context;
        
        const invoice = await Invoice.findOne({
          _id: args.id,
          workspaceId,
        });
        
        if (!invoice) {
          throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
        }
        
        invoice.approvedBy = user._id;
        invoice.approvedAt = new Date();
        invoice.status = "APPROVED";
        await invoice.save();
        
        return {
          success: true,
          message: "Facture approuvée avec succès",
          invoice,
        };
      }
    ),
  },
};

/**
 * ========================================
 * EXEMPLE AVANCÉ: Vérification dynamique des permissions
 * ========================================
 */

const advancedInvoiceResolver = {
  Mutation: {
    /**
     * Action complexe avec vérifications multiples
     */
    complexInvoiceAction: withOrganization(async (parent, args, context) => {
      const { permissions, workspaceId, userRole } = context;
      
      // Vérification dynamique des permissions
      if (!permissions.canRead("invoices")) {
        throw new AppError(
          "Vous n'avez pas accès aux factures",
          ERROR_CODES.FORBIDDEN
        );
      }
      
      // Logique métier avec vérifications conditionnelles
      if (args.action === "delete") {
        if (!permissions.canDelete("invoices")) {
          throw new AppError(
            "Vous ne pouvez pas supprimer de factures",
            ERROR_CODES.FORBIDDEN
          );
        }
        // Logique de suppression...
      } else if (args.action === "approve") {
        if (!permissions.hasPermission("invoices", "approve")) {
          throw new AppError(
            "Vous ne pouvez pas approuver de factures",
            ERROR_CODES.FORBIDDEN
          );
        }
        // Logique d'approbation...
      }
      
      // Suite de la logique...
      return { success: true };
    }),
  },
};

/**
 * ========================================
 * RÉSUMÉ DES PATTERNS D'UTILISATION
 * ========================================
 * 
 * 1. Lecture simple:
 *    requireRead("invoices")(resolver)
 * 
 * 2. Écriture (create/edit):
 *    requireWrite("invoices")(resolver)
 * 
 * 3. Suppression:
 *    requireDelete("invoices")(resolver)
 * 
 * 4. Permission spécifique:
 *    requirePermission("invoices", "approve")(resolver)
 * 
 * 5. Vérification dynamique:
 *    withOrganization(resolver) + context.permissions.hasPermission()
 * 
 * 6. Accès au contexte enrichi:
 *    - context.workspaceId: ID de l'organisation
 *    - context.organization: Objet organisation complet
 *    - context.userRole: Rôle de l'utilisateur (owner, admin, member, accountant)
 *    - context.permissions: Objet avec méthodes de vérification
 *    - context.user: Utilisateur authentifié
 */

export default invoiceResolvers;
