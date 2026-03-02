/**
 * Google Document AI Service
 * Alternative OCR plus précise pour les factures
 * Gratuit: 1000 pages/mois
 * 
 * Setup:
 * 1. Créer un projet Google Cloud
 * 2. Activer Document AI API
 * 3. Créer un processeur "Invoice Parser" ou "Form Parser"
 * 4. Télécharger le fichier de credentials JSON
 * 5. Définir GOOGLE_APPLICATION_CREDENTIALS dans .env
 */

import { DocumentProcessorServiceClient } from '@google-cloud/documentai';

class GoogleDocumentAIService {
  constructor() {
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    this.location = process.env.GOOGLE_DOCUMENT_AI_LOCATION || 'eu'; // 'us' ou 'eu'
    this.processorId = process.env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
    
    if (this.projectId && this.processorId) {
      // Configurer l'endpoint selon la région
      const apiEndpoint = `${this.location}-documentai.googleapis.com`;
      this.client = new DocumentProcessorServiceClient({
        apiEndpoint: apiEndpoint,
      });
      this.processorName = `projects/${this.projectId}/locations/${this.location}/processors/${this.processorId}`;
      this.enabled = true;
      // eslint-disable-next-line no-console
      console.log(`🔧 Google Document AI configuré:`);
      // eslint-disable-next-line no-console
      console.log(`   - Endpoint: ${apiEndpoint}`);
      // eslint-disable-next-line no-console
      console.log(`   - Processor: ${this.processorName}`);
    } else {
      this.enabled = false;
      console.warn('⚠️ Google Document AI non configuré. Variables manquantes: GOOGLE_CLOUD_PROJECT_ID, GOOGLE_DOCUMENT_AI_PROCESSOR_ID');
    }
  }

  /**
   * Vérifie si le service est disponible
   */
  isAvailable() {
    return this.enabled;
  }

  /**
   * Traite un document PDF ou image
   * @param {Buffer|string} document - Buffer du fichier ou URL
   * @param {string} mimeType - Type MIME (application/pdf, image/png, etc.)
   */
  async processDocument(document, mimeType = 'application/pdf') {
    if (!this.enabled) {
      throw new Error('Google Document AI non configuré');
    }

    try {
      let contentBuffer;
      let finalMimeType = mimeType;
      
      // Normaliser le mimeType
      if (!finalMimeType || finalMimeType === 'undefined') {
        finalMimeType = 'application/pdf';
      }
      
      // Si c'est une URL, télécharger le fichier
      if (typeof document === 'string' && document.startsWith('http')) {
        // eslint-disable-next-line no-console
        console.log(`📥 Google Document AI: Téléchargement depuis ${document.substring(0, 50)}...`);
        
        const response = await fetch(document);
        if (!response.ok) {
          throw new Error(`Échec téléchargement: ${response.status} ${response.statusText}`);
        }
        
        // Récupérer le content-type de la réponse si disponible
        const contentType = response.headers.get('content-type');
        if (contentType && contentType !== 'application/octet-stream') {
          finalMimeType = contentType.split(';')[0].trim();
        }
        
        const arrayBuffer = await response.arrayBuffer();
        contentBuffer = Buffer.from(arrayBuffer);
        
        // eslint-disable-next-line no-console
        console.log(`📄 Google Document AI: Document téléchargé (${contentBuffer.length} bytes, type: ${finalMimeType})`);
      } else if (Buffer.isBuffer(document)) {
        contentBuffer = document;
      } else if (typeof document === 'string') {
        // Assume it's base64
        contentBuffer = Buffer.from(document, 'base64');
      } else {
        throw new Error('Format de document non supporté');
      }

      // Vérifier que le contenu n'est pas vide
      if (!contentBuffer || contentBuffer.length === 0) {
        throw new Error('Contenu du document vide');
      }

      // Le SDK Google attend le contenu brut (Buffer)
      const request = {
        name: this.processorName,
        rawDocument: {
          content: contentBuffer,
          mimeType: finalMimeType,
        },
      };

      // eslint-disable-next-line no-console
      console.log(`🔄 Google Document AI: Envoi au processeur ${this.processorId}...`);
      // eslint-disable-next-line no-console
      console.log(`   - Processor Name: ${this.processorName}`);
      // eslint-disable-next-line no-console
      console.log(`   - Content length: ${contentBuffer.length} bytes`);
      // eslint-disable-next-line no-console
      console.log(`   - MimeType: ${finalMimeType}`);
      // eslint-disable-next-line no-console
      console.log(`   - Content type: Buffer (${Buffer.isBuffer(contentBuffer)})`);
      
      const [result] = await this.client.processDocument(request);
      
      const entitiesCount = result.document?.entities?.length || 0;
      // eslint-disable-next-line no-console
      console.log(`✅ Google Document AI: Document traité (${result.document?.text?.length || 0} caractères, ${entitiesCount} entités)`);

      return this.parseResult(result.document);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('❌ Erreur Google Document AI:', error.message);
      // eslint-disable-next-line no-console
      console.error('   - Code:', error.code);
      // eslint-disable-next-line no-console
      console.error('   - Details:', JSON.stringify(error.details || error.metadata?.internalRepr, null, 2));
      throw error;
    }
  }

