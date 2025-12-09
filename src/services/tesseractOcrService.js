/**
 * Tesseract.js OCR Service
 * Alternative OCR 100% gratuite et locale
 * Pas de limite, pas d'API externe
 * 
 * Installation: npm install tesseract.js pdf-poppler
 */

import Tesseract from 'tesseract.js';
import { fromBuffer } from 'pdf2pic';
import fetch from 'node-fetch';

class TesseractOcrService {
  constructor() {
    this.language = 'fra'; // Français
    this.worker = null;
  }

  /**
   * Initialise le worker Tesseract
   */
  async initWorker() {
    if (!this.worker) {
      this.worker = await Tesseract.createWorker(this.language);
      console.log('✅ Tesseract worker initialisé (langue: français)');
    }
    return this.worker;
  }

  /**
   * Traite un document (PDF ou image)
   * @param {Buffer|string} document - Buffer du fichier ou URL
   * @param {string} mimeType - Type MIME
   */
  async processDocument(document, mimeType = 'application/pdf') {
    try {
      let buffer;
      
      // Télécharger si URL
      if (typeof document === 'string' && document.startsWith('http')) {
        const response = await fetch(document);
        buffer = Buffer.from(await response.arrayBuffer());
      } else {
        buffer = document;
      }

      // Si PDF, convertir en images
      if (mimeType === 'application/pdf') {
        return await this.processPdf(buffer);
      } else {
        return await this.processImage(buffer);
      }
    } catch (error) {
      console.error('❌ Erreur Tesseract OCR:', error.message);
      throw error;
    }
  }

  /**
   * Traite un PDF (multi-pages)
   */
  async processPdf(pdfBuffer) {
    const worker = await this.initWorker();
    const pages = [];
    let fullText = '';

    try {
      // Convertir PDF en images
      const options = {
        density: 300,
        format: 'png',
        width: 2480,
        height: 3508,
      };

      const convert = fromBuffer(pdfBuffer, options);
      
      // Obtenir le nombre de pages
      let pageNum = 1;
      let hasMorePages = true;

      while (hasMorePages && pageNum <= 20) { // Max 20 pages
        try {
          const result = await convert(pageNum, { responseType: 'buffer' });
          
          if (result && result.buffer) {
            const ocrResult = await worker.recognize(result.buffer);
            const pageText = ocrResult.data.text;
            
            pages.push({
              pageNumber: pageNum,
              text: pageText,
              confidence: ocrResult.data.confidence,
            });
            
            fullText += pageText + '\n\n';
            pageNum++;
          } else {
            hasMorePages = false;
          }
        } catch (e) {
          // Plus de pages
          hasMorePages = false;
        }
      }
    } catch (error) {
      console.error('Erreur conversion PDF:', error.message);
      // Fallback: essayer de traiter comme image
      const ocrResult = await worker.recognize(pdfBuffer);
      fullText = ocrResult.data.text;
      pages.push({
        pageNumber: 1,
        text: fullText,
        confidence: ocrResult.data.confidence,
      });
    }

    return {
      success: true,
      extractedText: fullText.trim(),
      pages: pages,
      metadata: {
        provider: 'tesseract',
        pagesProcessed: pages.length,
        language: this.language,
      },
    };
  }

  /**
   * Traite une image
   */
  async processImage(imageBuffer) {
    const worker = await this.initWorker();
    const result = await worker.recognize(imageBuffer);

    return {
      success: true,
      extractedText: result.data.text,
      pages: [{
        pageNumber: 1,
        text: result.data.text,
        confidence: result.data.confidence,
      }],
      confidence: result.data.confidence,
      metadata: {
        provider: 'tesseract',
        pagesProcessed: 1,
        language: this.language,
      },
    };
  }

  /**
   * Ferme le worker
   */
  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

export default new TesseractOcrService();
