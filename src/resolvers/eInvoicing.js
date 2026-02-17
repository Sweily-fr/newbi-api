import { requireRead, requireWrite } from "../middlewares/rbac.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import superPdpService from "../services/superPdpService.js";
import eInvoiceRoutingService from "../services/eInvoiceRoutingService.js";
import Invoice from "../models/Invoice.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

const eInvoicingResolvers = {
  Query: {
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
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Récupérer les statistiques e-invoicing d'une organisation
     */
    eInvoicingStats: requireRead("invoices")(
      async (_, { workspaceId }, context) => {
        try {
          // Compter les factures par statut e-invoicing
          const stats = await Invoice.aggregate([
            { $match: { workspaceId: workspaceId } },
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
            if (stat._id && statusCounts.hasOwnProperty(stat._id)) {
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
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
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
              ERROR_CODES.FORBIDDEN
            );
          }

          // Tester la connexion à SuperPDP avant d'activer
          logger.info(
            `🔄 Test de connexion SuperPDP pour le workspace ${workspaceId}...`
          );
          const connectionTest =
            await superPdpService.testConnection(workspaceId);

          if (!connectionTest.success) {
            logger.warn(
              `❌ Échec du test de connexion SuperPDP: ${connectionTest.message}`
            );
            // On active quand même mais on prévient l'utilisateur
            // Les credentials peuvent être configurés plus tard via .env
          }

          const settings = await EInvoicingSettingsService.enableEInvoicing(
            workspaceId,
            { environment: environment || "sandbox" }
          );

          const message = connectionTest.success
            ? "Facturation électronique activée et connexion à SuperPDP vérifiée"
            : "Facturation électronique activée. Attention : la connexion à SuperPDP n'a pas pu être vérifiée. Vérifiez vos credentials dans le fichier .env";

          logger.info(
            `✅ E-invoicing activé pour le workspace ${workspaceId} (connexion: ${connectionTest.success ? "OK" : "NON VÉRIFIÉE"})`
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
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
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
              ERROR_CODES.FORBIDDEN
            );
          }

          const settings =
            await EInvoicingSettingsService.disableEInvoicing(workspaceId);

          logger.info(
            `⚠️ E-invoicing désactivé pour le workspace ${workspaceId}`
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
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
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
      }
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
              ERROR_CODES.VALIDATION_ERROR
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
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Envoyer à SuperPDP
          const result = await superPdpService.sendInvoice(
            workspaceId,
            invoice
          );

          if (result.success) {
            // Mettre à jour la facture
            invoice.superPdpInvoiceId = result.superPdpInvoiceId;
            invoice.eInvoiceStatus = superPdpService.mapStatusToNewbi(
              result.status
            );
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
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Vérifier si un destinataire peut recevoir des factures électroniques
     */
    checkRecipientEInvoicing: requireRead("invoices")(
      async (_, { workspaceId, siret }, context) => {
        try {
          const result = await superPdpService.checkRecipientDirectory(
            workspaceId,
            siret
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
      }
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
              ERROR_CODES.NOT_FOUND
            );
          }

          const result = eInvoiceRoutingService.determineFlowType(
            invoice,
            organization
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
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),
  },
};

export default eInvoicingResolvers;
