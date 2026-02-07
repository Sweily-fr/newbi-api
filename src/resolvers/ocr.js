/**
 * Resolvers GraphQL pour l'OCR (Hybrid: Claude Vision + fallbacks)
 */

import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import mongoose from "mongoose";
import mistralOcrService from "../services/mistralOcrService.js";
import hybridOcrService from "../services/hybridOcrService.js";
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
     * Effectue l'OCR sur un document avec l'API Mistral
     */
    processDocumentOcr: isAuthenticated(
      async (_, { file, options = {} }, { user }) => {
        try {
          // Vérifier si le service Mistral est configuré
          if (!mistralOcrService.isConfigured()) {
            throw createValidationError(
              "Service OCR non configuré. Veuillez contacter l'administrateur."
            );
          }

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

          // Lecture du fichier
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

          if (!uploadResult.url) {
            throw createInternalServerError(
              "Impossible d'obtenir l'URL publique du document"
            );
          }

          // Étape 2: Validation et nettoyage des options OCR
          const validatedOptions = mistralOcrService.validateOptions(options);

          // Étape 3: Traitement OCR avec Mistral en utilisant l'URL publique
          const ocrResult = await mistralOcrService.processDocumentFromUrl(
            uploadResult.url,
            filename,
            mimetype,
            validatedOptions
          );

          // Étape 4: Extraction des données structurées pour les reçus
          const structuredData =
            mistralOcrService.extractReceiptData(ocrResult);

          // Étape 5: Sauvegarde du document OCR en base de données
          const ocrDocument = new OcrDocument({
            userId: user.id,
            originalFileName: filename,
            mimeType: mimetype,
            fileSize: fileBuffer.length,
            documentUrl: uploadResult.url,
            cloudflareKey: uploadResult.key,
            extractedText: ocrResult.extractedText,
            rawOcrData: ocrResult.data,
            structuredData: {
              amount: structuredData.amount,
              date: structuredData.date,
              merchant: structuredData.merchant,
              description: structuredData.description,
              category: structuredData.category,
              paymentMethod: structuredData.paymentMethod,
              confidence: structuredData.confidence,
            },
            documentType: "receipt",
            status: "completed",
            processingMetadata: {
              processedAt: new Date(),
              ocrProvider: "mistral",
            },
          });

          const savedDocument = await ocrDocument.save();

          // Étape 5: Optionnel - Supprimer le fichier temporaire de Cloudflare
          // (commenté pour permettre la consultation ultérieure)
          // try {
          //   await cloudflareService.deleteImage(uploadResult.key);
          //   console.log('🗑️ Fichier temporaire supprimé de Cloudflare');
          // } catch (error) {
          //   console.warn('Impossible de supprimer le fichier temporaire:', error.message);
          // }

          return {
            success: ocrResult.success,
            extractedText: ocrResult.extractedText,
            data: JSON.stringify({
              raw: ocrResult.data, // Données brutes de Mistral
              structured: structuredData, // Données structurées pour le frontend
              documentId: savedDocument._id.toString(), // ID du document sauvegardé
            }),
            metadata: {
              fileName: ocrResult.metadata.fileName,
              mimeType: ocrResult.metadata.mimeType,
              fileSize: fileBuffer.length, // Garder la taille originale
              processedAt: ocrResult.metadata.processedAt,
              documentUrl: uploadResult.url, // URL Cloudflare
              cloudflareKey: uploadResult.key, // Pour suppression ultérieure si nécessaire
              documentId: savedDocument._id.toString(), // ID du document en BDD
            },
            message: "OCR effectué avec succès - Données structurées extraites",
          };
        } catch (error) {
          console.error("Erreur OCR:", error);

          // Si c'est une erreur de validation, la relancer telle quelle
          if (
            error.message.includes("Validation") ||
            error.name === "AppError"
          ) {
            throw error;
          }

          // Sinon, créer une erreur interne
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
