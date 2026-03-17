import { requireRead, requireWrite } from "../middlewares/rbac.js";
import esignatureService from "../services/esignatureService.js";
import SignatureRequest from "../models/SignatureRequest.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

/**
 * Récupérer le modèle Mongoose correspondant au type de document
 */
function getDocumentModel(documentType) {
  switch (documentType) {
    case "invoice":
      return Invoice;
    case "quote":
      return Quote;
    default:
      throw new AppError(
        `Type de document non supporté: ${documentType}`,
        ERROR_CODES.VALIDATION_ERROR
      );
  }
}

/**
 * Mapper le statut de l'API eSignature vers notre statut interne
 */
function mapExternalStatus(externalState) {
  const statusMap = {
    WAIT_VALIDATION: "WAIT_VALIDATION",
    WAIT_SIGN: "WAIT_SIGN",
    WAIT_SIGNER: "WAIT_SIGNER",
    DONE: "DONE",
    ERROR: "ERROR",
  };
  return statusMap[externalState] || "PENDING";
}

// Helper pour récupérer le dernier statut de signature d'un document
async function getLatestSignature(parent, documentType) {
  const docId = parent._id || parent.id;
  if (!docId) return null;
  return SignatureRequest.findOne({
    documentType,
    documentId: docId.toString(),
  }).sort({ createdAt: -1 }).lean();
}

