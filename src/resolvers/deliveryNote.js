import logger from "../utils/logger.js";
import { getOrganizationDefaultAnnex } from "../utils/documentAnnex.js";
import { buildSearchRegExp } from "../utils/searchRegex.js";
import { loadWorkspaceClient } from "../utils/loadWorkspaceClient.js";
import {
  loadWorkspaceInvoice,
  loadWorkspaceInvoices,
  loadWorkspaceQuote,
} from "../utils/workspaceDocumentLoaders.js";
import { canViewLinkedPage } from "../utils/linkedDocumentAccess.js";
import {
  buildClientDocumentFields,
  buildDocumentFieldsForClientId,
  documentFieldsForEditedClient,
} from "../utils/clientDocumentFields.js";
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
  assertStatusChangeAllowed,
  STATUS_CHANGE_ACTIONS,
  requireWrite,
  requireRead,
  requireDelete,
  requireAction,
  requireAllActions,
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
import { keepHiddenItemPrices } from "../utils/deliveryNoteItemPrices.js";
import { computeDocumentTotals } from "../utils/documentTotals.js";

const FINALIZED_DN_STATUSES = ["PENDING", "SHIPPED", "DELIVERED", "CANCELED"];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Date de réception saisie : ni dans le futur, ni avant l'émission du bon.
 * La date vient d'un champ « jour » (minuit UTC) : un jour de marge de
 * chaque côté pour les fuseaux horaires. Renvoie le message d'erreur, ou null.
 */
const invalidReceptionDate = (value, issueDate) => {
  if (!value) return null;
  const receivedAt = new Date(value);
  if (Number.isNaN(receivedAt.getTime())) {
    return "La date de réception est invalide.";
  }
  if (receivedAt.getTime() > Date.now() + DAY_MS) {
    return "La date de réception ne peut pas être dans le futur.";
  }
  const issuedAt = issueDate ? new Date(issueDate) : null;
  if (issuedAt && !Number.isNaN(issuedAt.getTime())) {
    const issueDay = Date.UTC(
      issuedAt.getUTCFullYear(),
      issuedAt.getUTCMonth(),
      issuedAt.getUTCDate(),
    );
    if (receivedAt.getTime() < issueDay - DAY_MS) {
      return "La date de réception ne peut pas précéder l'émission du bon de livraison.";
    }
  }
  return null;
};

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
const snapshotClient = async (freshClient, context) => ({
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
  documentFields: await buildClientDocumentFields(freshClient, context),
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
    imageUrl: item.imageUrl || undefined,
    showImage: item.showImage ?? undefined,
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
        : (product?.unitPrice ?? 0);
    const vatRate =
      item.vatRate !== undefined && item.vatRate !== null
        ? item.vatRate
        : (product?.vatRate ?? 20);
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
      // Image de la ligne, sinon celle du catalogue avec son réglage par défaut
      imageUrl: item.imageUrl || product?.imageUrl || undefined,
      showImage: item.imageUrl
        ? (item.showImage ?? undefined)
        : product?.imageUrl && product.showImageOnDocuments === false
          ? false
          : undefined,
    };
    if (vatRate === 0) {
      line.vatExemptionText =
        item.vatExemptionText || "TVA non applicable, art. 293 B du CGI";
    }
    return line;
  });
};

/**
 * Totaux de la facture d'un BL, avec les règles communes des documents de
 * vente (utils/documentTotals.js) et les conditions du devis d'origine :
 * autoliquidation, remise globale et frais de port.
 */
const calculateInvoiceTotals = (items, terms = {}) => {
  const totals = computeDocumentTotals({
    items,
    discount: terms.discount || 0,
    discountType: terms.discountType || "PERCENTAGE",
    shipping: terms.shipping || null,
    isReverseCharge: Boolean(terms.isReverseCharge),
  });
  const round = (n) => parseFloat(n.toFixed(2));
  return {
    totalHT: round(totals.totalHT),
    totalVAT: round(totals.totalVAT),
    totalTTC: round(totals.totalTTC),
    finalTotalHT: round(totals.finalTotalHT),
    finalTotalVAT: round(totals.finalTotalVAT),
    finalTotalTTC: round(totals.finalTotalTTC),
    discountAmount: round(totals.discountAmount),
  };
};

const isCompleteAddress = (address) =>
  Boolean(
    address?.street?.trim() &&
      address?.city?.trim() &&
      address?.postalCode?.trim(),
  );

/**
 * Conditions du devis d'origine reprises sur la facture d'un BL : régime de
 * TVA (autoliquidation, exonération), remise globale et port facturé. Le
 * port facturé exige une adresse : celle du devis, sinon l'adresse de
 * livraison du bon, sinon celle du client.
 */
