import logger from "../utils/logger.js";
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
    // Utiliser mistral-small-latest pour éviter les limites de quota
    this.model = "mistral-small-latest"; // Modèle plus léger et moins restrictif
  }

  /**
   * Analyse intelligente d'un document OCR avec l'IA Mistral
   * @param {Object} ocrData - Données OCR extraites
   * @returns {Promise<Object>} - Analyse structurée
   */
  async analyzeDocument(ocrData) {
    try {
      if (!this.apiKey) {
        console.warn(
          "⚠️ Clé API Mistral non configurée, utilisation du fallback",
        );
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
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "Tu es un expert en analyse de documents financiers (factures, reçus, tickets). Tu extrais les informations de manière précise et structurée. Tu réponds UNIQUEMENT en JSON valide, sans texte supplémentaire.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.1, // Température basse pour plus de précision
          response_format: { type: "json_object" }, // Forcer la réponse JSON
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          "❌ Erreur API Mistral Chat:",
          response.status,
          errorText,
        );
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

      logger.debug("✅ Analyse intelligente Mistral réussie");
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
Sois EXTRÊMEMENT précis et extrait CHAQUE détail visible dans le document.

DOCUMENT À ANALYSER:
${extractedText}

INSTRUCTIONS CRITIQUES:
1. Extrait TOUS les articles/produits avec leurs codes, quantités, prix unitaires et totaux
2. Extrait TOUTES les lignes de TVA (TVA 20%, TVA 5.5%, DEEE, eco-part, etc.)
3. Pour les montants, utilise le format numérique (ex: 30.96, pas "30,96€")
4. Pour les dates, utilise le format YYYY-MM-DD ou DD/MM/YYYY selon ce qui est visible
5. Extrait le numéro de client, numéro de facture, code barre, référence d'achat
6. Extrait l'adresse COMPLÈTE du fournisseur (rue, code postal, ville, pays)
7. Extrait l'adresse COMPLÈTE du client si présente
8. Pour le moyen de paiement, cherche: Carte Bancaire, CB, Espèces, Chèque, Virement, etc.
9. Extrait les informations légales: SIRET, TVA intracommunautaire, RCS, APE
10. Extrait les totaux: HT, TVA, TTC, montant payé, rendu monnaie
11. Pour la catégorie, choisis parmi: RENT, SUBSCRIPTIONS, OFFICE_SUPPLIES, SERVICES, TRANSPORT, MEALS, TELECOMMUNICATIONS, INSURANCE, ENERGY, SOFTWARE, HARDWARE, MARKETING, TRAINING, MAINTENANCE, TAXES, UTILITIES, OTHER

STRUCTURE JSON ATTENDUE (réponds UNIQUEMENT avec ce JSON, rien d'autre):
{
  "document_analysis": {
    "document_type": "invoice ou receipt ou ticket",
    "confidence": 0.95,
    "language": "fr",
    "vendor_type": "retail ou service ou restaurant"
  },
  "transaction_data": {
    "type": "expense",
    "amount": 62.75,
    "currency": "EUR",
    "tax_amount": 10.46,
    "tax_rate": 20,
    "transaction_date": "2025-10-07",
    "transaction_time": "18:51",
    "due_date": null,
    "payment_date": "2025-10-07",
    "document_number": "F/173A028082-25-001",
    "barcode": "0001144516",
    "reference": "CODE QTÉ P.U.TTC T.TVA TOTAL TTC",
    "vendor_name": "Boulanger Montigny Les Cormeilles",
    "client_number": "57803110",
    "client_name": "Mr AANGOUR MOHAMED",
    "status": "paid",
    "category": "HARDWARE",
    "subcategory": "electronics",
    "payment_method": "card",
    "description": "Achat matériel informatique (Pack EPSON, Souris LOGITECH)"
  },
  "extracted_fields": {
    "vendor_siret": "347384570020017",
    "vendor_vat_number": "FR 76 347 384 570",
    "vendor_rcs": "RCS LILLE B 347 384 570",
    "vendor_ape": "4754Z",
    "vendor_address": "Bd Victor Bordier face à Leroy Merlin, 95370 Montigny Les Cormeilles",
    "vendor_city": "Montigny Les Cormeilles",
    "vendor_postal_code": "95370",
    "vendor_country": "France",
    "vendor_email": null,
    "vendor_phone": null,
    "vendor_website": "boulanger.com",
    "client_name": "Mr AANGOUR MOHAMED",
    "client_number": "57803110",
    "client_address": "43 bis AV VICTOR BASCH, 95250 BEAUCHAMP",
    "items": [
      {
        "code": "0001144516",
        "description": "Pack EPSON Ecotank Bouteille S",
        "details": "Pas de pièce disponible",
        "quantity": 1,
        "unit_price": 30.96,
        "tax_rate": 20.00,
        "tax_amount": null,
        "total": 30.96,
        "warranty": "Garantie réparation jusqu'au 07.10.2027"
      },
      {
        "code": "0000831860",
        "description": "Souris LOGITECH M705 Silver sa",
        "details": "ECO-PART DEEE",
        "quantity": 1,
        "unit_price": 31.77,
        "tax_rate": 20.00,
        "tax_amount": 0.02,
        "total": 31.77,
        "eco_part_deee": 0.02,
        "warranty": "Non concerné"
      }
    ],
    "tax_details": [
      {
        "type": "TVA",
        "rate": 20.00,
        "base_amount": 52.29,
        "tax_amount": 10.46
      },
      {
        "type": "DEEE",
        "rate": 0,
        "base_amount": null,
        "tax_amount": 0.02
      }
    ],
    "totals": {
      "total_ht": 52.29,
      "total_tax": 10.46,
      "total_ttc": 62.75,
      "eco_part_deee": 0.02
    },
    "payment_details": {
      "method": "Carte Bancaire",
      "amount_paid": 62.75,
      "change_returned": 0
    },
    "legal_info": {
      "system_certification": "Système d'encaissement certifié LNE",
      "warranty_info": "Garantie légale de conformité : 2 ans minimum à compter de la délivrance du produit",
      "return_policy": "Service Après Vente"
    },
    "additional_info": {
      "store_location": "Boulanger Montigny Les Cormeilles",
      "store_address": "Bd Victor Bordier face à Leroy Merlin",
      "company_headquarters": "Avenue de la Motte, 59810 Lesquin",
      "app_info": "Téléchargez l'appli - Boulanger avec vous, 7j/7"
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
        vendor_type: analysis.document_analysis?.vendor_type || "unknown",
      },
      transaction_data: {
        type: analysis.transaction_data?.type || "expense",
        amount: this.parseAmount(analysis.transaction_data?.amount) || 0,
        currency: analysis.transaction_data?.currency || "EUR",
        tax_amount:
          this.parseAmount(analysis.transaction_data?.tax_amount) || 0,
        tax_rate: this.parseAmount(analysis.transaction_data?.tax_rate) || 0,
        transaction_date: this.validateDate(
          analysis.transaction_data?.transaction_date,
        ),
        transaction_time: analysis.transaction_data?.transaction_time || null,
        due_date: this.validateDate(analysis.transaction_data?.due_date),
        payment_date: this.validateDate(
          analysis.transaction_data?.payment_date,
        ),
        document_number: analysis.transaction_data?.document_number || null,
        barcode: analysis.transaction_data?.barcode || null,
        reference: analysis.transaction_data?.reference || null,
        client_number: analysis.transaction_data?.client_number || null,
        client_name: analysis.transaction_data?.client_name || null,
        vendor_name:
          analysis.transaction_data?.vendor_name || "Fournisseur inconnu",
        status: analysis.transaction_data?.status || "pending",
        category: analysis.transaction_data?.category || "OTHER",
        subcategory: analysis.transaction_data?.subcategory || "non_classifie",
        payment_method: analysis.transaction_data?.payment_method || "unknown",
        description: analysis.transaction_data?.description || "Transaction",
      },
      extracted_fields: {
        // Informations fournisseur
        vendor_siret: analysis.extracted_fields?.vendor_siret || null,
        vendor_vat_number: analysis.extracted_fields?.vendor_vat_number || null,
        vendor_rcs: analysis.extracted_fields?.vendor_rcs || null,
        vendor_ape: analysis.extracted_fields?.vendor_ape || null,
        vendor_address: analysis.extracted_fields?.vendor_address || null,
        vendor_city: analysis.extracted_fields?.vendor_city || null,
        vendor_postal_code:
          analysis.extracted_fields?.vendor_postal_code || null,
        vendor_country: analysis.extracted_fields?.vendor_country || null,
        vendor_email: analysis.extracted_fields?.vendor_email || null,
        vendor_phone: analysis.extracted_fields?.vendor_phone || null,
        vendor_website: analysis.extracted_fields?.vendor_website || null,

        // Informations client
        client_name: analysis.extracted_fields?.client_name || null,
        client_number: analysis.extracted_fields?.client_number || null,
        client_address: analysis.extracted_fields?.client_address || null,

        // Articles/Produits
        items: Array.isArray(analysis.extracted_fields?.items)
          ? analysis.extracted_fields.items.map((item) => ({
              code: item.code || null,
              description: item.description || "Article",
              details: item.details || null,
              quantity: this.parseAmount(item.quantity) || 1,
              unit_price: this.parseAmount(item.unit_price) || 0,
              tax_rate: this.parseAmount(item.tax_rate) || 0,
              tax_amount: this.parseAmount(item.tax_amount) || null,
              total: this.parseAmount(item.total) || 0,
              eco_part_deee: this.parseAmount(item.eco_part_deee) || null,
              warranty: item.warranty || null,
            }))
          : [],

        // Détails TVA
        tax_details: Array.isArray(analysis.extracted_fields?.tax_details)
          ? analysis.extracted_fields.tax_details.map((tax) => ({
              type: tax.type || "TVA",
              rate: this.parseAmount(tax.rate) || 0,
              base_amount: this.parseAmount(tax.base_amount) || null,
              tax_amount: this.parseAmount(tax.tax_amount) || 0,
            }))
          : [],

        // Totaux
        totals: {
          total_ht:
            this.parseAmount(analysis.extracted_fields?.totals?.total_ht) || 0,
          total_tax:
            this.parseAmount(analysis.extracted_fields?.totals?.total_tax) || 0,
          total_ttc:
            this.parseAmount(analysis.extracted_fields?.totals?.total_ttc) || 0,
          eco_part_deee:
            this.parseAmount(
              analysis.extracted_fields?.totals?.eco_part_deee,
            ) || null,
        },

        // Détails paiement
        payment_details: {
          method:
            analysis.extracted_fields?.payment_details?.method || "unknown",
          amount_paid:
            this.parseAmount(
              analysis.extracted_fields?.payment_details?.amount_paid,
            ) || 0,
          change_returned:
            this.parseAmount(
              analysis.extracted_fields?.payment_details?.change_returned,
            ) || 0,
        },

        // Informations légales
        legal_info: analysis.extracted_fields?.legal_info || {},

        // Informations additionnelles
        additional_info: analysis.extracted_fields?.additional_info || {},
      },
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
   * Valide une date et la convertit en format ISO YYYY-MM-DD
   * Supporte les formats: DD/MM/YY, DD/MM/YYYY, YYYY-MM-DD
   */
  validateDate(dateStr) {
    if (!dateStr) return null;

    // Si c'est déjà au format YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    // Format français DD/MM/YY ou DD/MM/YYYY
    const frenchMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (frenchMatch) {
      const day = frenchMatch[1].padStart(2, "0");
      const month = frenchMatch[2].padStart(2, "0");
      let year = frenchMatch[3];
      if (year.length === 2) {
        year = `20${year}`;
      }
      return `${year}-${month}-${day}`;
    }

    // Format avec tirets DD-MM-YYYY ou DD-MM-YY
    const dashMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (dashMatch) {
      const day = dashMatch[1].padStart(2, "0");
      const month = dashMatch[2].padStart(2, "0");
      let year = dashMatch[3];
      if (year.length === 2) {
        year = `20${year}`;
      }
      return `${year}-${month}-${day}`;
    }

    // Essayer de parser en dernier recours (attention: peut mal interpréter)
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
    logger.debug("📋 Utilisation de l'analyse de secours");

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
        category: "OTHER",
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
const mistralIntelligentAnalysisService =
  new MistralIntelligentAnalysisService();

export default mistralIntelligentAnalysisService;
