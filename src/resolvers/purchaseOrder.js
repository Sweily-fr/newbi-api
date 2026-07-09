import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import {
  archiveDocumentPdf,
  documentUrl,
} from "../utils/documentArchiveHelper.js";
import Quote from "../models/Quote.js";
import Invoice from "../models/Invoice.js";
import User from "../models/User.js";
import Client from "../models/Client.js";
import {
  requireWrite,
  requireRead,
  requireDelete,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  generatePurchaseOrderNumber,
  generateInvoiceNumber,
  validateNumberSequence,
} from "../utils/documentNumbers.js";
import {
  createNotFoundError,
  createResourceLockedError,
  createStatusTransitionError,
  createValidationError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import {
  requireCompanyInfo,
  getOrganizationInfo,
} from "../middlewares/company-info-guard.js";
import { mapOrganizationToCompanyInfo } from "../utils/companyInfoMapper.js";
import documentAutomationService from "../services/documentAutomationService.js";

// Fonction utilitaire pour calculer les totaux
const calculatePurchaseOrderTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  shipping = null,
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

    if (item.discount) {
      if (
        item.discountType === "PERCENTAGE" ||
        item.discountType === "percentage"
      ) {
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
      const discountPercent = Math.min(discount, 100);
      discountAmount = (totalHT * discountPercent) / 100;
    } else {
      discountAmount = discount;
    }
  }

  const finalTotalHT = totalHT - discountAmount;

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

const purchaseOrderResolvers = {
  PurchaseOrder: {
    companyInfo: async (po) => {
      // Pour les brouillons, toujours résoudre depuis l'organisation (données dynamiques)
      if (!po.status || po.status === "DRAFT") {
        try {
          const organization = await getOrganizationInfo(
            po.workspaceId.toString(),
          );
          return mapOrganizationToCompanyInfo(organization);
        } catch (error) {
          console.error(
            "[PurchaseOrder.companyInfo] Erreur résolution dynamique:",
            error.message,
          );
          if (po.companyInfo && po.companyInfo.name) return po.companyInfo;
          return {
            name: "",
            address: {
              street: "",
              city: "",
              postalCode: "",
              country: "France",
            },
          };
        }
      }
      // Pour les documents finalisés, utiliser les données embarquées (snapshot historique)
      if (po.companyInfo && po.companyInfo.name) {
        return po.companyInfo;
      }
      // Fallback : résoudre depuis l'organisation
      try {
        const organization = await getOrganizationInfo(
          po.workspaceId.toString(),
        );
        return mapOrganizationToCompanyInfo(organization);
      } catch (error) {
        console.error(
          "[PurchaseOrder.companyInfo] Erreur résolution fallback:",
          error.message,
        );
        return {
          name: "",
          address: { street: "", city: "", postalCode: "", country: "France" },
        };
      }
    },
    client: async (po) => {
      // Pour les brouillons, résoudre depuis la collection Client (données à jour)
      if ((!po.status || po.status === "DRAFT") && po.client?.id) {
        try {
          const freshClient = await Client.findById(po.client.id);
          if (freshClient) {
            return {
              id: freshClient._id.toString(),
              name: freshClient.name,
              email: freshClient.email,
              address: freshClient.address,
              type: freshClient.type,
              siret: freshClient.siret,
              vatNumber: freshClient.vatNumber,
              isInternational: freshClient.isInternational,
              firstName: freshClient.firstName,
              lastName: freshClient.lastName,
              hasDifferentShippingAddress:
                freshClient.hasDifferentShippingAddress,
              shippingAddress: freshClient.shippingAddress,
            };
          }
        } catch (error) {
          console.error(
            "[PurchaseOrder.client] Erreur résolution dynamique:",
            error.message,
          );
        }
      }
      // Pour les documents finalisés ou en fallback, utiliser le snapshot embarqué
      return po.client;
    },
    createdBy: async (po) => {
      if (!po.createdBy) return null;
      return await User.findById(po.createdBy);
    },
    sourceQuote: async (po) => {
      if (!po.sourceQuoteId) return null;
      return await Quote.findById(po.sourceQuoteId);
    },
    linkedInvoices: async (po) => {
      if (po.linkedInvoices && po.linkedInvoices.length > 0) {
        return await Invoice.find({ _id: { $in: po.linkedInvoices } });
      }
      return [];
    },
  },

  Query: {
    // URL d'aperçu du bon de commande archivé (R2) — null si brouillon / pas archivé
    purchaseOrderDocumentUrl: requireRead("purchaseOrders")(
      async (
        _,
        { workspaceId: inputWorkspaceId, purchaseOrderId },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return documentUrl({
          Model: PurchaseOrder,
          docType: "purchaseOrder",
          draftStatus: "DRAFT",
          workspaceId,
          docId: purchaseOrderId,
        });
      },
    ),
    purchaseOrder: requireRead("purchaseOrders")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const po = await PurchaseOrder.findOne({
          _id: id,
          workspaceId,
        }).populate("createdBy");

        if (!po) throw createNotFoundError("Bon de commande");
        return po;
      },
    ),

    purchaseOrders: requireRead("purchaseOrders")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          startDate,
          endDate,
          status,
          search,
          page = 1,
          limit = 10,
        },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
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
        const totalCount = await PurchaseOrder.countDocuments(query);

        const purchaseOrders = await PurchaseOrder.find(query)
          .populate("createdBy")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        return {
          purchaseOrders,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      },
    ),

    purchaseOrderStats: requireRead("purchaseOrders")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const [stats] = await PurchaseOrder.aggregate([
          { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId) } },
          {
            $group: {
              _id: null,
              totalCount: { $sum: 1 },
              draftCount: {
                $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] },
              },
              confirmedCount: {
                $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] },
              },
              validatedCount: {
                $sum: { $cond: [{ $eq: ["$status", "VALIDATED"] }, 1, 0] },
              },
              inProgressCount: {
                $sum: { $cond: [{ $eq: ["$status", "IN_PROGRESS"] }, 1, 0] },
              },
              deliveredCount: {
                $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, 1, 0] },
              },
              canceledCount: {
                $sum: { $cond: [{ $eq: ["$status", "CANCELED"] }, 1, 0] },
              },
              totalAmount: {
                $sum: {
                  $cond: [
                    { $eq: ["$status", "CANCELED"] },
                    0,
                    "$finalTotalTTC",
                  ],
                },
              },
            },
          },
          {
            $project: {
              _id: 0,
              totalCount: 1,
              draftCount: 1,
              confirmedCount: 1,
              validatedCount: 1,
              inProgressCount: 1,
              deliveredCount: 1,
              canceledCount: 1,
              totalAmount: 1,
            },
          },
        ]);

        const defaultStats = {
          totalCount: 0,
          draftCount: 0,
          confirmedCount: 0,
          validatedCount: 0,
          inProgressCount: 0,
          deliveredCount: 0,
          canceledCount: 0,
          totalAmount: 0,
        };

        if (stats) {
          Object.keys(defaultStats).forEach((key) => {
            if (stats[key] === null || stats[key] === undefined) {
              stats[key] = 0;
            }
          });
          return stats;
        }

        return defaultStats;
      },
    ),

    nextPurchaseOrderNumber: requireRead("purchaseOrders")(
      async (
        _,
        { workspaceId: inputWorkspaceId, prefix, autoNumbering },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wsId = new mongoose.Types.ObjectId(workspaceId);
        // Exclure les brouillons : seuls les documents finalisés réservent un
        // numéro dans la séquence (règle "au moins un document finalisé").
        // Un brouillon ne doit ni verrouiller le champ numéro ni décaler le
        // prochain numéro proposé.
        const query = { workspaceId: wsId, status: { $ne: "DRAFT" } };

        if (!autoNumbering && prefix) {
          query.prefix = prefix;
        }

        const allOrders = await PurchaseOrder.find(query, { number: 1 }).lean();

        let maxNumber = 0;
        for (const o of allOrders) {
          if (o.number && /^\d+$/.test(o.number)) {
            const num = parseInt(o.number, 10);
            if (num > maxNumber) maxNumber = num;
          }
        }
        return String(maxNumber + 1).padStart(4, "0");
      },
    ),

    checkPurchaseOrderNumberExists: requireRead("purchaseOrders")(
      async (
        _,
        { workspaceId: inputWorkspaceId, number, prefix, excludeId },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const query = { workspaceId, number, prefix, status: { $ne: "DRAFT" } };
        if (excludeId) {
          query._id = { $ne: excludeId };
        }
        const count = await PurchaseOrder.countDocuments(query);
        return count > 0;
      },
    ),
  },

  Mutation: {
    // Archive le PDF du bon de commande (généré côté frontend) sur R2
    archivePurchaseOrderPdf: requireWrite("purchaseOrders")(
      async (
        _,
        { workspaceId: inputWorkspaceId, purchaseOrderId, file },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return archiveDocumentPdf({
          Model: PurchaseOrder,
          docType: "purchaseOrder",
          draftStatus: "DRAFT",
          workspaceId,
          docId: purchaseOrderId,
          file,
        });
      },
    ),
    createPurchaseOrder: requireCompanyInfo(
      requireWrite("purchaseOrders")(
        async (_, { workspaceId: inputWorkspaceId, input }, context) => {
          const { user } = context;
          const workspaceId = resolveWorkspaceId(
            inputWorkspaceId,
            context.workspaceId,
          );

          if (!workspaceId) {
            throw new AppError(
              "Aucune organisation spécifiée.",
              ERROR_CODES.BAD_REQUEST,
            );
          }

          // Déterminer le préfixe
          let prefix = input.prefix;
          if (!prefix) {
            const lastPO = await PurchaseOrder.findOne({ workspaceId })
              .sort({ createdAt: -1 })
              .select("prefix")
              .lean();

            if (lastPO && lastPO.prefix) {
              prefix = lastPO.prefix;
            } else {
              const now = new Date();
              const year = now.getFullYear();
              const month = String(now.getMonth() + 1).padStart(2, "0");
              prefix = `BC-${year}${month}`;
            }
          }

          // Récupérer les informations de l'organisation (avant la numérotation :
          // le flag "séquence continue" en dépend)
          const organization = await getOrganizationInfo(workspaceId);
          const autoNumbering =
            organization?.purchaseOrderAutoNumbering === true;

          // === Génération du numéro (style Pennylane) ===
          // - Aucun BC finalisé → numéro manuel libre accepté
          // - Des BC finalisés existent → le numéro doit suivre la séquence (pas de trou/recul)
          // Périmètre : par préfixe en mode normal, tous préfixes confondus en séquence continue.
          const isDraft = !input.status || input.status === "DRAFT";
          let allowManualPONumber = false;
          if (input.number && !isDraft) {
            if (!/^\d{1,6}$/.test(input.number)) {
              throw new AppError(
                "Le numéro de bon de commande doit contenir entre 1 et 6 chiffres",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }

            const finalizedQuery = {
              workspaceId,
              status: {
                $in: [
                  "CONFIRMED",
                  "VALIDATED",
                  "IN_PROGRESS",
                  "DELIVERED",
                  "CANCELED",
                ],
              },
            };
            if (!autoNumbering) finalizedQuery.prefix = prefix;
            const firstFinalized =
              await PurchaseOrder.findOne(finalizedQuery).lean();

            if (firstFinalized) {
              const sequenceCheck = await validateNumberSequence(
                "purchaseOrder",
                input.number,
                prefix,
                { workspaceId, autoNumbering },
              );
              if (!sequenceCheck.isValid) {
                throw new AppError(
                  sequenceCheck.message,
                  ERROR_CODES.VALIDATION_ERROR,
                );
              }
            }
            allowManualPONumber = true;
          }

          const generatePONumber = async () => {
            if (allowManualPONumber) {
              return String(parseInt(input.number, 10)).padStart(4, "0");
            }
            // Les brouillons reçoivent un numéro DRAFT-timestamp (comme les devis
            // et factures) : ils ne consomment pas le compteur séquentiel et ne sont
            // pas comptés par nextPurchaseOrderNumber. Le numéro définitif est attribué
            // à la finalisation (DRAFT → CONFIRMED).
            return await generatePurchaseOrderNumber(prefix, {
              isDraft,
              workspaceId,
              userId: user.id,
              autoNumbering,
            });
          };

          let number = await generatePONumber();

          if (!organization?.companyName) {
            throw new AppError(
              "Les informations de votre entreprise doivent être configurées avant de créer un bon de commande",
              ERROR_CODES.COMPANY_INFO_REQUIRED,
            );
          }

          // Calculer les totaux
          const totals = calculatePurchaseOrderTotals(
            input.items,
            input.discount,
            input.discountType,
            input.shipping,
          );

          const clientData = input.client;
          if (
            clientData.type === "INDIVIDUAL" &&
            (!clientData.name || clientData.name.trim() === "")
          ) {
            if (clientData.firstName && clientData.lastName) {
              clientData.name = `${clientData.firstName} ${clientData.lastName}`;
            } else {
              clientData.name = clientData.email
                ? `Client ${clientData.email}`
                : "Client Particulier";
            }
          }

          // Créer le bon de commande - companyInfo uniquement pour les documents non-DRAFT
          // Retry sur E11000 : régénère le numéro via le compteur atomique en cas
          // de conflit (race condition). Numéro manuel échoue immédiatement.
          const PO_MAX_SAVE_RETRIES = 5;
          let purchaseOrder;
          for (let attempt = 1; attempt <= PO_MAX_SAVE_RETRIES; attempt++) {
            purchaseOrder = new PurchaseOrder({
              ...input,
              number,
              prefix,
              workspaceId,
              companyInfo: isDraft
                ? undefined
                : mapOrganizationToCompanyInfo(organization),
              client: {
                ...input.client,
                shippingAddress: input.client.hasDifferentShippingAddress
                  ? {
                      fullName: input.client.shippingAddress?.fullName || "",
                      street: input.client.shippingAddress?.street || "",
                      city: input.client.shippingAddress?.city || "",
                      postalCode:
                        input.client.shippingAddress?.postalCode || "",
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
              ...totals,
            });

            try {
              await purchaseOrder.save();
              break;
            } catch (err) {
              const isDup = err && (err.code === 11000 || err.code === 11001);
              if (!isDup) throw err;
              if (allowManualPONumber) {
                throw new AppError(
                  `Le numéro de bon de commande "${number}" est déjà utilisé`,
                  ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER,
                );
              }
              if (attempt === PO_MAX_SAVE_RETRIES) {
                console.error(
                  "[createPurchaseOrder] Échec après retries E11000:",
                  err.keyValue,
                );
                throw new AppError(
                  "Impossible de générer un numéro de bon de commande unique. Veuillez réessayer.",
                  ERROR_CODES.INTERNAL_ERROR,
                );
              }
              console.warn(
                `[createPurchaseOrder] Conflit E11000 tentative ${attempt}/${PO_MAX_SAVE_RETRIES}, retry:`,
                err.keyValue,
              );
              number = await generatePurchaseOrderNumber(prefix, {
                isDraft,
                workspaceId,
                userId: user.id,
                autoNumbering,
              });
            }
          }

          // Automatisations documents partagés (fire-and-forget)
          const poTriggerMap = {
            DRAFT: "PURCHASE_ORDER_DRAFT",
            CONFIRMED: "PURCHASE_ORDER_CONFIRMED",
          };
          const poTrigger = poTriggerMap[purchaseOrder.status];
          if (poTrigger) {
            documentAutomationService
              .executeAutomations(
                poTrigger,
                workspaceId,
                {
                  documentId: purchaseOrder._id.toString(),
                  documentType: "purchaseOrder",
                  documentNumber: purchaseOrder.number,
                  prefix: purchaseOrder.prefix || "",
                  clientName: purchaseOrder.client?.name || "",
                  issueDate: purchaseOrder.issueDate || purchaseOrder.createdAt,
                  clientId:
                    purchaseOrder.client?._id || purchaseOrder.clientId || null,
                },
                user._id.toString(),
              )
              .catch((err) =>
                console.error(
                  "Erreur automatisation documents (PO create):",
                  err,
                ),
              );
          }

          return await purchaseOrder.populate("createdBy");
        },
      ),
    ),

    updatePurchaseOrder: requireCompanyInfo(
      requireWrite("purchaseOrders")(
        async (_, { id, workspaceId: inputWorkspaceId, input }, context) => {
          const { user, workspaceId } = context;
          const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

          if (!po) {
            throw createNotFoundError("Bon de commande");
          }

          if (po.status === "DELIVERED") {
            throw createResourceLockedError(
              "Bon de commande",
              "un bon de commande livré ne peut pas être modifié",
            );
          }

          // Garde-fou de transition : updatePurchaseOrder gère l'édition de
          // contenu et la SEULE transition DRAFT → CONFIRMED (finalisation,
          // numérotée plus bas). Tout autre changement de statut (rétrogradation
          // en DRAFT, VALIDATED, IN_PROGRESS, DELIVERED, CANCELED…) doit passer
          // par changePurchaseOrderStatus, qui applique la whitelist de
          // transitions. Sans ce garde, un DRAFT → CANCELED consommerait un
          // numéro séquentiel pour un brouillon abandonné, et un finalisé
          // pouvait redevenir DRAFT en gardant son numéro.
          if (
            input.status &&
            input.status !== po.status &&
            !(po.status === "DRAFT" && input.status === "CONFIRMED")
          ) {
            throw createValidationError(
              "Changement de statut non autorisé lors de la modification du bon de commande",
              {
                status: `Pour passer un bon de commande de "${po.status}" à "${input.status}", utilisez l'action de changement de statut.`,
              },
            );
          }

          // Validation : empêcher le changement d'année de issueDate sur un bon de commande confirmé
          if (input.issueDate && po.status !== "DRAFT" && po.issueDate) {
            const oldYear = new Date(po.issueDate).getFullYear();
            const newYear = new Date(input.issueDate).getFullYear();
            if (oldYear !== newYear) {
              throw new AppError(
                `Impossible de changer l'année d'émission d'un bon de commande confirmé (${oldYear} → ${newYear}). Cela casserait la séquence de numérotation.`,
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
          }

          // Une fois le bon de commande finalisé (CONFIRMED/VALIDATED/…),
          // prefix et number sont VERROUILLÉS : les renuméroter casserait la
          // continuité de la séquence. La transition DRAFT → finalisé est
          // gérée plus bas (le numéro y est généré/validé).
          if (po.status !== "DRAFT") {
            if (input.number && input.number !== po.number) {
              throw createValidationError(
                "Le numéro d'un bon de commande finalisé est verrouillé",
                {
                  number: `Impossible de remplacer le numéro "${po.number}" par "${input.number}" sur un bon de commande ${po.status}.`,
                },
              );
            }
            if (input.prefix && input.prefix !== po.prefix) {
              throw createValidationError(
                "Le préfixe d'un bon de commande finalisé est verrouillé",
                {
                  prefix: `Impossible de remplacer le préfixe "${po.prefix}" par "${input.prefix}" sur un bon de commande ${po.status}.`,
                },
              );
            }
          }

          // Si des items sont fournis, recalculer les totaux
          if (input.items) {
            const totals = calculatePurchaseOrderTotals(
              input.items,
              input.discount !== undefined ? input.discount : po.discount,
              input.discountType || po.discountType,
              input.shipping !== undefined ? input.shipping : po.shipping,
            );
            input = { ...input, ...totals };
          }

          let updateData = { ...input };

          // Ne pas persister companyInfo pour les documents DRAFT
          delete updateData.companyInfo;

          const FINALIZED_PO_STATUSES = [
            "CONFIRMED",
            "VALIDATED",
            "IN_PROGRESS",
            "DELIVERED",
            "CANCELED",
          ];
          const isFinalizing =
            po.status === "DRAFT" &&
            FINALIZED_PO_STATUSES.includes(updateData.status);

          // Un brouillon qui reste brouillon garde son numéro provisoire
          // (DRAFT-xxx) : le numéro définitif n'est attribué qu'à la
          // finalisation. Le numéro affiché par l'éditeur n'est qu'une
          // prévisualisation — le persister créerait des collisions d'index
          // unique entre brouillons partageant le même "prochain numéro".
          if (po.status === "DRAFT" && !isFinalizing) {
            delete updateData.number;
          }

          // Transition DRAFT → finalisé via updatePurchaseOrder (chemin
          // utilisé par l'éditeur) : générer ou valider le numéro séquentiel,
          // comme le fait changePurchaseOrderStatus.
          if (isFinalizing) {
            // Snapshot companyInfo à la finalisation
            if (!po.companyInfo || !po.companyInfo.name) {
              const org = await getOrganizationInfo(workspaceId);
              updateData.companyInfo = mapOrganizationToCompanyInfo(org);
            }

            const finalizeOrg = await getOrganizationInfo(po.workspaceId);
            const autoNumbering =
              finalizeOrg?.purchaseOrderAutoNumbering === true;

            if (!input.number || !input.prefix) {
              // Générer automatiquement (même convention que changePurchaseOrderStatus)
              let prefix = input.prefix || po.prefix;
              if (!prefix) {
                const year = (po.issueDate || new Date()).getFullYear();
                const month = String(
                  (po.issueDate || new Date()).getMonth() + 1,
                ).padStart(2, "0");
                prefix = `BC-${year}${month}`;
              }

              updateData.number = await generatePurchaseOrderNumber(prefix, {
                workspaceId: po.workspaceId,
                userId: user.id,
                autoNumbering,
              });
              updateData.prefix = prefix;
            } else {
              // Numéro fourni explicitement : verrou de séquence (max+1
              // strict, pas de doublon parmi les finalisés) + renommage des
              // brouillons en conflit pour éviter une collision d'index unique.
              if (!/^\d{1,6}$/.test(input.number)) {
                throw new AppError(
                  "Le numéro de bon de commande doit contenir entre 1 et 6 chiffres",
                  ERROR_CODES.VALIDATION_ERROR,
                );
              }
              const normalizedNumber = String(
                parseInt(input.number, 10),
              ).padStart(4, "0");

              const sequenceCheck = await validateNumberSequence(
                "purchaseOrder",
                normalizedNumber,
                input.prefix,
                { workspaceId: po.workspaceId, autoNumbering },
              );
              if (!sequenceCheck.isValid) {
                throw new AppError(
                  sequenceCheck.message,
                  ERROR_CODES.VALIDATION_ERROR,
                );
              }

              const conflictingDrafts = await PurchaseOrder.find({
                prefix: input.prefix,
                number: normalizedNumber,
                status: "DRAFT",
                workspaceId: po.workspaceId,
                _id: { $ne: po._id },
              });
              // Suffixe court (≤ 20 caractères, cf. validateur du modèle) :
              // Date.now() complet faisait dépasser la limite → brouillon
              // renommé devenait inéditable.
              const renameStamp = Date.now().toString().slice(-6);
              for (let i = 0; i < conflictingDrafts.length; i++) {
                await PurchaseOrder.findByIdAndUpdate(
                  conflictingDrafts[i]._id,
                  {
                    number: `${normalizedNumber}-${renameStamp}${i}`,
                  },
                );
              }

              updateData.number = normalizedNumber;
            }
          }

          // Pour les brouillons, rafraîchir les données client depuis la
          // collection Client UNIQUEMENT si l'input ne fournit pas de client.
          // Si un client est fourni (édition du document), on respecte ses
          // valeurs : l'utilisateur a pu modifier manuellement les coordonnées
          // (email, adresse…) au niveau du bon de commande, et ces modifications
          // doivent primer sur la fiche client. Le frontend synchronise déjà les
          // données CRM à jour dans le formulaire à l'ouverture du brouillon.
          if (
            (!po.status || po.status === "DRAFT") &&
            !updateData.client &&
            po.client?.id
          ) {
            try {
              const freshClient = await Client.findById(po.client.id);
              if (freshClient) {
                updateData.client = {
                  id: freshClient._id.toString(),
                  type: freshClient.type,
                  name: freshClient.name,
                  firstName: freshClient.firstName,
                  lastName: freshClient.lastName,
                  email: freshClient.email,
                  address: freshClient.address,
                  hasDifferentShippingAddress:
                    freshClient.hasDifferentShippingAddress,
                  shippingAddress: freshClient.shippingAddress,
                  isInternational: freshClient.isInternational,
                  siret: freshClient.siret,
                  vatNumber: freshClient.vatNumber,
                };
              }
            } catch (error) {
              console.error(
                "[updatePurchaseOrder] Erreur rafraîchissement client:",
                error.message,
              );
            }
          }

          Object.assign(po, updateData);
          await po.save();
          return await po.populate("createdBy");
        },
      ),
    ),

    deletePurchaseOrder: requireCompanyInfo(
      requireDelete("purchaseOrders")(
        async (_, { id, workspaceId: inputWorkspaceId }, context) => {
          const { user, workspaceId } = context;
          const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

          if (!po) {
            throw createNotFoundError("Bon de commande");
          }

          if (po.status === "DELIVERED") {
            throw createResourceLockedError(
              "Bon de commande",
              "un bon de commande livré ne peut pas être supprimé",
            );
          }

          if (po.linkedInvoices && po.linkedInvoices.length > 0) {
            throw createResourceLockedError(
              "Bon de commande",
              "un bon de commande avec des factures liées ne peut pas être supprimé",
            );
          }

          await PurchaseOrder.deleteOne({ _id: id, workspaceId });
          return true;
        },
      ),
    ),

    changePurchaseOrderStatus: requireCompanyInfo(
      requireWrite("purchaseOrders")(
        async (_, { id, workspaceId: inputWorkspaceId, status }, context) => {
          const { user, workspaceId } = context;
          const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

          if (!po) {
            throw createNotFoundError("Bon de commande");
          }

          const allowedTransitions = {
            DRAFT: ["CONFIRMED", "CANCELED"],
            CONFIRMED: ["VALIDATED", "DRAFT", "CANCELED"],
            VALIDATED: ["IN_PROGRESS"],
            IN_PROGRESS: ["DELIVERED"],
            DELIVERED: [],
            CANCELED: [],
          };

          if (!allowedTransitions[po.status]?.includes(status)) {
            throw createStatusTransitionError(
              "Bon de commande",
              po.status,
              status,
            );
          }

          if (
            status === "CANCELED" &&
            po.linkedInvoices &&
            po.linkedInvoices.length > 0
          ) {
            throw createResourceLockedError(
              "Bon de commande",
              "un bon de commande avec des factures liées ne peut pas être annulé",
            );
          }

          const oldStatus = po.status;

          // Si transition DRAFT → CONFIRMED, snapshot companyInfo + client et générer un numéro séquentiel
          if (po.status === "DRAFT" && status === "CONFIRMED") {
            // Snapshot companyInfo à la finalisation
            if (!po.companyInfo || !po.companyInfo.name) {
              const org = await getOrganizationInfo(workspaceId);
              po.companyInfo = mapOrganizationToCompanyInfo(org);
            }

            // Snapshot client à la finalisation : on ne re-snapshote depuis la
            // collection Client QUE si le bon de commande n'a pas déjà de client
            // figé. Sinon on conserve le snapshot du document, qui reflète les
            // dernières données enregistrées (incl. les éventuelles modifications
            // manuelles des coordonnées faites lors de l'édition du brouillon).
            if (!po.client?.id) {
              const clientId = po.client?.id || po.clientId;
              if (clientId) {
                try {
                  const freshClient = await Client.findById(clientId);
                  if (freshClient) {
                    po.client = {
                      id: freshClient._id.toString(),
                      type: freshClient.type,
                      name: freshClient.name,
                      firstName: freshClient.firstName,
                      lastName: freshClient.lastName,
                      email: freshClient.email,
                      address: freshClient.address,
                      hasDifferentShippingAddress:
                        freshClient.hasDifferentShippingAddress,
                      shippingAddress: freshClient.shippingAddress,
                      isInternational: freshClient.isInternational,
                      siret: freshClient.siret,
                      vatNumber: freshClient.vatNumber,
                    };
                  }
                } catch (error) {
                  console.error(
                    "[changePurchaseOrderStatus] Erreur snapshot client:",
                    error.message,
                  );
                }
              }
            }

            // Transaction atomique pour éviter les numéros TEMP orphelins
            const MAX_RETRIES = 3;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              const session = await mongoose.startSession();
              try {
                await session.withTransaction(async () => {
                  let prefix = po.prefix;
                  if (!prefix) {
                    const year = (po.issueDate || new Date()).getFullYear();
                    const month = String(
                      (po.issueDate || new Date()).getMonth() + 1,
                    ).padStart(2, "0");
                    prefix = `BC-${year}${month}`;
                  }

                  const poOrg = await getOrganizationInfo(po.workspaceId);
                  const autoNumbering =
                    poOrg?.purchaseOrderAutoNumbering === true;

                  const newNumber = await generatePurchaseOrderNumber(prefix, {
                    workspaceId: po.workspaceId,
                    userId: user.id,
                    session,
                    autoNumbering,
                  });

                  // Utiliser un numéro temporaire pour éviter les conflits d'unicité
                  po.number = `TEMP-${Date.now()}`;
                  await po.save({ session });

                  po.number = newNumber;
                  po.prefix = prefix;
                  po.status = status;
                  await po.save({ session });
                });
                session.endSession();
                break;
              } catch (err) {
                session.endSession();
                if (err.code === 11000 && attempt < MAX_RETRIES - 1) {
                  console.log(
                    `⚠️ [changePurchaseOrderStatus] E11000 retry attempt ${attempt + 1}`,
                  );
                  continue;
                }
                throw err;
              }
            }
          } else {
            po.status = status;
            await po.save();
          }

          // Automatisations documents partagés (fire-and-forget)
          const statusTriggerMap = {
            CONFIRMED: "PURCHASE_ORDER_CONFIRMED",
            IN_PROGRESS: "PURCHASE_ORDER_IN_PROGRESS",
            DELIVERED: "PURCHASE_ORDER_DELIVERED",
            CANCELED: "PURCHASE_ORDER_CANCELED",
          };
          const poStatusTrigger = statusTriggerMap[status];
          if (poStatusTrigger) {
            documentAutomationService
              .executeAutomations(
                poStatusTrigger,
                workspaceId,
                {
                  documentId: po._id.toString(),
                  documentType: "purchaseOrder",
                  documentNumber: po.number,
                  prefix: po.prefix || "",
                  clientName: po.client?.name || "",
                  issueDate: po.issueDate || po.createdAt,
                  clientId: po.client?._id || po.clientId || null,
                },
                user._id.toString(),
              )
              .catch((err) =>
                console.error(
                  "Erreur automatisation documents (PO status):",
                  err,
                ),
              );
          }

          return await po.populate("createdBy");
        },
      ),
    ),

    convertQuoteToPurchaseOrder: requireWrite("purchaseOrders")(
      async (_, { quoteId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const quote = await Quote.findOne({ _id: quoteId, workspaceId });

        if (!quote) {
          throw createNotFoundError("Devis");
        }

        if (quote.status !== "COMPLETED") {
          throw new AppError(
            "Seuls les devis acceptés peuvent être convertis en bon de commande",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }

        const organization = await getOrganizationInfo(workspaceId);

        // Générer le préfixe et le numéro
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const prefix = `BC-${year}${month}`;

        const number = await generatePurchaseOrderNumber(prefix, {
          workspaceId,
          userId: user.id,
          autoNumbering: organization?.purchaseOrderAutoNumbering === true,
        });

        // Convertir les sous-documents Mongoose en objets simples pour une copie correcte
        const quoteObj = quote.toObject();

        const purchaseOrder = new PurchaseOrder({
          number,
          prefix,
          client: quoteObj.client,
          companyInfo: mapOrganizationToCompanyInfo(organization),
          items: quoteObj.items,
          status: "CONFIRMED",
          issueDate: new Date(),
          validUntil:
            quote.validUntil && new Date(quote.validUntil) >= new Date()
              ? quote.validUntil
              : null,
          headerNotes:
            organization.purchaseOrderHeaderNotes ||
            organization.documentHeaderNotes ||
            "",
          footerNotes:
            organization.purchaseOrderFooterNotes ||
            organization.documentFooterNotes ||
            "",
          termsAndConditions:
            organization.purchaseOrderTermsAndConditions ||
            organization.documentTermsAndConditions ||
            "",
          termsAndConditionsLinkTitle: "",
          termsAndConditionsLink: "",
          discount: quote.discount,
          discountType: quote.discountType,
          customFields: quoteObj.customFields,
          totalHT: quote.totalHT,
          totalVAT: quote.totalVAT,
          totalTTC: quote.totalTTC,
          finalTotalHT: quote.finalTotalHT,
          finalTotalVAT: quote.finalTotalVAT,
          finalTotalTTC: quote.finalTotalTTC,
          discountAmount: quote.discountAmount,
          workspaceId,
          createdBy: user.id,
          sourceQuoteId: quote._id,
          appearance: {
            textColor:
              organization.purchaseOrderTextColor ||
              organization.documentTextColor ||
              "#000000",
            headerTextColor:
              organization.purchaseOrderHeaderTextColor ||
              organization.documentHeaderTextColor ||
              "#ffffff",
            headerBgColor:
              organization.purchaseOrderHeaderBgColor ||
              organization.documentHeaderBgColor ||
              "#5b50FF",
          },
          shipping: quoteObj.shipping,
          isReverseCharge: quote.isReverseCharge || false,
          isVatExempt: quote.isVatExempt || false,
          clientPositionRight:
            organization.purchaseOrderClientPositionRight || false,
          showBankDetails: organization.showBankDetails || false,
          retenueGarantie: quote.retenueGarantie || 0,
          escompte: quote.escompte || 0,
        });

        await purchaseOrder.save();
        return await purchaseOrder.populate("createdBy");
      },
    ),

    convertPurchaseOrderToInvoice: requireWrite("purchaseOrders")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

        if (!po) {
          throw createNotFoundError("Bon de commande");
        }

        if (!["CONFIRMED", "IN_PROGRESS", "DELIVERED"].includes(po.status)) {
          throw new AppError(
            "Seuls les bons de commande confirmés, en cours ou livrés peuvent être convertis en facture",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }

        // Si le BC provient d'un devis, garantir qu'on ne facture pas au-delà
        // du montant du devis, tous chemins confondus (devis→facture directe
        // OU devis→BC→facture). On charge le devis source pour contrôler et
        // synchroniser quote.linkedInvoices (source de vérité anti-doublon).
        let sourceQuote = null;
        if (po.sourceQuoteId) {
          sourceQuote = await Quote.findOne({
            _id: po.sourceQuoteId,
            workspaceId,
          });

          if (sourceQuote) {
            const quoteAmount = sourceQuote.finalTotalTTC || 0;

            // Nettoyer les références mortes et calculer le déjà-facturé
            let existingInvoicesTotalAmount = 0;
            if (sourceQuote.linkedInvoices?.length > 0) {
              const existingInvoices = await Invoice.find({
                _id: { $in: sourceQuote.linkedInvoices },
              });
              const validIds = existingInvoices.map((inv) => inv._id);
              if (validIds.length !== sourceQuote.linkedInvoices.length) {
                sourceQuote.linkedInvoices = validIds;
                await sourceQuote.save();
              }
              existingInvoicesTotalAmount = existingInvoices.reduce(
                (sum, inv) => sum + (inv.finalTotalTTC || 0),
                0,
              );
            }

            if (
              quoteAmount > 0 &&
              quoteAmount - existingInvoicesTotalAmount <= 0.01
            ) {
              throw new AppError(
                `Le devis associé à ce bon de commande est déjà entièrement facturé (${existingInvoicesTotalAmount.toFixed(
                  2,
                )}€ sur ${quoteAmount.toFixed(2)}€)`,
                ERROR_CODES.RESOURCE_LOCKED,
                {
                  resource: "Devis",
                  quoteAmount,
                  existingInvoicesTotalAmount,
                },
              );
            }
          }
        }

        const organization = await getOrganizationInfo(workspaceId);

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const invoicePrefix = `F-${year}${month}`;

        const invoiceNumber = await generateInvoiceNumber(invoicePrefix, {
          isDraft: true,
          workspaceId,
          userId: user.id,
        });

        // Convertir les sous-documents Mongoose en objets simples pour une copie correcte
        const poObj = po.toObject();

        const invoice = new Invoice({
          number: invoiceNumber,
          prefix: invoicePrefix,
          client: poObj.client,
          companyInfo: undefined, // Draft - résolu dynamiquement via le field resolver
          items: poObj.items,
          status: "DRAFT",
          issueDate: new Date(),
          dueDate: new Date(new Date().setDate(new Date().getDate() + 30)),
          headerNotes:
            organization.invoiceHeaderNotes ||
            organization.documentHeaderNotes ||
            "",
          footerNotes:
            organization.invoiceFooterNotes ||
            organization.documentFooterNotes ||
            "",
          termsAndConditions:
            organization.invoiceTermsAndConditions ||
            organization.documentTermsAndConditions ||
            "",
          termsAndConditionsLinkTitle: "",
          termsAndConditionsLink: "",
          purchaseOrderNumber: `${po.prefix}-${po.number}`,
          // Tracer le devis d'origine pour que la garde anti-doublon de
          // convertQuoteToInvoice voie cette facture (chemin devis→BC→facture)
          sourceQuote: po.sourceQuoteId || undefined,
          discount: po.discount,
          discountType: po.discountType,
          customFields: poObj.customFields,
          totalHT: po.totalHT,
          totalVAT: po.totalVAT,
          totalTTC: po.totalTTC,
          finalTotalHT: po.finalTotalHT,
          finalTotalVAT: po.finalTotalVAT,
          finalTotalTTC: po.finalTotalTTC,
          discountAmount: po.discountAmount,
          workspaceId,
          createdBy: user.id,
          isReverseCharge: po.isReverseCharge || false,
          isVatExempt: po.isVatExempt || false,
          shipping: poObj.shipping,
          appearance: {
            textColor:
              organization.invoiceTextColor ||
              organization.documentTextColor ||
              "#000000",
            headerTextColor:
              organization.invoiceHeaderTextColor ||
              organization.documentHeaderTextColor ||
              "#ffffff",
            headerBgColor:
              organization.invoiceHeaderBgColor ||
              organization.documentHeaderBgColor ||
              "#5b50FF",
          },
          clientPositionRight: organization.invoiceClientPositionRight || false,
          showBankDetails: false, // Les coordonnées bancaires seront ajoutées lors de l'édition de la facture
          retenueGarantie: po.retenueGarantie || 0,
          escompte: po.escompte || 0,
        });

        await invoice.save();

        // Lier la facture au bon de commande
        if (!po.linkedInvoices) {
          po.linkedInvoices = [];
        }
        po.linkedInvoices.push(invoice._id);
        await po.save();

        // Synchroniser le devis source : sans cela, le devis paraît « vierge »
        // et pourrait être reconverti directement en facture → doublon.
        if (sourceQuote) {
          if (!sourceQuote.linkedInvoices) {
            sourceQuote.linkedInvoices = [];
          }
          sourceQuote.linkedInvoices.push(invoice._id);
          if (!sourceQuote.convertedToInvoice) {
            sourceQuote.convertedToInvoice = invoice._id;
          }
          await sourceQuote.save();
        }

        return await invoice.populate("createdBy");
      },
    ),

    sendPurchaseOrder: requireWrite("purchaseOrders")(
      async (_, { id, workspaceId: inputWorkspaceId, email }, context) => {
        const { user, workspaceId } = context;
        const po = await PurchaseOrder.findOne({ _id: id, workspaceId });

        if (!po) {
          throw createNotFoundError("Bon de commande");
        }

        // TODO: Implémenter l'envoi réel par email
        return true;
      },
    ),
  },
};

export default purchaseOrderResolvers;
