import logger from "../utils/logger.js";
/**
 * Hybrid OCR Service
 * Utilise le meilleur OCR disponible avec fallback automatique
 *
 * Ordre de priorité (configurable via OCR_PROVIDER):
 * 0. Claude Vision (par défaut) - API Anthropic, excellent pour factures FR
 * 1. Mindee OCR (si configuré et quota disponible) - Gratuit 250/mois, très précis
 * 2. Google Document AI (si configuré) - Gratuit 1000/mois, précis pour les factures
 * 3. Mistral OCR (fallback) - Bon pour le texte général
 * 4. Tesseract (dernier recours) - Gratuit et local, sans quota : images via
 *    OCR, PDF via leur couche texte. Champs extraits par regex (qualité
 *    "partial", à vérifier par l'utilisateur).
 *
 * Variables d'environnement:
 * - OCR_PROVIDER: Provider par défaut ("claude-vision", "mindee", "google-document-ai", "mistral-ocr")
 * - OCR_DISABLE_CLAUDE: "true" pour désactiver Claude Vision
 * - OCR_DISABLE_TESSERACT: "true" pour désactiver le dernier recours gratuit
 */

import claudeVisionOcrService from "./claudeVisionOcrService.js";
import mindeeOcrService from "./mindeeOcrService.js";
import googleDocumentAI from "./googleDocumentAIService.js";
import mistralOcrService from "./mistralOcrService.js";
import tesseractOcrService from "./tesseractOcrService.js";
import ocrCacheService from "./ocrCacheService.js";
import OcrUsage from "../models/OcrUsage.js";
import { extractInvoiceFieldsFromText } from "../utils/ocrTextFallback.js";
import { assertSafeDownloadUrl } from "../utils/ssrfGuard.js";

/**
 * Complète un résultat OCR "texte seul" (Google OCR basique, Tesseract) avec
 * des champs extraits par regex : montants FR/EN, devise, dates, numéro,
 * fournisseur. Marque le résultat "partial" pour que l'appelant sache que ces
 * champs n'ont pas été validés par une IA.
 */
function applyTextFallback(result, providerName) {
  const text = result.extractedText || result.text || "";
  if (!text) return result;
  try {
    const fallback = extractInvoiceFieldsFromText(text);
    if (!fallback.found) return result;
    result.transaction_data = fallback.transaction_data;
    result.extracted_fields = {
      ...(result.extracted_fields || {}),
      ...fallback.extracted_fields,
    };
    result.extractionQuality = "partial";
    logger.debug(
      `📝 ${providerName}: champs extraits par regex (TTC: ${fallback.transaction_data.amount} ${fallback.transaction_data.currency}, N°: ${fallback.transaction_data.document_number || "?"}, fournisseur: ${fallback.transaction_data.vendor_name || "?"})`,
    );
  } catch (extractionError) {
    console.warn(
      `⚠️ Extraction regex de secours échouée (${providerName}):`,
      extractionError.message,
    );
  }
  return result;
}

class HybridOcrService {
  constructor() {
    this.providers = [];
    this.initialized = false;
    this.lastWorkspaceId = null;
    // Provider par défaut configurable via variable d'environnement
    this.defaultProvider = process.env.OCR_PROVIDER || "claude-vision";
  }

