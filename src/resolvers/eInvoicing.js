import mongoose from "mongoose";
import { requireRead, requireWrite } from "../middlewares/rbac.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import superPdpService from "../services/superPdpService.js";
import eInvoiceRoutingService from "../services/eInvoiceRoutingService.js";
import cloudflareService from "../services/cloudflareService.js";
import Invoice from "../models/Invoice.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

const eInvoicingResolvers = {
  Query: {
    /**
     * URL d'affichage du PDF Factur-X d'une facture (preview).
     * Renvoie l'URL d'une route backend qui STREAME le document (depuis R2 ou
     * SuperPDP, côté serveur — pas d'URL signée ni de droit R2 côté navigateur).
     * - Brouillon → null (preview client live).
     * - Facture sans document archivé ni SuperPDP → null (preview client live).
     */
    invoiceDocumentUrl: requireRead("invoices")(
      async (_, { workspaceId, invoiceId }) => {
        const invoice = await Invoice.findOne({ _id: invoiceId, workspaceId });
        if (!invoice) {
          throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
        }

        // Brouillon ou aucun document disponible → preview client live
        if (invoice.status === "DRAFT") return null;
        if (!invoice.superPdpInvoiceId && !invoice.archivedPdfKey) return null;

        const base = (
          process.env.BACKEND_URL ||
          process.env.NEXT_PUBLIC_API_URL ||
          "http://localhost:4000"
        ).replace(/\/$/, "");

        return `${base}/invoices/${invoiceId}/document-pdf`;
      },
    ),

    /**
     * Statut de vérification KYC/KYB + entreprise SuperPDP connectée.
     * Tolérant aux erreurs : si non connecté / 403, renvoie connected=false.
     */
    eInvoicingVerification: requireRead("invoices")(
      async (_, { workspaceId }) => {
        try {
          const isEnabled =
            await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);
          if (!isEnabled) {
            return { connected: false };
          }

          const session = await superPdpService.getOAuthSession(workspaceId);

          // companies/me peut échouer si la vérification n'est pas encore "verified"
          let company = null;
          try {
            company = await superPdpService.getCurrentCompany(workspaceId);
          } catch (companyError) {
            logger.debug(
              `eInvoicingVerification: companies/me indisponible: ${companyError.message}`,
            );
          }

          return {
            connected: true,
            companyVerificationStatus: session.companyVerificationStatus,
            userIdentityVerificationStatus:
              session.userIdentityVerificationStatus,
            company: company
              ? {
                  formalName: company.formalName,
                  tradeName: company.tradeName,
                  number: company.number,
                  numberScheme: company.numberScheme,
                  vatRegime: company.vatRegime,
                  env: company.env,
                }
              : null,
          };
        } catch (error) {
          logger.warn(`eInvoicingVerification erreur: ${error.message}`);
          return { connected: false, error: error.message };
        }
      },
    ),

    /**
     * Entrées d'annuaire de l'entreprise (réception de factures).
     */
    eInvoicingDirectoryEntries: requireRead("invoices")(
      async (_, { workspaceId }) => {
        try {
          const isEnabled =
            await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);
          if (!isEnabled) return [];
          return await superPdpService.getDirectoryEntries(workspaceId);
        } catch (error) {
          logger.warn(`eInvoicingDirectoryEntries erreur: ${error.message}`);
          return [];
        }
      },
    ),

    /**
     * Historique des déclarations e-reporting transmises au PPF.
     */
    eInvoicingEReportings: requireRead("invoices")(
      async (_, { workspaceId }) => {
        try {
          const isEnabled =
            await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);
          if (!isEnabled) return [];
          const list = await superPdpService.getEReportings(workspaceId);
          return list.map((e) => ({
            id: e.id,
            kind: e.kind,
            startPeriod: e.start_period || null,
            endPeriod: e.end_period || null,
          }));
        } catch (error) {
          logger.warn(`eInvoicingEReportings erreur: ${error.message}`);
          return [];
        }
      },
    ),

    /**
     * Récupérer les paramètres e-invoicing d'une organisation
     */
    eInvoicingSettings: requireRead("invoices")(
      async (_, { workspaceId }, context) => {
        try {
          const settings =
            await EInvoicingSettingsService.getEInvoicingSettings(workspaceId);
          return settings;
        } catch (error) {
          logger.error("Erreur récupération paramètres e-invoicing:", error);
          throw new AppError(
            "Erreur lors de la récupération des paramètres e-invoicing",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Récupérer les statistiques e-invoicing d'une organisation
     */
    eInvoicingStats: requireRead("invoices")(
      async (_, { workspaceId }, context) => {
        try {
          // Compter les factures par statut e-invoicing
          const stats = await Invoice.aggregate([
            // L'agrégation ne caste pas automatiquement la String en ObjectId
            {
              $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId) },
            },
            {
              $group: {
                _id: "$eInvoiceStatus",
                count: { $sum: 1 },
              },
            },
          ]);

          const statusCounts = {
            NOT_SENT: 0,
            PENDING_VALIDATION: 0,
            VALIDATED: 0,
            SENT_TO_RECIPIENT: 0,
            RECEIVED: 0,
            ACCEPTED: 0,
            REJECTED: 0,
            PAID: 0,
            ERROR: 0,
          };

          stats.forEach((stat) => {
            if (
              stat._id &&
              Object.prototype.hasOwnProperty.call(statusCounts, stat._id)
            ) {
              statusCounts[stat._id] = stat.count;
            }
          });

          const totalSent =
            Object.values(statusCounts).reduce((a, b) => a + b, 0) -
            statusCounts.NOT_SENT;

          return {
            ...statusCounts,
            totalSent,
            successRate:
              totalSent > 0
                ? (
                    ((statusCounts.ACCEPTED + statusCounts.PAID) / totalSent) *
                    100
                  ).toFixed(2)
                : 0,
          };
        } catch (error) {
          logger.error("Erreur récupération stats e-invoicing:", error);
          throw new AppError(
            "Erreur lors de la récupération des statistiques e-invoicing",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),
  },

  Mutation: {
    /**
     * Activer la facturation électronique pour une organisation
     * Teste la connexion à SuperPDP avant d'activer
     */
    enableEInvoicing: requireWrite("invoices")(
      async (_, { workspaceId, environment }, context) => {
        try {
          const { userRole } = context;

          // Seuls les admins et owners peuvent activer l'e-invoicing
          if (userRole !== "admin" && userRole !== "owner") {
            throw new AppError(
              "Seuls les administrateurs peuvent activer la facturation électronique",
              ERROR_CODES.FORBIDDEN,
            );
          }

          // Tester la connexion à SuperPDP avant d'activer
          logger.info(
            `🔄 Test de connexion SuperPDP pour le workspace ${workspaceId}...`,
          );
          const connectionTest =
            await superPdpService.testConnection(workspaceId);

          if (!connectionTest.success) {
            logger.warn(
              `❌ Échec du test de connexion SuperPDP: ${connectionTest.message}`,
            );
            // On active quand même mais on prévient l'utilisateur
            // Les credentials peuvent être configurés plus tard via .env
          }

          const settings = await EInvoicingSettingsService.enableEInvoicing(
            workspaceId,
            { environment: environment || "sandbox" },
          );

          const message = connectionTest.success
            ? "Facturation électronique activée et connexion à SuperPDP vérifiée"
            : "Facturation électronique activée. Attention : la connexion à SuperPDP n'a pas pu être vérifiée. Vérifiez vos credentials dans le fichier .env";

          logger.info(
            `✅ E-invoicing activé pour le workspace ${workspaceId} (connexion: ${connectionTest.success ? "OK" : "NON VÉRIFIÉE"})`,
          );

          return {
            success: true,
            message,
            settings,
            connectionVerified: connectionTest.success,
          };
        } catch (error) {
          logger.error("Erreur activation e-invoicing:", error);
          throw new AppError(
            error.message ||
              "Erreur lors de l'activation de la facturation électronique",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Désactiver la facturation électronique pour une organisation
     */
    disableEInvoicing: requireWrite("invoices")(
      async (_, { workspaceId }, context) => {
        try {
          const { userRole } = context;

          if (userRole !== "admin" && userRole !== "owner") {
            throw new AppError(
              "Seuls les administrateurs peuvent désactiver la facturation électronique",
              ERROR_CODES.FORBIDDEN,
            );
          }

          const settings =
            await EInvoicingSettingsService.disableEInvoicing(workspaceId);

          logger.info(
            `⚠️ E-invoicing désactivé pour le workspace ${workspaceId}`,
          );

          return {
            success: true,
            message: "Facturation électronique désactivée",
            settings,
          };
        } catch (error) {
          logger.error("Erreur désactivation e-invoicing:", error);
          throw new AppError(
            error.message ||
              "Erreur lors de la désactivation de la facturation électronique",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Tester la connexion à SuperPDP
     */
    testSuperPdpConnection: requireWrite("invoices")(
      async (_, { workspaceId }, context) => {
        try {
          const result = await superPdpService.testConnection(workspaceId);

          return {
            success: result.success,
            message: result.message,
            profile: result.profile ? JSON.stringify(result.profile) : null,
          };
        } catch (error) {
          logger.error("Erreur test connexion SuperPDP:", error);
          return {
            success: false,
            message: `Erreur de connexion: ${error.message}`,
            profile: null,
          };
        }
      },
    ),

    /**
     * Renvoyer une facture à SuperPDP (en cas d'erreur précédente)
     */
    resendInvoiceToSuperPdp: requireWrite("invoices")(
      async (_, { workspaceId, invoiceId }, context) => {
        try {
          // Vérifier que l'e-invoicing est activé
          const isEnabled =
            await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);
          if (!isEnabled) {
            throw new AppError(
              "La facturation électronique n'est pas activée",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Récupérer la facture
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            workspaceId: workspaceId,
          });

          if (!invoice) {
            throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
          }

          // Vérifier que la facture n'est pas un brouillon
          if (invoice.status === "DRAFT") {
            throw new AppError(
              "Les brouillons ne peuvent pas être envoyés en facturation électronique",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Envoyer à SuperPDP
          const result = await superPdpService.sendInvoice(
            workspaceId,
            invoice,
          );

          if (result.success) {
            // Mettre à jour la facture (statut dérivé + historique brut SuperPDP)
            invoice.superPdpInvoiceId = result.superPdpInvoiceId;
            invoice.eInvoiceStatus = result.status;
            invoice.eInvoiceLastCode = result.lastCode || null;
            invoice.eInvoiceEvents = result.events || [];
            invoice.eInvoiceSentAt = new Date();
            invoice.eInvoiceError = null;
            invoice.facturXData = {
              xmlGenerated: true,
              profile: "EN16931",
              generatedAt: new Date(),
            };
            await invoice.save();

            return {
              success: true,
              message: "Facture envoyée avec succès à SuperPDP",
              superPdpInvoiceId: result.superPdpInvoiceId,
              status: invoice.eInvoiceStatus,
            };
          } else {
            // Enregistrer l'erreur
            invoice.eInvoiceStatus = "ERROR";
            invoice.eInvoiceError = result.error;
            await invoice.save();

            return {
              success: false,
              message: result.error,
              superPdpInvoiceId: null,
              status: "ERROR",
            };
          }
        } catch (error) {
          logger.error("Erreur renvoi facture SuperPDP:", error);
          throw new AppError(
            error.message || "Erreur lors du renvoi de la facture",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Vérifier si un destinataire peut recevoir des factures électroniques
     */
    checkRecipientEInvoicing: requireRead("invoices")(
      async (_, { workspaceId, siret }, context) => {
        try {
          const result = await superPdpService.checkRecipientDirectory(
            workspaceId,
            siret,
          );

          return {
            success: result.success,
            canReceiveEInvoices: result.canReceiveEInvoices,
            pdpName: result.pdpName,
            pdpId: result.pdpId,
            peppolId: result.peppolId,
            error: result.error,
          };
        } catch (error) {
          logger.error("Erreur vérification destinataire:", error);
          return {
            success: false,
            canReceiveEInvoices: false,
            error: error.message,
          };
        }
      },
    ),

    /**
     * Prévisualiser le routage e-invoicing d'une facture (sans l'envoyer)
     * Utile pour le debug et l'affichage frontend
     */
    previewInvoiceRouting: requireRead("invoices")(
      async (_, { workspaceId, invoiceId }, context) => {
        try {
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            workspaceId: workspaceId,
          });

          if (!invoice) {
            throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
          }

          const organization =
            await EInvoicingSettingsService.getOrganizationById(workspaceId);

          if (!organization) {
            throw new AppError(
              "Organisation non trouvée",
              ERROR_CODES.NOT_FOUND,
            );
          }

          const result = eInvoiceRoutingService.determineFlowType(
            invoice,
            organization,
          );

          return {
            flowType: result.flowType,
            reason: result.reason,
            details: {
              ...result.details,
              evaluatedAt: result.details.evaluatedAt?.toISOString(),
            },
          };
        } catch (error) {
          logger.error("Erreur preview routing:", error);
          throw new AppError(
            error.message || "Erreur lors de la prévisualisation du routage",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Archiver le PDF Factur-X (généré côté frontend) d'une facture sur Cloudflare R2.
     * Le PDF est stocké dans un bucket privé ; on le sert ensuite via une URL signée
     * (query invoiceDocumentUrl). Les brouillons ne sont jamais archivés.
     */
    archiveInvoicePdf: requireWrite("invoices")(
      async (_, { workspaceId, invoiceId, file }, context) => {
        const invoice = await Invoice.findOne({
          _id: invoiceId,
          workspaceId,
        });

        if (!invoice) {
          throw new AppError("Facture non trouvée", ERROR_CODES.NOT_FOUND);
        }

        // Sécurité : ne jamais archiver un brouillon
        if (invoice.status === "DRAFT") {
          throw new AppError(
            "Un brouillon ne peut pas être archivé",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        // Lire le fichier uploadé (pattern graphql-upload)
        const { createReadStream, mimetype } = await file;
        if (mimetype && mimetype !== "application/pdf") {
          throw new AppError(
            "Le document à archiver doit être un PDF",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        const chunks = [];
        for await (const chunk of createReadStream()) {
          chunks.push(chunk);
        }
        const pdfBuffer = Buffer.concat(chunks);

        // Garde-fou taille (PDF facture : 20 Mo max)
        if (pdfBuffer.length > 20 * 1024 * 1024) {
          throw new AppError(
            "PDF trop volumineux",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        const fileName = `facture_${invoice.prefix || ""}${invoice.number || invoiceId}.pdf`;

        // Upload dans le bucket DÉDIÉ aux factures (privé) — URL signée à la demande
        const uploadResult = await cloudflareService.uploadInvoicePdf(
          pdfBuffer,
          workspaceId,
          invoiceId.toString(),
          { source: "NEWBI", fileName },
        );

        invoice.archivedPdfKey = uploadResult.key;
        invoice.archivedPdfUrl = null; // bucket privé : pas d'URL publique
        invoice.archivedPdfStoredAt = new Date();
        invoice.archivedPdfSource = "NEWBI";
        await invoice.save();

        logger.info(
          `🗄️ PDF Factur-X archivé sur R2 pour la facture ${invoiceId} (${uploadResult.key})`,
        );

        return invoice;
      },
    ),

    /**
     * Inscrit l'entreprise dans les annuaires Peppol + PPF (pour recevoir des factures).
     * Idempotent : ignore les annuaires où une entrée "created" existe déjà.
     */
    registerEInvoicingDirectory: requireWrite("invoices")(
      async (_, { workspaceId }) => {
        const isEnabled =
          await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);
        if (!isEnabled) {
          throw new AppError(
            "La facturation électronique n'est pas activée",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        // Identifiant = SIREN de l'entreprise (depuis companies/me, sinon SIRET de l'org)
        let identifier = null;
        try {
          const company = await superPdpService.getCurrentCompany(workspaceId);
          identifier = company?.number || null;
        } catch (e) {
          logger.debug(
            `companies/me indisponible pour l'annuaire: ${e.message}`,
          );
        }
        if (!identifier) {
          const organization =
            await EInvoicingSettingsService.getOrganizationById(workspaceId);
          const rawNumber =
            organization?.siret ||
            organization?.siren ||
            organization?.companyInfo?.siret ||
            "";
          identifier = String(rawNumber).replace(/\s/g, "").substring(0, 9);
        }
        if (!identifier || identifier.length < 9) {
          throw new AppError(
            "SIREN de l'entreprise introuvable pour l'inscription à l'annuaire",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }

        // Entrées déjà présentes (idempotence)
        let existing = [];
        try {
          existing = await superPdpService.getDirectoryEntries(workspaceId);
        } catch (e) {
          logger.debug(`Lecture annuaire échouée (continue): ${e.message}`);
        }
        const alreadyCreated = new Set(
          existing
            .filter((e) => e.status === "created")
            .map((e) => e.directory),
        );

        for (const directory of ["peppol", "ppf"]) {
          if (alreadyCreated.has(directory)) continue;
          try {
            await superPdpService.registerDirectoryEntry(
              workspaceId,
              directory,
              identifier,
            );
          } catch (e) {
            logger.warn(
              `Inscription annuaire ${directory} échouée: ${e.message}`,
            );
          }
        }

        // Renvoyer l'état à jour
        return await superPdpService.getDirectoryEntries(workspaceId);
      },
    ),

    /**
     * Met à jour le régime TVA SuperPDP (pilote le calendrier d'envoi e-reporting au PPF).
     */
    updateEInvoicingVatRegime: requireWrite("invoices")(
      async (_, { workspaceId, vatRegime }) => {
        const allowed = ["monthly", "quarterly", "simplified", "vat_exemption"];
        if (!allowed.includes(vatRegime)) {
          throw new AppError(
            "Régime TVA invalide",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        const isEnabled =
          await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);
        if (!isEnabled) {
          throw new AppError(
            "La facturation électronique n'est pas activée",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        await superPdpService.updateVatRegime(workspaceId, vatRegime);
        return true;
      },
    ),
  },
};

export default eInvoicingResolvers;
