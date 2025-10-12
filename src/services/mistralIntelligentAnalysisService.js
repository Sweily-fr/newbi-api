/**
 * Service d'analyse intelligente avec l'API Chat de Mistral
 * Utilise l'IA pour extraire les données structurées des documents OCR
 */

import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

class MistralIntelligentAnalysisService {
  constructor() {
    this.apiKey = process.env.MISTRAL_API_KEY;
    this.chatEndpoint = "https://api.mistral.ai/v1/chat/completions";
    this.model = "mistral-large-latest"; // Modèle le plus performant pour l'analyse
  }

  /**
   * Analyse intelligente d'un document OCR avec l'IA Mistral
   * @param {Object} ocrData - Données OCR extraites
   * @returns {Promise<Object>} - Analyse structurée
   */
  async analyzeDocument(ocrData) {
    try {
      if (!this.apiKey) {
        console.warn("⚠️ Clé API Mistral non configurée, utilisation du fallback");
        return this.getFallbackAnalysis(ocrData);
      }

      const extractedText = ocrData.extractedText || "";
      
      if (!extractedText || extractedText.trim().length === 0) {
        console.warn("⚠️ Texte OCR vide, utilisation du fallback");
        return this.getFallbackAnalysis(ocrData);
      }

      // Prompt optimisé pour l'extraction de données financières
      const prompt = this.buildAnalysisPrompt(extractedText);

      // Appel à l'API Chat de Mistral
      const response = await fetch(this.chatEndpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: "Tu es un expert en analyse de documents financiers (factures, reçus, tickets). Tu extrais les informations de manière précise et structurée. Tu réponds UNIQUEMENT en JSON valide, sans texte supplémentaire."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.1, // Température basse pour plus de précision
          response_format: { type: "json_object" }, // Forcer la réponse JSON
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Erreur API Mistral Chat:", response.status, errorText);
        return this.getFallbackAnalysis(ocrData);
      }

      const result = await response.json();
      const content = result.choices[0]?.message?.content;

      if (!content) {
        console.warn("⚠️ Pas de contenu dans la réponse Mistral");
        return this.getFallbackAnalysis(ocrData);
      }

      // Parser la réponse JSON
      const analysis = JSON.parse(content);

      // Valider et nettoyer les données
      const validatedAnalysis = this.validateAndCleanAnalysis(analysis);

      console.log("✅ Analyse intelligente Mistral réussie");
      return validatedAnalysis;

    } catch (error) {
      console.error("❌ Erreur lors de l'analyse intelligente:", error);
      return this.getFallbackAnalysis(ocrData);
    }
  }

  /**
   * Construit le prompt d'analyse optimisé
   */
  buildAnalysisPrompt(extractedText) {
    return `Analyse ce document financier et extrait TOUTES les informations suivantes au format JSON.
Sois très précis et extrait TOUTES les valeurs visibles dans le document.

DOCUMENT À ANALYSER:
${extractedText}

INSTRUCTIONS:
1. Extrait TOUTES les informations présentes dans le document
2. Pour les montants, utilise le format numérique (ex: 6240.00, pas "6240,00€")
3. Pour les dates, utilise le format YYYY-MM-DD (ex: 2035-10-30)
4. Pour le nom du fournisseur, prends le nom de l'entreprise émettrice
5. Pour la catégorie, choisis parmi: transport, repas, bureau, prestation, autre
6. Pour le moyen de paiement, choisis parmi: card, transfer, cash, check, unknown

STRUCTURE JSON ATTENDUE (réponds UNIQUEMENT avec ce JSON, rien d'autre):
{
  "document_analysis": {
    "document_type": "invoice ou receipt",
    "confidence": 0.95,
    "language": "fr"
  },
  "transaction_data": {
    "type": "expense",
    "amount": 6240.00,
    "currency": "EUR",
    "tax_amount": 1040.00,
    "tax_rate": 20,
    "transaction_date": "2035-10-30",
    "due_date": "2035-11-30",
    "payment_date": null,
    "document_number": "123-456-7890",
    "vendor_name": "Nom de l'entreprise",
    "status": "pending",
    "category": "prestation",
    "subcategory": "service",
    "payment_method": "transfer",
    "description": "Description claire de la transaction"
  },
  "extracted_fields": {
    "vendor_siret": "123456789",
    "vendor_address": "Adresse complète",
    "vendor_email": "email@example.com",
    "vendor_phone": "0123456789",
    "client_name": "Nom du client",
    "client_address": "Adresse du client",
    "items": [
      {
        "description": "Description du produit/service",
        "quantity": 1,
        "unit_price": 2500.00,
        "total": 2500.00
      }
    ],
    "total_ht": 5200.00,
    "total_ttc": 6240.00,
    "payment_terms": "Par virement bancaire",
    "bank_details": {
      "bank_name": "Nom de la banque",
      "account_number": "123-456-7890"
    }
  }
}`;
  }

