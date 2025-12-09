/**
 * Service pour l'OCR avec l'API Mistral
 */

import fetch from "node-fetch";
import FormData from "form-data";
import dotenv from "dotenv";

dotenv.config();

class MistralOcrService {
  constructor() {
    this.apiKey = process.env.MISTRAL_API_KEY;
    this.endpoint =
      process.env.MISTRAL_OCR_ENDPOINT || "https://api.mistral.ai/v1/ocr";

    if (!this.apiKey) {
      console.warn(
        "⚠️ MISTRAL_API_KEY non définie dans les variables d'environnement"
      );
    }
  }

  /**
   * Effectue l'OCR sur un fichier via URL publique
   * @param {string} documentUrl - URL publique du document
   * @param {string} fileName - Nom du fichier
   * @param {string} mimeType - Type MIME du fichier
   * @param {Object} options - Options pour l'OCR
   * @returns {Promise<Object>} - Résultat de l'OCR
   */
  async processDocumentFromUrl(documentUrl, fileName, mimeType, options = {}) {
    try {
      if (!this.apiKey) {
        throw new Error("Clé API Mistral non configurée");
      }

      // Validation du type de fichier
      const supportedTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/pdf",
        "application/octet-stream", // Support pour les fichiers dont le MIME type n'est pas détecté correctement
        "image/tiff",
        "image/bmp",
      ];

      if (!supportedTypes.includes(mimeType)) {
        throw new Error(`Type de fichier non supporté: ${mimeType}`);
      }

      // Validation de l'URL
      if (!documentUrl || !documentUrl.startsWith("http")) {
        throw new Error("URL de document invalide");
      }

      // Forcer l'utilisation du modèle OCR correct (ignorer le modèle passé en option)
      const modelToUse = "mistral-ocr-latest"; // Toujours utiliser le modèle OCR

      // Configuration de base pour l'API Mistral
      const requestBody = {
        model: modelToUse,
        document: {
          type: "document_url",
          document_url: documentUrl,
        },
      };

      // Options avancées
      if (options.pages) {
        requestBody.pages = options.pages;
      }

      if (options.includeImageBase64) {
        requestBody.include_image_base64 = options.includeImageBase64;
      }

      if (options.imageLimit) {
        requestBody.image_limit = options.imageLimit;
      }

      if (options.imageMinSize) {
        requestBody.image_min_size = options.imageMinSize;
      }

      if (options.bboxAnnotationFormat) {
        requestBody.bbox_annotation_format = options.bboxAnnotationFormat;
      }

      if (options.documentAnnotationFormat) {
        requestBody.document_annotation_format =
          options.documentAnnotationFormat;
      }

      // Appel à l'API Mistral avec retry et backoff exponentiel
      const MAX_RETRIES = 3;
      const INITIAL_DELAY = 3000; // 3 secondes
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (response.ok) {
          const result = await response.json();
          // Succès - continuer le traitement
          return this.processOcrResult(result, fileName, mimeType, documentUrl);
        }

        // Gestion des erreurs
        const errorText = await response.text();
        
        // Rate limiting (429) - retry avec backoff
        if (response.status === 429 && attempt < MAX_RETRIES) {
          const delay = INITIAL_DELAY * Math.pow(2, attempt - 1); // 3s, 6s, 12s
          console.warn(`⚠️ Rate limit Mistral OCR (tentative ${attempt}/${MAX_RETRIES}), retry dans ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          lastError = `Rate limit (429)`;
          continue;
        }

        // Autre erreur ou dernière tentative
        console.error("Erreur API Mistral:", response.status, errorText);
        throw new Error(
          `Erreur API Mistral (${response.status}): ${errorText}`
        );
      }

      // Si on arrive ici, toutes les tentatives ont échoué
      throw new Error(`Échec après ${MAX_RETRIES} tentatives: ${lastError}`);
    } catch (error) {
      console.error('Erreur lors du traitement OCR:', error);
      throw new Error(`Échec de l'OCR: ${error.message}`);
    }
  }

  /**
   * Traite le résultat OCR et retourne les données structurées
   */
  processOcrResult(result, fileName, mimeType, documentUrl) {
    // Extraire le texte brut
    const extractedText = this.extractTextFromResult(result);

    // Parser le markdown pour obtenir des données structurées
    const structuredData = this.parseMarkdownToStructuredData(extractedText);

    return {
      success: true,
      data: result,
      extractedText: extractedText,
      structuredData: structuredData,
      metadata: {
        fileName,
        mimeType,
        documentUrl,
        processedAt: new Date().toISOString(),
        model: result.model || 'mistral-ocr-latest',
        pagesProcessed: result.usage_info?.pages_processed || 0,
        docSizeBytes: result.usage_info?.doc_size_bytes || 0,
      },
    };
  }

  /**
   * Extrait le texte principal du résultat Mistral
   * @param {Object} result - Résultat de l'API Mistral
   * @returns {string} - Texte extrait
   */
  extractTextFromResult(result) {
    try {
      // Structure moderne de Mistral OCR: pages avec markdown
      if (result.pages && Array.isArray(result.pages)) {
        const extractedText = result.pages
          .map((page) => {
            // Priorité au markdown (format structuré)
            if (page.markdown) {
              return page.markdown;
            }
            // Fallback sur text
            if (page.text) {
              return page.text;
            }
            // Fallback sur blocks
            if (page.blocks && Array.isArray(page.blocks)) {
              return page.blocks.map((block) => block.text || "").join(" ");
            }
            return "";
          })
          .filter((text) => text.trim()) // Supprimer les pages vides
          .join("\n\n");

        if (extractedText.trim()) {
          return extractedText;
        }
      }

      // Structure legacy: text direct
      if (result.text) {
        return result.text;
      }

      // Structure legacy: content array
      if (result.content && Array.isArray(result.content)) {
        const extractedText = result.content
          .map((item) => item.text || "")
          .join("\n");
        if (extractedText.trim()) {
          return extractedText;
        }
      }

      console.warn(
        "⚠️ Aucun texte trouvé dans la structure, utilisation du fallback JSON"
      );
      return JSON.stringify(result, null, 2);
    } catch (error) {
      console.error("❌ Erreur lors de l'extraction du texte:", error);
      return "Erreur lors de l'extraction du texte";
    }
  }

  /**
   * Parse le markdown pour extraire des données structurées
   * @param {string} markdown - Contenu markdown
   * @returns {Object} - Données structurées
   */
  parseMarkdownToStructuredData(markdown) {
    try {
      const data = {
        rawText: markdown,
        title: null,
        sections: [],
        tables: [],
        metadata: {},
      };

      const lines = markdown.split("\n");
      let currentSection = null;
      let inTable = false;
      let tableHeaders = [];
      let tableRows = [];

      for (const line of lines) {
        const trimmed = line.trim();

        // Titre principal (# FACTURE)
        if (trimmed.startsWith("# ") && !data.title) {
          data.title = trimmed.substring(2).trim();
        }

        // Sections (## Section)
        else if (trimmed.startsWith("## ")) {
          if (currentSection) {
            data.sections.push(currentSection);
          }
          currentSection = {
            title: trimmed.substring(3).trim(),
            content: [],
          };
          inTable = false;
        }

        // Détection de tableau
        else if (trimmed.includes("|") && trimmed.split("|").length > 2) {
          if (!inTable) {
            // Première ligne du tableau (headers)
            tableHeaders = trimmed
              .split("|")
              .map((h) => h.trim())
              .filter((h) => h);
            inTable = true;
            tableRows = [];
          } else if (!trimmed.includes("---")) {
            // Ligne de données (ignorer la ligne de séparation ---)
            const row = trimmed
              .split("|")
              .map((cell) => cell.trim())
              .filter((cell) => cell);
            if (row.length > 0) {
              tableRows.push(row);
            }
          }
        }

        // Fin de tableau ou contenu normal
        else {
          if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
            data.tables.push({
              headers: tableHeaders,
              rows: tableRows,
            });
            inTable = false;
          }

          if (currentSection && trimmed) {
            currentSection.content.push(trimmed);
          }
        }
      }

      // Ajouter la dernière section
      if (currentSection) {
        data.sections.push(currentSection);
      }

      // Ajouter le dernier tableau
      if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
        data.tables.push({
          headers: tableHeaders,
          rows: tableRows,
        });
      }

      return data;
    } catch (error) {
      console.error("❌ Erreur lors du parsing du markdown:", error);
      return {
        rawText: markdown,
        title: null,
        sections: [],
        tables: [],
        metadata: {},
        error: error.message,
      };
    }
  }

  /**
   * Valide les options d'OCR
   * @param {Object} options - Options à valider
   * @returns {Object} - Options validées
   */
  validateOptions(options = {}) {
    const validatedOptions = {};

    // Validation du modèle
    if (options.model && typeof options.model === "string") {
      validatedOptions.model = options.model;
    }

    // Validation des pages
    if (options.pages && Array.isArray(options.pages)) {
      validatedOptions.pages = options.pages.filter(
        (page) => typeof page === "number" && page >= 0
      );
    }

    // Validation des options booléennes
    if (typeof options.includeImageBase64 === "boolean") {
      validatedOptions.includeImageBase64 = options.includeImageBase64;
    }

    // Validation des limites numériques
    if (
      options.imageLimit &&
      typeof options.imageLimit === "number" &&
      options.imageLimit > 0
    ) {
      validatedOptions.imageLimit = Math.min(options.imageLimit, 100); // Limite max
    }

    if (
      options.imageMinSize &&
      typeof options.imageMinSize === "number" &&
      options.imageMinSize > 0
    ) {
      validatedOptions.imageMinSize = options.imageMinSize;
    }

    // Validation des formats d'annotation
    if (
      options.bboxAnnotationFormat &&
      typeof options.bboxAnnotationFormat === "object"
    ) {
      validatedOptions.bboxAnnotationFormat = options.bboxAnnotationFormat;
    }

    if (
      options.documentAnnotationFormat &&
      typeof options.documentAnnotationFormat === "object"
    ) {
      validatedOptions.documentAnnotationFormat =
        options.documentAnnotationFormat;
    }

    return validatedOptions;
  }

  /**
   * Vérifie si le service est configuré correctement
   * @returns {boolean}
   */
  isConfigured() {
    return !!this.apiKey;
  }
}

// Instance singleton
const mistralOcrService = new MistralOcrService();

export default mistralOcrService;