const esignatureResolvers = {
  // Field resolvers pour Quote
  Quote: {
    signatureStatus: async (parent) => {
      const sig = await getLatestSignature(parent, "quote");
      return sig?.status || null;
    },
    signingUrl: async (parent) => {
      const sig = await getLatestSignature(parent, "quote");
      return sig?.signingUrl || null;
    },
  },
  Query: {
    /**
     * Récupérer une demande de signature par ID
     */
    getSignatureRequest: requireRead("invoices")(
      async (_, { id }, context) => {
        try {
          const signatureRequest = await SignatureRequest.findOne({
            _id: id,
            organizationId: context.organizationId,
          });

          return signatureRequest;
        } catch (error) {
          logger.error("Erreur récupération signature:", error);
          throw new AppError(
            "Erreur lors de la récupération de la signature",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Lister les demandes de signature avec filtres
     */
    getSignatureRequests: requireRead("invoices")(
      async (_, { documentId, documentType, status }, context) => {
        try {
          const filter = {
            organizationId: context.organizationId,
          };

          if (documentId) filter.documentId = documentId;
          if (documentType) filter.documentType = documentType;
          if (status) filter.status = status;

          const signatureRequests = await SignatureRequest.find(filter)
            .sort({ createdAt: -1 })
            .limit(50);

          return signatureRequests;
        } catch (error) {
          logger.error("Erreur liste signatures:", error);
          throw new AppError(
            "Erreur lors de la récupération des signatures",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Récupérer le statut de signature le plus récent d'un document
     */
    getDocumentSignatureStatus: requireRead("invoices")(
      async (_, { documentType, documentId }, context) => {
        try {
          const signatureRequest = await SignatureRequest.findOne({
            documentType,
            documentId,
            organizationId: context.organizationId,
          }).sort({ createdAt: -1 });

          // Si on a une signature en cours, rafraîchir le statut depuis l'API
          if (
            signatureRequest &&
            signatureRequest.externalSignatureId &&
            !["DONE", "ERROR", "CANCELLED"].includes(signatureRequest.status)
          ) {
            try {
              const externalStatus =
                await esignatureService.getSignatureStatus(
                  signatureRequest.externalSignatureId
                );

              const newStatus = mapExternalStatus(externalStatus.state);
              if (newStatus !== signatureRequest.status) {
                signatureRequest.status = newStatus;
                if (externalStatus.errorMessage) {
                  signatureRequest.errorMessage =
                    externalStatus.errorMessage;
                }
                await signatureRequest.save();
              }
            } catch (err) {
              logger.warn(
                `Impossible de rafraîchir le statut eSignature: ${err.message}`
              );
            }
          }

          return signatureRequest;
        } catch (error) {
          logger.error("Erreur statut signature document:", error);
          throw new AppError(
            "Erreur lors de la récupération du statut de signature",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),
  },

  Mutation: {
    /**
     * Créer une demande de signature pour un document
     * Le frontend envoie le PDF en base64 via le champ documentBase64 de l'input
     */
    requestDocumentSignature: requireWrite("invoices")(
      async (_, { input }, context) => {
        try {
          const {
            documentType,
            documentId,
            signatureType = "SES",
            signers,
            title,
            signatureMode,
            documentBase64,
          } = input;

          // Seuls les devis peuvent être signés électroniquement
          if (documentType !== "quote") {
            throw new AppError(
              "Seuls les devis peuvent être signés électroniquement.",
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Vérifier que le document existe
          const Model = getDocumentModel(documentType);
          const document = await Model.findOne({
            _id: documentId,
            workspaceId: context.workspaceId,
          });

          if (!document) {
            throw new AppError(
              "Document non trouvé",
              ERROR_CODES.NOT_FOUND
            );
          }

          // Vérifier que le document n'est pas un brouillon
          if (document.status === "DRAFT") {
            throw new AppError(
              "Les brouillons ne peuvent pas être signés. Veuillez d'abord valider le document.",
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Vérifier qu'il n'y a pas déjà une signature en cours
          const existingSignature = await SignatureRequest.findOne({
            documentType,
            documentId,
            status: {
              $in: [
                "PENDING",
                "WAIT_VALIDATION",
                "WAIT_SIGN",
                "WAIT_SIGNER",
              ],
            },
          });

          if (existingSignature) {
            // Auto-annuler les demandes PENDING sans ID externe (jamais envoyées à l'API)
            if (existingSignature.status === "PENDING" && !existingSignature.externalSignatureId) {
              logger.info(`Auto-annulation de la demande PENDING orpheline ${existingSignature._id}`);
              existingSignature.status = "CANCELLED";
              await existingSignature.save();
            } else {
              throw new AppError(
                "Une demande de signature est déjà en cours pour ce document",
                ERROR_CODES.VALIDATION_ERROR
              );
            }
          }

          // Créer l'entrée SignatureRequest en base
          const signatureRequest = new SignatureRequest({
            organizationId: context.organizationId,
            workspaceId: context.workspaceId,
            documentType,
            documentId,
            documentNumber: document.number || null,
            signatureType,
            status: "PENDING",
            signers: signers.map((s) => ({
              name: s.name,
              surname: s.surname,
              email: s.email,
              mobile: s.mobile || null,
              authentication: s.authentication || ["email"],
            })),
            createdBy: context.user._id,
          });

          await signatureRequest.save();

          // Préparer le callback webhook
          const callbackConfig = esignatureService.buildCallbackConfig(
            signatureRequest._id.toString()
          );

          // Appeler l'API eSignature
          let apiResult;

          if (signatureType === "SES") {
            if (!documentBase64) {
              throw new AppError(
                "Le PDF du document est requis pour la signature SES",
                ERROR_CODES.VALIDATION_ERROR
              );
            }

            apiResult = await esignatureService.createSESSignature(
              documentBase64,
              signers,
              {
                title:
                  title ||
                  `Signature ${documentType === "invoice" ? "facture" : "devis"} ${document.number || ""}`,
                signatureMode: signatureMode || ["typed", "drawn"],
                signerMustRead: true,
                ui: {
                  completeUrl: `${process.env.FRONTEND_URL || ""}/dashboard/outils/${documentType === "invoice" ? "factures" : "devis"}/${documentId}?signed=true`,
                  cancelUrl: `${process.env.FRONTEND_URL || ""}/dashboard/outils/${documentType === "invoice" ? "factures" : "devis"}/${documentId}?signed=cancelled`,
                },
              },
              callbackConfig
            );
          } else if (signatureType === "QES_automatic") {
            if (!documentBase64) {
              throw new AppError(
                "Le PDF du document est requis pour la signature QES",
                ERROR_CODES.VALIDATION_ERROR
              );
            }

            apiResult = await esignatureService.createQESAutomatic(
              documentBase64,
              {
                title:
                  title ||
                  `Cachet ${documentType === "invoice" ? "facture" : "devis"} ${document.number || ""}`,
              },
              callbackConfig
            );
          } else {
            throw new AppError(
              `Type de signature non supporté: ${signatureType}`,
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Log complet de la réponse API
          console.log("===== API RESULT =====");
          console.log(JSON.stringify(apiResult, null, 2));
          console.log("======================");

          // Mettre à jour avec les infos de l'API
          // La réponse API encapsule les données dans apiResult.data
          const resultData = apiResult.data || apiResult;
          signatureRequest.externalSignatureId =
            resultData.id || resultData._id;
          signatureRequest.status = mapExternalStatus(
            resultData.state || "WAIT_VALIDATION"
          );
          // L'URL de signature est dans le premier signataire
          const firstSignerUrl = resultData.signers?.[0]?.url || null;
          signatureRequest.signingUrl = resultData.signingUrl || firstSignerUrl;
          await signatureRequest.save();

          logger.info(
            `Signature ${signatureType} créée pour ${documentType} ${document.number || documentId}`
          );

          return {
            success: true,
            message: "Demande de signature envoyée avec succès",
            signatureRequest,
          };
        } catch (error) {
          logger.error("Erreur création signature:", error);

          if (error instanceof AppError) {
            throw error;
          }

          throw new AppError(
            error.message ||
              "Erreur lors de la création de la demande de signature",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Annuler une demande de signature en cours
     */
    cancelSignature: requireWrite("invoices")(
      async (_, { signatureId }, context) => {
        try {
          const signatureRequest = await SignatureRequest.findOne({
            _id: signatureId,
            organizationId: context.organizationId,
          });

          if (!signatureRequest) {
            throw new AppError(
              "Demande de signature non trouvée",
              ERROR_CODES.NOT_FOUND
            );
          }

          if (["DONE", "CANCELLED"].includes(signatureRequest.status)) {
            throw new AppError(
              "Cette signature ne peut plus être annulée",
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Supprimer côté API eSignature
          if (signatureRequest.externalSignatureId) {
            try {
              await esignatureService.deleteSignature(
                signatureRequest.externalSignatureId
              );
            } catch (err) {
              logger.warn(
                `Impossible de supprimer la signature externe: ${err.message}`
              );
            }
          }

          signatureRequest.status = "CANCELLED";
          await signatureRequest.save();

          logger.info(
            `Signature ${signatureId} annulée`
          );

          return {
            success: true,
            message: "Demande de signature annulée",
            signatureRequest,
          };
        } catch (error) {
          logger.error("Erreur annulation signature:", error);

          if (error instanceof AppError) {
            throw error;
          }

          throw new AppError(
            error.message ||
              "Erreur lors de l'annulation de la signature",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Relancer une signature en erreur
     */
    retrySignature: requireWrite("invoices")(
      async (_, { signatureId }, context) => {
        try {
          const signatureRequest = await SignatureRequest.findOne({
            _id: signatureId,
            organizationId: context.organizationId,
          });

          if (!signatureRequest) {
            throw new AppError(
              "Demande de signature non trouvée",
              ERROR_CODES.NOT_FOUND
            );
          }

          if (signatureRequest.status !== "ERROR") {
            throw new AppError(
              "Seules les signatures en erreur peuvent être relancées",
              ERROR_CODES.VALIDATION_ERROR
            );
          }

          // Supprimer l'ancienne signature côté API
          if (signatureRequest.externalSignatureId) {
            try {
              await esignatureService.deleteSignature(
                signatureRequest.externalSignatureId
              );
            } catch (err) {
              logger.warn(
                `Impossible de supprimer l'ancienne signature: ${err.message}`
              );
            }
          }

          // Réinitialiser le statut pour permettre une nouvelle tentative
          signatureRequest.status = "PENDING";
          signatureRequest.externalSignatureId = null;
          signatureRequest.signingUrl = null;
          signatureRequest.errorMessage = null;
          signatureRequest.errorNumber = null;
          signatureRequest.callbackReceived = false;
          await signatureRequest.save();

          return {
            success: true,
            message:
              "Signature réinitialisée. Veuillez relancer la demande de signature.",
            signatureRequest,
          };
        } catch (error) {
          logger.error("Erreur retry signature:", error);

          if (error instanceof AppError) {
            throw error;
          }

          throw new AppError(
            error.message ||
              "Erreur lors de la relance de la signature",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),
  },
};

export default esignatureResolvers;
