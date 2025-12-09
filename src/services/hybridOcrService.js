/**
 * Hybrid OCR Service
 * Utilise le meilleur OCR disponible avec fallback automatique
 * 
 * Ordre de priorité:
 * 1. Google Document AI (si configuré) - Le plus précis pour les factures
 * 2. Mistral OCR (fallback) - Bon pour le texte général
 */

import googleDocumentAI from './googleDocumentAIService.js';
import mistralOcrService from './mistralOcrService.js';

class HybridOcrService {
  constructor() {
    this.providers = [];
    this.initialized = false;
  }

  /**
   * Initialise les providers (appelé au premier usage)
   */
  initProviders() {
    if (this.initialized) return;
    
    // Google Document AI (priorité 1) - Le plus précis pour les factures
    if (googleDocumentAI.isAvailable()) {
      this.providers.push({
        name: 'google-document-ai',
        service: googleDocumentAI,
        priority: 1,
      });
      // eslint-disable-next-line no-console
      console.log('✅ Google Document AI disponible (priorité 1)');
    }

    // Mistral OCR (priorité 2) - Fallback
    if (process.env.MISTRAL_API_KEY) {
      this.providers.push({
        name: 'mistral-ocr',
        service: mistralOcrService,
        priority: 2,
      });
      // eslint-disable-next-line no-console
      console.log('✅ Mistral OCR disponible (priorité 2)');
    }

    // Trier par priorité
    this.providers.sort((a, b) => a.priority - b.priority);
    
    // eslint-disable-next-line no-console
    console.log(`🔧 OCR Hybride: ${this.providers.length} provider(s) - Ordre: ${this.providers.map(p => p.name).join(' → ')}`);
    
    this.initialized = true;
  }

  /**
   * Traite un document avec le meilleur OCR disponible
   * Compatible avec l'interface de mistralOcrService
   */
  async processDocumentFromUrl(documentUrl, fileName, mimeType) {
    // Initialiser les providers au premier appel
    this.initProviders();
    
    const errors = [];

    for (const provider of this.providers) {
      try {
        // eslint-disable-next-line no-console
        console.log(`📄 OCR: Tentative avec ${provider.name}...`);
        
        let result;
        
        if (provider.name === 'google-document-ai') {
          // Google Document AI
          const rawResult = await provider.service.processDocument(documentUrl, mimeType);
          result = provider.service.toInvoiceFormat(rawResult);
          // Adapter au format attendu par invoiceExtractionService
          result.success = true;
          result.text = result.extractedText;
        } else if (provider.name === 'mistral-ocr') {
          // Mistral OCR - utilise l'interface existante
          result = await provider.service.processDocumentFromUrl(documentUrl, fileName, mimeType, {});
        }

        if (result && (result.extractedText || result.text)) {
          const textLength = (result.extractedText || result.text || '').length;
          // eslint-disable-next-line no-console
          console.log(`✅ OCR réussi avec ${provider.name} (${textLength} caractères)`);
          result.provider = provider.name;
          result.success = true;
          return result;
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`⚠️ ${provider.name} a échoué: ${error.message}`);
        errors.push({ provider: provider.name, error: error.message });
      }
    }

    // Tous les providers ont échoué
    return {
      success: false,
      error: `Tous les OCR ont échoué: ${errors.map(e => `${e.provider}: ${e.error}`).join(', ')}`,
      provider: 'none',
    };
  }

  /**
   * Retourne le provider actif
   */
  getActiveProvider() {
    return this.providers[0]?.name || 'none';
  }

  /**
   * Liste les providers disponibles
   */
  listProviders() {
    return this.providers.map(p => ({
      name: p.name,
      priority: p.priority,
    }));
  }
}

export default new HybridOcrService();
