/**
 * Service d'extraction de factures amélioré
 * Utilise des patterns spécialisés pour les factures françaises
 * et une analyse multi-passes pour une précision maximale
 */

import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// Patterns regex optimisés pour les factures françaises
const FRENCH_INVOICE_PATTERNS = {
  // Numéros de facture - formats courants français
  INVOICE_NUMBER: [
    /(?:Facture|FACTURE|Invoice|N°\s*facture|Numéro\s*de\s*facture|Réf\.?\s*facture|N°)[:\s]*([A-Z]{0,4}[-/]?\d{4,}[-/]?\d{0,6})/i,
    /(?:FA|FAC|FACT|INV|F)[-/]?(\d{4,}[-/]?\d{0,6})/i,
    /(\d{4}[-/]\d{4,})/,
  ],

  // Dates - formats français (JJ/MM/AAAA, JJ-MM-AAAA, etc.)
  DATE: [
    /(?:Date\s*(?:de\s*)?(?:facture|émission|facturation)?)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    /(?:Le|Du|Émise?\s*le)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/,
  ],

  // Date d'échéance
  DUE_DATE: [
    /(?:Échéance|Date\s*d['']échéance|Date\s*limite|Payable\s*(?:avant\s*le|le)|À\s*payer\s*avant)[:\s]*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i,
    /(?:Net\s*à|Paiement\s*à)\s*(\d+)\s*jours/i,
  ],

  // Montants - formats français avec virgule décimale
  TOTAL_TTC: [
    /(?:Total\s*TTC|Montant\s*TTC|Net\s*à\s*payer|Total\s*à\s*payer|TOTAL\s*TTC)[:\s€]*([0-9\s]+[,\.]\d{2})\s*€?/i,
    /(?:TOTAL|Total)[:\s€]*([0-9\s]+[,\.]\d{2})\s*€?\s*(?:TTC)?/i,
  ],

  TOTAL_HT: [
    /(?:Total\s*HT|Montant\s*HT|Base\s*HT|Sous-?total\s*HT|TOTAL\s*HT)[:\s€]*([0-9\s]+[,\.]\d{2})\s*€?/i,
    /(?:HT)[:\s€]*([0-9\s]+[,\.]\d{2})\s*€?/i,
  ],

  TVA_AMOUNT: [
    /(?:TVA|Montant\s*TVA|Total\s*TVA)[:\s€]*([0-9\s]+[,\.]\d{2})\s*€?/i,
    /(?:TVA\s*(?:\d+(?:[,\.]\d+)?%?))[:\s€]*([0-9\s]+[,\.]\d{2})\s*€?/i,
  ],

  TVA_RATE: [
    /(?:TVA|Taux\s*TVA)[:\s]*(\d+(?:[,\.]\d+)?)\s*%/i,
    /(\d+(?:[,\.]\d+)?)\s*%\s*(?:TVA)?/i,
  ],

  // SIRET (14 chiffres)
  SIRET: [
    /(?:SIRET|N°\s*SIRET)[:\s]*(\d{3}\s?\d{3}\s?\d{3}\s?\d{5})/i,
    /(?:SIRET)[:\s]*(\d{14})/i,
  ],

  // SIREN (9 chiffres)
  SIREN: [
    /(?:SIREN|N°\s*SIREN)[:\s]*(\d{3}\s?\d{3}\s?\d{3})/i,
    /(?:SIREN)[:\s]*(\d{9})/i,
  ],

  // Numéro de TVA intracommunautaire
  VAT_NUMBER: [
    /(?:TVA\s*intra(?:communautaire)?|N°\s*TVA|VAT|Identifiant\s*TVA)[:\s]*(FR\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{3})/i,
    /(?:TVA)[:\s]*(FR\s?\d{11})/i,
    /(FR\s?\d{2}\s?\d{9})/i,
  ],

  // RCS
  RCS: [
    /(?:RCS|Immatriculation)[:\s]*([A-Z\s]+\d{3}\s?\d{3}\s?\d{3})/i,
    /RCS\s+([A-Z]+)\s+[BDA]?\s*(\d{3}\s?\d{3}\s?\d{3})/i,
  ],

  // Code postal et ville
  POSTAL_CODE_CITY: [
    /(\d{5})\s+([A-ZÀ-Ÿ][A-Za-zÀ-ÿ\s\-']+)/,
    /([A-ZÀ-Ÿ][A-Za-zÀ-ÿ\s\-']+)\s+(\d{5})/,
  ],

  // IBAN
  IBAN: [
    /(?:IBAN)[:\s]*([A-Z]{2}\d{2}(?:\s?\d{4}){5,6}\s?\d{1,4})/i,
    /(FR\d{2}(?:\s?\d{4}){5}\s?\d{3})/i,
  ],

  // BIC/SWIFT
  BIC: [
    /(?:BIC|SWIFT)[:\s]*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)/i,
  ],

  // Email
  EMAIL: [
    /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
  ],

  // Téléphone français
  PHONE: [
    /(?:Tél\.?|Téléphone|Tel\.?|Phone)[:\s]*((?:0|\+33)[1-9](?:[\s\.\-]?\d{2}){4})/i,
    /((?:0|\+33)[1-9](?:[\s\.\-]?\d{2}){4})/,
  ],

  // Moyen de paiement
  PAYMENT_METHOD: [
    /(?:Mode\s*de\s*paiement|Paiement|Règlement)[:\s]*(Carte\s*(?:bancaire|bleue)|CB|Virement|Chèque|Espèces|Prélèvement)/i,
    /(Carte\s*(?:bancaire|bleue)|CB|Virement|Chèque|Espèces|Prélèvement)/i,
  ],
};

// Catégories de dépenses avec mots-clés
const EXPENSE_CATEGORIES = {
  OFFICE_SUPPLIES: ['fourniture', 'bureau', 'papeterie', 'cartouche', 'encre', 'stylo', 'classeur', 'papier'],
  EQUIPMENT: ['ordinateur', 'écran', 'clavier', 'souris', 'imprimante', 'scanner', 'téléphone', 'matériel', 'équipement', 'informatique'],
  TRAVEL: ['transport', 'train', 'avion', 'taxi', 'uber', 'vtc', 'essence', 'carburant', 'péage', 'parking', 'hôtel', 'hébergement'],
  MEALS: ['restaurant', 'repas', 'déjeuner', 'dîner', 'café', 'traiteur', 'restauration'],
  MARKETING: ['publicité', 'marketing', 'communication', 'flyer', 'affiche', 'pub', 'google ads', 'facebook'],
  TRAINING: ['formation', 'cours', 'séminaire', 'conférence', 'atelier', 'coaching'],
  SERVICES: ['prestation', 'service', 'conseil', 'consulting', 'maintenance', 'réparation', 'nettoyage'],
  RENT: ['loyer', 'location', 'bail', 'charges locatives'],
  UTILITIES: ['électricité', 'gaz', 'eau', 'internet', 'télécom', 'abonnement', 'edf', 'engie'],
  INSURANCE: ['assurance', 'mutuelle', 'prévoyance'],
  SUBSCRIPTIONS: ['abonnement', 'licence', 'saas', 'logiciel', 'software'],
};

class InvoiceExtractionService {
  constructor() {
    this.apiKey = process.env.MISTRAL_API_KEY;
    this.chatEndpoint = "https://api.mistral.ai/v1/chat/completions";
    // Utiliser un modèle plus puissant pour une meilleure précision
    this.model = process.env.MISTRAL_MODEL || "mistral-large-latest";
  }

  /**
   * Extraction principale avec analyse multi-passes
   */
  async extractInvoiceData(ocrResult) {
    try {
      const extractedText = ocrResult.extractedText || "";
      
      if (!extractedText || extractedText.trim().length < 50) {
        console.warn("⚠️ Texte OCR trop court pour analyse");
        return this.getEmptyResult("Texte insuffisant pour analyse");
      }

      // Passe 1: Extraction par patterns regex
      const regexExtraction = this.extractWithPatterns(extractedText);
      console.log("📋 Extraction regex:", JSON.stringify(regexExtraction, null, 2));

      // Passe 2: Analyse IA avec prompt optimisé
      const aiExtraction = await this.extractWithAI(extractedText, regexExtraction);
      console.log("🤖 Extraction IA:", JSON.stringify(aiExtraction, null, 2));

      // Passe 3: Fusion et validation croisée
      const mergedData = this.mergeAndValidate(regexExtraction, aiExtraction, extractedText);
      console.log("✅ Données fusionnées:", JSON.stringify(mergedData, null, 2));

      // Passe 4: Post-traitement et normalisation
      const finalData = this.postProcess(mergedData);

      return {
        success: true,
        ...finalData,
        raw_content: extractedText,
      };

    } catch (error) {
      console.error("❌ Erreur extraction facture:", error);
      return this.getEmptyResult(error.message);
    }
  }

  /**
   * Extraction par patterns regex
   */
  extractWithPatterns(text) {
    const result = {
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      totalTTC: null,
      totalHT: null,
      tvaAmount: null,
      tvaRate: null,
      siret: null,
      siren: null,
      vatNumber: null,
      rcs: null,
      iban: null,
      bic: null,
      email: null,
      phone: null,
      paymentMethod: null,
      postalCode: null,
      city: null,
    };

    // Appliquer chaque pattern
    for (const [field, patterns] of Object.entries(FRENCH_INVOICE_PATTERNS)) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          const fieldKey = this.patternToFieldKey(field);
          if (field === 'POSTAL_CODE_CITY' && match[1] && match[2]) {
            result.postalCode = match[1].trim();
            result.city = match[2].trim();
          } else if (match[1]) {
            result[fieldKey] = this.cleanExtractedValue(match[1], field);
          }
          break; // Prendre le premier match
        }
      }
    }

    return result;
  }

  /**
   * Convertit le nom du pattern en clé de champ
   */
  patternToFieldKey(patternName) {
    const mapping = {
      'INVOICE_NUMBER': 'invoiceNumber',
      'DATE': 'invoiceDate',
      'DUE_DATE': 'dueDate',
      'TOTAL_TTC': 'totalTTC',
      'TOTAL_HT': 'totalHT',
      'TVA_AMOUNT': 'tvaAmount',
      'TVA_RATE': 'tvaRate',
      'SIRET': 'siret',
      'SIREN': 'siren',
      'VAT_NUMBER': 'vatNumber',
      'RCS': 'rcs',
      'IBAN': 'iban',
      'BIC': 'bic',
      'EMAIL': 'email',
      'PHONE': 'phone',
      'PAYMENT_METHOD': 'paymentMethod',
    };
    return mapping[patternName] || patternName.toLowerCase();
  }

  /**
   * Nettoie une valeur extraite
   */
  cleanExtractedValue(value, field) {
    if (!value) return null;
    
    let cleaned = value.toString().trim();
    
    // Nettoyer les espaces multiples
    cleaned = cleaned.replace(/\s+/g, ' ');
    
    // Nettoyer les montants
    if (['TOTAL_TTC', 'TOTAL_HT', 'TVA_AMOUNT'].includes(field)) {
      cleaned = cleaned.replace(/\s/g, '').replace(',', '.');
      return parseFloat(cleaned) || null;
    }
    
    // Nettoyer les taux
    if (field === 'TVA_RATE') {
      cleaned = cleaned.replace(',', '.');
      return parseFloat(cleaned) || null;
    }
    
    // Nettoyer SIRET/SIREN
    if (['SIRET', 'SIREN'].includes(field)) {
      return cleaned.replace(/\s/g, '');
    }
    
    // Nettoyer numéro TVA
    if (field === 'VAT_NUMBER') {
      return cleaned.replace(/\s/g, '').toUpperCase();
    }
    
    return cleaned;
  }

  /**
   * Extraction par IA avec prompt optimisé
   */
  async extractWithAI(text, regexHints) {
    if (!this.apiKey) {
      console.warn("⚠️ Clé API Mistral non configurée");
      return {};
    }

    const prompt = this.buildOptimizedPrompt(text, regexHints);

    try {
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
              content: `Tu es un expert en extraction de données de factures françaises. Tu dois extraire TOUTES les informations avec une précision maximale.

RÈGLES CRITIQUES:
1. Les montants en France utilisent la VIRGULE comme séparateur décimal (ex: 1 234,56 €)
2. Convertis TOUJOURS les montants en format numérique avec POINT décimal (ex: 1234.56)
3. Les dates françaises sont au format JJ/MM/AAAA - convertis en YYYY-MM-DD
4. Le SIRET a 14 chiffres, le SIREN 9 chiffres
5. Le numéro de TVA français commence par FR suivi de 11 chiffres
6. Extrait TOUS les articles/lignes de la facture avec leurs détails
7. Réponds UNIQUEMENT en JSON valide, sans texte avant ou après`
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.05, // Très basse pour maximiser la précision
          response_format: { type: "json_object" },
          max_tokens: 4000,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Erreur API Mistral:", response.status, errorText);
        return {};
      }

      const result = await response.json();
      const content = result.choices[0]?.message?.content;

      if (!content) {
        return {};
      }

      return JSON.parse(content);

    } catch (error) {
      console.error("❌ Erreur extraction IA:", error);
      return {};
    }
  }

  /**
   * Construit un prompt optimisé pour l'extraction
   */
  buildOptimizedPrompt(text, regexHints) {
    // Inclure les indices regex pour guider l'IA
    const hintsSection = Object.entries(regexHints)
      .filter(([_, v]) => v !== null)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    return `FACTURE À ANALYSER:
"""
${text}
"""

${hintsSection ? `INDICES DÉTECTÉS PAR REGEX (à vérifier et compléter):
${hintsSection}` : ''}

EXTRAIT TOUTES les informations suivantes au format JSON:

{
  "vendor": {
    "name": "Nom exact de l'entreprise émettrice",
    "address": "Adresse complète sur une ligne",
    "street": "Numéro et nom de rue",
    "postalCode": "Code postal (5 chiffres)",
    "city": "Ville",
    "country": "Pays (France par défaut)",
    "siret": "14 chiffres sans espaces",
    "siren": "9 chiffres sans espaces",
    "vatNumber": "FR + 11 chiffres sans espaces",
    "rcs": "RCS + Ville + numéro",
    "ape": "Code APE/NAF",
    "capitalSocial": "Capital social en euros",
    "email": "Email de contact",
    "phone": "Téléphone",
    "website": "Site web"
  },
  "client": {
    "name": "Nom du client/destinataire",
    "address": "Adresse complète",
    "postalCode": "Code postal",
    "city": "Ville",
    "clientNumber": "Numéro client si présent"
  },
  "invoice": {
    "number": "Numéro de facture exact",
    "date": "YYYY-MM-DD",
    "dueDate": "YYYY-MM-DD ou null",
    "paymentDate": "YYYY-MM-DD ou null",
    "reference": "Référence commande/bon si présent"
  },
  "amounts": {
    "totalHT": 0.00,
    "totalTVA": 0.00,
    "totalTTC": 0.00,
    "currency": "EUR"
  },
  "taxes": [
    {
      "rate": 20.0,
      "baseHT": 0.00,
      "amount": 0.00
    }
  ],
  "items": [
    {
      "code": "Code article si présent",
      "description": "Description complète",
      "quantity": 1,
      "unit": "unité, pièce, heure, etc.",
      "unitPriceHT": 0.00,
      "unitPriceTTC": 0.00,
      "vatRate": 20.0,
      "totalHT": 0.00,
      "totalTTC": 0.00
    }
  ],
  "payment": {
    "method": "Carte bancaire|Virement|Chèque|Espèces|Prélèvement",
    "iban": "IBAN si présent",
    "bic": "BIC/SWIFT si présent",
    "bankName": "Nom de la banque"
  },
  "category": "OFFICE_SUPPLIES|EQUIPMENT|TRAVEL|MEALS|MARKETING|TRAINING|SERVICES|RENT|UTILITIES|INSURANCE|SUBSCRIPTIONS|OTHER",
  "confidence": 0.95,
  "notes": "Informations additionnelles importantes"
}

IMPORTANT: 
- Tous les montants doivent être des NOMBRES (pas de chaînes)
- Les dates doivent être au format YYYY-MM-DD
- Si une information n'est pas trouvée, utilise null
- Extrait CHAQUE ligne d'article visible`;
  }

  /**
   * Fusionne et valide les extractions
   */
  mergeAndValidate(regexData, aiData, originalText) {
    const merged = {
      document_analysis: {
        document_type: "invoice",
        confidence: aiData.confidence || 0.8,
        language: "fr",
      },
      transaction_data: {
        type: "expense",
        amount: null,
        currency: aiData.amounts?.currency || "EUR",
        tax_amount: null,
        tax_rate: null,
        transaction_date: null,
        due_date: null,
        payment_date: null,
        document_number: null,
        vendor_name: null,
        client_name: null,
        client_number: null,
        status: "pending",
        category: this.detectCategory(originalText, aiData),
        payment_method: null,
        description: null,
      },
      extracted_fields: {
        vendor_siret: null,
        vendor_siren: null,
        vendor_vat_number: null,
        vendor_rcs: null,
        vendor_ape: null,
        vendor_address: null,
        vendor_city: null,
        vendor_postal_code: null,
        vendor_country: "France",
        vendor_email: null,
        vendor_phone: null,
        vendor_website: null,
        vendor_capital: null,
        client_name: null,
        client_address: null,
        client_number: null,
        items: [],
        tax_details: [],
        totals: {
          total_ht: null,
          total_tax: null,
          total_ttc: null,
        },
        payment_details: {
          method: null,
          iban: null,
          bic: null,
          bank_name: null,
        },
      },
    };

    // Fusionner les données vendor
    const vendor = aiData.vendor || {};
    merged.transaction_data.vendor_name = vendor.name || null;
    merged.extracted_fields.vendor_siret = this.validateSiret(vendor.siret || regexData.siret);
    merged.extracted_fields.vendor_siren = this.validateSiren(vendor.siren || regexData.siren);
    merged.extracted_fields.vendor_vat_number = this.validateVatNumber(vendor.vatNumber || regexData.vatNumber);
    merged.extracted_fields.vendor_rcs = vendor.rcs || regexData.rcs;
    merged.extracted_fields.vendor_ape = vendor.ape;
    merged.extracted_fields.vendor_address = vendor.address || vendor.street;
    merged.extracted_fields.vendor_city = vendor.city || regexData.city;
    merged.extracted_fields.vendor_postal_code = vendor.postalCode || regexData.postalCode;
    merged.extracted_fields.vendor_country = vendor.country || "France";
    merged.extracted_fields.vendor_email = vendor.email || regexData.email;
    merged.extracted_fields.vendor_phone = vendor.phone || regexData.phone;
    merged.extracted_fields.vendor_website = vendor.website;
    merged.extracted_fields.vendor_capital = vendor.capitalSocial;

    // Fusionner les données client
    const client = aiData.client || {};
    merged.transaction_data.client_name = client.name;
    merged.transaction_data.client_number = client.clientNumber;
    merged.extracted_fields.client_name = client.name;
    merged.extracted_fields.client_address = client.address;
    merged.extracted_fields.client_number = client.clientNumber;

    // Fusionner les données facture
    const invoice = aiData.invoice || {};
    merged.transaction_data.document_number = invoice.number || regexData.invoiceNumber;
    merged.transaction_data.transaction_date = this.validateDate(invoice.date || regexData.invoiceDate);
    merged.transaction_data.due_date = this.validateDate(invoice.dueDate || regexData.dueDate);
    merged.transaction_data.payment_date = this.validateDate(invoice.paymentDate);

    // Fusionner les montants - priorité à l'IA, fallback regex
    const amounts = aiData.amounts || {};
    merged.extracted_fields.totals.total_ht = this.validateAmount(amounts.totalHT) || regexData.totalHT;
    merged.extracted_fields.totals.total_tax = this.validateAmount(amounts.totalTVA) || regexData.tvaAmount;
    merged.extracted_fields.totals.total_ttc = this.validateAmount(amounts.totalTTC) || regexData.totalTTC;
    
    merged.transaction_data.amount = merged.extracted_fields.totals.total_ttc;
    merged.transaction_data.tax_amount = merged.extracted_fields.totals.total_tax;
    merged.transaction_data.tax_rate = regexData.tvaRate || this.inferTaxRate(merged.extracted_fields.totals);

    // Fusionner les taxes
    if (Array.isArray(aiData.taxes)) {
      merged.extracted_fields.tax_details = aiData.taxes.map(tax => ({
        type: "TVA",
        rate: this.validateAmount(tax.rate) || 0,
        base_amount: this.validateAmount(tax.baseHT),
        tax_amount: this.validateAmount(tax.amount) || 0,
      }));
    }

    // Fusionner les articles
    if (Array.isArray(aiData.items)) {
      merged.extracted_fields.items = aiData.items.map(item => ({
        code: item.code,
        description: item.description || "Article",
        quantity: this.validateAmount(item.quantity) || 1,
        unit: item.unit || "unité",
        unit_price_ht: this.validateAmount(item.unitPriceHT),
        unit_price_ttc: this.validateAmount(item.unitPriceTTC),
        vat_rate: this.validateAmount(item.vatRate) || 20,
        total_ht: this.validateAmount(item.totalHT),
        total_ttc: this.validateAmount(item.totalTTC),
      }));
    }

    // Fusionner les données de paiement
    const payment = aiData.payment || {};
    merged.transaction_data.payment_method = this.normalizePaymentMethod(payment.method || regexData.paymentMethod);
    merged.extracted_fields.payment_details.method = payment.method || regexData.paymentMethod;
    merged.extracted_fields.payment_details.iban = this.validateIban(payment.iban || regexData.iban);
    merged.extracted_fields.payment_details.bic = payment.bic || regexData.bic;
    merged.extracted_fields.payment_details.bank_name = payment.bankName;

    // Générer la description
    merged.transaction_data.description = this.generateDescription(merged);

    return merged;
  }

  /**
   * Valide un SIRET (14 chiffres)
   */
  validateSiret(siret) {
    if (!siret) return null;
    const cleaned = siret.toString().replace(/\s/g, '');
    return /^\d{14}$/.test(cleaned) ? cleaned : null;
  }

  /**
   * Valide un SIREN (9 chiffres)
   */
  validateSiren(siren) {
    if (!siren) return null;
    const cleaned = siren.toString().replace(/\s/g, '');
    return /^\d{9}$/.test(cleaned) ? cleaned : null;
  }

  /**
   * Valide un numéro de TVA français
   */
  validateVatNumber(vatNumber) {
    if (!vatNumber) return null;
    const cleaned = vatNumber.toString().replace(/\s/g, '').toUpperCase();
    return /^FR\d{11}$/.test(cleaned) ? cleaned : null;
  }

  /**
   * Valide un IBAN
   */
  validateIban(iban) {
    if (!iban) return null;
    const cleaned = iban.toString().replace(/\s/g, '').toUpperCase();
    return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(cleaned) ? cleaned : null;
  }

  /**
   * Valide et normalise une date
   */
  validateDate(dateStr) {
    if (!dateStr) return null;

    // Si déjà au format YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const date = new Date(dateStr);
      return isNaN(date.getTime()) ? null : dateStr;
    }

    // Format français JJ/MM/AAAA ou JJ-MM-AAAA ou JJ.MM.AAAA
    const frenchMatch = dateStr.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
    if (frenchMatch) {
      let [, day, month, year] = frenchMatch;
      if (year.length === 2) {
        year = parseInt(year) > 50 ? `19${year}` : `20${year}`;
      }
      const formatted = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      const date = new Date(formatted);
      return isNaN(date.getTime()) ? null : formatted;
    }

    return null;
  }

  /**
   * Valide un montant
   */
  validateAmount(amount) {
    if (amount === null || amount === undefined) return null;
    if (typeof amount === 'number') return isNaN(amount) ? null : Math.round(amount * 100) / 100;
    if (typeof amount === 'string') {
      const cleaned = amount.replace(/\s/g, '').replace(',', '.');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? null : Math.round(parsed * 100) / 100;
    }
    return null;
  }

  /**
   * Infère le taux de TVA à partir des totaux
   */
  inferTaxRate(totals) {
    if (totals.total_ht && totals.total_tax) {
      const rate = (totals.total_tax / totals.total_ht) * 100;
      // Arrondir aux taux courants
      if (rate >= 19 && rate <= 21) return 20;
      if (rate >= 9.5 && rate <= 10.5) return 10;
      if (rate >= 5 && rate <= 6) return 5.5;
      if (rate >= 2 && rate <= 3) return 2.1;
      return Math.round(rate * 10) / 10;
    }
    return 20; // Taux par défaut
  }

  /**
   * Normalise le moyen de paiement
   */
  normalizePaymentMethod(method) {
    if (!method) return "unknown";
    const lower = method.toLowerCase();
    if (lower.includes('carte') || lower.includes('cb')) return "card";
    if (lower.includes('virement')) return "transfer";
    if (lower.includes('chèque') || lower.includes('cheque')) return "check";
    if (lower.includes('espèce') || lower.includes('cash')) return "cash";
    if (lower.includes('prélèvement')) return "direct_debit";
    return "unknown";
  }

  /**
   * Détecte la catégorie de dépense
   */
  detectCategory(text, aiData) {
    // Priorité à la catégorie IA si valide
    if (aiData.category && EXPENSE_CATEGORIES[aiData.category]) {
      return aiData.category;
    }

    const lowerText = text.toLowerCase();
    
    for (const [category, keywords] of Object.entries(EXPENSE_CATEGORIES)) {
      for (const keyword of keywords) {
        if (lowerText.includes(keyword)) {
          return category;
        }
      }
    }

    return "OTHER";
  }

  /**
   * Génère une description automatique
   */
  generateDescription(data) {
    const parts = [];
    
    if (data.transaction_data.vendor_name) {
      parts.push(data.transaction_data.vendor_name);
    }
    
    if (data.extracted_fields.items && data.extracted_fields.items.length > 0) {
      const itemDescs = data.extracted_fields.items
        .slice(0, 3)
        .map(i => i.description)
        .filter(Boolean);
      if (itemDescs.length > 0) {
        parts.push(`(${itemDescs.join(', ')})`);
      }
    }

    return parts.join(' ') || "Facture importée";
  }

  /**
   * Post-traitement final
   */
  postProcess(data) {
    // Vérifier la cohérence des montants
    const totals = data.extracted_fields.totals;
    
    // Si on a HT et TVA mais pas TTC, calculer
    if (totals.total_ht && totals.total_tax && !totals.total_ttc) {
      totals.total_ttc = Math.round((totals.total_ht + totals.total_tax) * 100) / 100;
      data.transaction_data.amount = totals.total_ttc;
    }
    
    // Si on a TTC et TVA mais pas HT, calculer
    if (totals.total_ttc && totals.total_tax && !totals.total_ht) {
      totals.total_ht = Math.round((totals.total_ttc - totals.total_tax) * 100) / 100;
    }
    
    // Si on a TTC et HT mais pas TVA, calculer
    if (totals.total_ttc && totals.total_ht && !totals.total_tax) {
      totals.total_tax = Math.round((totals.total_ttc - totals.total_ht) * 100) / 100;
      data.transaction_data.tax_amount = totals.total_tax;
    }

    // Calculer la confiance globale
    let confidence = 0.5;
    let fieldsFound = 0;
    let totalFields = 10;

    if (data.transaction_data.vendor_name) { fieldsFound++; }
    if (data.transaction_data.document_number) { fieldsFound++; }
    if (data.transaction_data.transaction_date) { fieldsFound++; }
    if (totals.total_ttc) { fieldsFound++; }
    if (totals.total_ht) { fieldsFound++; }
    if (totals.total_tax) { fieldsFound++; }
    if (data.extracted_fields.vendor_siret) { fieldsFound++; }
    if (data.extracted_fields.items.length > 0) { fieldsFound++; }
    if (data.transaction_data.payment_method !== "unknown") { fieldsFound++; }
    if (data.extracted_fields.vendor_address) { fieldsFound++; }

    confidence = Math.round((fieldsFound / totalFields) * 100) / 100;
    data.document_analysis.confidence = Math.max(confidence, data.document_analysis.confidence || 0);

    return data;
  }

  /**
   * Retourne un résultat vide en cas d'erreur
   */
  getEmptyResult(errorMessage) {
    return {
      success: false,
      document_analysis: {
        document_type: "unknown",
        confidence: 0,
        language: "fr",
        error: errorMessage,
      },
      transaction_data: {
        type: "expense",
        amount: 0,
        currency: "EUR",
        tax_amount: 0,
        tax_rate: 0,
        transaction_date: null,
        due_date: null,
        document_number: null,
        vendor_name: "Fournisseur inconnu",
        status: "pending",
        category: "OTHER",
        payment_method: "unknown",
        description: "Extraction échouée - Saisie manuelle requise",
      },
      extracted_fields: {
        items: [],
        tax_details: [],
        totals: { total_ht: 0, total_tax: 0, total_ttc: 0 },
        payment_details: {},
      },
      raw_content: "",
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
const invoiceExtractionService = new InvoiceExtractionService();

export default invoiceExtractionService;
