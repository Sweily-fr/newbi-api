import logger from "../utils/logger.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { loadWorkspaceClient } from "../utils/loadWorkspaceClient.js";
import mongoose from "mongoose";
import DeliveryNote from "../models/DeliveryNote.js";
import {
  archiveDocumentPdf,
  documentUrl,
} from "../utils/documentArchiveHelper.js";
import Quote from "../models/Quote.js";
import Invoice from "../models/Invoice.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import Client from "../models/Client.js";
import {
  requireWrite,
  requireRead,
  requireDelete,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import {
  generateDeliveryNoteNumber,
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
import { refreshDraftDates } from "../utils/draftDates.js";
import { DELIVERY_NOTE_STATUS } from "../models/constants/enums.js";

const FINALIZED_DN_STATUSES = ["PENDING", "SHIPPED", "DELIVERED", "CANCELED"];

// Un BL n'a pas de réglage d'organisation dédié (pas de « séquence continue »
// comme les BC) : la numérotation est toujours par préfixe.
const DN_AUTO_NUMBERING = false;

const buildDefaultPrefix = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `BL-${year}${month}`;
};

/**
 * Libère un numéro définitif occupé par un brouillon (même mécanique que
 * createPurchaseOrder / createQuote : l'index unique couvre TOUS les statuts
 * alors que la numérotation ignore les brouillons).
 */
const renameConflictingDrafts = async (
  { prefix, number, workspaceId, excludeId = null },
  options = {},
) => {
  const query = { prefix, number, status: "DRAFT", workspaceId };
  if (excludeId) query._id = { $ne: excludeId };

  const conflictingDrafts = await DeliveryNote.find(
    query,
    { _id: 1 },
    options,
  ).lean();
  if (conflictingDrafts.length === 0) return;

  const renameStamp = Date.now().toString().slice(-6);
  await DeliveryNote.bulkWrite(
    conflictingDrafts.map((draft, i) => ({
      updateOne: {
        filter: { _id: draft._id },
        update: { $set: { number: `${number}-${renameStamp}${i}` } },
      },
    })),
    options,
  );
};

/**
 * Snapshot client (même forme que les autres documents).
 */
const snapshotClient = (freshClient) => ({
  id: freshClient._id.toString(),
  type: freshClient.type,
  name: freshClient.name,
  firstName: freshClient.firstName,
  lastName: freshClient.lastName,
  email: freshClient.email,
  address: freshClient.address,
  hasDifferentShippingAddress: freshClient.hasDifferentShippingAddress,
  shippingAddress: freshClient.shippingAddress,
  isInternational: freshClient.isInternational,
  siret: freshClient.siret,
  vatNumber: freshClient.vatNumber,
});

/**
 * Adresse de livraison par défaut : adresse de livraison distincte du client
 * si renseignée, sinon son adresse principale.
 */
const defaultDeliveryAddress = (client) => {
  if (!client) return undefined;
  if (client.hasDifferentShippingAddress && client.shippingAddress?.street) {
    return {
      fullName: client.shippingAddress.fullName || "",
      street: client.shippingAddress.street || "",
      city: client.shippingAddress.city || "",
      postalCode: client.shippingAddress.postalCode || "",
      country: client.shippingAddress.country || "",
    };
  }
  if (client.address?.street) {
    return {
      fullName: client.name || "",
      street: client.address.street || "",
      city: client.address.city || "",
      postalCode: client.address.postalCode || "",
      country: client.address.country || "",
    };
  }
  return undefined;
};

/**
 * Nettoie l'adresse de livraison reçue en entrée (jamais de sous-document
 * vide : Mongoose refuserait l'adresse et l'API renverrait une erreur opaque).
 */
const cleanDeliveryAddress = (address) => {
  if (!address) return undefined;
  const cleaned = {
    fullName: address.fullName || "",
    street: address.street || "",
    city: address.city || "",
    postalCode: address.postalCode || "",
    country: address.country || "",
  };
  const hasContent = Object.values(cleaned).some((v) => v && v.trim());
  return hasContent ? cleaned : undefined;
};

/**
 * Convertit les lignes d'un devis / d'une facture en lignes de BL.
 * Les prix sont conservés (cachés) pour la facturation ultérieure.
 */
const itemsFromPricedDocument = (items = []) =>
  items.map((item) => ({
    description: item.description,
    details: item.details || "",
    quantity: item.quantity,
    orderedQuantity: item.quantity,
    deliveredQuantity: item.quantity,
    unit: item.unit || "",
    unitPrice: item.unitPrice,
    vatRate: item.vatRate,
    vatExemptionText: item.vatExemptionText,
    discount: item.discount,
    discountType: item.discountType,
  }));

/**
 * Convertit les lignes d'un BL en lignes de facture : prix cachés du BL,
 * sinon tarif du catalogue (productId), sinon 0 € à compléter dans l'éditeur.
 */
const itemsForInvoice = async (items = [], workspaceId) => {
  const productIds = items
    .map((i) => i.productId)
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
  const products =
    productIds.length > 0
      ? await Product.find({ _id: { $in: productIds }, workspaceId }).lean()
      : [];
  const productMap = new Map(products.map((p) => [p._id.toString(), p]));

  return items.map((item) => {
    const product = item.productId ? productMap.get(item.productId) : null;
    const unitPrice =
      item.unitPrice !== undefined && item.unitPrice !== null
        ? item.unitPrice
        : product?.unitPrice ?? 0;
    const vatRate =
      item.vatRate !== undefined && item.vatRate !== null
        ? item.vatRate
        : product?.vatRate ?? 20;
    const line = {
      description: item.description,
      details: item.details || "",
      quantity:
        item.deliveredQuantity !== undefined && item.deliveredQuantity !== null
          ? item.deliveredQuantity
          : item.quantity,
      unitPrice,
      vatRate,
      unit: item.unit || "",
      discount: item.discount || 0,
      discountType: item.discountType || "PERCENTAGE",
    };
    if (vatRate === 0) {
      line.vatExemptionText =
        item.vatExemptionText || "TVA non applicable, art. 293 B du CGI";
    }
    return line;
  });
};

const calculateInvoiceTotals = (items) => {
  let totalHT = 0;
  let totalVAT = 0;
  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;
    if (item.discount) {
      if (item.discountType === "PERCENTAGE") {
        itemHT = itemHT * (1 - Math.min(item.discount, 100) / 100);
      } else {
        itemHT = Math.max(0, itemHT - item.discount);
      }
    }
    totalHT += itemHT;
    totalVAT += itemHT * (item.vatRate / 100);
  });
  const round = (n) => parseFloat(n.toFixed(2));
  return {
    totalHT: round(totalHT),
    totalVAT: round(totalVAT),
    totalTTC: round(totalHT + totalVAT),
    finalTotalHT: round(totalHT),
    finalTotalVAT: round(totalVAT),
    finalTotalTTC: round(totalHT + totalVAT),
    discountAmount: 0,
  };
};

