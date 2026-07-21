import logger from "../utils/logger.js";
/**
 * Mindee OCR Service
 * Service OCR utilisant le SDK Mindee pour l'extraction de données de factures
 *
 * Avantages:
 * - Gratuit: 250 pages/mois
 * - Très précis pour les factures françaises
 * - Extraction structurée native (pas besoin d'analyse IA supplémentaire)
 *
 * Setup:
 * 1. Créer un compte sur https://platform.mindee.com
 * 2. Récupérer la clé API
 * 3. Définir MINDEE_API_KEY dans .env
 */

import * as mindee from "mindee";

class MindeeOcrService {
  constructor() {
    // Nettoyer la clé API (trim pour supprimer espaces/retours à la ligne)
    this.apiKey = process.env.MINDEE_API_KEY?.trim();
    this.client = null;
    this.enabled = false;

    if (this.apiKey) {
      try {
        // Initialiser le client Mindee avec la clé API
        this.client = new mindee.Client({ apiKey: this.apiKey });
        // DÉSACTIVÉ: Problème d'authentification avec le compte trial Mindee
        // Pour réactiver: changer false en true ci-dessous
        this.enabled = false;

        // Masquer la clé pour le log
        const maskedKey =
          this.apiKey.substring(0, 8) +
          "..." +
          this.apiKey.substring(this.apiKey.length - 4);
        console.warn(
          `⚠️ Mindee OCR DÉSACTIVÉ (clé: ${maskedKey}, erreur 401 Authorization)`,
        );
        console.warn(
          `⚠️ Vérifiez: 1) Clé API active, 2) Email vérifié, 3) Compte trial validé`,
        );
        console.warn(
          `⚠️ Note: Mindee n'a pas de plan gratuit permanent (Trial 14j puis 44€/mois)`,
        );
      } catch (error) {
        console.error("❌ Erreur initialisation Mindee SDK:", error.message);
        this.enabled = false;
      }
    } else {
      console.warn(
        "⚠️ Mindee OCR non configuré. Variable manquante: MINDEE_API_KEY",
      );
    }
  }

  /**
   * Vérifie si le service est disponible
   */
  isAvailable() {
    return this.enabled && this.client !== null;
  }

  /**
   * Traite un document (facture) avec Mindee SDK
   * @param {string} documentUrl - URL du document (Cloudflare)
   * @param {string} mimeType - Type MIME du document
   * @returns {Promise<Object>} Résultat de l'OCR
   */
  async processDocument(documentUrl, mimeType = "application/pdf") {
    if (!this.isAvailable()) {
      throw new Error("Mindee OCR non configuré");
    }

    try {
      logger.debug(
        `📄 Mindee OCR: Traitement de ${documentUrl.substring(0, 60)}...`,
      );

      // Télécharger le fichier depuis Cloudflare
      logger.debug(`📥 Mindee OCR: Téléchargement du document...`);
      const downloadResponse = await fetch(documentUrl);

      if (!downloadResponse.ok) {
        throw new Error(
          `Échec téléchargement: ${downloadResponse.status} ${downloadResponse.statusText}`,
        );
      }

      const arrayBuffer = await downloadResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      logger.debug(
        `📄 Mindee OCR: Document téléchargé (${buffer.length} bytes)`,
      );

      // Utiliser le SDK Mindee avec docFromBuffer
      logger.debug(`🔄 Mindee OCR: Envoi au SDK Mindee...`);

      // Créer l'input source depuis le buffer
      const inputSource = this.client.docFromBuffer(buffer, "invoice.pdf");

      // Parser avec l'API Invoice V4
      const response = await this.client.parse(
        mindee.product.InvoiceV4,
        inputSource,
      );

      logger.debug(`✅ Mindee OCR: Document traité avec succès`);

      return this.parseResult(response);
    } catch (error) {
      console.error("❌ Erreur Mindee OCR:", error.message);
      console.error("Stack:", error.stack);

      // Gérer les erreurs spécifiques Mindee
      if (
        error.message?.includes("quota") ||
        error.message?.includes("limit")
      ) {
        throw new Error("MINDEE_QUOTA_EXCEEDED: Quota mensuel Mindee atteint");
      }

      throw error;
    }
  }

