import CreditNote from "../models/CreditNote.js";
import {
  archiveDocumentPdf,
  documentUrl,
} from "../utils/documentArchiveHelper.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import Client from "../models/Client.js";
import Event from "../models/Event.js";
import {
  isAuthenticated,
  withWorkspace,
} from "../middlewares/better-auth-jwt.js";
import {
  requireCompanyInfo,
  getOrganizationInfo,
} from "../middlewares/company-info-guard.js";
import {
  requireWrite,
  requireDelete,
  checkSubscriptionActive,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import { mapOrganizationToCompanyInfo } from "../utils/companyInfoMapper.js";
import { triggerCreditNoteFacturXArchive } from "../services/creditNoteFacturXArchiveService.js";
import {
  generateCreditNoteNumber,
  validateNumberSequence,
} from "../utils/documentNumbers.js";
import mongoose from "mongoose";
import {
  createNotFoundError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import documentAutomationService from "../services/documentAutomationService.js";
// withWorkspace imported from better-auth-jwt.js (centralized, with membership verification)

/**
 * Calcule les totaux d'un avoir
 * @param {Boolean} isReverseCharge - Indique si l'avoir est soumis à l'auto-liquidation (TVA = 0)
 */
const calculateCreditNoteTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  isReverseCharge = false,
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    // Prendre en compte le pourcentage d'avancement
    const progressPercentage =
      item.progressPercentage !== undefined && item.progressPercentage !== null
        ? parseFloat(item.progressPercentage)
        : 100;
    const itemTotal =
      item.quantity * item.unitPrice * (progressPercentage / 100);
    const itemDiscount = item.discount || 0;
    const itemDiscountType = item.discountType || "FIXED";

    let itemTotalAfterDiscount = itemTotal;
    if (
      itemDiscountType === "PERCENTAGE" ||
      itemDiscountType === "percentage"
    ) {
      // Limiter la remise à 100% maximum
      const discountPercent = Math.min(itemDiscount, 100);
      itemTotalAfterDiscount = itemTotal * (1 - discountPercent / 100);
    } else {
      itemTotalAfterDiscount = itemTotal - itemDiscount;
    }

    totalHT += itemTotalAfterDiscount;
    // Auto-liquidation : TVA = 0 si isReverseCharge = true
    const itemVAT = isReverseCharge
      ? 0
      : itemTotalAfterDiscount * (item.vatRate / 100);
    totalVAT += itemVAT;
  });

  // Appliquer la remise globale
  let finalTotalHT = totalHT;
  if (discountType === "PERCENTAGE" || discountType === "percentage") {
    // Limiter la remise à 100% maximum
    const discountPercent = Math.min(discount, 100);
    finalTotalHT = totalHT * (1 - discountPercent / 100);
  } else {
    finalTotalHT = totalHT - discount;
  }

  // Recalculer la TVA après remise globale
  // Si finalTotalHT <= 0 (remise >= 100%), la TVA doit être 0
  // Auto-liquidation : TVA = 0 si isReverseCharge = true
  let finalTotalVAT = 0;
  if (!isReverseCharge && finalTotalHT > 0 && totalHT > 0) {
    finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
  }
  const finalTotalTTC = finalTotalHT + finalTotalVAT;

  // Les avoirs ont des montants négatifs
  return {
    totalHT: -Math.abs(totalHT),
    totalVAT: -Math.abs(totalVAT),
    totalTTC: -Math.abs(totalHT + totalVAT),
    finalTotalHT: -Math.abs(finalTotalHT),
    finalTotalVAT: -Math.abs(finalTotalVAT),
    finalTotalTTC: -Math.abs(finalTotalTTC),
  };
};

