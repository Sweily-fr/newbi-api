/**
 * Hybrid OCR Service
 * Utilise le meilleur OCR disponible avec fallback automatique
 *
 * Ordre de priorité:
 * 1. Mindee OCR (si configuré et quota disponible) - Gratuit 250/mois, très précis
 * 2. Google Document AI (si configuré) - Gratuit 1000/mois, précis pour les factures
 * 3. Mistral OCR (fallback) - Bon pour le texte général
 */

import mindeeOcrService from "./mindeeOcrService.js";
import googleDocumentAI from "./googleDocumentAIService.js";
import mistralOcrService from "./mistralOcrService.js";
import OcrUsage from "../models/OcrUsage.js";

class HybridOcrService {
  constructor() {
    this.providers = [];
    this.initialized = false;
    this.lastWorkspaceId = null;
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

    // Mindee OCR (priorité 1) - Gratuit 250/mois, très précis pour les factures françaises
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
          priority: 1,
        });
        console.log(
          `✅ Mindee OCR disponible (priorité 1) - ${mindeeUsage}/250 utilisés ce mois`
        );
      } else {
        console.log(
          `⚠️ Mindee OCR: quota atteint (${mindeeUsage}/250) - basculement vers fallback`
        );
      }
    }

    // Google Document AI (priorité 2) - Le plus précis pour les factures
    if (googleDocumentAI.isAvailable()) {
      this.providers.push({
        name: "google-document-ai",
        service: googleDocumentAI,
        priority: 2,
      });
      console.log("✅ Google Document AI disponible (priorité 2)");
    }

    // Mistral OCR (priorité 3) - Fallback
    if (process.env.MISTRAL_API_KEY) {
      this.providers.push({
        name: "mistral-ocr",
        service: mistralOcrService,
        priority: 3,
      });
      console.log("✅ Mistral OCR disponible (priorité 3)");
    }

    // Trier par priorité
    this.providers.sort((a, b) => a.priority - b.priority);

    console.log(
      `🔧 OCR Hybride: ${this.providers.length} provider(s) - Ordre: ${this.providers.map((p) => p.name).join(" → ")}`
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
    workspaceId = null
  ) {
    // Initialiser les providers au premier appel (avec vérification quota)
    await this.initProviders(workspaceId);

    const errors = [];

    for (const provider of this.providers) {
      try {
        console.log(`📄 OCR: Tentative avec ${provider.name}...`);

        let result;

        if (provider.name === "mindee") {
          // Mindee OCR - Priorité 1
          const rawResult = await provider.service.processDocument(
            documentUrl,
            mimeType
          );
          result = provider.service.toInvoiceFormat(rawResult);

          // Incrémenter le compteur d'usage Mindee
          if (workspaceId) {
            try {
              await OcrUsage.incrementUsage(workspaceId, "mindee", {
                fileName,
                success: true,
              });
              console.log(
                `📊 Mindee: Usage incrémenté pour workspace ${workspaceId}`
              );
            } catch (usageError) {
              console.warn(
                "⚠️ Erreur incrémentation usage Mindee:",
                usageError.message
              );
            }
          }
        } else if (provider.name === "google-document-ai") {
          // Google Document AI - Priorité 2
          const rawResult = await provider.service.processDocument(
            documentUrl,
            mimeType
          );
          result = provider.service.toInvoiceFormat(rawResult);
          result.success = true;
          result.text = result.extractedText;

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
                usageError.message
              );
            }
          }
        } else if (provider.name === "mistral-ocr") {
          // Mistral OCR - Priorité 3 (fallback)
          result = await provider.service.processDocumentFromUrl(
            documentUrl,
            fileName,
            mimeType,
            {}
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
                usageError.message
              );
            }
          }
        }

        if (result && (result.extractedText || result.text)) {
          const textLength = (result.extractedText || result.text || "").length;
          console.log(
            `✅ OCR réussi avec ${provider.name} (${textLength} caractères)`
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
          console.log("📊 Mindee quota atteint, basculement vers fallback...");
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
