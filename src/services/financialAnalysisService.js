/**
 * Service d'analyse financière pour l'extraction de données structurées
 * à partir de documents OCR (factures, reçus, relevés bancaires)
 */

class FinancialAnalysisService {
  constructor() {
    // Patterns de reconnaissance pour différents types de documents
    this.patterns = {
      amounts: {
        // Montants avec différents formats
        total: /(?:total\s*(?:ttc|ht)?|montant|amount)\s*:?\s*([0-9,.\s]+)\s*€?/gi,
        tva: /(?:tva|tax|vat)\s*:?\s*([0-9,.\s]+)\s*€?/gi,
        rate: /(?:taux|rate)\s*:?\s*([0-9,.\s]+)\s*%/gi
      },
      dates: {
        // Différents formats de dates
        emission: /(?:date?\s*(?:d'émission|émission|emission)|émis\s*le|date)\s*:?\s*([0-9]{1,2}[-\/\.][0-9]{1,2}[-\/\.][0-9]{2,4})/gi,
        echeance: /(?:échéance|due\s*date|à\s*payer\s*avant)\s*:?\s*([0-9]{1,2}[-\/\.][0-9]{1,2}[-\/\.][0-9]{2,4})/gi,
        paiement: /(?:payé\s*le|payment\s*date|date\s*de\s*paiement)\s*:?\s*([0-9]{1,2}[-\/\.][0-9]{1,2}[-\/\.][0-9]{2,4})/gi
      },
      document: {
        number: /(?:n°|num|facture|invoice|ref)\s*:?\s*([A-Z0-9\-_]+)/gi,
        type: /(?:facture|invoice|reçu|receipt|ticket|relevé)/gi
      }
    };

    // Catégories automatiques
    this.categories = {
      transport: ['essence', 'carburant', 'péage', 'taxi', 'uber', 'sncf', 'transport', 'parking', 'location', 'véhicule'],
      repas: ['restaurant', 'café', 'bar', 'traiteur', 'boulangerie', 'supermarché', 'alimentation', 'repas'],
      bureau: ['bureau', 'fournitures', 'papeterie', 'informatique', 'logiciel', 'abonnement', 'téléphone', 'internet'],
      prestation: ['conseil', 'développement', 'design', 'marketing', 'formation', 'consulting', 'service', 'prestation'],
      sante: ['pharmacie', 'médecin', 'dentiste', 'santé', 'mutuelle', 'assurance'],
      logement: ['loyer', 'électricité', 'gaz', 'eau', 'charges', 'assurance', 'habitation']
    };
  }

  /**
   * Analyse un document OCR et extrait les données financières
   * @param {Object} ocrData - Données OCR structurées
   * @param {Object} options - Options d'analyse
   * @returns {Object} - Données financières structurées
   */
  async analyzeDocument(ocrData, options = {}) {
    try {
      console.log('🔍 Début de l\'analyse financière du document');
      
      const rawText = ocrData.extractedText || '';
      const structuredData = ocrData.structuredData || {};
      
      // Analyse du type de document
      const documentAnalysis = this.analyzeDocumentType(rawText, structuredData);
      
      // Extraction des données de transaction
      const transactionData = this.extractTransactionData(rawText, structuredData, documentAnalysis);
      
      // Extraction des champs supplémentaires
      const extractedFields = this.extractAdditionalFields(rawText, structuredData);
      
      const result = {
        success: true,
        document_analysis: documentAnalysis,
        transaction_data: transactionData,
        extracted_fields: extractedFields,
        raw_content: rawText
      };
      
      console.log('✅ Analyse financière terminée:', {
        type: documentAnalysis.document_type,
        amount: transactionData.amount,
        vendor: transactionData.vendor_name
      });
      
      return result;
      
    } catch (error) {
      console.error('❌ Erreur lors de l\'analyse financière:', error);
      return {
        success: false,
        error: error.message,
        document_analysis: {
          document_type: "unknown",
          confidence: 0.0,
          language: "fr"
        },
        transaction_data: this.getEmptyTransactionData(),
        extracted_fields: {},
        raw_content: ocrData.extractedText || ''
      };
    }
  }

  /**
   * Analyse le type de document
   */
  analyzeDocumentType(rawText, structuredData) {
    const text = rawText.toLowerCase();
    let documentType = 'receipt';
    let confidence = 0.5;
    
    // Détection du type de document
    if (text.includes('facture') || text.includes('invoice')) {
      documentType = 'invoice';
      confidence = 0.9;
    } else if (text.includes('reçu') || text.includes('ticket') || text.includes('receipt')) {
      documentType = 'receipt';
      confidence = 0.8;
    } else if (text.includes('relevé') || text.includes('statement')) {
      documentType = 'bank_statement';
      confidence = 0.8;
    }
    
    // Détection de la langue
    const language = text.includes('invoice') || text.includes('amount') ? 'en' : 'fr';
    
    return {
      document_type: documentType,
      confidence: confidence,
      language: language
    };
  }

  /**
   * Extrait les données de transaction principales
   */
  extractTransactionData(rawText, structuredData, documentAnalysis) {
    const text = rawText.toLowerCase();
    
    // Détermination du type (expense/income)
    const type = this.determineTransactionType(rawText, structuredData);
    
    // Extraction des montants
    const amounts = this.extractAmounts(rawText, structuredData);
    
    // Extraction des dates
    const dates = this.extractDates(rawText);
    
    // Extraction du vendeur/fournisseur
    const vendorName = this.extractVendorName(rawText, structuredData);
    
    // Numéro de document
    const documentNumber = this.extractDocumentNumber(rawText);
    
    // Catégorisation automatique
    const category = this.categorizeTransaction(rawText, vendorName);
    
    // Statut du paiement
    const status = this.determinePaymentStatus(rawText, dates);
    
    return {
      type: type,
      amount: amounts.total,
      currency: "EUR",
      tax_amount: amounts.tax,
      tax_rate: amounts.taxRate,
      transaction_date: dates.transaction,
      due_date: dates.due,
      payment_date: dates.payment,
      document_number: documentNumber,
      vendor_name: vendorName,
      status: status,
      category: category.main,
      subcategory: category.sub,
      payment_method: this.extractPaymentMethod(rawText),
      description: this.generateDescription(vendorName, category.main, amounts.total)
    };
  }

  /**
   * Détermine si c'est une dépense ou un revenu
   */
  determineTransactionType(rawText, structuredData) {
    const text = rawText.toLowerCase();
    
    // Indices pour un revenu (facture émise)
    const incomeIndicators = [
      'facturé à',
      'à payer à',
      'bénéficiaire',
      'coordonnées bancaires'
    ];
    
    // Indices pour une dépense (facture reçue)
    const expenseIndicators = [
      'payé à',
      'fournisseur',
      'vendeur',
      'magasin'
    ];
    
    // Vérification des indicateurs
    const hasIncomeIndicators = incomeIndicators.some(indicator => text.includes(indicator));
    const hasExpenseIndicators = expenseIndicators.some(indicator => text.includes(indicator));
    
    if (hasIncomeIndicators && !hasExpenseIndicators) {
      return 'income';
    }
    
    // Par défaut, considérer comme une dépense
    return 'expense';
  }

  /**
   * Extrait les montants (total, TVA, taux)
   */
  extractAmounts(rawText, structuredData) {
    let total = 0.00;
    let tax = 0.00;
    let taxRate = 0.00;
    
    // Extraction depuis les tableaux structurés si disponibles
    if (structuredData.tables && structuredData.tables.length > 0) {
      const mainTable = structuredData.tables[0];
      total = this.extractAmountFromTable(mainTable, 'total');
      tax = this.extractAmountFromTable(mainTable, 'tva');
    }
    
    // Fallback: extraction par regex
    if (total === 0.00) {
      total = this.extractAmountByPattern(rawText, this.patterns.amounts.total);
    }
    
    if (tax === 0.00) {
      tax = this.extractAmountByPattern(rawText, this.patterns.amounts.tva);
    }
    
    // Extraction du taux de TVA
    taxRate = this.extractAmountByPattern(rawText, this.patterns.amounts.rate);
    
    return { total, tax, taxRate };
  }

  /**
   * Extrait un montant depuis un tableau structuré
   */
  extractAmountFromTable(table, type) {
    if (!table.rows) return 0.00;
    
    const searchTerms = {
      total: ['total', 'montant', 'ttc'],
      tva: ['tva', 'tax', 'taxe']
    };
    
    const terms = searchTerms[type] || [];
    
    for (const row of table.rows) {
      for (let i = 0; i < row.length; i++) {
        const cell = row[i].toLowerCase();
        if (terms.some(term => cell.includes(term))) {
          // Chercher le montant dans la même ligne
          for (let j = i; j < row.length; j++) {
            const amount = this.parseAmount(row[j]);
            if (amount > 0) return amount;
          }
        }
      }
    }
    
    return 0.00;
  }

  /**
   * Extrait un montant par pattern regex
   */
  extractAmountByPattern(text, pattern) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      return this.parseAmount(matches[0][1]);
    }
    return 0.00;
  }