  /**
   * Valide et nettoie l'analyse
   */
  validateAndCleanAnalysis(analysis) {
    // Structure par défaut
    const validated = {
      success: true,
      document_analysis: {
        document_type: analysis.document_analysis?.document_type || "receipt",
        confidence: analysis.document_analysis?.confidence || 0.8,
        language: analysis.document_analysis?.language || "fr",
      },
      transaction_data: {
        type: analysis.transaction_data?.type || "expense",
        amount: this.parseAmount(analysis.transaction_data?.amount) || 0,
        currency: analysis.transaction_data?.currency || "EUR",
        tax_amount: this.parseAmount(analysis.transaction_data?.tax_amount) || 0,
        tax_rate: this.parseAmount(analysis.transaction_data?.tax_rate) || 0,
        transaction_date: this.validateDate(analysis.transaction_data?.transaction_date),
        due_date: this.validateDate(analysis.transaction_data?.due_date),
        payment_date: this.validateDate(analysis.transaction_data?.payment_date),
        document_number: analysis.transaction_data?.document_number || null,
        vendor_name: analysis.transaction_data?.vendor_name || "Fournisseur inconnu",
        status: analysis.transaction_data?.status || "pending",
        category: analysis.transaction_data?.category || "autre",
        subcategory: analysis.transaction_data?.subcategory || "non_classifie",
        payment_method: analysis.transaction_data?.payment_method || "unknown",
        description: analysis.transaction_data?.description || "Transaction",
      },
      extracted_fields: analysis.extracted_fields || {},
      raw_content: "",
    };

    return validated;
  }

  /**
   * Parse un montant en nombre
   */
  parseAmount(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const cleaned = value.replace(/[^\d.,]/g, "").replace(/,/g, ".");
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Valide une date
   */
  validateDate(dateStr) {
    if (!dateStr) return null;
    
    // Si c'est déjà au format YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    // Essayer de parser
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split("T")[0];
      }
    } catch (error) {
      console.warn("Date invalide:", dateStr);
    }

    return null;
  }

  /**
   * Analyse de secours si l'API échoue
   */
  getFallbackAnalysis(ocrData) {
    console.log("📋 Utilisation de l'analyse de secours");
    
    return {
      success: false,
      document_analysis: {
        document_type: "unknown",
        confidence: 0.3,
        language: "fr",
      },
      transaction_data: {
        type: "expense",
        amount: 0,
        currency: "EUR",
        tax_amount: 0,
        tax_rate: 0,
        transaction_date: null,
        due_date: null,
        payment_date: null,
        document_number: null,
        vendor_name: "Fournisseur inconnu",
        status: "pending",
        category: "autre",
        subcategory: "non_classifie",
        payment_method: "unknown",
        description: "Document non analysable - Veuillez saisir manuellement",
      },
      extracted_fields: {},
      raw_content: ocrData.extractedText || "",
    };
  }

  /**
   * Vérifie si le service est configuré
   */
  isConfigured() {
    return !!this.apiKey;
  }
}

// Instance singleton
const mistralIntelligentAnalysisService = new MistralIntelligentAnalysisService();

export default mistralIntelligentAnalysisService;
