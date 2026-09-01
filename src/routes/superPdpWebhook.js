import express from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import superPdpService from "../services/superPdpService.js";
import {
  fetchSuperPdpPdfFile,
  invoiceIsAddressedToOrganization,
} from "../services/purchaseInvoiceReceptionService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Vérifier la signature du webhook SuperPDP
 * @param {string} payload - Corps de la requête (raw)
 * @param {string} signature - Signature fournie par SuperPDP
 * @param {string} secret - Secret webhook de l'organisation
 * @returns {boolean} - true si la signature est valide
 */
const verifyWebhookSignature = (payload, signature, secret) => {
  if (!signature || !secret) {
    return false;
  }

  try {
    // SuperPDP utilise probablement HMAC-SHA256
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload, "utf8")
      .digest("hex");

    // Comparaison sécurisée pour éviter les timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    logger.error(
      "Erreur lors de la vérification de la signature webhook:",
      error
    );
    return false;
  }
};

/**
 * Mapper le statut SuperPDP vers le statut Newbi
 * @param {string} superPdpStatus - Statut SuperPDP
 * @returns {string} - Statut Newbi (eInvoiceStatus)
 */
const mapStatusToNewbi = (superPdpStatus) => {
  const statusMap = {
    // Statuts de validation
    PENDING: "PENDING_VALIDATION",
    PENDING_VALIDATION: "PENDING_VALIDATION",
    VALIDATING: "PENDING_VALIDATION",
    VALIDATED: "VALIDATED",
    VALIDATION_ERROR: "ERROR",

    // Statuts d'envoi
    SENDING: "SENT_TO_RECIPIENT",
    SENT: "SENT_TO_RECIPIENT",
    SENT_TO_RECIPIENT: "SENT_TO_RECIPIENT",

    // Statuts de réception
    DELIVERED: "RECEIVED",
    RECEIVED: "RECEIVED",

    // Statuts de traitement par le destinataire
    ACCEPTED: "ACCEPTED",
    APPROVED: "ACCEPTED",
    REJECTED: "REJECTED",
    REFUSED: "REJECTED",

    // Statut de paiement
    PAID: "PAID",

    // Erreurs
    ERROR: "ERROR",
    FAILED: "ERROR",
  };

  return statusMap[superPdpStatus?.toUpperCase()] || "PENDING_VALIDATION";
};

/**
 * POST /webhook/superpdp
 * Endpoint pour recevoir les notifications de SuperPDP
 *
 * SuperPDP envoie des webhooks pour notifier des changements de statut :
 * - Validation de la facture
 * - Envoi au destinataire
 * - Réception par le destinataire
 * - Acceptation/Rejet
 * - Paiement
 */
