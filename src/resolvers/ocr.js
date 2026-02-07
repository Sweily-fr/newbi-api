/**
 * Resolvers GraphQL pour l'OCR (Hybrid: Claude Vision + fallbacks)
 */

import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
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
      async (_, { file, workspaceId, options = {} }, { user }) => {
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
                "Formats supportés: JPG, PNG, GIF, WebP, PDF, TIFF, BMP"
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

          // OCR direct via Claude Vision (pas de téléchargement Cloudflare)
          console.log(`🔍 OCR direct (processFromBase64) pour ${filename}`);
          const rawResult = await claudeVisionOcrService.processFromBase64(
            base64Data,
            mimetype,
            filename,
            contentHash
          );

          if (!rawResult.success) {
            throw createInternalServerError(
              `Erreur OCR: ${rawResult.error || rawResult.message}`
            );
          }

          // Formater les données structurées
          const structuredResult = claudeVisionOcrService.toInvoiceFormat(rawResult);

          // Construire financialAnalysis depuis les données structurées
          const financialAnalysis = {
            transaction_data: structuredResult.transaction_data,
            extracted_fields: structuredResult.extracted_fields,
            document_analysis: structuredResult.document_analysis,
          };

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

          // Fire & forget: récupérer organizationId puis upload Cloudflare + save MongoDB + cache Redis
          (async () => {
            try {
              // Récupérer organizationId
              let organizationId = null;
              const rawOrgId =
                user.organizationId ||
                user.organization?.id ||
                user.organization?._id ||
                user.currentOrganizationId;

              if (rawOrgId) {
                organizationId = typeof rawOrgId === "object"
                  ? (rawOrgId._id?.toString() || rawOrgId.id?.toString() || rawOrgId.toString())
                  : rawOrgId.toString();
              } else {
                try {
                  const memberRecord = await mongoose.connection.db
                    .collection("member")
                    .findOne({ userId: new mongoose.Types.ObjectId(user.id) });
                  if (memberRecord?.organizationId) {
                    organizationId = memberRecord.organizationId.toString();
                  }
                } catch (err) {
                  console.warn("⚠️ Impossible de récupérer organizationId:", err.message);
                }
              }

              // Upload vers Cloudflare (background)
              const uploadResult = await cloudflareService.uploadImage(
                fileBuffer,
                filename,
                user.id,
                "ocr",
                organizationId
              );

              // Sauvegarder en MongoDB
              const ocrDocument = new OcrDocument({
                _id: documentId,
                userId: user.id,
                workspaceId: workspaceId,
                originalFileName: filename,
                mimeType: mimetype,
                fileSize: fileBuffer.length,
                documentUrl: uploadResult.url,
                cloudflareKey: uploadResult.key,
                extractedText: rawResult.extractedText,
                rawOcrData: rawResult.data || {},
                structuredData: structuredResult.extracted_fields || {},
                financialAnalysis: financialAnalysis,
                metadata: {
                  model: rawResult.model || rawResult.provider || "claude-vision",
                  processedAt: new Date().toISOString(),
                  provider: rawResult.provider,
                },
                createdAt: new Date(),
                updatedAt: new Date(),
              });

              await ocrDocument.save();
              console.log(`✅ OCR document sauvegardé (background): ${documentId}`);

              // Cache Redis
              await ocrCacheService.set(contentHash, response);
            } catch (err) {
              console.error("❌ Erreur background (upload/save/cache):", err.message);
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
            `Erreur lors du traitement OCR: ${error.message}`
          );
        }
      }
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
        { user }
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
                "Formats supportés: JPG, PNG, GIF, WebP, PDF, TIFF, BMP"
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
            workspaceId
          );

          if (!ocrResult.success) {
            throw createInternalServerError(
              `Erreur OCR: ${ocrResult.error || ocrResult.message}`
            );
          }

          // Étape 2: Analyse financière
          // Si Claude Vision a fourni les données structurées, on les utilise directement
          // Sinon (fallback Mistral), on appelle l'analyse Mistral
          let financialAnalysis;

          if (ocrResult.provider === "claude-vision") {
            // Claude Vision fournit déjà transaction_data, extracted_fields, document_analysis
            console.log(
              "⚡ Claude Vision: données structurées disponibles, skip analyse Mistral"
            );
            financialAnalysis = {
              transaction_data: ocrResult.transaction_data,
              extracted_fields: ocrResult.extracted_fields,
              document_analysis: ocrResult.document_analysis,
            };
          } else {
            // Fallback: analyse avec Mistral AI
            console.log(
              "🤖 Démarrage de l'analyse intelligente avec Mistral AI..."
            );
            financialAnalysis =
              await mistralIntelligentAnalysisService.analyzeDocument(ocrResult);
            console.log(
              "✅ Analyse intelligente terminée:",
              financialAnalysis.transaction_data?.vendor_name
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
              cloudflareUrl
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
            extractedText: ocrResult.extractedText || ocrResult.text || "Aucun texte extrait",
            rawOcrData: ocrResult.data || {},
            structuredData: ocrResult.structuredData || {},
            financialAnalysis: financialAnalysis || {},
            metadata: {
              model: ocrResult.model || options.model || ocrResult.provider || "hybrid",
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
            `Erreur lors du traitement OCR: ${error.message}`
          );
        }
      }
    ),
  },
};

export default ocrResolvers;