const creditNoteResolvers = {
  Query: {
    // URL d'aperçu de l'avoir archivé (R2) — null si pas encore archivé
    creditNoteDocumentUrl: withWorkspace(
      async (parent, { creditNoteId }, { workspaceId }) => {
        return documentUrl({
          Model: CreditNote,
          docType: "creditNote",
          draftStatus: null,
          workspaceId,
          docId: creditNoteId,
        });
      },
    ),
    creditNote: withWorkspace(async (parent, { id }, { workspaceId }) => {
      const creditNote = await CreditNote.findOne({
        _id: id,
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
      }).populate("originalInvoice");

      if (!creditNote) {
        throw createNotFoundError("Avoir non trouvé");
      }

      return creditNote;
    }),

    creditNotes: withWorkspace(async (parent, args, context) => {
      const { startDate, endDate, status, search, page = 1, limit = 10 } = args;
      const { workspaceId } = context;

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
          { number: { $regex: search, $options: "i" } },
          { "client.name": { $regex: search, $options: "i" } },
          { reason: { $regex: search, $options: "i" } },
        ];
      }

      const skip = (page - 1) * limit;
      const totalCount = await CreditNote.countDocuments(query);
      const creditNotes = await CreditNote.find(query)
        .populate("originalInvoice")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      return {
        creditNotes,
        totalCount,
        hasNextPage: totalCount > skip + limit,
      };
    }),

    creditNotesByInvoice: withWorkspace(
      async (parent, { invoiceId }, { workspaceId }) => {
        const creditNotes = await CreditNote.find({
          originalInvoice: new mongoose.Types.ObjectId(invoiceId),
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        })
          .populate("originalInvoice")
          .sort({ createdAt: -1 });

        return creditNotes;
      },
    ),

    creditNoteStats: withWorkspace(async (parent, _args, { workspaceId }) => {
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
              $sum: { $cond: [{ $eq: ["$status", "CREATED"] }, 1, 0] },
            },
            totalAmount: { $sum: "$finalTotalTTC" },
          },
        },
      ]);

      return (
        stats[0] || {
          totalCount: 0,
          createdCount: 0,
          totalAmount: 0,
        }
      );
    }),

    nextCreditNoteNumber: withWorkspace(
      async (parent, { prefix, isDraft }, { workspaceId }) => {
        const number = await generateCreditNoteNumber(prefix, {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          isDraft: isDraft || false,
        });
        return number;
      },
    ),
  },

  Mutation: {
    // Archive le PDF Factur-X de l'avoir (généré côté frontend) sur R2
    archiveCreditNotePdf: requireWrite("creditNotes")(
      async (parent, { creditNoteId, file }, context) => {
        const { workspaceId } = context;
        return archiveDocumentPdf({
          Model: CreditNote,
          docType: "creditNote",
          draftStatus: null,
          workspaceId,
          docId: creditNoteId,
          file,
        });
      },
    ),
    createCreditNote: requireCompanyInfo(
      requireWrite("creditNotes")(async (parent, { input }, context) => {
        const { workspaceId } = context;
        await checkSubscriptionActive(context);
        try {
          // Vérifier que la facture originale existe
          const originalInvoice = await Invoice.findOne({
            _id: input.originalInvoiceId,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (!originalInvoice) {
            throw createNotFoundError("Facture originale non trouvée");
          }

          // Vérifier que la facture est en attente, terminée ou annulée
          if (
            !["PENDING", "COMPLETED", "CANCELED"].includes(
              originalInvoice.status,
            )
          ) {
            throw createValidationError(
              "Un avoir ne peut être créé que pour une facture en attente, terminée ou annulée",
            );
          }

          // Calculer les totaux du nouvel avoir avec auto-liquidation si nécessaire
          const totals = calculateCreditNoteTotals(
            input.items,
            input.discount,
            input.discountType,
            originalInvoice.isReverseCharge || false,
          );

          // Vérifier que la somme des avoirs ne dépasse pas le montant de la facture
          const existingCreditNotes = await CreditNote.find({
            originalInvoice: originalInvoice._id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          // Calculer la somme des avoirs existants (valeurs absolues car les avoirs sont négatifs)
          const existingCreditNotesTotal = existingCreditNotes.reduce(
            (sum, creditNote) => {
              return sum + Math.abs(creditNote.finalTotalTTC || 0);
            },
            0,
          );

          // Montant du nouvel avoir (valeur absolue)
          const newCreditNoteAmount = Math.abs(totals.finalTotalTTC);

          // Montant total de la facture originale
          const invoiceTotalAmount = originalInvoice.finalTotalTTC || 0;

          // Vérifier que la somme totale ne dépasse pas le montant de la facture
          if (
            existingCreditNotesTotal + newCreditNoteAmount >
            invoiceTotalAmount
          ) {
            const remainingAmount =
              invoiceTotalAmount - existingCreditNotesTotal;
            throw createValidationError(
              `Le montant de cet avoir (${newCreditNoteAmount.toFixed(2)}€) dépasse le montant restant disponible (${remainingAmount.toFixed(2)}€). La somme des avoirs ne peut pas dépasser le montant de la facture originale (${invoiceTotalAmount.toFixed(2)}€).`,
            );
          }

          // Préfixe effectif : le même doit servir à la validation ET à la
          // génération, sinon le périmètre de la séquence diverge. Le préfixe
          // par défaut est mensuel (AV-AAAAMM) — mêmes règles que la génération
          // et le modèle. Sans ça, un numéro validé "tous préfixes confondus"
          // pouvait être rejeté à tort quand le préfixe mensuel change de mois.
          const now = new Date();
          const effectivePrefix =
            input.prefix ||
            `AV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

          // Numéro manuel : valider la continuité de la séquence (max+1
          // strict, pas de doublon) avant de l'accepter — même verrou que
          // les factures/devis/BC.
          let manualNumber = input.number;
          if (manualNumber) {
            if (!/^\d{1,6}$/.test(manualNumber)) {
              throw new AppError(
                "Le numéro d'avoir doit contenir entre 1 et 6 chiffres",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
            manualNumber = String(parseInt(manualNumber, 10)).padStart(4, "0");

            const sequenceCheck = await validateNumberSequence(
              "creditNote",
              manualNumber,
              effectivePrefix,
              { workspaceId },
            );
            if (!sequenceCheck.isValid) {
              throw new AppError(
                sequenceCheck.message,
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
          }

          // Générer le numéro d'avoir
          const number = await generateCreditNoteNumber(effectivePrefix, {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            isDraft: false,
            manualNumber,
          });

          // Toujours snapshot companyInfo pour les avoirs (pas de statut DRAFT)
          let creditNoteCompanyInfo =
            input.companyInfo || originalInvoice.companyInfo;
          if (!creditNoteCompanyInfo || !creditNoteCompanyInfo.name) {
            const org = await getOrganizationInfo(workspaceId);
            creditNoteCompanyInfo = mapOrganizationToCompanyInfo(org);
          }

          // Créer l'avoir
          const creditNote = new CreditNote({
            ...input,
            number,
            // Fixer le préfixe validé/généré (et pas seulement le défaut du
            // modèle) pour garantir que le numéro et le préfixe stockés
            // décrivent la même séquence.
            prefix: effectivePrefix,
            status: "CREATED",
            companyInfo: creditNoteCompanyInfo,
            originalInvoice: originalInvoice._id,
            originalInvoiceNumber: originalInvoice.number,
            // Copier l'auto-liquidation depuis la facture originale
            isReverseCharge: originalInvoice.isReverseCharge || false,
            client: {
              ...input.client,
              // Pour les avoirs, ne pas copier l'adresse de livraison du client
              // car on utilise celle de la facture originale dans le champ shipping
              hasDifferentShippingAddress: false,
              shippingAddress: undefined,
            },
            // Copier les informations de livraison depuis la facture originale
            shipping: originalInvoice.shipping
              ? {
                  billShipping: originalInvoice.shipping.billShipping,
                  shippingAddress: originalInvoice.shipping.shippingAddress
                    ? {
                        fullName:
                          originalInvoice.shipping.shippingAddress.fullName,
                        street: originalInvoice.shipping.shippingAddress.street,
                        city: originalInvoice.shipping.shippingAddress.city,
                        postalCode:
                          originalInvoice.shipping.shippingAddress.postalCode,
                        country:
                          originalInvoice.shipping.shippingAddress.country,
                      }
                    : undefined,
                  shippingAmountHT: originalInvoice.shipping.shippingAmountHT,
                  shippingVatRate: originalInvoice.shipping.shippingVatRate,
                }
              : undefined,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            createdBy: new mongoose.Types.ObjectId(context.user.id),
            ...totals,
          });

          await creditNote.save();

          // Archivage R2 du PDF de l'avoir — non bloquant, serveur-à-serveur.
          // Parité avec l'archivage auto des factures : fonctionne pour TOUS les
          // clients (mobile inclus), qui n'archivent pas le PDF côté client.
          triggerCreditNoteFacturXArchive(creditNote, workspaceId);

          // Créer un événement
          await Event.create({
            title: `Avoir créé: ${creditNote.prefix}${creditNote.number}`,
            description: `Avoir ${creditNote.prefix}${creditNote.number} créé pour la facture ${originalInvoice.prefix}${originalInvoice.number} - ${creditNote.client.name} - ${creditNote.finalTotalTTC}€`,
            start: new Date(),
            end: new Date(),
            allDay: true,
            color: "blue",
            type: "CREDIT_NOTE_CREATED",
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            userId: new mongoose.Types.ObjectId(context.user.id),
          });

          // Ajouter une activité au client
          try {
            const client = await Client.findOne({
              email: creditNote.client.email,
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
            });

            if (client) {
              client.activity.push({
                id: new mongoose.Types.ObjectId().toString(),
                type: "credit_note_created",
                description: `a créé un avoir en référence à la facture ${originalInvoice.prefix}${originalInvoice.number}`,
                userId: new mongoose.Types.ObjectId(context.user.id),
                userName: context.user.name || context.user.email,
                userImage: context.user.image,
                metadata: {
                  documentType: "creditNote",
                  documentId: creditNote._id.toString(),
                  documentNumber: `${creditNote.prefix}-${creditNote.number}`,
                  status: creditNote.status,
                  originalInvoiceNumber: `${originalInvoice.prefix}-${originalInvoice.number}`,
                },
                createdAt: new Date(),
              });

              await client.save();
              console.log(
                `✅ Activité ajoutée au client ${client.name} pour l'avoir ${creditNote.prefix}${creditNote.number}`,
              );
            } else {
              console.log(
                `⚠️ Client non trouvé avec l'email ${creditNote.client.email} dans le workspace ${workspaceId}`,
              );
            }
          } catch (clientError) {
            console.error(
              "Erreur lors de l'ajout de l'activité au client:",
              clientError,
            );
            // Ne pas bloquer la création de l'avoir si l'ajout de l'activité échoue
          }

          // Automatisations documents partagés (fire-and-forget, ne bloque pas la réponse)
          documentAutomationService
            .executeAutomations(
              "CREDIT_NOTE_CREATED",
              workspaceId,
              {
                documentId: creditNote._id.toString(),
                documentType: "creditNote",
                documentNumber: creditNote.number,
                prefix: creditNote.prefix || "",
                clientName: creditNote.client?.name || "",
                issueDate: creditNote.issueDate || creditNote.createdAt,
                clientId: creditNote.client?._id || creditNote.clientId || null,
              },
              context.user._id.toString(),
            )
            .catch((err) =>
              console.error("Erreur automatisation documents (avoir):", err),
            );

          return await CreditNote.findById(creditNote._id).populate(
            "originalInvoice",
          );
        } catch (error) {
          console.error("Erreur lors de la création de l'avoir:", error);
          throw error;
        }
      }),
    ),

    updateCreditNote: requireCompanyInfo(
      requireWrite("creditNotes")(async (parent, { id, input }, context) => {
        const { workspaceId } = context;
        await checkSubscriptionActive(context);
        try {
          const creditNote = await CreditNote.findOne({
            _id: id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (!creditNote) {
            throw createNotFoundError("Avoir non trouvé");
          }

          // Les avoirs avec statut CREATED peuvent toujours être modifiés

          // Un avoir est toujours finalisé (pas de brouillon) : son numéro et
          // son préfixe sont VERROUILLÉS — les renuméroter casserait la
          // continuité de la séquence.
          if (input.number && input.number !== creditNote.number) {
            throw createValidationError("Le numéro d'un avoir est verrouillé", {
              number: `Impossible de remplacer le numéro "${creditNote.number}" par "${input.number}" sur un avoir émis.`,
            });
          }
          if (input.prefix && input.prefix !== creditNote.prefix) {
            throw createValidationError(
              "Le préfixe d'un avoir est verrouillé",
              {
                prefix: `Impossible de remplacer le préfixe "${creditNote.prefix}" par "${input.prefix}" sur un avoir émis.`,
              },
            );
          }

          // Empêcher le changement d'année d'émission : issueYear fait partie
          // de l'index unique, changer d'année déplacerait l'avoir dans une
          // autre séquence annuelle (collision ou trou).
          if (input.issueDate && creditNote.issueDate) {
            const oldYear = new Date(creditNote.issueDate).getFullYear();
            const newYear = new Date(input.issueDate).getFullYear();
            if (oldYear !== newYear) {
              throw createValidationError(
                `Impossible de changer l'année d'émission d'un avoir (${oldYear} → ${newYear}). Cela casserait la séquence de numérotation.`,
                {
                  issueDate: `L'année d'émission ne peut pas être modifiée de ${oldYear} à ${newYear} sur un avoir émis.`,
                },
              );
            }
          }

          // Calculer les nouveaux totaux si les items ont changé
          let totals = {};
          if (input.items) {
            // Récupérer la facture originale pour obtenir isReverseCharge
            const originalInvoice = await Invoice.findById(
              creditNote.originalInvoice,
            );
            if (!originalInvoice) {
              throw createNotFoundError("Facture originale non trouvée");
            }

            totals = calculateCreditNoteTotals(
              input.items,
              input.discount || creditNote.discount,
              input.discountType || creditNote.discountType,
              originalInvoice.isReverseCharge || false,
            );

            // Vérifier que la somme des avoirs ne dépasse pas le montant de la facture lors de la modification
            // Récupérer tous les autres avoirs pour cette facture (excluant celui en cours de modification)
            const otherCreditNotes = await CreditNote.find({
              originalInvoice: creditNote.originalInvoice,
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              _id: { $ne: id }, // Exclure l'avoir en cours de modification
            });

            // Calculer la somme des autres avoirs existants
            const otherCreditNotesTotal = otherCreditNotes.reduce((sum, cn) => {
              return sum + Math.abs(cn.finalTotalTTC || 0);
            }, 0);

            // Montant du nouvel avoir modifié
            const updatedCreditNoteAmount = Math.abs(totals.finalTotalTTC);

            // Montant total de la facture originale
            const invoiceTotalAmount = originalInvoice.finalTotalTTC || 0;

            // Vérifier que la somme totale ne dépasse pas le montant de la facture
            if (
              otherCreditNotesTotal + updatedCreditNoteAmount >
              invoiceTotalAmount
            ) {
              const remainingAmount =
                invoiceTotalAmount - otherCreditNotesTotal;
              throw createValidationError(
                `Le montant de cet avoir modifié (${updatedCreditNoteAmount.toFixed(2)}€) dépasse le montant restant disponible (${remainingAmount.toFixed(2)}€). La somme des avoirs ne peut pas dépasser le montant de la facture originale (${invoiceTotalAmount.toFixed(2)}€).`,
              );
            }
          }

          // Mettre à jour l'avoir
          Object.assign(creditNote, input, totals);
          await creditNote.save();

          // Créer un événement
          await Event.create({
            type: "CREDIT_NOTE_UPDATED",
            entityType: "CreditNote",
            entityId: creditNote._id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            userId: new mongoose.Types.ObjectId(context.user.id),
            metadata: {
              creditNoteNumber: creditNote.number,
            },
          });

          return await CreditNote.findById(creditNote._id).populate(
            "originalInvoice",
          );
        } catch (error) {
          console.error("Erreur lors de la mise à jour de l'avoir:", error);
          throw error;
        }
      }),
    ),

    deleteCreditNote: requireCompanyInfo(
      requireDelete("creditNotes")(async (parent, { id }, context) => {
        const { workspaceId } = context;
        await checkSubscriptionActive(context);
        try {
          const creditNote = await CreditNote.findOne({
            _id: id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (!creditNote) {
            throw createNotFoundError("Avoir non trouvé");
          }

          // Les avoirs avec statut CREATED peuvent toujours être supprimés

          await CreditNote.findOneAndDelete({ _id: id, workspaceId });

          // Créer un événement
          await Event.create({
            type: "CREDIT_NOTE_DELETED",
            entityType: "CreditNote",
            entityId: creditNote._id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            userId: new mongoose.Types.ObjectId(context.user.id),
            metadata: {
              creditNoteNumber: creditNote.number,
            },
          });

          return true;
        } catch (error) {
          console.error("Erreur lors de la suppression de l'avoir:", error);
          throw error;
        }
      }),
    ),

    // changeCreditNoteStatus mutation removed - credit notes only have CREATED status
  },

  CreditNote: {
    companyInfo: async (creditNote) => {
      if (creditNote.companyInfo && creditNote.companyInfo.name) {
        return creditNote.companyInfo;
      }
      try {
        const organization = await getOrganizationInfo(
          creditNote.workspaceId.toString(),
        );
        return mapOrganizationToCompanyInfo(organization);
      } catch (error) {
        console.error(
          "[CreditNote.companyInfo] Erreur résolution dynamique:",
          error.message,
        );
        return {
          name: "",
          address: { street: "", city: "", postalCode: "", country: "France" },
        };
      }
    },
    createdBy: async (creditNote) => {
      if (!creditNote.createdBy) return null;
      return await User.findById(creditNote.createdBy);
    },
  },
};

export default creditNoteResolvers;