router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      logger.info("📥 Webhook SuperPDP reçu");

      // Récupérer le corps brut pour la vérification de signature
      const rawBody = req.body.toString("utf8");
      let payload;

      try {
        payload = JSON.parse(rawBody);
      } catch (parseError) {
        logger.error("Erreur parsing webhook SuperPDP:", parseError);
        return res.status(400).json({ error: "Invalid JSON payload" });
      }

      logger.debug(
        "Payload webhook SuperPDP:",
        JSON.stringify(payload, null, 2)
      );

      // Extraire les informations du webhook
      const {
        event, // Type d'événement (invoice.status_changed, invoice.validated, etc.)
        invoiceId, // ID de la facture chez SuperPDP
        status, // Nouveau statut
        previousStatus, // Ancien statut (optionnel)
        timestamp, // Date de l'événement
        metadata, // Métadonnées (contient newbiInvoiceId et workspaceId)
        error, // Détails de l'erreur (si applicable)
      } = payload;

      // Vérifier que les champs requis sont présents
      if (!invoiceId) {
        logger.warn("Webhook SuperPDP sans invoiceId");
        return res.status(400).json({ error: "Missing invoiceId" });
      }

      // ============================================================
      // Gestion des factures REÇUES (factures d'achat fournisseurs)
      // ============================================================
      if (
        event === "invoice.received" ||
        event === "invoice.incoming" ||
        event === "invoice.delivered_to_recipient"
      ) {
        logger.info(`📥 Nouvelle facture d'achat reçue via SuperPDP: ${invoiceId}`);

        try {
          // Déterminer le workspaceId depuis les métadonnées ou la signature
          const workspaceId = metadata?.workspaceId || metadata?.organizationId;

          if (!workspaceId) {
            logger.warn("Webhook facture reçue sans workspaceId dans metadata");
            return res.status(200).json({
              received: true,
              warning: "No workspaceId in metadata, cannot create purchase invoice",
            });
          }

          // Vérifier si la facture d'achat existe déjà
          const existingPurchase = await PurchaseInvoice.findOne({
            superPdpInvoiceId: invoiceId,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          });

          if (existingPurchase) {
            logger.info(`Facture d'achat ${invoiceId} déjà importée, mise à jour du statut`);
            existingPurchase.eInvoiceStatus = superPdpService.mapStatusToNewbi(status) || "RECEIVED";
            await existingPurchase.save();
            return res.status(200).json({
              received: true,
              action: "updated",
              purchaseInvoiceId: existingPurchase._id.toString(),
            });
          }

          // Récupérer le détail complet de la facture (EN16931).
          // Pas de fallback sur le payload webhook : il ne contient ni
          // fournisseur ni montants, on créerait une facture vide. Le cron de
          // réception réimportera la facture au prochain tick.
          let invoiceDetail;
          try {
            invoiceDetail = await superPdpService.getReceivedInvoiceDetail(
              workspaceId,
              invoiceId
            );
          } catch (detailError) {
            logger.warn(
              `Impossible de récupérer le détail EN16931 pour ${invoiceId}, import différé au cron de réception: ${detailError.message}`
            );
            return res.status(200).json({
              received: true,
              warning: "EN16931 detail unavailable, deferred to reception cron",
            });
          }

          if (!superPdpService.hasReceivedInvoiceData(invoiceDetail)) {
            logger.warn(
              `Détail EN16931 vide pour ${invoiceId}, import différé au cron de réception`
            );
            return res.status(200).json({
              received: true,
              warning: "EN16931 detail empty, deferred to reception cron",
            });
          }

          // Ne pas importer les factures adressées à un autre destinataire
          // (compte SuperPDP partagé entre plusieurs workspaces)
          const organization =
            await EInvoicingSettingsService.getOrganizationById(workspaceId);
          if (!invoiceIsAddressedToOrganization(invoiceDetail, organization)) {
            logger.info(
              `Facture SuperPDP ${invoiceId} ignorée : destinataire différent de l'organisation ${workspaceId}`
            );
            return res.status(200).json({
              received: true,
              warning: "Invoice not addressed to this workspace",
            });
          }

          // Trouver un utilisateur admin pour le createdBy
          const User = mongoose.model("User");
          const adminUser = await User.findOne({
            "organizations.organizationId": new mongoose.Types.ObjectId(workspaceId),
          });

          if (!adminUser) {
            logger.error(`Aucun utilisateur trouvé pour le workspace ${workspaceId}`);
            return res.status(200).json({
              received: true,
              warning: "No user found for workspace",
            });
          }

          // Transformer et créer la facture d'achat
          const purchaseInvoiceData = superPdpService.transformReceivedInvoiceToPurchaseInvoice(
            invoiceDetail,
            workspaceId,
            adminUser._id
          );
          // Le détail peut être un EN16931 nu sans champ id : forcer l'ID du
          // webhook pour préserver l'idempotence par superPdpInvoiceId.
          purchaseInvoiceData.superPdpInvoiceId = String(invoiceId);

          // Rattacher le PDF de la facture (best-effort)
          const pdfFile = await fetchSuperPdpPdfFile(
            workspaceId,
            String(adminUser._id),
            invoiceId,
            purchaseInvoiceData.invoiceNumber
          );
          if (pdfFile) {
            purchaseInvoiceData.files = [pdfFile];
          }

          // Auto-créer ou trouver le fournisseur
          let supplier = await Supplier.findOne({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            name: { $regex: new RegExp(`^${purchaseInvoiceData.supplierName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
          });

          if (!supplier) {
            supplier = await Supplier.create({
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              name: purchaseInvoiceData.supplierName,
              siret: purchaseInvoiceData.ocrMetadata?.supplierSiret || undefined,
              vatNumber: purchaseInvoiceData.ocrMetadata?.supplierVatNumber || undefined,
              defaultCategory: purchaseInvoiceData.category,
            });
          }

          purchaseInvoiceData.supplierId = supplier._id;

          const newPurchaseInvoice = await PurchaseInvoice.create(purchaseInvoiceData);

          logger.info(
            `✅ Facture d'achat créée depuis webhook SuperPDP: ${newPurchaseInvoice._id} (${purchaseInvoiceData.supplierName})`
          );

          return res.status(200).json({
            received: true,
            action: "created",
            purchaseInvoiceId: newPurchaseInvoice._id.toString(),
          });
        } catch (purchaseError) {
          logger.error("❌ Erreur création facture d'achat depuis webhook:", purchaseError);
          return res.status(200).json({
            received: true,
            warning: `Error creating purchase invoice: ${purchaseError.message}`,
          });
        }
      }

      // ============================================================
      // Gestion des factures ÉMISES (changement de statut)
      // ============================================================

      // Vérifier aussi si c'est un changement de statut sur une facture d'achat
      const purchaseInvoice = await PurchaseInvoice.findOne({ superPdpInvoiceId: invoiceId });
      if (purchaseInvoice) {
        const newPurchaseStatus = superPdpService.mapStatusToNewbi(status);
        logger.info(
          `📊 Mise à jour statut facture d'achat ${purchaseInvoice._id}: ${purchaseInvoice.eInvoiceStatus} → ${newPurchaseStatus}`
        );
        purchaseInvoice.eInvoiceStatus = newPurchaseStatus;
        if (newPurchaseStatus === "PAID") {
          purchaseInvoice.status = "PAID";
          purchaseInvoice.paymentDate = new Date();
        }
        await purchaseInvoice.save();
        return res.status(200).json({
          received: true,
          type: "purchase_invoice",
          purchaseInvoiceId: purchaseInvoice._id.toString(),
          newStatus: newPurchaseStatus,
        });
      }

      // Trouver la facture Newbi (émise) correspondante
      let invoice = await Invoice.findOne({ superPdpInvoiceId: invoiceId });

      // Si pas trouvée par superPdpInvoiceId, essayer avec les métadonnées
      if (!invoice && metadata?.newbiInvoiceId) {
        invoice = await Invoice.findById(metadata.newbiInvoiceId);
      }

      if (!invoice) {
        logger.warn(`Facture non trouvée pour SuperPDP ID: ${invoiceId}`);
        // Retourner 200 pour éviter les retries de SuperPDP
        return res.status(200).json({
          received: true,
          warning: "Invoice not found in Newbi",
        });
      }

      // Vérifier la signature du webhook (si configurée)
      const signature =
        req.headers["x-superpdp-signature"] ||
        req.headers["x-webhook-signature"];

      if (signature) {
        const credentials =
          await EInvoicingSettingsService.getSuperPdpCredentials(
            invoice.workspaceId.toString()
          );

        if (credentials?.webhookSecret) {
          const isValid = verifyWebhookSignature(
            rawBody,
            signature,
            credentials.webhookSecret
          );

          if (!isValid) {
            logger.warn("Signature webhook SuperPDP invalide");
            return res.status(401).json({ error: "Invalid signature" });
          }
        }
      }

      // Mapper le statut SuperPDP vers Newbi
      const newStatus = mapStatusToNewbi(status);
      const oldStatus = invoice.eInvoiceStatus;

      logger.info(
        `📊 Mise à jour statut facture ${invoice.prefix}${invoice.number}: ${oldStatus} → ${newStatus}`
      );

      // Mettre à jour la facture
      const updateData = {
        eInvoiceStatus: newStatus,
      };

      // Si c'est une erreur, enregistrer les détails
      if (newStatus === "ERROR" && error) {
        updateData.eInvoiceError =
          typeof error === "string" ? error : JSON.stringify(error);
      }

      // Si le superPdpInvoiceId n'était pas encore défini
      if (!invoice.superPdpInvoiceId) {
        updateData.superPdpInvoiceId = invoiceId;
      }

      // Mettre à jour la facture
      await Invoice.findByIdAndUpdate(invoice._id, { $set: updateData });

      logger.info(
        `✅ Facture ${invoice.prefix}${invoice.number} mise à jour avec statut: ${newStatus}`
      );

      // Répondre à SuperPDP
      res.status(200).json({
        received: true,
        invoiceId: invoice._id.toString(),
        newStatus: newStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("❌ Erreur traitement webhook SuperPDP:", error);

      // Retourner 500 pour que SuperPDP réessaie
      res.status(500).json({
        error: "Internal server error",
        message: error.message,
      });
    }
  }
);

/**
 * GET /webhook/superpdp/health
 * Endpoint de santé pour vérifier que le webhook est accessible
 */
router.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "SuperPDP Webhook",
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /webhook/superpdp/test
 * Endpoint de test pour simuler un webhook (développement uniquement)
 */
router.post("/test", async (req, res) => {
  // Uniquement en développement
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Not available in production" });
  }

  try {
    const { invoiceId, status } = req.body;

    if (!invoiceId || !status) {
      return res.status(400).json({ error: "Missing invoiceId or status" });
    }

    // Trouver la facture
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Mettre à jour le statut
    const newStatus = mapStatusToNewbi(status);
    invoice.eInvoiceStatus = newStatus;
    await invoice.save();

    res.status(200).json({
      success: true,
      invoiceId: invoice._id.toString(),
      newStatus: newStatus,
    });
  } catch (error) {
    logger.error("Erreur test webhook:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
