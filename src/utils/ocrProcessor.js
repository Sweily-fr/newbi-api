/**
 * Utilitaire de traitement OCR pour extraire les informations des factures et reçus
 */
import { createWorker } from "tesseract.js";
import fs from "fs";

// Expressions régulières pour extraire les informations courantes des factures
const REGEX = {
  // Numéro de TVA (formats européens courants)
  VAT_NUMBER:
    /(?:TVA|VAT|Tax ID|N° TVA|VAT Number|VAT No)[^\w]?[:\s]*([A-Z]{2}[0-9A-Z]{2,12})/i,

  // Numéro de facture
  INVOICE_NUMBER:
    /(?:Facture|Invoice|Bill|N°)[^\w]?[:\s]*([A-Z0-9]{1,4}[-\s]?[0-9]{1,10})/i,

  // Date de facture (formats courants)
  INVOICE_DATE:
    /(?:Date|Date de facture|Invoice date|Date d'émission)[^\w]?[:\s]*(\d{1,2}[-./]\d{1,2}[-./]\d{2,4}|\d{4}[-./]\d{1,2}[-./]\d{1,2})/i,

  // Montant total
  TOTAL_AMOUNT:
    /(?:Total|Montant total|Total amount|Total TTC|Total \(TTC\))[^\w]?[:\s]*([0-9\s]+[,.][0-9]{2})/i,

  // Montant TVA
  VAT_AMOUNT:
    /(?:TVA|VAT|Tax|Taxe|Montant TVA|VAT amount)[^\w]?[:\s]*([0-9\s]+[,.][0-9]{2})/i,

  // Devise
  CURRENCY: /(?:€|\$|£|EUR|USD|GBP|CAD|CHF)/i,
};

/**
 * Nettoie et normalise le texte extrait
 * @param {string} text - Texte à nettoyer
 * @returns {string} - Texte nettoyé
 */
const cleanText = (text) => {
  return text.replace(/\s+/g, " ").trim();
};

/**
 * Extrait un montant à partir d'une chaîne de caractères
 * @param {string} amountStr - Chaîne contenant un montant
 * @returns {number|null} - Montant converti en nombre ou null si non valide
 */
const extractAmount = (amountStr) => {
  if (!amountStr) return null;

  // Nettoyer la chaîne
  const cleaned = amountStr.replace(/\s/g, "").replace(/,/g, ".");

  // Extraire le nombre
  const match = cleaned.match(/([0-9]+\.?[0-9]*)/);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }

  return null;
};

/**
 * Extrait la devise à partir du texte
 * @param {string} text - Texte contenant potentiellement une devise
 * @returns {string} - Code de devise (EUR par défaut)
 */
const extractCurrency = (text) => {
  if (text.includes("€") || text.match(/\bEUR\b/i)) {
    return "EUR";
  } else if (text.includes("$") || text.match(/\bUSD\b/i)) {
    return "USD";
  } else if (text.includes("£") || text.match(/\bGBP\b/i)) {
    return "GBP";
  } else if (text.match(/\bCAD\b/i)) {
    return "CAD";
  } else if (text.match(/\bCHF\b/i)) {
    return "CHF";
  }

  // Par défaut, on suppose que c'est en euros
  return "EUR";
};

/**
 * Extrait le nom du fournisseur à partir du texte
 * @param {string} text - Texte OCR complet
 * @returns {string|null} - Nom du fournisseur ou null si non trouvé
 */
const extractVendorName = (text) => {
  // Cette fonction est simplifiée et pourrait être améliorée avec des algorithmes plus avancés
  // Généralement, le nom du fournisseur est souvent en haut de la facture

  // Diviser le texte en lignes
  const lines = text.split("\n");

  // Prendre les premières lignes non vides qui ne contiennent pas de mots clés comme "facture"
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i].trim();
    if (
      line &&
      line.length > 3 &&
      !line.match(/facture|invoice|reçu|receipt|ticket|bill/i)
    ) {
      return line;
    }
  }

  return null;
};

/**
 * Extrait l'adresse du fournisseur à partir du texte
 * @param {string} text - Texte OCR complet
 * @returns {string|null} - Adresse du fournisseur ou null si non trouvée
 */
const extractVendorAddress = (text) => {
  // Cette fonction est simplifiée et pourrait être améliorée

  // Recherche des motifs d'adresse (code postal, ville)
  const addressRegex = /\b\d{5}\s+[A-Za-z\s-]+\b/;
  const match = text.match(addressRegex);

  if (match) {
    // Trouver la ligne contenant l'adresse et les lignes précédentes
    const lines = text.split("\n");
    const addressLineIndex = lines.findIndex((line) => line.includes(match[0]));

    if (addressLineIndex > 0) {
      // Prendre la ligne de l'adresse et jusqu'à 2 lignes précédentes
      const startIndex = Math.max(0, addressLineIndex - 2);
      return lines
        .slice(startIndex, addressLineIndex + 1)
        .join(", ")
        .trim();
    }

    return match[0];
  }

  return null;
};

