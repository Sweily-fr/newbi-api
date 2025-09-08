import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import Quote from "../models/Quote.js";
import Event from "../models/Event.js";
import { isAuthenticated } from "../middlewares/better-auth.js";
import { requireCompanyInfo } from "../middlewares/company-info-guard.js";
import { generateInvoiceNumber } from "../utils/documentNumbers.js";
import mongoose from "mongoose";
import {
  createNotFoundError,
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";

/**
 * Wrapper pour les resolvers nécessitant un workspace
 * Vérifie que l'utilisateur a accès au workspace et les permissions nécessaires
 * @param {Function} resolver - Resolver GraphQL à exécuter
 * @param {String} requiredPermission - Permission requise (read, write, admin)
 * @returns {Function} - Resolver avec vérification de workspace
 */
const withWorkspace = (resolver, requiredPermission = "read") => {
  return isAuthenticated(async (parent, args, context, info) => {
    try {
      // Récupérer le workspaceId depuis les arguments ou le contexte
      const workspaceId = args.workspaceId || context.workspaceId;
      if (!workspaceId)
        throw new AppError("workspaceId requis", ERROR_CODES.BAD_REQUEST);

      // Pour l'instant, on assume que l'utilisateur est propriétaire/admin du workspace
      // car Better Auth gère l'authentification et l'accès aux workspaces
      // TODO: Récupérer le vrai rôle depuis Better Auth ou la base de données

      // Créer l'objet workspace avec les permissions basées sur le rôle
      // Par défaut, on donne les permissions d'admin/owner pour éviter les erreurs
      const workspace = {
        id: workspaceId,
        role: "owner", // Par défaut owner, à récupérer depuis Better Auth
        permissions: {
          canRead: true,
          canWrite: true,
          canDelete: true,
          canAdmin: true,
        },
      };

      // Enrichir le contexte avec le workspaceId et les informations du workspace
      const enrichedContext = {
        ...context,
        workspaceId,
        workspace,
      };

      return await resolver(parent, args, enrichedContext, info);
    } catch (error) {
      console.error(
        `Erreur dans withWorkspace pour ${resolver.name || "unknown"}:`,
        error.message
      );
      throw error;
    }
  });
};

// Fonction utilitaire pour calculer les totaux avec remise
const calculateInvoiceTotals = (
  items,
  discount = 0,
  discountType = "FIXED"
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

    // Appliquer la remise au niveau de l'item si elle existe
    if (item.discount) {
      if (item.discountType === "PERCENTAGE") {
        itemHT = itemHT * (1 - item.discount / 100);
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
    if (discountType === "PERCENTAGE") {
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
    discountAmount,
  };
};

const invoiceResolvers = {
  Query: {
    invoice: withWorkspace(async (_, { id, workspaceId }, context) => {
      const invoice = await Invoice.findOne({
        _id: id,
        workspaceId: workspaceId, // ✅ Filtrage par workspace au lieu de createdBy
      }).populate("createdBy");
      if (!invoice) throw createNotFoundError("Facture");
      return invoice;
    }),

    invoices: withWorkspace(
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
        context
      ) => {
        // ✅ Base query avec workspaceId
        const query = { workspaceId: workspaceId };
        const { workspace, user } = context;

        if (startDate || endDate) {
          query.createdAt = {};
          if (startDate) query.createdAt.$gte = new Date(startDate);
          if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        if (status) {
          // Si on filtre par COMPLETED, inclure aussi les factures CANCELED
          if (status === "COMPLETED") {
            query.status = { $in: ["COMPLETED", "CANCELED"] };
          } else {
            query.status = status;
          }
        }

        if (search) {
          const searchRegex = new RegExp(search, "i");
          query.$or = [
            { number: searchRegex },
            { "client.name": searchRegex },
            { "client.email": searchRegex },
          ];
        }

        // ✅ Filtrage par rôle utilisateur dans le workspace
        if (workspace.role === "guest") {
          // Les invités ne voient que leurs propres factures
          query.createdBy = user._id;
        }
        // Les membres et admins voient toutes les factures du workspace

        const skip = (page - 1) * limit;
        const totalCount = await Invoice.countDocuments(query);

        const invoices = await Invoice.find(query)
          .populate("createdBy")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        return {
          invoices,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      }
    ),

    invoiceStats: withWorkspace(async (_, { workspaceId }, context) => {
      const { workspace, user } = context;

      // Base match avec workspaceId
      let matchQuery = {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      };

      // Filtrage par rôle si nécessaire
      if (workspace.role === "guest") {
        matchQuery.createdBy = new mongoose.Types.ObjectId(user._id);
      }

      const [stats] = await Invoice.aggregate([
        { $match: matchQuery },
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
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$status", "COMPLETED"] },
                      { $eq: ["$status", "CANCELED"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            canceledCount: {
              $sum: { $cond: [{ $eq: ["$status", "CANCELED"] }, 1, 0] },
            },
            totalAmount: { $sum: "$totalTTC" },
          },
        },
      ]);

      return (
        stats || {
          totalCount: 0,
          draftCount: 0,
          pendingCount: 0,
          completedCount: 0,
          canceledCount: 0,
          totalAmount: 0,
        }
      );
    }),

    nextInvoiceNumber: withWorkspace(
      async (_, { workspaceId, prefix, isDraft }, context) => {
        const { user } = context || {};
        if (!user) {
          throw new Error('User not found in context');
        }

        if (isDraft) {
          // Pour les brouillons : utiliser la même logique que pour les devis
          const userObj = await mongoose.model("User").findById(user._id);
          const customPrefix = prefix || userObj?.settings?.invoiceNumberPrefix;
          return await generateInvoiceNumber(customPrefix, {
            workspaceId: workspaceId,
            isDraft: true,
            userId: user._id
          });
        } else {
          // Pour les factures finalisées : générer le prochain numéro séquentiel par workspace
          const userObj = await mongoose.model("User").findById(user._id);
          const customPrefix = prefix || userObj?.settings?.invoiceNumberPrefix;
          return await generateInvoiceNumber(customPrefix, {
            workspaceId: workspaceId, // ✅ Génération par workspace
            isPending: true,
          });
        }
      }
    ),
  },

  Mutation: {
    createInvoice: requireCompanyInfo(
      withWorkspace(async (_, { workspaceId, input }, context) => {
        const { user, workspace } = context;

        // ✅ Vérifier les permissions d'écriture
        if (!workspace.permissions.canWrite) {
          throw new AppError(
            "Permission d'\u00e9criture requise",
            ERROR_CODES.FORBIDDEN
          );
        }

        // Récupérer les informations actuelles de l'entreprise de l'utilisateur
        const userWithCompany = await User.findById(user._id);
        if (!userWithCompany || !userWithCompany.company) {
          throw new Error("Informations d'entreprise non configurées");
        }

        // Debug: Vérifier les données de l'entreprise récupérées
        console.log("Données entreprise récupérées:", {
          hasCompany: !!userWithCompany.company,
          hasBankDetails: !!(
            userWithCompany.company && userWithCompany.company.bankDetails
          ),
          bankDetails: userWithCompany.company?.bankDetails,
        });

        // Utiliser le préfixe fourni ou générer un préfixe par défaut
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const prefix = input.prefix || `F-${year}${month}-`;

        // Fonction pour gérer les conflits de brouillons
        const handleDraftConflicts = async (newNumber) => {
          // Vérifier s'il existe une facture en DRAFT avec le même numéro
          const conflictingDrafts = await Invoice.find({
            prefix,
            number: newNumber,
            status: 'DRAFT',
            workspaceId,
            createdBy: context.user._id
          });
          
          // S'il y a des factures en conflit, mettre à jour leur numéro
          for (const draft of conflictingDrafts) {
            // Utiliser le format DRAFT-ID avec timestamp
            const timestamp = Date.now() + Math.floor(Math.random() * 1000);
            const finalDraftNumber = `DRAFT-${newNumber}-${timestamp}`;
            
            // Mettre à jour la facture en brouillon avec le nouveau numéro
            await Invoice.findByIdAndUpdate(draft._id, { number: finalDraftNumber });
            console.log(`Facture en brouillon mise à jour avec le numéro ${finalDraftNumber}`);
          }
          
          return newNumber;
        };

        // Logique de génération des numéros
        let number;

        if (input.status === 'DRAFT') {
          // Pour les brouillons : utiliser generateInvoiceNumber avec isDraft: true
          const currentUser = await mongoose.model('User').findById(context.user._id);
          const customPrefix = input.prefix || currentUser?.settings?.invoiceNumberPrefix;
          number = await generateInvoiceNumber(customPrefix, {
            workspaceId,
            isDraft: true,
            userId: context.user._id,
            manualNumber: input.number // Passer le numéro manuel s'il est fourni
          });
        } else {
          // Pour les factures finalisées (PENDING/COMPLETED) : numéro séquentiel
          if (input.number) {
            // Gérer les conflits avec les brouillons avant d'assigner le numéro
            await handleDraftConflicts(input.number);
            
            // Vérifier si le numéro fourni existe déjà parmi les factures finalisées
            const existingInvoice = await Invoice.findOne({
              prefix,
              number: input.number,
              status: { $ne: "DRAFT" },
              workspaceId: workspaceId,
            });

            if (existingInvoice) {
              throw new AppError(
                `Le numéro de facture ${prefix}${input.number} existe déjà`,
                ERROR_CODES.DUPLICATE_ERROR
              );
            }

            number = input.number;
          } else {
            // Générer le prochain numéro séquentiel (strict, sans écart)
            const sequentialNumber = await generateInvoiceNumber(prefix, {
              workspaceId: workspaceId,
              // Plus de numéro manuel pour les factures non-brouillons - numérotation strictement séquentielle
            });
            
            // Gérer les conflits avec les brouillons
            await handleDraftConflicts(sequentialNumber);
            
            number = sequentialNumber;
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
              "client.email": clientData.email.toLowerCase(),
              workspaceId,
            });

            const existingInvoice = await Invoice.findOne({
              "client.email": clientData.email.toLowerCase(),
              workspaceId,
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

          // Create invoice with company info from user's profile if not provided
          const invoice = new Invoice({
            ...input,
            number,
            prefix,
            companyInfo: input.companyInfo || userWithCompany.company,
            workspaceId: workspaceId, // ✅ Ajout automatique du workspaceId
            createdBy: user._id, // ✅ Conservé pour audit trail
            ...totals, // Ajouter tous les totaux calculés
          });

          await invoice.save();

          // Créer automatiquement un événement de calendrier pour l'échéance de la facture
          if (invoice.dueDate) {
            try {
              await Event.createInvoiceDueEvent(invoice, user._id, workspaceId);
              console.log("Événement de calendrier créé pour la facture:", {
                invoiceId: invoice._id,
                invoiceNumber: `${invoice.prefix}${invoice.number}`,
                dueDate: invoice.dueDate,
              });
            } catch (eventError) {
              console.error(
                "Erreur lors de la création de l'événement de calendrier:",
                eventError
              );
              // Ne pas faire échouer la création de facture si l'événement échoue
            }
          }

          // Vérifier si le numéro de bon de commande correspond à un devis existant
          if (input.purchaseOrderNumber) {
            // Rechercher tous les devis du workspace
            const quotes = await Quote.find({ workspaceId });

            // Trouver un devis dont le préfixe+numéro correspond au numéro de bon de commande
            const matchingQuote = quotes.find((quote) => {
              // Construire l'identifiant complet du devis (préfixe + numéro)
              const quoteFullId = `${quote.prefix}${quote.number}`;

              // Comparer avec le numéro de bon de commande (insensible à la casse)
              return (
                quoteFullId.toLowerCase() ===
                input.purchaseOrderNumber.toLowerCase()
              );
            });

            if (matchingQuote) {
              // Vérifier si le devis n'a pas déjà trop de factures liées
              const linkedInvoicesCount = matchingQuote.linkedInvoices
                ? matchingQuote.linkedInvoices.length
                : 0;

              if (linkedInvoicesCount < 3) {
                // Ajouter cette facture aux factures liées du devis
                if (!matchingQuote.linkedInvoices) {
                  matchingQuote.linkedInvoices = [];
                }

                // Vérifier que la facture n'est pas déjà liée
                const alreadyLinked = matchingQuote.linkedInvoices.some(
                  (linkedInvoice) =>
                    linkedInvoice.toString() === invoice._id.toString()
                );

                if (!alreadyLinked) {
                  matchingQuote.linkedInvoices.push(invoice._id);
                  await matchingQuote.save();
                }
              }
            }
          }

          return await invoice.populate("createdBy");
        } catch (error) {
          // Intercepter les erreurs de validation Mongoose
          console.error("Erreur lors de la création de la facture:", error);

          // Si c'est une erreur de validation Mongoose
          if (error.name === "ValidationError") {
            const validationErrors = {};

            // Transformer les erreurs Mongoose en format plus lisible
            Object.keys(error.errors).forEach((key) => {
              validationErrors[key] = error.errors[key].message;
            });

            throw createValidationError(
              "La facture contient des erreurs de validation",
              validationErrors
            );
          }

          // Si c'est une autre erreur, la propager
          throw error;
        }
      })
    ),

    updateInvoice: requireCompanyInfo(
      withWorkspace(async (_, { id, workspaceId, input }, context) => {
        const { user, workspace } = context;

        // Rechercher la facture sans utiliser Mongoose pour éviter les validations automatiques
        const invoiceData = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId, // ✅ Vérification workspace
        }).lean();

        if (!invoiceData) {
          throw createNotFoundError("Facture");
        }

        // ✅ Vérifications de permissions granulaires
        if (
          workspace.role === "guest" &&
          invoiceData.createdBy.toString() !== user._id.toString()
        ) {
          throw new AppError(
            "Vous ne pouvez modifier que vos propres factures",
            ERROR_CODES.FORBIDDEN
          );
        }

        if (!workspace.permissions.canWrite) {
          throw new AppError(
            "Permission d'\u00e9criture requise",
            ERROR_CODES.FORBIDDEN
          );
        }

        // Vérifier si la facture peut être modifiée (statut)
        if (invoiceData.status === "COMPLETED" && workspace.role !== "admin") {
          throw createResourceLockedError("Cette facture est verrouillée");
        }

        if (invoiceData.status === "CANCELED") {
          throw createResourceLockedError(
            "Facture",
            "une facture annulée ne peut pas être modifiée"
          );
        }

        // Vérifier si l'utilisateur tente de modifier le numéro de facture
        if (input.number && input.number !== invoiceData.number) {
          // Vérifier si des factures avec le statut PENDING ou COMPLETED existent déjà
          const pendingInvoicesCount = await Invoice.countDocuments({
            workspaceId: workspaceId,
            status: { $in: ["PENDING", "COMPLETED"] },
            number: input.number,
            prefix: invoiceData.prefix,
            _id: { $ne: id },
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
            ...updatedInput.companyInfo,
          };

          // Gestion spéciale des coordonnées bancaires
          if (updatedInput.companyInfo.bankDetails === null) {
            // Si bankDetails est explicitement null, le supprimer complètement
            delete updateData.companyInfo.bankDetails;
          } else if (updatedInput.companyInfo.bankDetails) {
            // Si bankDetails est fourni, vérifier que tous les champs requis sont présents
            const { iban, bic, bankName } =
              updatedInput.companyInfo.bankDetails;

            // Si l'un des champs est vide ou manquant, supprimer complètement bankDetails
            if (!iban || !bic || !bankName) {
              delete updateData.companyInfo.bankDetails;
            }
          }
        }

        // Mettre à jour le client si fourni
        if (updatedInput.client) {
          // Vérifier si le client a une adresse de livraison différente
          if (
            updatedInput.client.hasDifferentShippingAddress === true &&
            !updatedInput.client.shippingAddress
          ) {
            throw createValidationError(
              "L'adresse de livraison est requise lorsque l'option \"Adresse de livraison différente\" est activée",
              { "client.shippingAddress": "L'adresse de livraison est requise" }
            );
          }

          updateData.client = {
            ...invoiceData.client,
            ...updatedInput.client,
          };

          // Mettre à jour l'adresse du client si fournie
          if (updatedInput.client.address) {
            updateData.client.address = {
              ...(invoiceData.client.address || {}),
              ...updatedInput.client.address,
            };
          }

          // Mettre à jour l'adresse de livraison du client si fournie
          if (updatedInput.client.shippingAddress) {
            updateData.client.shippingAddress = {
              ...(invoiceData.client.shippingAddress || {}),
              ...updatedInput.client.shippingAddress,
            };
          }
        }

        // Gérer le lien des conditions générales
        if (updatedInput.termsAndConditionsLink !== undefined) {
          if (updatedInput.termsAndConditionsLink === "") {
            // Si une chaîne vide est fournie, supprimer le lien
            updateData.termsAndConditionsLink = null;
          } else {
            updateData.termsAndConditionsLink =
              updatedInput.termsAndConditionsLink;
          }
        }

        // Gestion spéciale de la transition DRAFT vers PENDING/COMPLETED
        if (
          invoiceData.status === "DRAFT" &&
          updatedInput.status &&
          updatedInput.status !== "DRAFT"
        ) {
          // La facture passe de brouillon à finalisée : générer un nouveau numéro séquentiel
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, "0");
          const prefix = invoiceData.prefix || `F-${year}${month}-`;

          // Utiliser generateInvoiceNumber pour générer le prochain numéro séquentiel
          // Cela garantit que le numéro est unique et suit la séquence correcte
          const newNumber = await generateInvoiceNumber(prefix, {
            workspaceId: workspaceId,
            userId: context.user._id,
            isPending: true,
            year: year
          });

          // Mettre à jour le numéro et le préfixe
          updateData.number = newNumber;
          updateData.prefix = prefix;

          console.log(
            `🔄 Transition DRAFT->${updatedInput.status}: ` +
            `Nouveau numéro séquentiel généré: "${newNumber}"`
          );
        }

        // Fusionner toutes les autres mises à jour
        Object.keys(updatedInput).forEach((key) => {
          if (
            key !== "client" &&
            key !== "companyInfo" &&
            key !== "termsAndConditionsLink"
          ) {
            // Éviter de mettre à jour le numéro s'il n'a pas changé pour éviter l'erreur de clé dupliquée
            if (key === "number" && updatedInput[key] === invoiceData.number) {
              return; // Skip this field
            }
            // Ne JAMAIS écraser le numéro si on vient de le générer pour la transition DRAFT->PENDING
            if (
              key === "number" &&
              invoiceData.status === "DRAFT" &&
              updatedInput.status &&
              updatedInput.status !== "DRAFT"
            ) {
              console.log(
                `⚠️  Ignoré le numéro "${updatedInput[key]}" du frontend car transition DRAFT->PENDING détectée`
              );
              return; // Skip this field car déjà géré ci-dessus avec un numéro séquentiel
            }
            // Préserver le numéro existant pour les brouillons qui restent en DRAFT
            if (
              key === "number" &&
              invoiceData.status === "DRAFT" &&
              (!updatedInput.status || updatedInput.status === "DRAFT")
            ) {
              return; // Skip this field - garder le numéro existant pour les brouillons
            }
            updateData[key] = updatedInput[key];
          }
        });

        try {
          // Désactiver temporairement les validations pour les coordonnées bancaires
          // car elles sont gérées manuellement dans le code ci-dessus
          const originalValidate = Invoice.schema.path(
            "companyInfo.bankDetails.iban"
          )?.validators;
          const originalValidateBic = Invoice.schema.path(
            "companyInfo.bankDetails.bic"
          )?.validators;
          const originalValidateBankName = Invoice.schema.path(
            "companyInfo.bankDetails.bankName"
          )?.validators;

          // Supprimer temporairement les validateurs
          if (originalValidate) {
            Invoice.schema.path("companyInfo.bankDetails.iban").validators = [];
          }
          if (originalValidateBic) {
            Invoice.schema.path("companyInfo.bankDetails.bic").validators = [];
          }
          if (originalValidateBankName) {
            Invoice.schema.path("companyInfo.bankDetails.bankName").validators =
              [];
          }

          // Mettre à jour la facture
          const updatedInvoice = await Invoice.findOneAndUpdate(
            { _id: id, workspaceId: workspaceId },
            { $set: updateData },
            { new: true, runValidators: true }
          ).populate("createdBy");

          // Rétablir les validateurs
          if (originalValidate) {
            Invoice.schema.path("companyInfo.bankDetails.iban").validators =
              originalValidate;
          }
          if (originalValidateBic) {
            Invoice.schema.path("companyInfo.bankDetails.bic").validators =
              originalValidateBic;
          }
          if (originalValidateBankName) {
            Invoice.schema.path("companyInfo.bankDetails.bankName").validators =
              originalValidateBankName;
          }

          if (!updatedInvoice) {
            throw createNotFoundError("Facture");
          }

          // Mettre à jour l'événement de calendrier si la date d'échéance a changé
          if (updatedInvoice.dueDate) {
            try {
              await Event.updateInvoiceEvent(updatedInvoice, user.id);
              console.log(
                "Événement de calendrier mis à jour pour la facture:",
                {
                  invoiceId: updatedInvoice._id,
                  invoiceNumber: `${updatedInvoice.prefix}${updatedInvoice.number}`,
                  dueDate: updatedInvoice.dueDate,
                }
              );
            } catch (eventError) {
              console.error(
                "Erreur lors de la mise à jour de l'événement de calendrier:",
                eventError
              );
              // Ne pas faire échouer la mise à jour de facture si l'événement échoue
            }
          }

          return updatedInvoice;
        } catch (error) {
          // Intercepter les erreurs de validation Mongoose
          console.error("Erreur lors de la mise à jour de la facture:", error);

          // Si c'est une erreur de validation Mongoose
          if (error.name === "ValidationError") {
            const validationErrors = {};

            // Transformer les erreurs Mongoose en format plus lisible
            Object.keys(error.errors).forEach((key) => {
              validationErrors[key] = error.errors[key].message;
            });

            throw createValidationError(
              "La facture contient des erreurs de validation",
              validationErrors
            );
          }

          // Si c'est une autre erreur, la propager
          throw new AppError(
            `Erreur de mise à jour: ${error.message}`,
            ERROR_CODES.VALIDATION_ERROR
          );
        }
      })
    ),

    deleteInvoice: withWorkspace(async (_, { id, workspaceId }, context) => {
      const { workspace } = context;

      // ✅ Seuls les admins peuvent supprimer
      if (!workspace.permissions.canDelete) {
        throw new AppError(
          "Permission d'administrateur requise",
          ERROR_CODES.FORBIDDEN
        );
      }

      const invoice = await Invoice.findOne({
        _id: id,
        workspaceId: workspaceId,
      });

      if (!invoice) {
        throw createNotFoundError("Facture");
      }

      if (invoice.status === "COMPLETED") {
        throw createResourceLockedError(
          "Impossible de supprimer une facture finalisée"
        );
      }

      // Si la facture est liée à un devis, retirer le lien du devis

      let sourceQuoteId = invoice.sourceQuote;

      // Si sourceQuote n'existe pas, chercher le devis qui contient cette facture
      if (!sourceQuoteId) {
        console.log(
          `Facture ${invoice.number} sans sourceQuote, recherche du devis lié...`
        );
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
        console.log(
          `Suppression du lien entre la facture ${invoice.number} et le devis`
        );
        await Quote.updateOne(
          { _id: sourceQuoteId },
          { $pull: { linkedInvoices: invoice._id } }
        );
      }

      // Supprimer l'événement de calendrier associé à la facture
      try {
        await Event.deleteInvoiceEvent(invoice._id, user.id);
        console.log("Événement de calendrier supprimé pour la facture:", {
          invoiceId: invoice._id,
          invoiceNumber: `${invoice.prefix}${invoice.number}`,
        });
      } catch (eventError) {
        console.error(
          "Erreur lors de la suppression de l'événement de calendrier:",
          eventError
        );
        // Ne pas faire échouer la suppression de facture si l'événement échoue
      }

      await Invoice.deleteOne({ _id: id, workspaceId: workspaceId });

      // Supprimer les événements liés
      await Event.deleteMany({
        invoiceId: id,
        workspaceId: workspaceId,
      });

      console.log(`Facture ${invoice.number} supprimée avec succès`);
      return { success: true, message: "Facture supprimée avec succès" };
    }),

    changeInvoiceStatus: withWorkspace(
      async (_, { id, workspaceId, status }, context) => {
        const { user, workspace } = context;

        const invoice = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId,
        }).populate("createdBy");

        if (!invoice) {
          throw createNotFoundError("Facture");
        }

        // ✅ Vérifications de permissions
        if (
          workspace.role === "guest" &&
          invoice.createdBy._id.toString() !== user._id.toString()
        ) {
          throw new AppError(
            "Vous ne pouvez modifier que vos propres factures",
            ERROR_CODES.FORBIDDEN
          );
        }

        if (!workspace.permissions.canWrite) {
          throw new AppError(
            "Permission d'\u00e9criture requise",
            ERROR_CODES.FORBIDDEN
          );
        }

        // Vérifier si le changement de statut est autorisé
        if (invoice.status === status) {
          return invoice; // Aucun changement nécessaire
        }

        // Vérifier les transitions de statut autorisées
        if (
          invoice.status === "COMPLETED" ||
          invoice.status === "CANCELED" ||
          (invoice.status === "PENDING" && status === "DRAFT") ||
          (status === "DRAFT" && invoice.status !== "DRAFT")
        ) {
          throw createStatusTransitionError("Facture", invoice.status, status);
        }

        // Vérifier que la date d'émission n'est pas inférieure à la date actuelle lors du passage de DRAFT à PENDING
        if (invoice.status === "DRAFT" && status === "PENDING") {
          const today = new Date();
          today.setHours(0, 0, 0, 0); // Réinitialiser l'heure pour comparer uniquement les dates

          const issueDate = new Date(invoice.issueDate);
          issueDate.setHours(0, 0, 0, 0);

          if (issueDate < today) {
            throw createValidationError(
              "La date d'émission ne peut pas être antérieure à la date actuelle pour une facture en statut 'PENDING'",
              {
                issueDate:
                  "La date d'émission doit être égale ou postérieure à la date actuelle",
              }
            );
          }
        }

        // Si la facture passe de DRAFT à PENDING, générer un nouveau numéro séquentiel
        if (invoice.status === "DRAFT" && status === "PENDING") {
          console.log(
            `🔄 Transition DRAFT->PENDING: Ancien numéro "${invoice.number}"`
          );

          // Sauvegarder le numéro original du brouillon
          const originalDraftNumber = invoice.number;

          // D'abord changer temporairement le numéro pour éviter les conflits
          const tempNumber = `TEMP-${Date.now()}`;
          invoice.number = tempNumber;
          await invoice.save();

          // Utiliser la logique de validation de brouillon
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, "0");
          const prefix = `F-${year}${month}-`;

          // Utiliser la fonction handleDraftValidation pour respecter la séquence
          const newNumber = await generateInvoiceNumber(prefix, {
            isValidatingDraft: true,
            currentDraftNumber: invoice.number,
            originalDraftNumber: originalDraftNumber, // Passer le numéro original
            workspaceId: workspaceId,
            year: year,
            currentInvoiceId: invoice._id // Passer l'ID de la facture actuelle
          });

          console.log(
            `✅ Numéro généré pour la transition: "${newNumber}"`
          );

          // Mettre à jour le numéro et le préfixe de la facture
          invoice.number = newNumber;
          invoice.prefix = prefix;

          console.log(
            `🔄 Transition DRAFT->PENDING: Numéro temporaire remplacé par "${newNumber}"`
          );
        }

        invoice.status = status;
        await invoice.save();

        return await invoice.populate("createdBy");
      }
    ),

    markInvoiceAsPaid: withWorkspace(
      async (_, { id, workspaceId, paymentDate }, context) => {
        const { user, workspace } = context;

        const invoice = await Invoice.findOne({
          _id: id,
          workspaceId: workspaceId,
        }).populate("createdBy");

        if (!invoice) {
          throw createNotFoundError("Facture");
        }

        // ✅ Vérifications de permissions
        if (
          workspace.role === "guest" &&
          invoice.createdBy._id.toString() !== user._id.toString()
        ) {
          throw new AppError(
            "Vous ne pouvez modifier que vos propres factures",
            ERROR_CODES.FORBIDDEN
          );
        }

        if (!workspace.permissions.canWrite) {
          throw new AppError(
            "Permission d'\u00e9criture requise",
            ERROR_CODES.FORBIDDEN
          );
        }

        // Vérifier si la facture peut être marquée comme payée
        if (invoice.status === "DRAFT") {
          throw createStatusTransitionError(
            "Facture",
            invoice.status,
            "COMPLETED",
            "Une facture en brouillon ne peut pas être marquée comme payée"
          );
        }

        if (invoice.status === "CANCELED") {
          throw createStatusTransitionError(
            "Facture",
            invoice.status,
            "COMPLETED",
            "Une facture annulée ne peut pas être marquée comme payée"
          );
        }

        if (invoice.status === "COMPLETED") {
          // La facture est déjà marquée comme payée, vérifier si la date de paiement est différente
          if (
            invoice.paymentDate &&
            new Date(invoice.paymentDate).toISOString() ===
              new Date(paymentDate).toISOString()
          ) {
            return invoice; // Aucun changement nécessaire
          }
        }

        // Mettre à jour le statut et la date de paiement
        invoice.status = "COMPLETED";
        invoice.paymentDate = new Date(paymentDate);
        await invoice.save();

        return await invoice.populate("createdBy");
      }
    ),

    sendInvoice: withWorkspace(async (_, { id, workspaceId }, { user }) => {
      const invoice = await Invoice.findOne({ _id: id, workspaceId });

      if (!invoice) {
        throw createNotFoundError("Facture");
      }

      // Ici, vous pourriez implémenter la logique d'envoi d'email
      // Pour l'instant, nous simulons un succès
      // TODO: Implémenter l'envoi réel de la facture par email

      return true;
    }),

    createLinkedInvoice: withWorkspace(
      async (
        _,
        { quoteId, amount, isDeposit, workspaceId },
        { user, workspace }
      ) => {
        console.log("Création de facture liée - Paramètres reçus:", {
          quoteId,
          amount,
          isDeposit,
          userId: user.id,
        });

        // Validation et conversion explicite du montant
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
          throw createValidationError("Montant invalide", {
            amount: "Le montant doit être un nombre positif",
          });
        }

        console.log("Montant converti:", {
          original: amount,
          converted: numericAmount,
        });

        // Vérifier que le devis existe et appartient au workspace
        const quote = await Quote.findOne({ _id: quoteId, workspaceId });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        // Récupérer les informations actuelles de l'entreprise
        const userWithCompany = await User.findById(user.id);
        if (!userWithCompany.company) {
          throw new AppError(
            "Vous devez configurer les informations de votre entreprise avant de créer une facture",
            ERROR_CODES.VALIDATION_ERROR
          );
        }

        // Debug: Vérifier les données de l'entreprise dans createLinkedInvoice
        console.log("Données entreprise dans createLinkedInvoice:", {
          hasCompany: !!userWithCompany.company,
          companyName: userWithCompany.company?.name,
          siret: userWithCompany.company?.siret,
          vatNumber: userWithCompany.company?.vatNumber,
          companyStatus: userWithCompany.company?.companyStatus,
          hasBankDetails: !!(
            userWithCompany.company && userWithCompany.company.bankDetails
          ),
          bankDetails: userWithCompany.company?.bankDetails,
        });

        // Vérifier que le devis est accepté
        if (quote.status !== "COMPLETED") {
          throw createValidationError(
            "Seuls les devis acceptés peuvent être convertis en factures liées",
            { status: "Le devis doit être accepté pour créer une facture liée" }
          );
        }

        // Vérifier le nombre de factures déjà liées (max 3)
        const linkedInvoicesCount = quote.linkedInvoices
          ? quote.linkedInvoices.length
          : 0;
        if (linkedInvoicesCount >= 3) {
          throw createValidationError("Limite de factures liées atteinte", {
            linkedInvoices: "Un devis ne peut avoir plus de 3 factures liées",
          });
        }

        // Calculer le montant total déjà facturé et vérifier les acomptes
        let totalInvoiced = 0;
        let hasDeposit = false;
        if (quote.linkedInvoices && quote.linkedInvoices.length > 0) {
          const existingInvoices = await Invoice.find({
            _id: { $in: quote.linkedInvoices },
            workspaceId: workspaceId,
          });
          console.log(
            "Factures existantes trouvées:",
            existingInvoices.map((inv) => ({
              id: inv._id,
              number: inv.number,
              finalTotalTTC: inv.finalTotalTTC,
              isDeposit: inv.isDeposit,
            }))
          );
          totalInvoiced = existingInvoices.reduce(
            (sum, inv) => sum + (inv.finalTotalTTC || 0),
            0
          );
          hasDeposit = existingInvoices.some((inv) => inv.isDeposit === true);
        }

        // Vérifier qu'il n'y a qu'un seul acompte
        if (isDeposit && hasDeposit) {
          throw createValidationError("Acompte déjà existant", {
            isDeposit: "Un devis ne peut avoir qu'un seul acompte",
          });
        }

        // Vérifier que le montant ne dépasse pas le total du devis
        const remainingAmount = quote.finalTotalTTC - totalInvoiced;

        console.log("Validation du montant:", {
          quoteFinalTotalTTC: quote.finalTotalTTC,
          totalInvoiced,
          remainingAmount,
          requestedAmount: numericAmount,
          isDeposit,
          linkedInvoicesCount: quote.linkedInvoices
            ? quote.linkedInvoices.length
            : 0,
        });

        if (numericAmount > remainingAmount) {
          console.error("Erreur de validation - Montant trop élevé:", {
            amount: numericAmount,
            remainingAmount,
            difference: numericAmount - remainingAmount,
          });
          throw createValidationError("Montant de facture invalide", {
            amount: `Le montant ne peut pas dépasser le reste à facturer (${remainingAmount.toFixed(
              2
            )}€)`,
          });
        }

        // Si c'est la dernière facture possible (3ème facture OU reste exactement ce montant),
        // le montant doit être exactement égal au reste à facturer
        const isLastPossibleInvoice =
          linkedInvoicesCount === 2 || remainingAmount === numericAmount;
        if (linkedInvoicesCount === 2 && numericAmount !== remainingAmount) {
          throw createValidationError(
            "Montant de la dernière facture invalide",
            {
              amount: `La dernière facture liée doit être exactement égale au reste à facturer (${remainingAmount.toFixed(
                2
              )}€)`,
            }
          );
        }

        // Générer le numéro de facture
        const prefix = quote.prefix || "F";
        const number = await generateInvoiceNumber(prefix, {
          isDraft: true,
          workspaceId: workspaceId,
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
          status: "DRAFT",
          issueDate: new Date(),
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 jours par défaut
          client: quote.client,
          // S'assurer que les champs SIRET et numéro de TVA sont correctement copiés depuis les informations de l'utilisateur
          companyInfo: {
            // Copier les propriétés de base de l'entreprise
            name: userWithCompany.company.name || "",
            email: userWithCompany.company.email || "",
            phone: userWithCompany.company.phone || "",
            website: userWithCompany.company.website || "",
            address: userWithCompany.company.address || {},
            // Copier les propriétés légales au premier niveau comme attendu par le schéma companyInfoSchema
            siret: userWithCompany.company.siret || "",
            vatNumber: userWithCompany.company.vatNumber || "",
            companyStatus: userWithCompany.company.companyStatus || "AUTRE",
            // Autres propriétés si nécessaire
            logo: userWithCompany.company.logo || "",
            // Copier les coordonnées bancaires si elles existent
            bankDetails: userWithCompany.company.bankDetails || {},
          },
          sourceQuote: quote._id,

          // Créer un article unique avec le montant spécifié
          items: [
            {
              description: isDeposit
                ? `Acompte sur devis ${quote.prefix}${quote.number}`
                : `Facture partielle sur devis ${quote.prefix}${quote.number}`,
              quantity: 1,
              unitPrice: unitPriceHT,
              vatRate: vatRate,
              unit: "forfait",
              discount: 0,
              discountType: "FIXED",
              details: "",
              vatExemptionText: "",
            },
          ],

          headerNotes: quote.headerNotes || "",
          footerNotes: quote.footerNotes || "",
          termsAndConditions: quote.termsAndConditions || "",
          termsAndConditionsLinkTitle: quote.termsAndConditionsLinkTitle || "",
          termsAndConditionsLink: quote.termsAndConditionsLink || "",

          discount: 0,
          discountType: "FIXED",
          customFields: quote.customFields || [],
          createdBy: user._id, // ✅ Conservé pour audit trail
          workspaceId: workspaceId, // ✅ Ajout du workspaceId
        });

        // Calculer les totaux
        const totals = calculateInvoiceTotals(
          invoice.items,
          invoice.discount,
          invoice.discountType
        );
        Object.assign(invoice, totals);

        // Vérifier que le montant TTC final correspond exactement au montant demandé
        // (avec une tolérance de 0.01€ pour les erreurs d'arrondi)
        if (Math.abs(invoice.finalTotalTTC - numericAmount) > 0.01) {
          console.warn(
            `Différence de montant détectée: demandé=${numericAmount}, calculé=${invoice.finalTotalTTC}`
          );
          // Forcer le montant exact si nécessaire
          invoice.finalTotalTTC = numericAmount;
        }

        // Debug: Vérifier les coordonnées bancaires avant nettoyage
        console.log("Coordonnées bancaires avant nettoyage:", {
          hasBankDetails: !!(
            invoice.companyInfo && invoice.companyInfo.bankDetails
          ),
          bankDetails: invoice.companyInfo?.bankDetails,
        });

        // Nettoyer les coordonnées bancaires si elles sont invalides
        if (invoice.companyInfo && invoice.companyInfo.bankDetails) {
          const { iban, bic, bankName } = invoice.companyInfo.bankDetails;
          console.log("Vérification des champs bancaires:", {
            iban: !!iban,
            bic: !!bic,
            bankName: !!bankName,
          });

          // Si l'un des champs est vide ou manquant, supprimer complètement bankDetails
          if (!iban || !bic || !bankName) {
            console.log("Suppression des coordonnées bancaires invalides");
            delete invoice.companyInfo.bankDetails;
          }
        }

        console.log("Coordonnées bancaires après nettoyage:", {
          hasBankDetails: !!(
            invoice.companyInfo && invoice.companyInfo.bankDetails
          ),
          bankDetails: invoice.companyInfo?.bankDetails,
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
        const populatedInvoice = await invoice.populate("createdBy");
        const updatedQuote = await Quote.findById(quote._id).populate({
          path: "linkedInvoices",
          select: "id number status finalTotalTTC isDeposit",
        });

        return {
          invoice: populatedInvoice,
          quote: updatedQuote,
        };
      }
    ),

    deleteLinkedInvoice: withWorkspace(
      async (_, { id, workspaceId }, { user }) => {
        console.log("Tentative de suppression de facture liée:", {
          invoiceId: id,
          userId: user.id,
        });

        const invoice = await Invoice.findOne({ _id: id, workspaceId });

        if (!invoice) {
          console.log("Facture non trouvée:", {
            invoiceId: id,
            userId: user.id,
          });
          throw createNotFoundError("Facture liée");
        }

        console.log("Facture trouvée:", {
          id: invoice._id,
          number: invoice.number,
          status: invoice.status,
          sourceQuote: invoice.sourceQuote,
          hasSourceQuote: !!invoice.sourceQuote,
        });

        // Vérifier que c'est bien une facture liée à un devis
        let sourceQuoteId = invoice.sourceQuote;

        if (!sourceQuoteId) {
          console.log("Facture sans sourceQuote, recherche dans les devis...");

          // Essayer de trouver le devis qui contient cette facture dans ses linkedInvoices

          const quoteWithInvoice = await Quote.findOne({
            linkedInvoices: invoice._id,
            workspaceId,
          });

          if (quoteWithInvoice) {
            console.log("Devis source trouvé via linkedInvoices:", {
              quoteId: quoteWithInvoice._id,
              quoteNumber: `${quoteWithInvoice.prefix}${quoteWithInvoice.number}`,
            });
            sourceQuoteId = quoteWithInvoice._id;

            // Mettre à jour la facture avec le sourceQuote manquant
            await Invoice.updateOne(
              { _id: invoice._id },
              { sourceQuote: sourceQuoteId }
            );
            console.log("sourceQuote mis à jour pour la facture");
          } else {
            console.log(
              "Erreur: Facture sans sourceQuote et non trouvée dans les devis:",
              {
                invoiceId: invoice._id,
                number: invoice.number,
                purchaseOrderNumber: invoice.purchaseOrderNumber,
              }
            );
            throw createValidationError("Facture non liée", {
              invoice: "Cette facture n'est pas liée à un devis",
            });
          }
        }

        // Vérifier que la facture peut être supprimée
        if (invoice.status === "COMPLETED" || invoice.status === "CANCELED") {
          throw createResourceLockedError(
            "Facture liée",
            `une facture ${
              invoice.status === "COMPLETED" ? "terminée" : "annulée"
            } ne peut pas être supprimée`
          );
        }

        // Retirer la facture de la liste des factures liées du devis

        await Quote.updateOne(
          { _id: sourceQuoteId },
          { $pull: { linkedInvoices: invoice._id } }
        );

        console.log(
          "Facture retirée de la liste des factures liées du devis:",
          {
            quoteId: sourceQuoteId,
            invoiceId: invoice._id,
          }
        );

        // Supprimer la facture
        await Invoice.deleteOne({ _id: id, workspaceId });

        console.log("Facture liée supprimée avec succès:", {
          invoiceId: id,
          invoiceNumber: invoice.number,
          quoteId: sourceQuoteId,
        });

        return true;
      }
    ),
  },
};

export default invoiceResolvers;