const quoteInvoiceTerms = (quote, fallbackAddresses = []) => {
  if (!quote) return { discount: 0, discountType: "PERCENTAGE" };
  const shippingAddress = [
    quote.shipping?.shippingAddress,
    ...fallbackAddresses,
  ].find(isCompleteAddress);
  const shipping = quote.shipping?.billShipping
    ? {
        billShipping: true,
        shippingAddress: shippingAddress
          ? {
              fullName: shippingAddress.fullName || "",
              street: shippingAddress.street,
              city: shippingAddress.city,
              postalCode: shippingAddress.postalCode,
              country: shippingAddress.country || "France",
            }
          : undefined,
        shippingAmountHT: quote.shipping.shippingAmountHT || 0,
        shippingVatRate: quote.shipping.shippingVatRate ?? 20,
      }
    : undefined;
  return {
    isReverseCharge: Boolean(quote.isReverseCharge),
    isVatExempt: Boolean(quote.isVatExempt),
    discount: quote.discount || 0,
    discountType: quote.discountType || "PERCENTAGE",
    ...(shipping ? { shipping } : {}),
  };
};

/** Filtre d'une liste de factures liées restée telle qu'elle a été lue. */
const unchangedLinkedInvoices = (linkedInvoices) =>
  linkedInvoices && linkedInvoices.length > 0
    ? { linkedInvoices: [...linkedInvoices] }
    : { "linkedInvoices.0": { $exists: false } };

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
            address: {
              street: "",
              city: "",
              postalCode: "",
              country: "France",
            },
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
          if (freshClient) return await snapshotClient(freshClient, context);
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
    // Documents liés via les DataLoaders de la requête (une requête pour toute
    // la liste au lieu d'une par bon de livraison).
    // Chacun suit « Voir » de sa page : le devis (et ses prix) et les
    // factures ne sont pas renvoyés à un rôle limité aux bons de livraison.
    sourceQuote: async (dn, _args, context) => {
      if (!dn.sourceQuote) return null;
      if (!(await canViewLinkedPage(context, dn.workspaceId, "quotes"))) {
        return null;
      }
      return loadWorkspaceQuote(context, dn.sourceQuote, dn.workspaceId);
    },
    sourceInvoice: async (dn, _args, context) => {
      if (!dn.sourceInvoice) return null;
      if (!(await canViewLinkedPage(context, dn.workspaceId, "invoices"))) {
        return null;
      }
      return loadWorkspaceInvoice(context, dn.sourceInvoice, dn.workspaceId);
    },
    linkedInvoices: async (dn, _args, context) => {
      if (!(await canViewLinkedPage(context, dn.workspaceId, "invoices"))) {
        return [];
      }
      if (dn.linkedInvoices && dn.linkedInvoices.length > 0) {
        return loadWorkspaceInvoices(
          context,
          dn.linkedInvoices,
          dn.workspaceId,
        );
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
        const dn = await DeliveryNote.findOne({
          _id: id,
          workspaceId,
        }).populate("createdBy");
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
          const searchRegex = buildSearchRegExp(search);
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
      requireAction("deliveryNotes", "create")(
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
          if (!isDraft && input.status !== "PENDING") {
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
                // Champs personnalisés figés dès la création d'un document non brouillon
                documentFields: isDraft
                  ? undefined
                  : await buildDocumentFieldsForClientId(
                      clientData.id,
                      workspaceId,
                      context,
                    ),
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

          // Lignes renvoyées sans prix (l'éditeur n'en a pas) : garder les
          // prix cachés repris du devis ou de la facture, sinon la facture
          // du bon sortait à 0 €
          if (Array.isArray(input.items)) {
            updateData.items = keepHiddenItemPrices(input.items, dn.items);
          }

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
              if (!prefix)
                prefix = buildDefaultPrefix(dn.issueDate || new Date());

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
                {
                  workspaceId: dn.workspaceId,
                  autoNumbering: DN_AUTO_NUMBERING,
                },
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
              if (freshClient)
                updateData.client = await snapshotClient(freshClient, context);
            } catch (error) {
              logger.error(
                "[updateDeliveryNote] Erreur rafraîchissement client:",
                error.message,
              );
            }
          }

          // BL non brouillon (ou finalisé par cette modification) dont
          // l'input renvoie le client : ClientInput ne porte pas les champs
          // personnalisés affichés sur le document. Les recalculer au lieu
          // de les effacer en remplaçant le client figé.
          const statusAfterUpdate = updateData.status || dn.status;
          if (
            statusAfterUpdate !== "DRAFT" &&
            updateData.client &&
            !Array.isArray(updateData.client.documentFields)
          ) {
            updateData.client = {
              ...updateData.client,
              documentFields: await documentFieldsForEditedClient(
                updateData.client,
                dn.client,
                dn.workspaceId,
                context,
              ),
            };
          }

          const statusBeforeUpdate = dn.status;
          Object.assign(dn, updateData);
          // Copie PDF des emails (cachedPdf) réutilisée telle quelle par les
          // envois sans PDF joint : elle date d'avant la modification.
          if (dn.cachedPdf?.key || dn.cachedPdf?.url) {
            dn.cachedPdf = undefined;
          }

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

          // Comme l'écran : seul un brouillon se supprime. Un bon émis porte
          // un numéro de la séquence et a pu partir chez le client.
          if (dn.status !== "DRAFT") {
            throw new AppError(
              "Seuls les brouillons peuvent être supprimés : ce bon de livraison est numéroté.",
              ERROR_CODES.RESOURCE_LOCKED,
              { resource: "deliveryNote", reason: "NUMBERED_DOCUMENT" },
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
      requireAction("deliveryNotes", STATUS_CHANGE_ACTIONS)(
        async (_, { id, workspaceId: inputWorkspaceId, status }, context) => {
          // Émettre le brouillon = créer ou modifier ; autres statuts =
          // « status »
          assertStatusChangeAllowed(context, "deliveryNotes", status, "PENDING");
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
                  if (freshClient)
                    dn.client = await snapshotClient(freshClient, context);
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
      requireAction("deliveryNotes", "status")(
        async (_, { id, workspaceId: inputWorkspaceId, input }, context) => {
          const { workspaceId } = context;
          const dn = await DeliveryNote.findOne({ _id: id, workspaceId });

          if (!dn) throw createNotFoundError("Bon de livraison");

          // Un bon livré garde la preuve de sa réception (réceptionnaire,
          // signature du client, date), comme l'écran qui ne la propose plus
          if (dn.status === "DELIVERED") {
            throw new AppError(
              "Ce bon de livraison est déjà livré : sa réception ne peut plus être modifiée.",
              ERROR_CODES.RESOURCE_LOCKED,
              { resource: "deliveryNote", reason: "ALREADY_DELIVERED" },
            );
          }

          if (!["PENDING", "SHIPPED"].includes(dn.status)) {
            throw createStatusTransitionError(
              "Bon de livraison",
              dn.status,
              "DELIVERED",
            );
          }

          const receptionDateError = invalidReceptionDate(
            input.receivedAt,
            dn.issueDate,
          );
          if (receptionDateError) {
            throw createValidationError(receptionDateError, {
              receivedAt: receptionDateError,
            });
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

    // Bon de livraison depuis un devis : « Transformer » sur les devis ET
    // « Créer » sur les bons de livraison (comme l'écran)
    createDeliveryNoteFromQuote: requireAllActions([
      ["quotes", "convert"],
      ["deliveryNotes", "create"],
    ])(
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
          clientPositionRight:
            organization?.documentClientPositionRight || false,
        });

        await deliveryNote.save();
        return await deliveryNote.populate("createdBy");
      },
    ),

    // Bon de livraison depuis une facture : « Créer » sur les bons de
    // livraison ET « Voir » sur les factures (il en recopie client et lignes)
    createDeliveryNoteFromInvoice: requireAllActions([
      ["deliveryNotes", "create"],
      ["invoices", "view"],
    ])(
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
          clientPositionRight:
            organization?.documentClientPositionRight || false,
        });

        await deliveryNote.save();
        return await deliveryNote.populate("createdBy");
      },
    ),

    // Facturer un bon de livraison : action « convert » de la page, et
    // « Créer » sur les factures (comme l'écran)
    createInvoiceFromDeliveryNote: requireAllActions([
      ["deliveryNotes", "convert"],
      ["invoices", "create"],
    ])(
      async (_, { deliveryNoteId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId } = context;
        const dn = await DeliveryNote.findOne({
          _id: deliveryNoteId,
          workspaceId,
        });

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

        // Devis d'origine : ses conditions (TVA, remise, port) passent sur la
        // facture, et il n'est jamais facturé au-delà de son montant, tous
        // chemins confondus (conversion directe, factures liées, autres BL).
        const sourceQuote = dn.sourceQuote
          ? await Quote.findOne({ _id: dn.sourceQuote, workspaceId })
          : null;
        const terms = quoteInvoiceTerms(sourceQuote, [
          dn.deliveryAddress,
          dn.client?.address,
        ]);

        const dnObj = dn.toObject();
        const items = await itemsForInvoice(dnObj.items, workspaceId);
        const totals = calculateInvoiceTotals(items, terms);

        if (sourceQuote) {
          const quoteAmount = sourceQuote.finalTotalTTC || 0;
          const alreadyInvoiced = sourceQuote.linkedInvoices?.length
            ? (
                await Invoice.find({
                  _id: { $in: sourceQuote.linkedInvoices },
                  workspaceId,
                }).select("finalTotalTTC")
              ).reduce((sum, inv) => sum + (inv.finalTotalTTC || 0), 0)
            : 0;
          const remaining =
            Math.round((quoteAmount - alreadyInvoiced) * 100) / 100;
          if (
            quoteAmount > 0 &&
            Math.round(totals.finalTotalTTC * 100) > Math.round(remaining * 100)
          ) {
            const euros = (n) => `${n.toFixed(2).replace(".", ",")} €`;
            throw new AppError(
              remaining <= 0
                ? `Le devis ${sourceQuote.prefix ? `${sourceQuote.prefix}-` : ""}${sourceQuote.number} est déjà entièrement facturé (${euros(alreadyInvoiced)} sur ${euros(quoteAmount)}).`
                : `Ce bon de livraison dépasse le reste à facturer du devis ${sourceQuote.prefix ? `${sourceQuote.prefix}-` : ""}${sourceQuote.number} (${euros(remaining)} sur ${euros(quoteAmount)}, ${euros(alreadyInvoiced)} déjà facturés).`,
              ERROR_CODES.RESOURCE_LOCKED,
              { resource: "Devis", quoteAmount, alreadyInvoiced, remaining },
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

        // Réservations atomiques avant de créer la facture : le BL (une seule
        // facture) puis le devis (factures liées telles que lues pour le reste
        // à facturer). Deux demandes simultanées : la seconde est refusée.
        const invoiceId = new mongoose.Types.ObjectId();
        const dnClaim = await DeliveryNote.updateOne(
          {
            _id: dn._id,
            workspaceId,
            ...unchangedLinkedInvoices(dn.linkedInvoices),
          },
          { $set: { linkedInvoices: [invoiceId] } },
        );
        if (dnClaim.modifiedCount !== 1) {
          throw new AppError(
            "Une facture a déjà été générée depuis ce bon de livraison",
            ERROR_CODES.RESOURCE_LOCKED,
          );
        }
        const releaseDeliveryNote = () =>
          DeliveryNote.updateOne(
            { _id: dn._id, workspaceId },
            { $pull: { linkedInvoices: invoiceId } },
          );

        let quoteClaimed = false;
        if (sourceQuote) {
          const update = { $push: { linkedInvoices: invoiceId } };
          // Un devis encore en attente reste acceptable ou refusable : il
          // n'est marqué « converti » qu'une fois accepté
          if (
            !sourceQuote.convertedToInvoice &&
            sourceQuote.status === "COMPLETED"
          ) {
            update.$set = { convertedToInvoice: invoiceId };
          }
          const quoteClaim = await Quote.updateOne(
            {
              _id: sourceQuote._id,
              workspaceId,
              ...unchangedLinkedInvoices(sourceQuote.linkedInvoices),
            },
            update,
          );
          if (quoteClaim.modifiedCount !== 1) {
            await releaseDeliveryNote();
            throw new AppError(
              "Le devis de ce bon de livraison vient d'être facturé par ailleurs : vérifiez son reste à facturer puis réessayez.",
              ERROR_CODES.RESOURCE_LOCKED,
            );
          }
          quoteClaimed = true;
        }

        const invoice = new Invoice({
          _id: invoiceId,
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
          annex: getOrganizationDefaultAnnex(organization, "invoice"),
          // Référence du BL sur la facture (même champ que pour les BC)
          purchaseOrderNumber: `${dn.prefix}-${dn.number}`,
          sourceQuote: dn.sourceQuote || undefined,
          customFields: dnObj.customFields,
          ...terms,
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

        try {
          await invoice.save();
        } catch (error) {
          await releaseDeliveryNote();
          if (quoteClaimed) {
            await Quote.updateOne(
              { _id: sourceQuote._id, workspaceId },
              {
                $pull: { linkedInvoices: invoiceId },
                ...(sourceQuote.convertedToInvoice
                  ? {}
                  : { $unset: { convertedToInvoice: "" } }),
              },
            );
          }
          throw error;
        }

        return await invoice.populate("createdBy");
      },
    ),

    sendDeliveryNote: requireAction("deliveryNotes", "send")(
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
