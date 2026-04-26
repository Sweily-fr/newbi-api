/**
 * Resolvers GraphQL pour l'OCR (Hybrid: Claude Vision + fallbacks)
 */

import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import { checkSubscriptionActive } from "../middlewares/rbac.js";
import mongoose from "mongoose";
import mistralOcrService from "../services/mistralOcrService.js";
import hybridOcrService from "../services/hybridOcrService.js";
import claudeVisionOcrService from "../services/claudeVisionOcrService.js";
import cloudflareService from "../services/cloudflareService.js";
import ocrCacheService from "../services/ocrCacheService.js";
import mistralIntelligentAnalysisService from "../services/mistralIntelligentAnalysisService.js";
import OcrDocument from "../models/OcrDocument.js";
import crypto from "crypto";
import {
  createValidationError,
  createInternalServerError,
} from "../utils/errors.js";

const ocrResolvers = {
  Upload: GraphQLUpload,

  Mutation: {
    /**
     * Effectue l'OCR sur un document — OCR direct sans aller-retour Cloudflare
     * Le fichier est lu en mémoire, envoyé directement à Claude Vision en base64,
     * puis uploadé sur Cloudflare en tâche de fond (fire & forget).
     */
    processDocumentOcr: isAuthenticated(
      async (
        _,
        { file, workspaceId, options = {} },
        { user, organizationId: contextOrgId },
      ) => {
        try {
          const { createReadStream, filename, mimetype } = await file;

          // Validation du nom de fichier
          if (!filename) {
            throw createValidationError("Nom de fichier requis");
          }

          // Validation du MIME type
          const supportedTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/gif",
            "image/webp",
            "application/pdf",
            "application/octet-stream",
            "image/tiff",
            "image/bmp",
          ];

          if (!supportedTypes.includes(mimetype)) {
            throw createValidationError(
              `Type de fichier non supporté: ${mimetype}. ` +
                "Formats supportés: JPG, PNG, GIF, WebP, PDF, TIFF, BMP",
            );
          }

          // Lecture du fichier en mémoire
          const stream = createReadStream();
          const chunks = [];

          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const fileBuffer = Buffer.concat(chunks);

          // Validation de la taille (max 10MB)
          const maxSize = 10 * 1024 * 1024; // 10MB
          if (fileBuffer.length > maxSize) {
            throw createValidationError("Fichier trop volumineux (max 10MB)");
          }

          // Hash du contenu pour le cache
          const contentHash = crypto
            .createHash("sha256")
            .update(fileBuffer)
            .digest("hex");

          // Vérifier le cache Redis
          const cached = await ocrCacheService.get(contentHash);
          if (cached) {
            console.log(`💾 OCR Cache HIT pour ${filename} — retour immédiat`);
            return cached;
          }

          // Convertir en base64 pour Claude Vision
          const base64Data = fileBuffer.toString("base64");

          let rawResult;
          let structuredResult;
          let financialAnalysis;
          let usedFallback = false;

          // Tentative 1: OCR direct via Claude Vision
          try {
            console.log(`🔍 OCR direct (processFromBase64) pour ${filename}`);
            rawResult = await claudeVisionOcrService.processFromBase64(
              base64Data,
              mimetype,
              filename,
              contentHash,
            );

            if (!rawResult.success) {
              throw new Error(
                rawResult.error || rawResult.message || "OCR échoué",
              );
            }

            // Formater les données structurées
            structuredResult =
              claudeVisionOcrService.toInvoiceFormat(rawResult);
            financialAnalysis = {
              transaction_data: structuredResult.transaction_data,
              extracted_fields: structuredResult.extracted_fields,
              document_analysis: structuredResult.document_analysis,
            };
          } catch (claudeError) {
            // Tentative 2: Fallback — upload Cloudflare + OCR hybride (Mistral, etc.)
            console.warn(`⚠️ Claude Vision échoué: ${claudeError.message}`);
            console.log(
              `🔄 Fallback: upload Cloudflare + OCR hybride pour ${filename}`,
            );

            try {
              // Utiliser organizationId du contexte GraphQL (header x-organization-id)
              const fallbackOrgId = contextOrgId || null;

              // Upload vers Cloudflare pour obtenir une URL publique
              const uploadResult = await cloudflareService.uploadImage(
                fileBuffer,
                filename,
                user.id,
                "ocr",
                fallbackOrgId,
              );

              if (!uploadResult?.url) {
                throw new Error("Échec upload Cloudflare");
              }

              console.log(`☁️ Upload Cloudflare OK: ${uploadResult.url}`);

              // OCR via service hybride (Mistral, Google, etc.)
              const hybridResult =
                await hybridOcrService.processDocumentFromUrl(
                  uploadResult.url,
                  filename,
                  mimetype,
                  workspaceId,
                );

              if (!hybridResult.success) {
                throw new Error(hybridResult.error || "OCR hybride échoué");
              }

              // Analyse intelligente si le provider n'est pas Claude
              if (hybridResult.provider === "claude-vision") {
                financialAnalysis = {
                  transaction_data: hybridResult.transaction_data,
                  extracted_fields: hybridResult.extracted_fields,
                  document_analysis: hybridResult.document_analysis,
                };
              } else {
                console.log("🤖 Analyse intelligente Mistral (fallback)...");
                financialAnalysis =
                  await mistralIntelligentAnalysisService.analyzeDocument(
                    hybridResult,
                  );
              }

              rawResult = {
                success: true,
                extractedText: hybridResult.extractedText || hybridResult.text,
                data: hybridResult.data || {},
                provider: hybridResult.provider || "hybrid-fallback",
                model: hybridResult.model || "fallback",
              };
              structuredResult = {
                extracted_fields:
                  financialAnalysis.extracted_fields ||
                  hybridResult.structuredData ||
                  {},
              };
              usedFallback = true;

              console.log(`✅ Fallback OCR réussi via ${rawResult.provider}`);
            } catch (fallbackError) {
              console.error(`❌ Fallback OCR échoué: ${fallbackError.message}`);
              throw createInternalServerError(
                `Erreur OCR (Claude + fallback): Claude: ${claudeError.message} | Fallback: ${fallbackError.message}`,
              );
            }
          }

          // Générer un ID de document
          const documentId = new mongoose.Types.ObjectId();

          // Construire la réponse
          const response = {
            success: true,
            extractedText: rawResult.extractedText,
            financialAnalysis: JSON.stringify(financialAnalysis),
            data: JSON.stringify({
              raw: rawResult.data,
              structured: structuredResult.extracted_fields || {},
              financial: financialAnalysis,
            }),
            metadata: {
              fileName: filename,
              mimeType: mimetype,
              fileSize: fileBuffer.length,
              processedAt: new Date().toISOString(),
              documentUrl: null,
              cloudflareKey: null,
              documentId: documentId.toString(),
            },
            message: `Document traité avec succès via ${rawResult.provider || "claude-vision"}`,
          };

          // Fire & forget: upload Cloudflare (si pas déjà fait) + save MongoDB + cache Redis
          (async () => {
            try {
              let documentUrl = null;
              let cloudflareKey = null;

              if (!usedFallback) {
                // Upload vers Cloudflare uniquement si pas déjà fait par le fallback
                const uploadResult = await cloudflareService.uploadImage(
                  fileBuffer,
                  filename,
                  user.id,
                  "ocr",
                  contextOrgId,
                );
                documentUrl = uploadResult.url;
                cloudflareKey = uploadResult.key;
              }

              // Sauvegarder en MongoDB
              const ocrDocument = new OcrDocument({
                _id: documentId,
                userId: user.id,
                workspaceId: workspaceId,
                originalFileName: filename,
                mimeType: mimetype,
                fileSize: fileBuffer.length,
                documentUrl: documentUrl,
                cloudflareKey: cloudflareKey,
                extractedText: rawResult.extractedText,
                rawOcrData: rawResult.data || {},
                structuredData: structuredResult.extracted_fields || {},
                financialAnalysis: financialAnalysis,
                metadata: {
                  model:
                    rawResult.model || rawResult.provider || "claude-vision",
                  processedAt: new Date().toISOString(),
                  provider: rawResult.provider,
                },
                createdAt: new Date(),
                updatedAt: new Date(),
              });

              await ocrDocument.save();
              console.log(
                `✅ OCR document sauvegardé (background): ${documentId}`,
              );

              // Cache Redis
              await ocrCacheService.set(contentHash, response);
            } catch (err) {
              console.error(
                "❌ Erreur background (upload/save/cache):",
                err.message,
              );
            }
          })();

          return response;
        } catch (error) {
          console.error("Erreur OCR:", error);

          if (
            error.message.includes("Validation") ||
            error.name === "AppError"
          ) {
            throw error;
          }

          throw createInternalServerError(
            `Erreur lors du traitement OCR: ${error.message}`,
          );
        }
      },
    ),

    /**
     * Effectue l'OCR sur un document déjà uploadé sur Cloudflare
     * Utilise hybridOcrService (Claude Vision par défaut) avec cache Redis
     */
    processDocumentOcrFromUrl: isAuthenticated(
      async (
        _,
        {
          cloudflareUrl,
          fileName,
          mimeType,
          fileSize,
          workspaceId,
          options = {},
        },
        { user },
      ) => {
        try {
          // Validation des paramètres
          if (!cloudflareUrl) {
            throw createValidationError("URL Cloudflare requise");
          }
          if (!fileName) {
            throw createValidationError("Nom de fichier requis");
          }
          if (!mimeType) {
            throw createValidationError("Type MIME requis");
          }

          // Validation du MIME type
          const supportedTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/gif",
            "image/webp",
            "application/pdf",
            "application/octet-stream",
            "image/tiff",
            "image/bmp",
          ];

          if (!supportedTypes.includes(mimeType)) {
            throw createValidationError(
              `Type de fichier non supporté: ${mimeType}. ` +
                "Formats supportés: JPG, PNG, GIF, WebP, PDF, TIFF, BMP",
            );
          }

          // Étape 0: Vérifier le cache Redis basé sur l'URL
          const urlHash = crypto
            .createHash("sha256")
            .update(cloudflareUrl)
            .digest("hex");
          const cached = await ocrCacheService.get(urlHash);

          if (cached) {
            console.log(`💾 OCR Cache HIT pour ${fileName} — retour immédiat`);
            return cached;
          }

          // Étape 1: OCR avec le service hybride (Claude Vision par défaut)
          const ocrResult = await hybridOcrService.processDocumentFromUrl(
            cloudflareUrl,
            fileName,
            mimeType,
            workspaceId,
          );

          if (!ocrResult.success) {
            throw createInternalServerError(
              `Erreur OCR: ${ocrResult.error || ocrResult.message}`,
            );
          }

          // Étape 2: Analyse financière
          // Si Claude Vision a fourni les données structurées, on les utilise directement
          // Sinon (fallback Mistral), on appelle l'analyse Mistral
          let financialAnalysis;

          if (ocrResult.provider === "claude-vision") {
            // Claude Vision fournit déjà transaction_data, extracted_fields, document_analysis
            console.log(
              "⚡ Claude Vision: données structurées disponibles, skip analyse Mistral",
            );
            financialAnalysis = {
              transaction_data: ocrResult.transaction_data,
              extracted_fields: ocrResult.extracted_fields,
              document_analysis: ocrResult.document_analysis,
            };
          } else {
            // Fallback: analyse avec Mistral AI
            console.log(
              "🤖 Démarrage de l'analyse intelligente avec Mistral AI...",
            );
            financialAnalysis =
              await mistralIntelligentAnalysisService.analyzeDocument(
                ocrResult,
              );
            console.log(
              "✅ Analyse intelligente terminée:",
              financialAnalysis.transaction_data?.vendor_name,
            );
          }

          // Étape 3: Sauvegarder le résultat en base de données (fire & forget)
          // Générer l'ID avant le save pour l'inclure dans la réponse
          const documentId = new mongoose.Types.ObjectId();

          // Extraire la clé Cloudflare depuis l'URL si possible
          let cloudflareKey = "unknown";
          try {
            const url = new URL(cloudflareUrl);
            cloudflareKey = url.pathname.substring(1);
          } catch (error) {
            console.warn(
              "⚠️ Impossible d'extraire la clé Cloudflare depuis l'URL:",
              cloudflareUrl,
            );
          }

          const ocrDocument = new OcrDocument({
            _id: documentId,
            userId: user.id,
            workspaceId: workspaceId,
            originalFileName: fileName,
            mimeType: mimeType,
            fileSize: fileSize || 0,
            documentUrl: cloudflareUrl,
            cloudflareKey: cloudflareKey,
            extractedText:
              ocrResult.extractedText ||
              ocrResult.text ||
              "Aucun texte extrait",
            rawOcrData: ocrResult.data || {},
            structuredData: ocrResult.structuredData || {},
            financialAnalysis: financialAnalysis || {},
            metadata: {
              model:
                ocrResult.model ||
                options.model ||
                ocrResult.provider ||
                "hybrid",
              processedAt: new Date().toISOString(),
              pagesProcessed: ocrResult.metadata?.pagesProcessed || 0,
              docSizeBytes: ocrResult.metadata?.docSizeBytes || 0,
              options: options,
              provider: ocrResult.provider,
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Fire & forget — ne pas bloquer la réponse
          ocrDocument.save().catch((err) => {
            console.error("❌ Erreur sauvegarde OcrDocument:", err.message);
          });

          // Construire la réponse
          const response = {
            success: true,
            extractedText: ocrResult.extractedText || ocrResult.text,
            financialAnalysis: JSON.stringify(financialAnalysis),
            data: JSON.stringify({
              raw: ocrResult.data,
              structured: ocrResult.structuredData || {},
              financial: financialAnalysis,
            }),
            metadata: {
              fileName: fileName,
              mimeType: mimeType,
              fileSize: null,
              processedAt: new Date().toISOString(),
              documentUrl: cloudflareUrl,
              cloudflareKey: null,
              documentId: documentId.toString(),
            },
            message: `Document traité avec succès via ${ocrResult.provider || "hybrid"}`,
          };

          // Étape 4: Sauvegarder dans le cache Redis (fire & forget)
          ocrCacheService.set(urlHash, response).catch((err) => {
            console.warn("⚠️ Erreur sauvegarde cache OCR:", err.message);
          });

          return response;
        } catch (error) {
          console.error("Erreur OCR depuis URL:", error);

          // Si c'est une erreur de validation, la relancer telle quelle
          if (
            error.message.includes("Validation") ||
            error.name === "AppError"
          ) {
            throw error;
          }

          // Sinon, créer une erreur serveur interne
          throw createInternalServerError(
            `Erreur lors du traitement OCR: ${error.message}`,
          );
        }
      },
    ),
  },
};

// ✅ Phase A.1 — Subscription check sur toutes les mutations OCR (fail-closed: coûts Claude Vision / Mistral AI)
const originalOcrMutations = ocrResolvers.Mutation;
ocrResolvers.Mutation = Object.fromEntries(
  Object.entries(originalOcrMutations).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context, { failClosed: true });
      return fn(parent, args, context, info);
    },
  ]),
);

export default ocrResolvers;