  /**
   * Parse le résultat de Document AI
   */
  parseResult(document) {
    const extractedData = {
      text: document.text || '',
      entities: {},
      confidence: 0,
    };

    // Extraire les entités détectées
    if (document.entities && document.entities.length > 0) {
      let totalConfidence = 0;
      
      for (const entity of document.entities) {
        const type = entity.type.toLowerCase().replace(/_/g, '');
        const value = entity.mentionText || entity.normalizedValue?.text || '';
        const confidence = entity.confidence || 0;
        
        // Mapper les types Google vers nos champs
        const fieldMapping = {
          'invoiceid': 'invoiceNumber',
          'invoicenumber': 'invoiceNumber',
          'invoicedate': 'invoiceDate',
          'duedate': 'dueDate',
          'totalamount': 'totalTTC',
          'netamount': 'totalHT',
          'taxamount': 'totalTVA',
          'suppliername': 'vendorName',
          'supplieraddress': 'vendorAddress',
          'receivername': 'clientName',
          'receiveraddress': 'clientAddress',
          'currencycode': 'currency',
          'paymentterms': 'paymentTerms',
        };

        const fieldName = fieldMapping[type] || type;
        extractedData.entities[fieldName] = {
          value: value,
          confidence: confidence,
        };
        
        totalConfidence += confidence;
      }
      
      extractedData.confidence = totalConfidence / document.entities.length;
    }

    // Extraire les pages
    extractedData.pages = (document.pages || []).map((page, index) => ({
      pageNumber: index + 1,
      width: page.dimension?.width,
      height: page.dimension?.height,
      text: this.extractPageText(page, document.text),
    }));

    return extractedData;
  }

  /**
   * Extrait le texte d'une page spécifique
   */
  extractPageText(page, fullText) {
    if (!page.layout?.textAnchor?.textSegments) {
      return '';
    }
    
    return page.layout.textAnchor.textSegments
      .map(segment => {
        const start = parseInt(segment.startIndex) || 0;
        const end = parseInt(segment.endIndex) || fullText.length;
        return fullText.substring(start, end);
      })
      .join('');
  }

  /**
   * Convertit le résultat au format standard (transaction_data / extracted_fields)
   * compatible avec GmailScannerService.transformOcrDataToInvoice()
   */
  toInvoiceFormat(result) {
    const entities = result.entities || {};

    return {
      success: true,
      extractedText: result.text,
      transaction_data: {
        vendor_name: entities.vendorName?.value || '',
        amount: this.parseAmount(entities.totalTTC?.value) || 0,
        amount_ht: this.parseAmount(entities.totalHT?.value) || 0,
        tax_amount: this.parseAmount(entities.totalTVA?.value) || 0,
        transaction_date: entities.invoiceDate?.value || null,
        due_date: entities.dueDate?.value || null,
        document_number: entities.invoiceNumber?.value || null,
        currency: entities.currency?.value || 'EUR',
        category: 'OTHER',
        payment_method: '',
      },
      extracted_fields: {
        vendor_address: entities.vendorAddress?.value || '',
        vendor_city: '',
        vendor_postal_code: '',
        vendor_country: 'France',
        vendor_siret: entities.vendorSiret?.value || null,
        vendor_vat_number: entities.vendorVatNumber?.value || null,
        vendor_email: null,
        vendor_phone: null,
        client_name: entities.clientName?.value || null,
        client_address: entities.clientAddress?.value || null,
        items: (entities.items || []).map(item => ({
          description: item.description || '',
          quantity: 1,
          unit_price: 0,
          total: 0,
          vat_rate: 20,
        })),
        totals: {
          total_ht: this.parseAmount(entities.totalHT?.value) || 0,
          total_tax: this.parseAmount(entities.totalTVA?.value) || 0,
          total_ttc: this.parseAmount(entities.totalTTC?.value) || 0,
        },
      },
      confidence: result.confidence,
      metadata: {
        provider: 'google-document-ai',
        pagesProcessed: result.pages?.length || 1,
      },
    };
  }

  /**
   * Parse un montant en nombre
   */
  parseAmount(value) {
    if (!value) return null;
    // Nettoyer le montant (espaces, symboles monétaires)
    const cleaned = value.toString()
      .replace(/[€$£\s]/g, '')
      .replace(/,/g, '.');
    return parseFloat(cleaned) || null;
  }
}

export default new GoogleDocumentAIService();