  /**
   * Parse le résultat Mindee en format standardisé
   * Structure API REST: { document: { inference: { prediction: {...} } } }
   */
  parseResult(response) {
    // La réponse API REST a la structure: { api_request: {...}, document: { inference: { prediction: {...} } } }
    const prediction = response.document?.inference?.prediction;

    if (!prediction) {
      throw new Error("Réponse Mindee invalide: pas de prediction");
    }

    // Extraire le texte brut (concaténation des champs)
    const extractedText = this.buildExtractedText(prediction);

    // Construire les données structurées
    const structuredData = {
      invoiceNumber: prediction.invoiceNumber?.value || null,
      invoiceDate: prediction.date?.value || null,
      dueDate: prediction.dueDate?.value || null,
      totalTTC: prediction.totalAmount?.value || null,
      totalHT: prediction.totalNet?.value || null,
      totalTVA: prediction.totalTax?.value || null,
      vendorName: prediction.supplierName?.value || null,
      vendorAddress: this.formatAddress(prediction.supplierAddress?.value),
      vendorPhone: prediction.supplierPhoneNumber?.value || null,
      vendorEmail: prediction.supplierEmail?.value || null,
      vendorVatNumber:
        prediction.supplierCompanyRegistrations?.find(
          (r) => r.type === "VAT NUMBER",
        )?.value || null,
      vendorSiret:
        prediction.supplierCompanyRegistrations?.find((r) => r.type === "SIRET")
          ?.value || null,
      clientName: prediction.customerName?.value || null,
      clientAddress: this.formatAddress(prediction.customerAddress?.value),
      currency: prediction.locale?.currency || "EUR",
      language: prediction.locale?.language || "fr",
    };

    // Extraire les lignes d'articles
    const lineItems = (prediction.lineItems || []).map((item) => ({
      description: item.description || "",
      quantity: item.quantity || 1,
      unitPrice: item.unitPrice || 0,
      totalPrice: item.totalAmount || 0,
      taxRate: item.taxRate ? item.taxRate * 100 : null, // Convertir en pourcentage
      productCode: item.productCode || null,
    }));

    // Extraire les détails de TVA
    const taxDetails = (prediction.taxes || []).map((tax) => ({
      rate: tax.rate ? tax.rate * 100 : 0,
      base: tax.base || 0,
      amount: tax.value || 0,
    }));

    return {
      success: true,
      extractedText,
      structuredData,
      lineItems,
      taxDetails,
      confidence: this.calculateConfidence(prediction),
      metadata: {
        provider: "mindee",
        documentType: prediction.documentType?.value || "INVOICE",
        pageCount: response.document?.nPages || 1,
        processedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Construit le texte extrait à partir des champs Mindee
   */
  buildExtractedText(prediction) {
    const parts = [];

    if (prediction.supplierName?.value) {
      parts.push(`Fournisseur: ${prediction.supplierName.value}`);
    }
    if (prediction.supplierAddress?.value) {
      parts.push(`Adresse: ${prediction.supplierAddress.value}`);
    }
    if (prediction.invoiceNumber?.value) {
      parts.push(`Facture N°: ${prediction.invoiceNumber.value}`);
    }
    if (prediction.date?.value) {
      parts.push(`Date: ${prediction.date.value}`);
    }
    if (prediction.dueDate?.value) {
      parts.push(`Échéance: ${prediction.dueDate.value}`);
    }
    if (prediction.customerName?.value) {
      parts.push(`Client: ${prediction.customerName.value}`);
    }

    // Ajouter les lignes d'articles
    if (prediction.lineItems?.length > 0) {
      parts.push("\nArticles:");
      prediction.lineItems.forEach((item, index) => {
        parts.push(
          `${index + 1}. ${item.description || "Article"} - Qté: ${item.quantity || 1} - Prix: ${item.totalAmount || 0}€`,
        );
      });
    }

    // Ajouter les totaux
    parts.push("\nTotaux:");
    if (prediction.totalNet?.value) {
      parts.push(`Total HT: ${prediction.totalNet.value}€`);
    }
    if (prediction.totalTax?.value) {
      parts.push(`Total TVA: ${prediction.totalTax.value}€`);
    }
    if (prediction.totalAmount?.value) {
      parts.push(`Total TTC: ${prediction.totalAmount.value}€`);
    }

    return parts.join("\n");
  }

  /**
   * Formate une adresse Mindee
   */
  formatAddress(address) {
    if (!address) return null;
    if (typeof address === "string") return address;

    // Si c'est un objet avec des composants
    const parts = [];
    if (address.streetNumber) parts.push(address.streetNumber);
    if (address.streetName) parts.push(address.streetName);
    if (address.postalCode) parts.push(address.postalCode);
    if (address.city) parts.push(address.city);
    if (address.country) parts.push(address.country);

    return parts.join(" ") || null;
  }

  /**
   * Calcule un score de confiance global
   */
  calculateConfidence(prediction) {
    const confidenceFields = [
      prediction.invoiceNumber?.confidence,
      prediction.date?.confidence,
      prediction.totalAmount?.confidence,
      prediction.supplierName?.confidence,
    ].filter((c) => c !== undefined && c !== null);

    if (confidenceFields.length === 0) return 0.5;

    return (
      confidenceFields.reduce((sum, c) => sum + c, 0) / confidenceFields.length
    );
  }

  /**
   * Convertit le résultat au format attendu par invoiceExtractionService
   * Compatible avec le format hybridOcrService
   */
  toInvoiceFormat(result) {
    return {
      success: true,
      extractedText: result.extractedText,
      text: result.extractedText, // Alias pour compatibilité
      structuredData: result.structuredData,
      data: {
        lineItems: result.lineItems,
        taxDetails: result.taxDetails,
      },
      metadata: result.metadata,
      provider: "mindee",
    };
  }
}

export default new MindeeOcrService();