  /**
   * Initialise les providers (appelé au premier usage)
   * @param {string} workspaceId - ID du workspace pour vérifier les quotas
   */
  async initProviders(workspaceId = null) {
    // Réinitialiser si le workspace change (pour vérifier les quotas)
    if (this.initialized && this.lastWorkspaceId === workspaceId) {
      return;
    }

    this.providers = [];
    this.lastWorkspaceId = workspaceId;

    // Déterminer les priorités selon le provider par défaut configuré
    const getPriority = (providerName) => {
      if (providerName === this.defaultProvider) return 0;
      const basePriorities = {
        "claude-vision": 1,
        mindee: 2,
        "google-document-ai": 3,
        "mistral-ocr": 4,
        tesseract: 9,
      };
      return basePriorities[providerName] || 5;
    };

    // Claude Vision (priorité 0 par défaut) - API Anthropic
    const claudeDisabled = process.env.OCR_DISABLE_CLAUDE === "true";
    if (!claudeDisabled && claudeVisionOcrService.isAvailable()) {
      this.providers.push({
        name: "claude-vision",
        service: claudeVisionOcrService,
        priority: getPriority("claude-vision"),
      });
      logger.debug(
        `✅ Claude Vision OCR disponible (priorité ${getPriority("claude-vision")}) - Provider Anthropic`,
      );
    } else if (claudeDisabled) {
      logger.debug("ℹ️ Claude Vision OCR désactivé via OCR_DISABLE_CLAUDE");
    }

    // Mindee OCR - Gratuit 250/mois, très précis pour les factures françaises
    if (mindeeOcrService.isAvailable()) {
      let mindeeAvailable = true;
      let mindeeUsage = 0;

      // Vérifier le quota si workspaceId fourni
      if (workspaceId) {
        try {
          mindeeUsage = await OcrUsage.getCurrentUsage(workspaceId, "mindee");
          mindeeAvailable = mindeeUsage < 250;
        } catch (error) {
          console.warn("⚠️ Erreur vérification quota Mindee:", error.message);
          mindeeAvailable = true; // En cas d'erreur, on essaie quand même
        }
      }

      if (mindeeAvailable) {
        this.providers.push({
          name: "mindee",
          service: mindeeOcrService,
          priority: getPriority("mindee"),
        });
        logger.debug(
          `✅ Mindee OCR disponible (priorité ${getPriority("mindee")}) - ${mindeeUsage}/250 utilisés ce mois`,
        );
      } else {
        logger.debug(
          `⚠️ Mindee OCR: quota atteint (${mindeeUsage}/250) - basculement vers fallback`,
        );
      }
    }

    // Google Document AI - Gratuit 1000/mois
    if (googleDocumentAI.isAvailable()) {
      this.providers.push({
        name: "google-document-ai",
        service: googleDocumentAI,
        priority: getPriority("google-document-ai"),
      });
      logger.debug(
        `✅ Google Document AI disponible (priorité ${getPriority("google-document-ai")})`,
      );
    }

    // Mistral OCR - Fallback
    if (process.env.MISTRAL_API_KEY) {
      this.providers.push({
        name: "mistral-ocr",
        service: mistralOcrService,
        priority: getPriority("mistral-ocr"),
      });
      logger.debug(
        `✅ Mistral OCR disponible (priorité ${getPriority("mistral-ocr")})`,
      );
    }

    // Tesseract - Dernier recours gratuit et local (toujours disponible)
    if (tesseractOcrService.isAvailable()) {
      this.providers.push({
        name: "tesseract",
        service: tesseractOcrService,
        priority: getPriority("tesseract"),
      });
      logger.debug(
        `✅ Tesseract OCR disponible (priorité ${getPriority("tesseract")}) - gratuit, dernier recours`,
      );
    } else {
      logger.debug("ℹ️ Tesseract OCR désactivé via OCR_DISABLE_TESSERACT");
    }

    // Trier par priorité
    this.providers.sort((a, b) => a.priority - b.priority);

    logger.debug(
      `🔧 OCR Hybride: ${this.providers.length} provider(s) - Ordre: ${this.providers.map((p) => p.name).join(" → ")} (défaut: ${this.defaultProvider})`,
    );

    this.initialized = true;
  }

