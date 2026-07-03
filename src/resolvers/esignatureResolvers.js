import { requireRead, requireWrite } from "../middlewares/rbac.js";
import esignatureService from "../services/esignatureService.js";
import SignatureRequest from "../models/SignatureRequest.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { acceptQuoteOnSignature } from "../services/quoteSignatureSync.js";
import { storeSignedDocuments } from "../services/esignatureDocuments.js";
import { sendSignatureInvitations } from "../services/esignatureEmail.js";
import {
  publishSignatureStatus,
  signatureChannel,
} from "../services/esignaturePubsub.js";
import { getPubSub } from "../config/redis.js";

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
        ERROR_CODES.VALIDATION_ERROR,
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
  // Normaliser la casse : l'API peut renvoyer l'état en minuscules/casse mixte
  const key = String(externalState || "")
    .trim()
    .toUpperCase();
  const mapped = statusMap[key];
  if (!mapped) {
    logger.warn(
      `mapExternalStatus: état eSignature inconnu "${externalState}", repli sur PENDING`,
    );
    return "PENDING";
  }
  return mapped;
}

// Helper pour récupérer la dernière SignatureRequest d'un document (filtre optionnel)
async function getLatestSignature(parent, documentType, extraFilter = {}) {
  const docId = parent._id || parent.id;
  if (!docId) return null;
  return SignatureRequest.findOne({
    documentType,
    documentId: docId.toString(),
    ...extraFilter,
  })
    .sort({ createdAt: -1 })
    .lean();
}