  /**
   * Parse un montant textuel en nombre
   */
  parseAmount(amountStr) {
    if (!amountStr) return 0.00;
    
    // Nettoyer la chaîne
    const cleaned = amountStr
      .replace(/[^\d,.-]/g, '') // Garder seulement chiffres, virgules, points, tirets
      .replace(/\s/g, '') // Supprimer espaces
      .replace(/,/g, '.'); // Remplacer virgules par points
    
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0.00 : parsed;
  }

  /**
   * Extrait les dates du document
   */
  extractDates(rawText) {
    const transaction = this.extractDateByPattern(rawText, this.patterns.dates.emission);
    const due = this.extractDateByPattern(rawText, this.patterns.dates.echeance);
    const payment = this.extractDateByPattern(rawText, this.patterns.dates.paiement);
    
    return {
      transaction: transaction,
      due: due,
      payment: payment
    };
  }

  /**
   * Extrait une date par pattern et la formate
   */
  extractDateByPattern(text, pattern) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      return this.formatDate(matches[0][1]);
    }
    return null;
  }

  /**
   * Formate une date au format YYYY-MM-DD
   */
  formatDate(dateStr) {
    if (!dateStr) return null;
    
    try {
      // Gérer différents formats : DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
      const cleaned = dateStr.replace(/[^\d]/g, '');
      
      if (cleaned.length === 8) {
        const day = cleaned.substring(0, 2);
        const month = cleaned.substring(2, 4);
        const year = cleaned.substring(4, 8);
        
        return `${year}-${month}-${day}`;
      }
      
      return null;
    } catch (error) {
      console.warn('Erreur lors du formatage de date:', dateStr, error);
      return null;
    }
  }

  /**
   * Extrait le nom du vendeur/fournisseur
   */
  extractVendorName(rawText, structuredData) {
    // Essayer d'extraire depuis les sections structurées
    if (structuredData.sections) {
      for (const section of structuredData.sections) {
        if (section.title && !section.title.toLowerCase().includes('facturé à')) {
          // Prendre le premier nom qui n'est pas "Facturé à"
          const name = section.title.trim();
          if (name.length > 2 && name.length < 100) {
            return name;
          }
        }
      }
    }
    
    // Fallback: chercher dans le texte brut
    const lines = rawText.split('\n');
    for (const line of lines.slice(0, 10)) { // Chercher dans les 10 premières lignes
      const trimmed = line.trim();
      if (trimmed.length > 3 && trimmed.length < 100 && 
          !trimmed.toLowerCase().includes('facture') &&
          !trimmed.toLowerCase().includes('date')) {
        return trimmed;
      }
    }
    
    return 'Fournisseur inconnu';
  }

  /**
   * Extrait le numéro de document
   */
  extractDocumentNumber(rawText) {
    const matches = [...rawText.matchAll(this.patterns.document.number)];
    if (matches.length > 0) {
      return matches[0][1];
    }
    return null;
  }

  /**
   * Catégorise automatiquement la transaction
   */
  categorizeTransaction(rawText, vendorName) {
    const text = (rawText + ' ' + vendorName).toLowerCase();
    
    for (const [category, keywords] of Object.entries(this.categories)) {
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          return {
            main: category,
            sub: keyword
          };
        }
      }
    }
    
    return {
      main: 'autre',
      sub: 'non_classifie'
    };
  }

  /**
   * Détermine le statut de paiement
   */
  determinePaymentStatus(rawText, dates) {
    const text = rawText.toLowerCase();
    
    if (text.includes('payé') || text.includes('paid') || dates.payment) {
      return 'paid';
    }
    
    if (dates.due) {
      const dueDate = new Date(dates.due);
      const today = new Date();
      
      if (dueDate < today) {
        return 'overdue';
      }
    }
    
    return 'pending';
  }

  /**
   * Extrait le moyen de paiement
   */
  extractPaymentMethod(rawText) {
    const text = rawText.toLowerCase();
    
    if (text.includes('carte') || text.includes('card')) return 'card';
    if (text.includes('virement') || text.includes('transfer')) return 'transfer';
    if (text.includes('espèces') || text.includes('cash')) return 'cash';
    if (text.includes('chèque') || text.includes('check')) return 'check';
    
    return 'unknown';
  }

  /**
   * Génère une description automatique
   */
  generateDescription(vendorName, category, amount) {
    const categoryLabels = {
      transport: 'Transport',
      repas: 'Repas',
      bureau: 'Fournitures bureau',
      prestation: 'Prestation',
      autre: 'Dépense'
    };
    
    const label = categoryLabels[category] || 'Dépense';
    return `${label} - ${vendorName} (${amount}€)`;
  }

  /**
   * Extrait les champs supplémentaires
   */
  extractAdditionalFields(rawText, structuredData) {
    const fields = {};
    
    // Extraction d'adresse, SIRET, etc.
    const siretMatch = rawText.match(/siret\s*:?\s*([0-9\s]+)/gi);
    if (siretMatch) {
      fields.vendor_siret = siretMatch[0].replace(/[^\d]/g, '');
    }
    
    // Extraction des items depuis les tableaux
    if (structuredData.tables && structuredData.tables.length > 0) {
      fields.items = this.extractItemsFromTable(structuredData.tables[0]);
    }
    
    return fields;
  }

  /**
   * Extrait les items depuis un tableau
   */
  extractItemsFromTable(table) {
    if (!table.headers || !table.rows) return [];
    
    const items = [];
    
    for (const row of table.rows) {
      if (row.length >= 3) {
        const item = {
          description: row[0] || '',
          quantity: this.parseAmount(row[1]) || 1,
          unit_price: this.parseAmount(row[2]) || 0,
          total: this.parseAmount(row[row.length - 1]) || 0
        };
        
        if (item.description && item.description.length > 2) {
          items.push(item);
        }
      }
    }
    
    return items;
  }

  /**
   * Retourne une structure de transaction vide
   */
  getEmptyTransactionData() {
    return {
      type: "expense",
      amount: 0.00,
      currency: "EUR",
      tax_amount: 0.00,
      tax_rate: 0.00,
      transaction_date: null,
      due_date: null,
      payment_date: null,
      document_number: null,
      vendor_name: "unknown",
      status: "pending",
      category: "autre",
      subcategory: "unknown",
      payment_method: "unknown",
      description: "Document non analysable"
    };
  }
}

// Instance singleton
const financialAnalysisService = new FinancialAnalysisService();

export default financialAnalysisService;