  /**
   * Traite un document avec le meilleur OCR disponible
   * Compatible avec l'interface de mistralOcrService
   * @param {string} documentUrl - URL du document
   * @param {string} fileName - Nom du fichier
   * @param {string} mimeType - Type MIME
   * @param {string} workspaceId - ID du workspace (pour gestion quota Mindee)
   */
  async processDocumentFromUrl(
    documentUrl,
    fileName,
    mimeType,
    workspaceId = null,
  ) {
    // 🔐 Anti-SSRF : valider l'URL fournie (souvent client-contrôlée) avant tout
    // téléchargement serveur, quel que soit le provider OCR retenu.
    assertSafeDownloadUrl(documentUrl);

    // Initialiser les providers au premier appel (avec vérification quota)
    await this.initProviders(workspaceId);

    const errors = [];

    for (const provider of this.providers) {
      try {
        logger.debug(`📄 OCR: Tentative avec ${provider.name}...`);

        let result;

        if (provider.name === "claude-vision") {
          // Claude Vision OCR - Provider par défaut (Anthropic API)
          const rawResult = await provider.service.processDocument(
            documentUrl,
            mimeType,
          );
          result = provider.service.toInvoiceFormat(rawResult);

          // Incrémenter le compteur d'usage Claude Vision
          if (workspaceId) {
            try {
              await OcrUsage.incrementUsage(workspaceId, "claude-vision", {
                fileName,
                success: true,
                tokensUsed:
                  rawResult.usage?.inputTokens + rawResult.usage?.outputTokens,
              });
              logger.debug(
                `📊 Claude Vision: Usage incrémenté pour workspace ${workspaceId}`,
              );
            } catch (usageError) {
              console.warn(
                "⚠️ Erreur incrémentation usage Claude Vision:",
                usageError.message,
              );
            }
          }
        } else if (provider.name === "mindee") {
          // Mindee OCR - Fallback 1
          const rawResult = await provider.service.processDocument(
            documentUrl,
            mimeType,
          );
          result = provider.service.toInvoiceFormat(rawResult);

          // Incrémenter le compteur d'usage Mindee
          if (workspaceId) {
            try {
              await OcrUsage.incrementUsage(workspaceId, "mindee", {
                fileName,
                success: true,
              });
              logger.debug(
                `📊 Mindee: Usage incrémenté pour workspace ${workspaceId}`,
              );
            } catch (usageError) {
              console.warn(
                "⚠️ Erreur incrémentation usage Mindee:",
                usageError.message,
              );
            }
          }
        } else if (provider.name === "google-document-ai") {
          // Google Document AI - Priorité 2
          const rawResult = await provider.service.processDocument(
            documentUrl,
            mimeType,
          );
          result = provider.service.toInvoiceFormat(rawResult);
          result.success = true;
          result.text = result.extractedText;

          // Si Google Document AI n'a pas renvoyé d'entités structurées
          // (processeur OCR basique vs Invoice Parser), extraire via regex
          const hasEntities =
            result.transaction_data?.vendor_name ||
            result.transaction_data?.amount ||
            result.transaction_data?.document_number;
          if (!hasEntities) {
            applyTextFallback(result, "Google Document AI");
          }

          // Incrémenter le compteur d'usage Google
          if (workspaceId) {
            try {
              await OcrUsage.incrementUsage(workspaceId, "google-document-ai", {
                fileName,
                success: true,
              });
            } catch (usageError) {
              console.warn(
                "⚠️ Erreur incrémentation usage Google:",
                usageError.message,
              );
            }
          }
        } else if (provider.name === "mistral-ocr") {
          // Mistral OCR - Priorité 3 (fallback)
          result = await provider.service.processDocumentFromUrl(
            documentUrl,
            fileName,
            mimeType,
            {},
          );

          // Incrémenter le compteur d'usage Mistral
          if (workspaceId) {
            try {
              await OcrUsage.incrementUsage(workspaceId, "mistral", {
                fileName,
                success: true,
              });
            } catch (usageError) {
              console.warn(
                "⚠️ Erreur incrémentation usage Mistral:",
                usageError.message,
              );
            }
          }
        } else if (provider.name === "tesseract") {
          // Tesseract - Dernier recours gratuit : texte + champs par regex
          result = await provider.service.processDocumentFromUrl(
            documentUrl,
            fileName,
            mimeType,
          );
          applyTextFallback(result, "Tesseract");

          if (workspaceId) {
            try {
              await OcrUsage.incrementUsage(workspaceId, "tesseract", {
                fileName,
                success: true,
              });
            } catch (usageError) {
              console.warn(
                "⚠️ Erreur incrémentation usage Tesseract:",
                usageError.message,
              );
            }
          }
        }

        if (result && (result.extractedText || result.text)) {
          const textLength = (result.extractedText || result.text || "").length;
          logger.debug(
            `✅ OCR réussi avec ${provider.name} (${textLength} caractères)`,
          );
          result.provider = provider.name;
          result.success = true;
          return result;
        }
      } catch (error) {
        console.warn(`⚠️ ${provider.name} a échoué: ${error.message}`);
        errors.push({ provider: provider.name, error: error.message });

        // Si Mindee échoue à cause du quota, on continue avec le fallback
        if (error.message?.includes("MINDEE_QUOTA_EXCEEDED")) {
          logger.debug("📊 Mindee quota atteint, basculement vers fallback...");
          // Forcer la réinitialisation pour exclure Mindee
          this.initialized = false;
          continue;
        }
      }
    }

    // Tous les providers ont échoué
    return {
      success: false,
      error: `Tous les OCR ont échoué: ${errors.map((e) => `${e.provider}: ${e.error}`).join(", ")}`,
      provider: "none",
    };
  }