const esignatureResolvers = {
  // Field resolvers pour Quote
  Quote: {
    // Signature du client : on ignore les cachets QES automatiques de l'entreprise
    signatureStatus: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: { $ne: "QES_automatic" },
      });
      return sig?.status || null;
    },
    signingUrl: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: { $ne: "QES_automatic" },
      });
      return sig?.signingUrl || null;
    },
    // Cachet qualifié de l'entreprise (QES automatique)
    sealStatus: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: "QES_automatic",
      });
      return sig?.status || null;
    },
    sealedDocumentUrl: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: "QES_automatic",
      });
      return sig?.signedDocumentUrl || null;
    },
    // Document signé par le client (preuve), hors cachet entreprise
    signedDocumentUrl: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: { $ne: "QES_automatic" },
      });
      return sig?.signedDocumentUrl || null;
    },
    // Certificat de preuve / piste d'audit de la signature client
    auditTrailUrl: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: { $ne: "QES_automatic" },
      });
      return sig?.auditTrailUrl || null;
    },
    // Signataires de la signature client (avec date de signature)
    signers: async (parent) => {
      const sig = await getLatestSignature(parent, "quote", {
        signatureType: { $ne: "QES_automatic" },
      });
      return sig?.signers || [];
    },
  },
  Query: {
    /**
     * Récupérer une demande de signature par ID
     */
    getSignatureRequest: requireRead("invoices")(async (_, { id }, context) => {
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
          ERROR_CODES.INTERNAL_ERROR,
        );
      }
    }),

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
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
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

          if (signatureRequest && signatureRequest.externalSignatureId) {
            const isActive = !["DONE", "ERROR", "CANCELLED"].includes(
              signatureRequest.status,
            );
            try {
              if (isActive) {
                // Rafraîchir le statut depuis l'API
                const externalStatus =
                  await esignatureService.getSignatureStatus(
                    signatureRequest.externalSignatureId,
                  );

                // L'API OpenAPI encapsule les données dans .data
                const detail = externalStatus?.data || externalStatus || {};

                const newStatus = mapExternalStatus(detail.state);
                if (newStatus !== signatureRequest.status) {
                  signatureRequest.status = newStatus;
                  if (detail.errorMessage) {
                    signatureRequest.errorMessage = detail.errorMessage;
                  }
                  await signatureRequest.save();
                  publishSignatureStatus(signatureRequest);

                  // Filet de sécurité sans webhook (ex: local) : récupérer le
                  // document signé/cacheté puis auto-accepter le devis.
                  if (newStatus === "DONE") {
                    await storeSignedDocuments(signatureRequest);
                    await acceptQuoteOnSignature(signatureRequest);
                  }
                }
              } else if (
                signatureRequest.status === "DONE" &&
                !signatureRequest.signedDocumentUrl
              ) {
                // Demande déjà terminée mais document jamais récupéré
                // (cas local : le webhook n'a pas tourné) → backfill.
                await storeSignedDocuments(signatureRequest);
                await acceptQuoteOnSignature(signatureRequest);
              }
            } catch (err) {
              logger.warn(
                `Impossible de rafraîchir le statut eSignature: ${err.message}`,
              );
            }
          }

          return signatureRequest;
        } catch (error) {
          logger.error("Erreur statut signature document:", error);
          throw new AppError(
            "Erreur lors de la récupération du statut de signature",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
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
            signaturePlacement,
          } = input;

          // Placement de la zone de signature calculé par le frontend
          // (juste au-dessus du pied de page, sur la partie blanche).
          const placementOption = signaturePlacement?.length
            ? {
                signaturePlacement: signaturePlacement.map((p) => ({
                  page: p.page,
                  x: Math.round(p.x),
                  y: Math.round(p.y),
                })),
              }
            : {};

          // Seuls les devis peuvent être signés électroniquement
          if (documentType !== "quote") {
            throw new AppError(
              "Seuls les devis peuvent être signés électroniquement.",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Vérifier que le document existe
          const Model = getDocumentModel(documentType);
          const document = await Model.findOne({
            _id: documentId,
            workspaceId: context.workspaceId,
          });

          if (!document) {
            throw new AppError("Document non trouvé", ERROR_CODES.NOT_FOUND);
          }

          // Vérifier que le document n'est pas un brouillon
          if (document.status === "DRAFT") {
            throw new AppError(
              "Les brouillons ne peuvent pas être signés. Veuillez d'abord valider le document.",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Vérifier qu'il n'y a pas déjà une signature en cours
          const existingSignature = await SignatureRequest.findOne({
            documentType,
            documentId,
            status: {
              $in: ["PENDING", "WAIT_VALIDATION", "WAIT_SIGN", "WAIT_SIGNER"],
            },
          });

          if (existingSignature) {
            // Une demande PENDING n'a jamais été confirmée comme réellement envoyée
            // (une demande active côté provider est en WAIT_VALIDATION/WAIT_SIGN/WAIT_SIGNER).
            // On l'auto-annule pour permettre un renvoi, même si un externalSignatureId
            // existe (cas d'une demande restée coincée en PENDING).
            if (existingSignature.status === "PENDING") {
              logger.info(
                `Auto-annulation de la demande PENDING ${existingSignature._id} (externalSignatureId: ${existingSignature.externalSignatureId || "aucun"})`,
              );
              // Supprimer l'orphelin côté API si une demande externe avait été créée
              if (existingSignature.externalSignatureId) {
                try {
                  await esignatureService.deleteSignature(
                    existingSignature.externalSignatureId,
                  );
                } catch (err) {
                  logger.warn(
                    `Impossible de supprimer la signature externe orpheline ${existingSignature.externalSignatureId}: ${err.message}`,
                  );
                }
              }
              existingSignature.status = "CANCELLED";
              await existingSignature.save();
            } else {
              throw new AppError(
                "Une demande de signature est déjà en attente de signature pour ce devis. Annulez la demande en cours avant d'en envoyer une nouvelle.",
                ERROR_CODES.VALIDATION_ERROR,
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
            signatureRequest._id.toString(),
          );

          // Appeler l'API eSignature
          let apiResult;

          if (signatureType === "SES") {
            if (!documentBase64) {
              throw new AppError(
                "Le PDF du document est requis pour la signature SES",
                ERROR_CODES.VALIDATION_ERROR,
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
                ...placementOption,
                ui: {
                  completeUrl: `${process.env.FRONTEND_URL || ""}/dashboard/outils/${documentType === "invoice" ? "factures" : "devis"}?id=${documentId}&signed=true`,
                  cancelUrl: `${process.env.FRONTEND_URL || ""}/dashboard/outils/${documentType === "invoice" ? "factures" : "devis"}?id=${documentId}&signed=cancelled`,
                },
              },
              callbackConfig,
            );
          } else if (signatureType === "QES_otp") {
            if (!documentBase64) {
              throw new AppError(
                "Le PDF du document est requis pour la signature QES",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
            if (!signers || signers.length === 0) {
              throw new AppError(
                "Au moins un signataire est requis pour la signature QES",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }

            apiResult = await esignatureService.createQESOTP(
              documentBase64,
              signers,
              {
                title:
                  title ||
                  `Signature ${documentType === "invoice" ? "facture" : "devis"} ${document.number || ""}`,
                signatureMode: signatureMode || ["typed", "drawn"],
                signerMustRead: true,
                ...placementOption,
                ui: {
                  completeUrl: `${process.env.FRONTEND_URL || ""}/dashboard/outils/${documentType === "invoice" ? "factures" : "devis"}?id=${documentId}&signed=true`,
                  cancelUrl: `${process.env.FRONTEND_URL || ""}/dashboard/outils/${documentType === "invoice" ? "factures" : "devis"}?id=${documentId}&signed=cancelled`,
                },
              },
              callbackConfig,
            );
          } else if (signatureType === "QES_automatic") {
            if (!documentBase64) {
              throw new AppError(
                "Le PDF du document est requis pour la signature QES",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }

            apiResult = await esignatureService.createQESAutomatic(
              documentBase64,
              {
                title:
                  title ||
                  `Cachet ${documentType === "invoice" ? "facture" : "devis"} ${document.number || ""}`,
              },
              callbackConfig,
            );
          } else {
            throw new AppError(
              `Type de signature non supporté: ${signatureType}`,
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Mettre à jour avec les infos de l'API
          // La réponse API encapsule les données dans apiResult.data
          const resultData = apiResult.data || apiResult;
          signatureRequest.externalSignatureId =
            resultData.id || resultData._id;
          signatureRequest.status = mapExternalStatus(
            resultData.state || "WAIT_VALIDATION",
          );
          // L'URL de signature est dans le premier signataire
          const firstSignerUrl = resultData.signers?.[0]?.url || null;
          signatureRequest.signingUrl = resultData.signingUrl || firstSignerUrl;
          await signatureRequest.save();

          publishSignatureStatus(signatureRequest);

          logger.info(
            `Signature ${signatureType} créée pour ${documentType} ${document.number || documentId}`,
          );

          // Envoyer l'invitation à signer à chaque signataire (sauf cachet entreprise).
          // L'API n'envoie pas toujours d'email (sandbox) : on garantit l'acheminement
          // du lien via Resend. Fire-and-forget pour ne pas bloquer la réponse.
          if (signatureType !== "QES_automatic") {
            const apiSigners = Array.isArray(resultData.signers)
              ? resultData.signers
              : [];
            // Associer chaque URL renvoyée par l'API au signataire correspondant
            // (par email si disponible, sinon par position).
            const signerUrls = signers.map((s, i) => {
              const match =
                apiSigners.find(
                  (as) =>
                    as?.email &&
                    s?.email &&
                    as.email.toLowerCase() === s.email.toLowerCase(),
                ) ||
                apiSigners[i] ||
                {};
              return {
                email: s.email,
                name: s.name,
                surname: s.surname,
                url: match.url || signatureRequest.signingUrl,
              };
            });

            const documentNumber =
              `${document.prefix || ""}-${document.number || ""}`.replace(
                /^-/,
                "",
              );
            const companyName =
              document.companyInfo?.name || "Votre prestataire";
            const totalAmount =
              document.finalTotalTTC ?? document.totalTTC ?? null;

            sendSignatureInvitations({
              signerUrls,
              companyName,
              documentNumber: documentNumber || document.number || "",
              totalAmount:
                totalAmount != null
                  ? new Intl.NumberFormat("fr-FR", {
                      style: "currency",
                      currency: "EUR",
                    }).format(totalAmount)
                  : null,
              qualified: signatureType === "QES_otp",
            }).catch((err) =>
              logger.error(
                `Envoi invitations signature (devis ${documentNumber}): ${err.message}`,
              ),
            );
          }

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
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),

    /**
     * Apposer un cachet qualifié (QES automatique) sur le document signé d'un devis.
     * Exige une signature client (SES/QES_otp) terminée. Ne change pas le statut du devis.
     */
    sealQuoteDocument: requireWrite("quotes")(
      async (_, { quoteId }, context) => {
        try {
          const quote = await Quote.findOne({
            _id: quoteId,
            workspaceId: context.workspaceId,
          });
          if (!quote) {
            throw new AppError("Devis non trouvé", ERROR_CODES.NOT_FOUND);
          }

          // Exiger une signature client terminée (hors cachet entreprise)
          const clientSignature = await SignatureRequest.findOne({
            documentType: "quote",
            documentId: quoteId,
            signatureType: { $ne: "QES_automatic" },
            status: "DONE",
          }).sort({ createdAt: -1 });

          if (!clientSignature || !clientSignature.externalSignatureId) {
            throw new AppError(
              "Le devis doit d'abord être signé par le client avant d'être cacheté.",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Empêcher un double cachet
          const existingSeal = await SignatureRequest.findOne({
            documentType: "quote",
            documentId: quoteId,
            signatureType: "QES_automatic",
            status: {
              $in: [
                "PENDING",
                "WAIT_VALIDATION",
                "WAIT_SIGN",
                "WAIT_SIGNER",
                "DONE",
              ],
            },
          });
          if (existingSeal) {
            // Auto-annuler un cachet PENDING orphelin (jamais envoyé), sinon bloquer
            if (
              existingSeal.status === "PENDING" &&
              !existingSeal.externalSignatureId
            ) {
              existingSeal.status = "CANCELLED";
              await existingSeal.save();
            } else {
              throw new AppError(
                existingSeal.status === "DONE"
                  ? "Ce devis a déjà été cacheté."
                  : "Un cachet est déjà en cours pour ce devis.",
                ERROR_CODES.VALIDATION_ERROR,
              );
            }
          }

          // Récupérer le document signé par le client
          const signedDocBuffer =
            await esignatureService.downloadSignedDocument(
              clientSignature.externalSignatureId,
            );
          if (!signedDocBuffer || !Buffer.isBuffer(signedDocBuffer)) {
            throw new AppError(
              "Impossible de récupérer le document signé à cacheter.",
              ERROR_CODES.INTERNAL_ERROR,
            );
          }

          // Créer l'entrée de cachet
          const sealRequest = new SignatureRequest({
            organizationId: context.organizationId,
            workspaceId: context.workspaceId,
            documentType: "quote",
            documentId: quoteId,
            documentNumber: quote.number || null,
            signatureType: "QES_automatic",
            status: "PENDING",
            signers: [],
            createdBy: context.user._id,
          });
          await sealRequest.save();

          const callbackConfig = esignatureService.buildCallbackConfig(
            sealRequest._id.toString(),
          );

          const apiResult = await esignatureService.createQESAutomatic(
            signedDocBuffer,
            {
              title: `Cachet devis ${quote.number || ""}`,
              // Même ligne que la signature client (bas), cachet à gauche
              page: 1,
              x: 50,
              y: 730,
            },
            callbackConfig,
          );

          const resultData = apiResult.data || apiResult;
          sealRequest.externalSignatureId = resultData.id || resultData._id;
          sealRequest.status = mapExternalStatus(
            resultData.state || "WAIT_VALIDATION",
          );
          await sealRequest.save();
          publishSignatureStatus(sealRequest);

          logger.info(`Cachet QES créé pour devis ${quote.number || quoteId}`);

          return {
            success: true,
            message: "Cachet qualifié appliqué au document signé",
            signatureRequest: sealRequest,
          };
        } catch (error) {
          logger.error("Erreur cachet devis:", error);
          if (error instanceof AppError) throw error;
          throw new AppError(
            error.message || "Erreur lors de l'application du cachet",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
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
              ERROR_CODES.NOT_FOUND,
            );
          }

          if (["DONE", "CANCELLED"].includes(signatureRequest.status)) {
            throw new AppError(
              "Cette signature ne peut plus être annulée",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Supprimer côté API eSignature
          if (signatureRequest.externalSignatureId) {
            try {
              await esignatureService.deleteSignature(
                signatureRequest.externalSignatureId,
              );
            } catch (err) {
              logger.warn(
                `Impossible de supprimer la signature externe: ${err.message}`,
              );
            }
          }

          signatureRequest.status = "CANCELLED";
          await signatureRequest.save();
          publishSignatureStatus(signatureRequest);

          logger.info(`Signature ${signatureId} annulée`);

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
            error.message || "Erreur lors de l'annulation de la signature",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
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
              ERROR_CODES.NOT_FOUND,
            );
          }

          if (signatureRequest.status !== "ERROR") {
            throw new AppError(
              "Seules les signatures en erreur peuvent être relancées",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }

          // Supprimer l'ancienne signature côté API
          if (signatureRequest.externalSignatureId) {
            try {
              await esignatureService.deleteSignature(
                signatureRequest.externalSignatureId,
              );
            } catch (err) {
              logger.warn(
                `Impossible de supprimer l'ancienne signature: ${err.message}`,
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
            error.message || "Erreur lors de la relance de la signature",
            ERROR_CODES.INTERNAL_ERROR,
          );
        }
      },
    ),
  },

  Subscription: {
    // Mises à jour temps réel du statut de signature d'un document.
    signatureStatusUpdated: {
      subscribe: (_, { documentId }) =>
        getPubSub().asyncIterableIterator([signatureChannel(documentId)]),
    },
  },
};

export default esignatureResolvers;
