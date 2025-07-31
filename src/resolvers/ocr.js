/**
 * Resolvers GraphQL pour l'OCR avec Mistral
 */

import { GraphQLUpload } from 'graphql-upload';
import { isAuthenticated } from '../middlewares/auth.js';
import mistralOcrService from '../services/mistralOcrService.js';
import cloudflareService from '../services/cloudflareService.js';
import financialAnalysisService from '../services/financialAnalysisService.js';
import OcrDocument from '../models/OcrDocument.js';
import { 
  createValidationError,
  createInternalServerError 
} from '../utils/errors.js';

const ocrResolvers = {
  Upload: GraphQLUpload,

  Mutation: {
    /**
     * Effectue l'OCR sur un document avec l'API Mistral
     */
    processDocumentOcr: isAuthenticated(async (_, { file, options = {} }, { user }) => {
      try {
        // Vérifier si le service Mistral est configuré
        if (!mistralOcrService.isConfigured()) {
          throw createValidationError('Service OCR non configuré. Veuillez contacter l\'administrateur.');
        }

        const { createReadStream, filename, mimetype } = await file;

        // Validation du nom de fichier
        if (!filename) {
          throw createValidationError('Nom de fichier requis');
        }

        // Validation du MIME type
        const supportedTypes = [
          'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
          'application/pdf', 'application/octet-stream', 'image/tiff', 'image/bmp'
        ];

        if (!supportedTypes.includes(mimetype)) {
          throw createValidationError(
            `Type de fichier non supporté: ${mimetype}. ` +
            'Formats supportés: JPG, PNG, GIF, WebP, PDF, TIFF, BMP'
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
          throw createValidationError('Fichier trop volumineux (max 10MB)');
        }

        console.log(`🔍 Début OCR pour: ${filename} (${mimetype}, ${fileBuffer.length} bytes)`);
        console.log('📋 Options OCR reçues dans le resolver:', JSON.stringify(options, null, 2));

        // Étape 1: Upload du fichier sur Cloudflare pour obtenir une URL publique
        console.log('📤 Upload du fichier sur Cloudflare...');
        const uploadResult = await cloudflareService.uploadImage(
          fileBuffer,
          filename,
          user.id,
          'ocr-documents'
        );

        if (!uploadResult.url) {
          throw createInternalServerError('Impossible d\'obtenir l\'URL publique du document');
        }

        console.log('✅ Fichier uploadé sur Cloudflare:', uploadResult.url);

        // Étape 2: Validation et nettoyage des options OCR
        const validatedOptions = mistralOcrService.validateOptions(options);

        // Étape 3: Traitement OCR avec Mistral en utilisant l'URL publique
        console.log('🔍 Appel API Mistral OCR...');
        const ocrResult = await mistralOcrService.processDocumentFromUrl(
          uploadResult.url,
          filename,
          mimetype,
          validatedOptions
        );

        console.log(`✅ OCR terminé pour: ${filename}`);

        // Étape 4: Extraction des données structurées pour les reçus
        console.log('📊 Extraction des données structurées du reçu...');
        const structuredData = mistralOcrService.extractReceiptData(ocrResult);
        console.log('✅ Données structurées extraites:', structuredData);

        // Étape 5: Sauvegarde du document OCR en base de données
        console.log('💾 Sauvegarde du document OCR en base de données...');
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
            confidence: structuredData.confidence
          },
          documentType: 'receipt',
          status: 'completed',
          processingMetadata: {
            processedAt: new Date(),
            ocrProvider: 'mistral'
          }
        });
        
        const savedDocument = await ocrDocument.save();
        console.log('✅ Document OCR sauvegardé avec ID:', savedDocument._id);

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
            documentId: savedDocument._id.toString() // ID du document sauvegardé
          }),
          metadata: {
            fileName: ocrResult.metadata.fileName,
            mimeType: ocrResult.metadata.mimeType,
            fileSize: fileBuffer.length, // Garder la taille originale
            processedAt: ocrResult.metadata.processedAt,
            documentUrl: uploadResult.url, // URL Cloudflare
            cloudflareKey: uploadResult.key, // Pour suppression ultérieure si nécessaire
            documentId: savedDocument._id.toString() // ID du document en BDD
          },
          message: 'OCR effectué avec succès - Données structurées extraites'
        };

      } catch (error) {
        console.error('Erreur OCR:', error);
        
        // Si c'est une erreur de validation, la relancer telle quelle
        if (error.message.includes('Validation') || error.name === 'AppError') {
          throw error;
        }
        
        // Sinon, créer une erreur interne
        throw createInternalServerError(`Erreur lors du traitement OCR: ${error.message}`);
      }
    }),

    /**
     * Effectue l'OCR sur un document déjà uploadé sur Cloudflare
     */
    processDocumentOcrFromUrl: isAuthenticated(async (_, { cloudflareUrl, fileName, mimeType, fileSize, options = {} }, { user }) => {
      try {
        // Vérifier si le service Mistral est configuré
        if (!mistralOcrService.isConfigured()) {
          throw createValidationError('Service OCR non configuré. Veuillez contacter l\'administrateur.');
        }

        // Validation des paramètres
        if (!cloudflareUrl) {
          throw createValidationError('URL Cloudflare requise');
        }
        if (!fileName) {
          throw createValidationError('Nom de fichier requis');
        }
        if (!mimeType) {
          throw createValidationError('Type MIME requis');
        }

        // Validation du MIME type
        const supportedTypes = [
          'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
          'application/pdf', 'application/octet-stream', 'image/tiff', 'image/bmp'
        ];

        if (!supportedTypes.includes(mimeType)) {
          throw createValidationError(
            `Type de fichier non supporté: ${mimeType}. ` +
            'Formats supportés: JPG, PNG, GIF, WebP, PDF, TIFF, BMP'
          );
        }

        console.log(`🔍 Début OCR depuis URL: ${fileName} (${mimeType})`);
        console.log('🔗 URL Cloudflare:', cloudflareUrl);
        console.log('📋 Options OCR reçues:', JSON.stringify(options, null, 2));

        // Étape 1: Appel de l'API Mistral OCR avec l'URL Cloudflare
        console.log('🔍 Appel API Mistral OCR...');
        const ocrResult = await mistralOcrService.processDocumentFromUrl(cloudflareUrl, fileName, mimeType, options);

        if (!ocrResult.success) {
          throw createInternalServerError(`Erreur OCR: ${ocrResult.message}`);
        }

        console.log('✅ OCR traité avec succès');
        console.log('📊 Résultat OCR:', {
          success: ocrResult.success,
          extractedText: ocrResult.extractedText,
          extractedTextType: typeof ocrResult.extractedText,
          extractedTextLength: ocrResult.extractedText?.length || 0,
          hasData: !!ocrResult.data,
          dataType: typeof ocrResult.data
        });

        // Étape 2: Analyse financière des données OCR
        console.log('💰 Analyse financière du document...');
        const financialAnalysis = await financialAnalysisService.analyzeDocument(ocrResult);
        
        console.log('📊 Résultat de l\'analyse financière:', {
          success: financialAnalysis.success,
          type: financialAnalysis.transaction_data?.type,
          amount: financialAnalysis.transaction_data?.amount,
          vendor: financialAnalysis.transaction_data?.vendor_name,
          category: financialAnalysis.transaction_data?.category
        });
        
        // Étape 3: Sauvegarder le résultat en base de données
        console.log('💾 Sauvegarde en base de données...');
        
        // Extraire la clé Cloudflare depuis l'URL si possible
        let cloudflareKey = 'unknown';
        try {
          const url = new URL(cloudflareUrl);
          cloudflareKey = url.pathname.substring(1); // Enlever le '/' du début
        } catch (error) {
          console.warn('⚠️ Impossible d\'extraire la clé Cloudflare depuis l\'URL:', cloudflareUrl);
        }
        
        const ocrDocument = new OcrDocument({
          userId: user.id,
          originalFileName: fileName,
          mimeType: mimeType,
          fileSize: fileSize || 0, // Utiliser la taille fournie ou 0 par défaut
          documentUrl: cloudflareUrl,
          cloudflareKey: cloudflareKey,
          extractedText: ocrResult.extractedText || 'Aucun texte extrait', // S'assurer qu'il n'est pas undefined ou vide
          rawOcrData: ocrResult.data || {}, // Données brutes de Mistral
          structuredData: ocrResult.structuredData || {}, // Données structurées parsées
          financialAnalysis: financialAnalysis || {}, // Analyse financière
          metadata: {
            model: ocrResult.metadata?.model || options.model || 'mistral-ocr',
            processedAt: new Date().toISOString(),
            pagesProcessed: ocrResult.metadata?.pagesProcessed || 0,
            docSizeBytes: ocrResult.metadata?.docSizeBytes || 0,
            options: options
          },
          createdAt: new Date(),
          updatedAt: new Date()
        });

        const savedDocument = await ocrDocument.save();
        console.log('✅ Document OCR sauvegardé avec ID:', savedDocument._id);

        // Retourner le résultat structuré avec analyse financière
        return {
          success: ocrResult.success,
          extractedText: ocrResult.extractedText,
          financialAnalysis: JSON.stringify(financialAnalysis), // Analyse financière sérialisée
          data: JSON.stringify({
            raw: ocrResult.data, // Données brutes de Mistral
            structured: ocrResult.structuredData, // Données structurées si disponibles
            financial: financialAnalysis // Analyse financière incluse
          }),
          metadata: {
            fileName: fileName,
            mimeType: mimeType,
            fileSize: null, // Pas de taille car on n'a pas le fichier
            processedAt: new Date().toISOString(),
            documentUrl: cloudflareUrl,
            cloudflareKey: null,
            documentId: savedDocument._id.toString()
          },
          message: 'Document traité avec succès'
        };

      } catch (error) {
        console.error('Erreur OCR depuis URL:', error);
        
        // Si c'est une erreur de validation, la relancer telle quelle
        if (error.message.includes('Validation') || error.name === 'AppError') {
          throw error;
        }
        
        // Sinon, créer une erreur serveur interne
        throw createInternalServerError(`Erreur lors du traitement OCR: ${error.message}`);
      }
    }),
  },
};

export default ocrResolvers;