/**
 * Normalise une date extraite en format ISO
 * @param {string} dateStr - Chaîne de date à normaliser
 * @returns {string|null} - Date au format ISO ou null si non valide
 */
const normalizeDate = (dateStr) => {
  if (!dateStr) return null;

  // Remplacer les séparateurs par des tirets
  const normalized = dateStr.replace(/[./]/g, "-");

  // Différents formats possibles
  const formats = [
    // JJ-MM-AAAA
    {
      regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
      formatter: (d, m, y) =>
        `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    },
    // AAAA-MM-JJ
    {
      regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
      formatter: (y, m, d) =>
        `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`,
    },
    // JJ-MM-AA
    {
      regex: /^(\d{1,2})-(\d{1,2})-(\d{2})$/,
      formatter: (d, m, y) => {
        // Déterminer le siècle (20 ou 21)
        const fullYear = parseInt(y) > 50 ? `19${y}` : `20${y}`;
        return `${fullYear}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      },
    },
  ];

  // Tester chaque format
  for (const format of formats) {
    const match = normalized.match(format.regex);
    if (match) {
      try {
        const formattedDate = format.formatter(...match.slice(1));
        // Vérifier si la date est valide
        const date = new Date(formattedDate);
        if (!isNaN(date.getTime())) {
          return formattedDate;
        }
      } catch (e) {
        continue;
      }
    }
  }

  return null;
};

/**
 * Traite un fichier avec OCR pour extraire les informations de facture
 * @param {string} filePath - Chemin vers le fichier à traiter
 * @returns {Promise<Object>} - Données extraites
 */
const processFileWithOCR = async (filePath) => {
  // Vérifier si le fichier existe
  if (!fs.existsSync(filePath)) {
    throw new Error(`Le fichier ${filePath} n'existe pas`);
  }

  try {
    // Créer un worker Tesseract
    const worker = await createWorker("fra+eng");

    // Reconnaissance du texte
    const { data } = await worker.recognize(filePath);

    // Terminer le worker
    await worker.terminate();

    // Texte extrait
    const text = data.text;

    // Extraire les informations avec les regex
    const vatNumberMatch = text.match(REGEX.VAT_NUMBER);
    const invoiceNumberMatch = text.match(REGEX.INVOICE_NUMBER);
    const invoiceDateMatch = text.match(REGEX.INVOICE_DATE);
    const totalAmountMatch = text.match(REGEX.TOTAL_AMOUNT);
    const vatAmountMatch = text.match(REGEX.VAT_AMOUNT);

    // Extraire le nom du fournisseur et l'adresse
    const vendorName = extractVendorName(text);
    const vendorAddress = extractVendorAddress(text);

    // Extraire la devise
    const currency = extractCurrency(text);

    // Calculer un score de confiance simple
    let confidenceScore = 0;
    let extractedFields = 0;

    if (vendorName) {
      confidenceScore += data.confidence / 100;
      extractedFields++;
    }
    if (vatNumberMatch) {
      confidenceScore += data.confidence / 100;
      extractedFields++;
    }
    if (invoiceNumberMatch) {
      confidenceScore += data.confidence / 100;
      extractedFields++;
    }
    if (invoiceDateMatch) {
      confidenceScore += data.confidence / 100;
      extractedFields++;
    }
    if (totalAmountMatch) {
      confidenceScore += data.confidence / 100;
      extractedFields++;
    }

    // Normaliser le score de confiance
    confidenceScore =
      extractedFields > 0 ? confidenceScore / extractedFields : 0;

    // Retourner les données extraites
    return {
      vendorName: vendorName,
      vendorAddress: vendorAddress,
      vendorVatNumber: vatNumberMatch ? vatNumberMatch[1] : null,
      invoiceNumber: invoiceNumberMatch ? invoiceNumberMatch[1] : null,
      invoiceDate: invoiceDateMatch ? normalizeDate(invoiceDateMatch[1]) : null,
      totalAmount: totalAmountMatch ? extractAmount(totalAmountMatch[1]) : null,
      vatAmount: vatAmountMatch ? extractAmount(vatAmountMatch[1]) : null,
      currency: currency,
      confidenceScore: confidenceScore,
      rawExtractedText: cleanText(text),
    };
  } catch (error) {
    console.error("Erreur lors du traitement OCR:", error);
    throw new Error(`Erreur lors du traitement OCR: ${error.message}`);
  }
};

export { processFileWithOCR };