const deliveryNoteResolvers = {
  DeliveryNote: {
    companyInfo: async (dn) => {
      // Brouillon : résolution dynamique depuis l'organisation
      if (!dn.status || dn.status === "DRAFT") {
        try {
          const organization = await getOrganizationInfo(
            dn.workspaceId.toString(),
          );
          return mapOrganizationToCompanyInfo(organization);
        } catch (error) {
          logger.error(
            "[DeliveryNote.companyInfo] Erreur résolution dynamique:",
            error.message,
          );
          if (dn.companyInfo && dn.companyInfo.name) return dn.companyInfo;
          return {
            name: "",
            address: { street: "", city: "", postalCode: "", country: "France" },
          };
        }
      }
      // Finalisé : snapshot historique
      if (dn.companyInfo && dn.companyInfo.name) {
        return dn.companyInfo;
      }
      try {
        const organization = await getOrganizationInfo(
          dn.workspaceId.toString(),
        );
        return mapOrganizationToCompanyInfo(organization);
      } catch (error) {
        logger.error(
          "[DeliveryNote.companyInfo] Erreur résolution fallback:",
          error.message,
        );
        return {
          name: "",
          address: { street: "", city: "", postalCode: "", country: "France" },
        };
      }
    },
    client: async (dn, _args, context) => {
      if ((!dn.status || dn.status === "DRAFT") && dn.client?.id) {
        try {
          const freshClient = await loadWorkspaceClient(
            context,
            dn.client.id,
            dn.workspaceId,
          );
          if (freshClient) return snapshotClient(freshClient);
        } catch (error) {
          logger.error(
            "[DeliveryNote.client] Erreur résolution dynamique:",
            error.message,
          );
        }
      }
      return dn.client;
    },
    createdBy: async (dn) => {
      if (!dn.createdBy) return null;
      if (dn.createdBy._id) return dn.createdBy;
      return await User.findById(dn.createdBy);
    },
    sourceQuote: async (dn) => {
      if (!dn.sourceQuote) return null;
      return await Quote.findOne({
        _id: dn.sourceQuote,
        workspaceId: dn.workspaceId,
      });
    },
    sourceInvoice: async (dn) => {
      if (!dn.sourceInvoice) return null;
      return await Invoice.findOne({
        _id: dn.sourceInvoice,
        workspaceId: dn.workspaceId,
      });
    },
    linkedInvoices: async (dn) => {
      if (dn.linkedInvoices && dn.linkedInvoices.length > 0) {
        return await Invoice.find({
          _id: { $in: dn.linkedInvoices },
          workspaceId: dn.workspaceId,
        });
      }
      return [];
    },
  },

  Query: {
    // URL d'aperçu du BL archivé (R2) — null si brouillon / pas archivé
    deliveryNoteDocumentUrl: requireRead("deliveryNotes")(
      async (_, { workspaceId: inputWorkspaceId, deliveryNoteId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return documentUrl({
          Model: DeliveryNote,
          docType: "deliveryNote",
          draftStatus: "DRAFT",
          workspaceId,
          docId: deliveryNoteId,
        });
      },
    ),

    deliveryNote: requireRead("deliveryNotes")(
      async (_, { workspaceId: inputWorkspaceId, id }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const dn = await DeliveryNote.findOne({ _id: id, workspaceId }).populate(
          "createdBy",
        );
        if (!dn) throw createNotFoundError("Bon de livraison");
        return dn;
      },
    ),

    deliveryNotes: requireRead("deliveryNotes")(
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
          const searchRegex = new RegExp(escapeRegex(search), "i");
          query.$or = [
            { number: searchRegex },
            { "client.name": searchRegex },
            { "client.email": searchRegex },
            { trackingNumber: searchRegex },
            { carrier: searchRegex },
          ];
        }

        const skip = (page - 1) * limit;
        const totalCount = await DeliveryNote.countDocuments(query);

        const deliveryNotes = await DeliveryNote.find(query)
          .populate("createdBy")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit);

        return {
          deliveryNotes,
          totalCount,
          hasNextPage: totalCount > skip + limit,
        };
      },
    ),

    deliveryNoteStats: requireRead("deliveryNotes")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const [stats] = await DeliveryNote.aggregate([
          { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId) } },
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
              shippedCount: {
                $sum: { $cond: [{ $eq: ["$status", "SHIPPED"] }, 1, 0] },
              },
              deliveredCount: {
                $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, 1, 0] },
              },
              canceledCount: {
                $sum: { $cond: [{ $eq: ["$status", "CANCELED"] }, 1, 0] },
              },
            },
          },
          { $project: { _id: 0 } },
        ]);

        const defaultStats = {
          totalCount: 0,
          draftCount: 0,
          pendingCount: 0,
          shippedCount: 0,
          deliveredCount: 0,
          canceledCount: 0,
        };
        if (!stats) return defaultStats;
        Object.keys(defaultStats).forEach((key) => {
          if (stats[key] === null || stats[key] === undefined) stats[key] = 0;
        });
        return stats;
      },
    ),

    nextDeliveryNumber: requireRead("deliveryNotes")(
      async (
        _,
        { workspaceId: inputWorkspaceId, prefix, autoNumbering },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wsId = new mongoose.Types.ObjectId(workspaceId);
        // Seuls les documents finalisés réservent un numéro dans la séquence.
        const query = { workspaceId: wsId, status: { $ne: "DRAFT" } };
        if (!autoNumbering && prefix) query.prefix = prefix;

        const all = await DeliveryNote.find(query, { number: 1 }).lean();
        let maxNumber = 0;
        for (const d of all) {
          if (d.number && /^\d+$/.test(d.number)) {
            const num = parseInt(d.number, 10);
            if (num > maxNumber) maxNumber = num;
          }
        }
        return String(maxNumber + 1).padStart(4, "0");
      },
    ),

    checkDeliveryNumberExists: requireRead("deliveryNotes")(
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
        if (excludeId) query._id = { $ne: excludeId };
        const count = await DeliveryNote.countDocuments(query);
        return count > 0;
      },
    ),
  },

  Mutation: {
    // Archive le PDF du BL (généré côté frontend) sur R2
    archiveDeliveryNotePdf: requireWrite("deliveryNotes")(
      async (
        _,
        { workspaceId: inputWorkspaceId, deliveryNoteId, file },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return archiveDocumentPdf({
          Model: DeliveryNote,
          docType: "deliveryNote",
          draftStatus: "DRAFT",
          workspaceId,
          docId: deliveryNoteId,
          file,
        });
      },
    ),

    createDeliveryNote: requireCompanyInfo(
      requireWrite("deliveryNotes")(
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

          // Préfixe : celui fourni, sinon celui du dernier BL, sinon BL-YYYYMM
          let prefix = input.prefix;
          if (!prefix) {
            const lastDN = await DeliveryNote.findOne({ workspaceId })
              .sort({ createdAt: -1 })
              .select("prefix")
              .lean();
            prefix =
              lastDN && lastDN.prefix ? lastDN.prefix : buildDefaultPrefix();
          }

          const organization = await getOrganizationInfo(workspaceId);
          if (!organization?.companyName) {
            throw new AppError(
              "Les informations de votre entreprise doivent être configurées avant de créer un bon de livraison",
              ERROR_CODES.COMPANY_INFO_REQUIRED,
            );
          }

          const isDraft = !input.status || input.status === "DRAFT";
          if (
            !isDraft &&
            input.status !== "PENDING"
          ) {
            throw createValidationError(
              "Un bon de livraison se crée en brouillon ou « À expédier »",
              {
                status: `Le statut "${input.status}" n'est pas autorisé à la création.`,
              },
            );
          }

          // Numéro manuel : accepté seulement s'il respecte la séquence
          let allowManualNumber = false;
          if (input.number && !isDraft) {
            if (!/^\d{1,6}$/.test(input.number)) {
              throw new AppError(
                "Le numéro de bon de livraison doit contenir entre 1 et 6 chiffres",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
            const firstFinalized = await DeliveryNote.findOne({
              workspaceId,
              prefix,
              status: { $in: FINALIZED_DN_STATUSES },
            }).lean();
            if (firstFinalized) {
              const sequenceCheck = await validateNumberSequence(
                "deliveryNote",
                String(parseInt(input.number, 10)).padStart(4, "0"),
                prefix,
                { workspaceId, autoNumbering: DN_AUTO_NUMBERING },
              );
              if (!sequenceCheck.isValid) {
                throw new AppError(
                  sequenceCheck.message,
                  ERROR_CODES.VALIDATION_ERROR,
                );
              }
            }
            allowManualNumber = true;
          }

          const generateNumber = async () => {
            if (allowManualNumber) {
              return String(parseInt(input.number, 10)).padStart(4, "0");
            }
            return await generateDeliveryNoteNumber(prefix, {
              isDraft,
              workspaceId,
              userId: user.id,
              autoNumbering: DN_AUTO_NUMBERING,
            });
          };

          let number = await generateNumber();

          const clientData = { ...input.client };
          if (
            clientData.type === "INDIVIDUAL" &&
            (!clientData.name || clientData.name.trim() === "")
          ) {
            clientData.name =
              clientData.firstName && clientData.lastName
                ? `${clientData.firstName} ${clientData.lastName}`
                : clientData.email
                  ? `Client ${clientData.email}`
                  : "Client Particulier";
          }

          // Liens source : vérifiés dans le workspace (jamais de fuite)
          let sourceQuote;
          if (input.sourceQuoteId) {
            const q = await Quote.findOne({
              _id: input.sourceQuoteId,
              workspaceId,
            }).select("_id");
            if (!q) throw createNotFoundError("Devis source");
            sourceQuote = q._id;
          }
          let sourceInvoice;
          if (input.sourceInvoiceId) {
            const inv = await Invoice.findOne({
              _id: input.sourceInvoiceId,
              workspaceId,
            }).select("_id");
            if (!inv) throw createNotFoundError("Facture source");
            sourceInvoice = inv._id;
          }

          const rest = { ...input };
          delete rest.sourceQuoteId;
          delete rest.sourceInvoiceId;
          // companyInfo n'est jamais fourni par le client : snapshot serveur
          delete rest.companyInfo;

          const DN_MAX_SAVE_RETRIES = 5;
          let deliveryNote;
          for (let attempt = 1; attempt <= DN_MAX_SAVE_RETRIES; attempt++) {
            if (!isDraft) {
              await renameConflictingDrafts({ prefix, number, workspaceId });
            }

            deliveryNote = new DeliveryNote({
              ...rest,
              number,
              prefix,
              workspaceId,
              status: isDraft ? "DRAFT" : "PENDING",
              companyInfo: isDraft
                ? undefined
                : mapOrganizationToCompanyInfo(organization),
              client: {
                ...clientData,
                shippingAddress: clientData.hasDifferentShippingAddress
                  ? {
                      fullName: clientData.shippingAddress?.fullName || "",
                      street: clientData.shippingAddress?.street || "",
                      city: clientData.shippingAddress?.city || "",
                      postalCode: clientData.shippingAddress?.postalCode || "",
                      country: clientData.shippingAddress?.country || "",
                    }
                  : undefined,
              },
              deliveryAddress:
                cleanDeliveryAddress(input.deliveryAddress) ||
                defaultDeliveryAddress(clientData),
              appearance: input.appearance || {
                textColor: "#000000",
                headerTextColor: "#ffffff",
                headerBgColor: "#1d1d1b",
              },
              sourceQuote,
              sourceInvoice,
              createdBy: user.id,
            });

            try {
              await deliveryNote.save();
              break;
            } catch (err) {
              const isDup = err && (err.code === 11000 || err.code === 11001);
              if (!isDup) throw err;
              if (allowManualNumber) {
                throw new AppError(
                  `Le numéro de bon de livraison "${number}" est déjà utilisé`,
                  ERROR_CODES.DUPLICATE_DOCUMENT_NUMBER,
                );
              }
              if (attempt === DN_MAX_SAVE_RETRIES) {
                logger.error(
                  "[createDeliveryNote] Échec après retries E11000:",
                  err.keyValue,
                );
                throw new AppError(
                  "Impossible de générer un numéro de bon de livraison unique. Veuillez réessayer.",
                  ERROR_CODES.INTERNAL_ERROR,
                );
              }
              logger.warn(
                `[createDeliveryNote] Conflit E11000 tentative ${attempt}/${DN_MAX_SAVE_RETRIES}, retry:`,
                err.keyValue,
              );
              number = await generateDeliveryNoteNumber(prefix, {
                isDraft,
                workspaceId,
                userId: user.id,
                autoNumbering: DN_AUTO_NUMBERING,
              });
            }
          }

          return await deliveryNote.populate("createdBy");
        },
      ),
    ),

    updateDeliveryNote: requireCompanyInfo(
      requireWrite("deliveryNotes")(
        async (_, { id, workspaceId: inputWorkspaceId, input }, context) => {
          const { user, workspaceId } = context;
          const dn = await DeliveryNote.findOne({ _id: id, workspaceId });

          if (!dn) throw createNotFoundError("Bon de livraison");

          if (dn.status === "DELIVERED" || dn.status === "CANCELED") {
            throw createResourceLockedError(
              "Bon de livraison",
              dn.status === "DELIVERED"
                ? "un bon de livraison livré ne peut plus être modifié"
                : "un bon de livraison annulé ne peut plus être modifié",
            );
          }

          // updateDeliveryNote gère l'édition de contenu et la SEULE
          // transition DRAFT → PENDING (finalisation, numérotée plus bas).
          // Tout autre changement de statut passe par changeDeliveryNoteStatus.
          if (
            input.status &&
            input.status !== dn.status &&
            !(dn.status === "DRAFT" && input.status === "PENDING")
          ) {
            throw createValidationError(
              "Changement de statut non autorisé lors de la modification du bon de livraison",
              {
                status: `Pour passer un bon de livraison de "${dn.status}" à "${input.status}", utilisez l'action de changement de statut.`,
              },
            );
          }

          if (input.issueDate && dn.status !== "DRAFT" && dn.issueDate) {
            const oldYear = new Date(dn.issueDate).getFullYear();
            const newYear = new Date(input.issueDate).getFullYear();
            if (oldYear !== newYear) {
              throw new AppError(
                `Impossible de changer l'année d'émission d'un bon de livraison finalisé (${oldYear} → ${newYear}). Cela casserait la séquence de numérotation.`,
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
          }

          // Préfixe et numéro verrouillés une fois finalisé
          if (dn.status !== "DRAFT") {
            if (input.number !== undefined && input.number !== dn.number) {
              throw createValidationError(
                "Le numéro d'un bon de livraison finalisé est verrouillé",
                {
                  number: `Impossible de remplacer le numéro "${dn.number}" par "${input.number}" sur un bon de livraison ${dn.status}.`,
                },
              );
            }
            if (input.prefix !== undefined && input.prefix !== dn.prefix) {
              throw createValidationError(
                "Le préfixe d'un bon de livraison finalisé est verrouillé",
                {
                  prefix: `Impossible de remplacer le préfixe "${dn.prefix}" par "${input.prefix}" sur un bon de livraison ${dn.status}.`,
                },
              );
            }
          }

          let updateData = { ...input };
          // companyInfo n'est jamais fourni par le client : snapshot serveur
          delete updateData.companyInfo;

          if (input.deliveryAddress !== undefined) {
            updateData.deliveryAddress = cleanDeliveryAddress(
              input.deliveryAddress,
            );
          }

          const isFinalizing =
            dn.status === "DRAFT" && updateData.status === "PENDING";

          // Un brouillon qui reste brouillon garde son numéro provisoire
          if (dn.status === "DRAFT" && !isFinalizing) {
            delete updateData.number;
          }

          if (isFinalizing) {
            if (!dn.companyInfo || !dn.companyInfo.name) {
              const org = await getOrganizationInfo(workspaceId);
              updateData.companyInfo = mapOrganizationToCompanyInfo(org);
            }

            if (!input.number || !input.prefix) {
              let prefix = input.prefix || dn.prefix;
              if (!prefix) prefix = buildDefaultPrefix(dn.issueDate || new Date());

              updateData.number = await generateDeliveryNoteNumber(prefix, {
                workspaceId: dn.workspaceId,
                userId: user.id,
                autoNumbering: DN_AUTO_NUMBERING,
              });
              updateData.prefix = prefix;

              await renameConflictingDrafts({
                prefix,
                number: updateData.number,
                workspaceId: dn.workspaceId,
                excludeId: dn._id,
              });
            } else {
              if (!/^\d{1,6}$/.test(input.number)) {
                throw new AppError(
                  "Le numéro de bon de livraison doit contenir entre 1 et 6 chiffres",
                  ERROR_CODES.VALIDATION_ERROR,
                );
              }
              const normalizedNumber = String(
                parseInt(input.number, 10),
              ).padStart(4, "0");

              const sequenceCheck = await validateNumberSequence(
                "deliveryNote",
                normalizedNumber,
                input.prefix,
                { workspaceId: dn.workspaceId, autoNumbering: DN_AUTO_NUMBERING },
              );
              if (!sequenceCheck.isValid) {
                throw new AppError(
                  sequenceCheck.message,
                  ERROR_CODES.VALIDATION_ERROR,
                );
              }

              await renameConflictingDrafts({
                prefix: input.prefix,
                number: normalizedNumber,
                workspaceId: dn.workspaceId,
                excludeId: dn._id,
              });

              updateData.number = normalizedNumber;
            }
          }

          // Brouillon sans client fourni : rafraîchir depuis la fiche client
          if (
            (!dn.status || dn.status === "DRAFT") &&
            !updateData.client &&
            dn.client?.id
          ) {
            try {
              const freshClient = await Client.findOne({
                _id: dn.client.id,
                workspaceId: dn.workspaceId,
              });
              if (freshClient) updateData.client = snapshotClient(freshClient);
            } catch (error) {
              logger.error(
                "[updateDeliveryNote] Erreur rafraîchissement client:",
                error.message,
              );
            }
          }

          const statusBeforeUpdate = dn.status;
          Object.assign(dn, updateData);

          // BL finalisé dont le contenu change : l'archive PDF ne reflète
          // plus le document, le client web la réécrit après (même logique
          // que updateQuote / updatePurchaseOrder).
          if (statusBeforeUpdate !== "DRAFT" && dn.archivedPdfKey) {
            dn.archivedPdfKey = undefined;
            dn.archivedPdfStoredAt = undefined;
            dn.archivedPdfSource = undefined;
          }

          await dn.save();
          return await dn.populate("createdBy");
        },
      ),
    ),

    deleteDeliveryNote: requireCompanyInfo(
      requireDelete("deliveryNotes")(
        async (_, { id, workspaceId: inputWorkspaceId }, context) => {
          const { workspaceId } = context;
          const dn = await DeliveryNote.findOne({ _id: id, workspaceId });

          if (!dn) throw createNotFoundError("Bon de livraison");

          if (dn.status === "DELIVERED") {
            throw createResourceLockedError(
              "Bon de livraison",
              "un bon de livraison livré ne peut pas être supprimé",
            );
          }

          if (dn.linkedInvoices && dn.linkedInvoices.length > 0) {
            throw createResourceLockedError(
              "Bon de livraison",
              "un bon de livraison avec des factures liées ne peut pas être supprimé",
            );
          }

          await DeliveryNote.deleteOne({ _id: id, workspaceId });
          return true;
        },
      ),
    ),

    changeDeliveryNoteStatus: requireCompanyInfo(
      requireWrite("deliveryNotes")(
        async (_, { id, workspaceId: inputWorkspaceId, status }, context) => {
          const { user, workspaceId } = context;
          const dn = await DeliveryNote.findOne({ _id: id, workspaceId });

          if (!dn) throw createNotFoundError("Bon de livraison");

          const allowedTransitions = {
            DRAFT: ["PENDING", "CANCELED"],
            PENDING: ["SHIPPED", "DELIVERED", "DRAFT", "CANCELED"],
            SHIPPED: ["DELIVERED", "CANCELED"],
            DELIVERED: [],
            CANCELED: [],
          };

          if (!allowedTransitions[dn.status]?.includes(status)) {
            throw createStatusTransitionError(
              "Bon de livraison",
              dn.status,
              status,
            );
          }

          if (
            status === "CANCELED" &&
            dn.linkedInvoices &&
            dn.linkedInvoices.length > 0
          ) {
            throw createResourceLockedError(
              "Bon de livraison",
              "un bon de livraison avec des factures liées ne peut pas être annulé",
            );
          }

          // DRAFT → PENDING : snapshot + numéro séquentiel (transaction)
          if (dn.status === "DRAFT" && status === "PENDING") {
            const refreshedDates = refreshDraftDates(
              dn.issueDate,
              dn.deliveryDate,
            );
            if (refreshedDates.changed) {
              dn.issueDate = refreshedDates.issueDate;
              dn.deliveryDate = refreshedDates.secondDate;
            }

            if (!dn.companyInfo || !dn.companyInfo.name) {
              const org = await getOrganizationInfo(workspaceId);
              dn.companyInfo = mapOrganizationToCompanyInfo(org);
            }

            if (!dn.client?.id) {
              const clientId = dn.client?.id || dn.clientId;
              if (clientId) {
                try {
                  const freshClient = await Client.findOne({
                    _id: clientId,
                    workspaceId: dn.workspaceId,
                  });
                  if (freshClient) dn.client = snapshotClient(freshClient);
                } catch (error) {
                  logger.error(
                    "[changeDeliveryNoteStatus] Erreur snapshot client:",
                    error.message,
                  );
                }
              }
            }

            const MAX_RETRIES = 3;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
              const session = await mongoose.startSession();
              try {
                await session.withTransaction(async () => {
                  let prefix = dn.prefix;
                  if (!prefix) {
                    prefix = buildDefaultPrefix(dn.issueDate || new Date());
                  }

                  const newNumber = await generateDeliveryNoteNumber(prefix, {
                    workspaceId: dn.workspaceId,
                    userId: user.id,
                    session,
                    autoNumbering: DN_AUTO_NUMBERING,
                  });

                  await renameConflictingDrafts(
                    {
                      prefix,
                      number: newNumber,
                      workspaceId: dn.workspaceId,
                      excludeId: dn._id,
                    },
                    { session },
                  );

                  dn.number = `TEMP-${Date.now()}`;
                  await dn.save({ session });

                  dn.number = newNumber;
                  dn.prefix = prefix;
                  dn.status = status;
                  await dn.save({ session });
                });
                session.endSession();
                break;
              } catch (err) {
                session.endSession();
                if (err.code === 11000 && attempt < MAX_RETRIES - 1) {
                  logger.debug(
                    `⚠️ [changeDeliveryNoteStatus] E11000 retry attempt ${attempt + 1}`,
                  );
                  continue;
                }
                throw err;
              }
            }
          } else {
            if (status === "DELIVERED" && !dn.receivedAt) {
              dn.receivedAt = new Date();
            }
            dn.status = status;
            await dn.save();
          }

          return await dn.populate("createdBy");
        },
      ),
    ),

    recordDeliveryNoteReception: requireCompanyInfo(
      requireWrite("deliveryNotes")(
        async (_, { id, workspaceId: inputWorkspaceId, input }, context) => {
          const { workspaceId } = context;
          const dn = await DeliveryNote.findOne({ _id: id, workspaceId });

          if (!dn) throw createNotFoundError("Bon de livraison");

          if (!["PENDING", "SHIPPED", "DELIVERED"].includes(dn.status)) {
            throw createStatusTransitionError(
              "Bon de livraison",
              dn.status,
              "DELIVERED",
            );
          }

          if (input.receivedBy !== undefined) dn.receivedBy = input.receivedBy;
          if (input.signatureDataUrl !== undefined) {
            dn.signatureDataUrl = input.signatureDataUrl || undefined;
          }
          dn.receivedAt = input.receivedAt
            ? new Date(input.receivedAt)
            : dn.receivedAt || new Date();
          dn.status = "DELIVERED";

          // L'archive PDF ne contient pas la réception : elle sera réécrite
          // par le client web après cette mutation.
          if (dn.archivedPdfKey) {
            dn.archivedPdfKey = undefined;
            dn.archivedPdfStoredAt = undefined;
            dn.archivedPdfSource = undefined;
          }

          await dn.save();
          return await dn.populate("createdBy");
        },
      ),
    ),

    createDeliveryNoteFromQuote: requireWrite("deliveryNotes")(
      async (_, { quoteId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const quote = await Quote.findOne({ _id: quoteId, workspaceId });

        if (!quote) throw createNotFoundError("Devis");

        if (!["PENDING", "COMPLETED"].includes(quote.status)) {
          throw new AppError(
            "Seuls les devis en attente ou acceptés peuvent générer un bon de livraison",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }

        const organization = await getOrganizationInfo(workspaceId);
        const quoteObj = quote.toObject();

        // Le BL issu d'un devis est créé en brouillon : l'utilisateur
        // complète transporteur / adresse / quantités avant de l'émettre.
        const prefix = buildDefaultPrefix();
        const number = await generateDeliveryNoteNumber(prefix, {
          isDraft: true,
          workspaceId,
          userId: user.id,
        });

        const deliveryNote = new DeliveryNote({
          number,
          prefix,
          status: "DRAFT",
          issueDate: new Date(),
          client: quoteObj.client,
          items: itemsFromPricedDocument(quoteObj.items),
          deliveryAddress: defaultDeliveryAddress(quoteObj.client),
          headerNotes: organization?.documentHeaderNotes || "",
          footerNotes: organization?.documentFooterNotes || "",
          customFields: quoteObj.customFields,
          workspaceId,
          createdBy: user.id,
          sourceQuote: quote._id,
          appearance: {
            textColor: organization?.documentTextColor || "#000000",
            headerTextColor: organization?.documentHeaderTextColor || "#ffffff",
            headerBgColor: organization?.documentHeaderBgColor || "#5b50FF",
          },
          clientPositionRight: organization?.documentClientPositionRight || false,
        });

        await deliveryNote.save();
        return await deliveryNote.populate("createdBy");
      },
    ),

    createDeliveryNoteFromInvoice: requireWrite("deliveryNotes")(
      async (_, { invoiceId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const invoice = await Invoice.findOne({ _id: invoiceId, workspaceId });

        if (!invoice) throw createNotFoundError("Facture");

        if (invoice.status === "CANCELED") {
          throw new AppError(
            "Une facture annulée ne peut pas générer de bon de livraison",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }

        const organization = await getOrganizationInfo(workspaceId);
        const invoiceObj = invoice.toObject();

        const prefix = buildDefaultPrefix();
        const number = await generateDeliveryNoteNumber(prefix, {
          isDraft: true,
          workspaceId,
          userId: user.id,
        });

        const deliveryNote = new DeliveryNote({
          number,
          prefix,
          status: "DRAFT",
          issueDate: new Date(),
          client: invoiceObj.client,
          items: itemsFromPricedDocument(invoiceObj.items),
          deliveryAddress: defaultDeliveryAddress(invoiceObj.client),
          headerNotes: organization?.documentHeaderNotes || "",
          footerNotes: organization?.documentFooterNotes || "",
          customFields: invoiceObj.customFields,
          workspaceId,
          createdBy: user.id,
          sourceInvoice: invoice._id,
          sourceQuote: invoice.sourceQuote || undefined,
          appearance: {
            textColor: organization?.documentTextColor || "#000000",
            headerTextColor: organization?.documentHeaderTextColor || "#ffffff",
            headerBgColor: organization?.documentHeaderBgColor || "#5b50FF",
          },
          clientPositionRight: organization?.documentClientPositionRight || false,
        });

        await deliveryNote.save();
        return await deliveryNote.populate("createdBy");
      },
    ),

    createInvoiceFromDeliveryNote: requireWrite("invoices")(
      async (_, { deliveryNoteId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const dn = await DeliveryNote.findOne({ _id: deliveryNoteId, workspaceId });

        if (!dn) throw createNotFoundError("Bon de livraison");

        if (!["PENDING", "SHIPPED", "DELIVERED"].includes(dn.status)) {
          throw new AppError(
            "Seuls les bons de livraison émis (à expédier, expédiés ou livrés) peuvent être facturés",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }

        if (dn.sourceInvoice) {
          throw new AppError(
            "Ce bon de livraison a été généré depuis une facture : elle existe déjà",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }

        if (dn.linkedInvoices && dn.linkedInvoices.length > 0) {
          const existing = await Invoice.countDocuments({
            _id: { $in: dn.linkedInvoices },
            workspaceId,
          });
          if (existing > 0) {
            throw new AppError(
              "Une facture a déjà été générée depuis ce bon de livraison",
              ERROR_CODES.RESOURCE_LOCKED,
            );
          }
        }

        const organization = await getOrganizationInfo(workspaceId);

        const now = new Date();
        const invoicePrefix = `F-${now.getFullYear()}${String(
          now.getMonth() + 1,
        ).padStart(2, "0")}`;
        const invoiceNumber = await generateInvoiceNumber(invoicePrefix, {
          isDraft: true,
          workspaceId,
          userId: user.id,
        });

        const dnObj = dn.toObject();
        const items = await itemsForInvoice(dnObj.items, workspaceId);
        const totals = calculateInvoiceTotals(items);

        const invoice = new Invoice({
          number: invoiceNumber,
          prefix: invoicePrefix,
          client: dnObj.client,
          companyInfo: undefined, // Draft : résolu dynamiquement
          items,
          status: "DRAFT",
          issueDate: new Date(),
          dueDate: new Date(new Date().setDate(new Date().getDate() + 30)),
          headerNotes:
            organization?.invoiceHeaderNotes ||
            organization?.documentHeaderNotes ||
            "",
          footerNotes:
            organization?.invoiceFooterNotes ||
            organization?.documentFooterNotes ||
            "",
          termsAndConditions:
            organization?.invoiceTermsAndConditions ||
            organization?.documentTermsAndConditions ||
            "",
          termsAndConditionsLinkTitle: "",
          termsAndConditionsLink: "",
          // Référence du BL sur la facture (même champ que pour les BC)
          purchaseOrderNumber: `${dn.prefix}-${dn.number}`,
          sourceQuote: dn.sourceQuote || undefined,
          discount: 0,
          discountType: "PERCENTAGE",
          customFields: dnObj.customFields,
          ...totals,
          workspaceId,
          createdBy: user.id,
          appearance: {
            textColor:
              organization?.invoiceTextColor ||
              organization?.documentTextColor ||
              "#000000",
            headerTextColor:
              organization?.invoiceHeaderTextColor ||
              organization?.documentHeaderTextColor ||
              "#ffffff",
            headerBgColor:
              organization?.invoiceHeaderBgColor ||
              organization?.documentHeaderBgColor ||
              "#5b50FF",
          },
          clientPositionRight:
            organization?.invoiceClientPositionRight || false,
          showBankDetails: false,
        });

        await invoice.save();

        if (!dn.linkedInvoices) dn.linkedInvoices = [];
        dn.linkedInvoices.push(invoice._id);
        await dn.save();

        // Synchroniser le devis source (anti-doublon de facturation)
        if (dn.sourceQuote) {
          const sourceQuote = await Quote.findOne({
            _id: dn.sourceQuote,
            workspaceId,
          });
          if (sourceQuote) {
            if (!sourceQuote.linkedInvoices) sourceQuote.linkedInvoices = [];
            sourceQuote.linkedInvoices.push(invoice._id);
            if (!sourceQuote.convertedToInvoice) {
              sourceQuote.convertedToInvoice = invoice._id;
            }
            await sourceQuote.save();
          }
        }

        return await invoice.populate("createdBy");
      },
    ),

    sendDeliveryNote: requireWrite("deliveryNotes")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { workspaceId } = context;
        const dn = await DeliveryNote.findOne({ _id: id, workspaceId });
        if (!dn) throw createNotFoundError("Bon de livraison");
        // L'envoi réel passe par sendDeliveryNoteEmail (documentEmail),
        // comme pour les autres documents.
        return true;
      },
    ),
  },
};

export { DELIVERY_NOTE_STATUS };
export default deliveryNoteResolvers;