  /**
   * NOUVELLE MÉTHODE: Traitement batch optimisé
   * Utilise le pré-téléchargement en masse et le cache Redis
   * @param {Array<{cloudflareUrl: string, fileName: string, mimeType: string}>} files
   * @param {string} workspaceId
   * @returns {Promise<Array>}
   */
  async batchProcessDocuments(files, workspaceId = null) {
    await this.initProviders(workspaceId);

    // Vérifier si Claude Vision est le provider principal
    const primaryProvider = this.providers[0];

    if (primaryProvider?.name === "claude-vision") {
      logger.debug(
        `🚀 Batch OCR avec Claude Vision (${files.length} fichiers)...`,
      );

      // Utiliser le batch processing optimisé de Claude Vision
      const documents = files.map((f) => ({
        url: f.cloudflareUrl,
        fileName: f.fileName,
        mimeType: f.mimeType,
      }));

      const results = await claudeVisionOcrService.batchProcessDocuments(
        documents,
        ocrCacheService,
      );

      // Incrémenter l'usage pour chaque succès
      const successResults = results.filter((r) => r.success);
      if (workspaceId && successResults.length > 0) {
        try {
          for (const r of successResults) {
            await OcrUsage.incrementUsage(workspaceId, "claude-vision", {
              fileName: r.fileName,
              success: true,
              tokensUsed:
                r.result?.usage?.inputTokens + r.result?.usage?.outputTokens,
            });
          }
          logger.debug(
            `📊 Claude Vision: ${successResults.length} usages enregistrés`,
          );
        } catch (usageError) {
          console.warn("⚠️ Erreur enregistrement usage:", usageError.message);
        }
      }

      // Convertir au format attendu par le resolver
      return results.map((r) => {
        if (r.success) {
          return {
            success: true,
            fileName: r.fileName,
            url: r.url,
            fromCache: r.fromCache,
            result: r.result,
          };
        } else {
          return {
            success: false,
            fileName: r.fileName,
            url: r.url,
            error: r.error,
          };
        }
      });
    }

    // Fallback: traitement séquentiel avec les autres providers
    logger.debug(
      `🔄 Batch OCR séquentiel avec ${primaryProvider?.name || "fallback"}...`,
    );

    const results = [];
    for (const file of files) {
      try {
        const result = await this.processDocumentFromUrl(
          file.cloudflareUrl,
          file.fileName,
          file.mimeType,
          workspaceId,
        );
        results.push({
          success: true,
          fileName: file.fileName,
          url: file.cloudflareUrl,
          result,
        });
      } catch (error) {
        results.push({
          success: false,
          fileName: file.fileName,
          url: file.cloudflareUrl,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Retourne les statistiques du cache
   */
  getCacheStats() {
    return ocrCacheService.getStats();
  }

  /**
   * Retourne le provider actif
   */
  getActiveProvider() {
    return this.providers[0]?.name || "none";
  }

  /**
   * Liste les providers disponibles
   */
  listProviders() {
    return this.providers.map((p) => ({
      name: p.name,
      priority: p.priority,
    }));
  }
}

export default new HybridOcrService();
