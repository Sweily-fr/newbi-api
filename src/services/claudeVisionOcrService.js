/**
 * Service OCR utilisant Claude Vision API (Anthropic)
 * Provider par défaut pour l'extraction de données de factures
 *
 * OPTIMISATIONS v2:
 * - Pré-téléchargement en masse (batch download)
 * - Modèle adaptatif (Haiku pour factures simples, Sonnet pour complexes)
 * - Traitement parallèle optimisé (40 requêtes simultanées)
 * - Support cache Redis (intégration externe)
 */

import Anthropic from "@anthropic-ai/sdk";
import fetch from "node-fetch";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

// Prompt système pour l'extraction de factures/reçus/tickets
const INVOICE_EXTRACTION_PROMPT = `Tu es un expert en extraction de données de documents financiers français (factures, reçus, tickets de caisse, notes de frais).

IMPORTANT - INSTRUCTIONS CRITIQUES:
- Retourne UNIQUEMENT un JSON valide, sans texte avant ou après.
- Extrais TOUTES les informations visibles sur le document, même partielles.
- Ne laisse AUCUN champ vide si l'information est présente sur le document.
- Pour les reçus/tickets de caisse, le nom du magasin/commerce EST le vendor.name.
- OBLIGATION: Tu DOIS extraire au minimum le montant total (total_ttc), la date, et le nom du fournisseur.
- Lis CHAQUE LIGNE du document attentivement, y compris le haut, le bas, et les petits caractères.
- Si tu vois un montant avec "TOTAL", "A PAYER", "NET A PAYER", "MONTANT" → c'est le total_ttc.
- Si tu vois "TVA", "T.V.A", un pourcentage → extrais le montant et le taux de TVA.
- Si tu vois une date sous quelque forme que ce soit (JJ/MM/AAAA, JJ.MM.AAAA, JJ-MM-AAAA, etc.) → extrais-la.
- Pour les tickets de caisse: le nom en GROS en haut = vendor.name, le total en bas = total_ttc.
- NE RETOURNE JAMAIS un JSON avec seulement le nom du fournisseur. Il y a TOUJOURS un montant et une date sur un document financier.

Structure JSON attendue:
{
  "document_type": "FACTURE" | "AVOIR" | "DEVIS" | "BON_COMMANDE" | "AUTRE",
  "invoice_number": "numéro de facture",
  "invoice_date": "YYYY-MM-DD",
  "due_date": "YYYY-MM-DD ou null",
  "payment_date": "YYYY-MM-DD ou null",

  "vendor": {
    "name": "nom de l'entreprise émettrice",
    "address": "adresse complète",
    "city": "ville",
    "postal_code": "code postal",
    "country": "pays",
    "siret": "numéro SIRET (14 chiffres)",
    "siren": "numéro SIREN (9 chiffres)",
    "vat_number": "numéro TVA intracommunautaire",
    "email": "email",
    "phone": "téléphone",
    "website": "site web",
    "rcs": "numéro RCS",
    "ape_code": "code APE/NAF",
    "capital": "capital social"
  },

  "client": {
    "name": "nom du client (entreprise qui REÇOIT et PAIE la facture)",
    "address": "adresse du client",
    "city": "ville du client",
    "postal_code": "code postal du client",
    "country": "pays du client",
    "siret": "numéro SIRET du client (14 chiffres) - IMPORTANT: différent du SIRET de l'émetteur",
    "vat_number": "numéro TVA intracommunautaire du client",
    "email": "email du client",
    "phone": "téléphone du client",
    "client_number": "numéro client si présent"
  },

  "items": [
    {
      "description": "description du produit/service",
      "quantity": 1,
      "unit": "unité (ex: h, jour, pièce)",
      "unit_price_ht": 100.00,
      "vat_rate": 20,
      "total_ht": 100.00,
      "total_ttc": 120.00,
      "product_code": "code article si présent"
    }
  ],

  "totals": {
    "total_ht": 100.00,
    "total_vat": 20.00,
    "total_ttc": 120.00,
    "discount": 0,
    "shipping": 0
  },

  "tax_details": [
    {
      "rate": 20,
      "base": 100.00,
      "amount": 20.00
    }
  ],

  "payment_details": {
    "method": "CARD" | "CASH" | "CHECK" | "TRANSFER" | "DIRECT_DEBIT" | "UNKNOWN",
    "iban": "IBAN si présent",
    "bic": "BIC si présent",
    "bank_name": "nom de la banque"
  },

  "category": "RENT" | "SUBSCRIPTIONS" | "OFFICE_SUPPLIES" | "SERVICES" | "TRANSPORT" | "MEALS" | "TELECOMMUNICATIONS" | "INSURANCE" | "ENERGY" | "SOFTWARE" | "HARDWARE" | "MARKETING" | "TRAINING" | "MAINTENANCE" | "TAXES" | "UTILITIES" | "OTHER",

  "currency": "EUR",
  "notes": "mentions légales ou notes importantes",
  "confidence": 0.95
}

Règles:
1. Extrais TOUS les champs disponibles sur la facture
2. Les montants doivent être des nombres (pas de symbole €)
3. DATES - FORMAT FRANÇAIS OBLIGATOIRE:
   - Les dates sur les factures françaises sont TOUJOURS au format JJ/MM/AAAA (jour/mois/année)
   - JAMAIS le format américain MM/DD/YYYY
   - "02/11/2025" = 2 NOVEMBRE 2025, convertir en "2025-11-02" (PAS "2025-02-11")
   - "15/03/2025" = 15 MARS 2025, convertir en "2025-03-15"
   - Toujours interpréter le PREMIER nombre comme le JOUR et le DEUXIÈME comme le MOIS
4. Si un champ n'est pas présent, utilise null
5. Détermine la catégorie selon le contenu (fournitures bureau, déplacement, repas, etc.)
6. Indique ta confiance (0-1) basée sur la qualité de l'extraction
7. DISTINCTION ÉMETTEUR vs CLIENT:
   - Le "vendor" est l'entreprise qui ÉMET/ENVOIE la facture (logo, en-tête, SIRET en pied de page)
   - Le "client" est l'entreprise qui REÇOIT et PAIE la facture
   - NE PAS confondre les deux - extraire le SIRET de chaque entité séparément`;

// Configuration des modèles
const MODELS = {
  SONNET: process.env.CLAUDE_VISION_MODEL || "claude-sonnet-4-20250514",
  HAIKU: process.env.CLAUDE_HAIKU_MODEL || "claude-haiku-4-5-20251001",
};

// Seuils de complexité
const COMPLEXITY_THRESHOLD_KB = 100; // Factures < 100KB = simples

class ClaudeVisionOcrService {
  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    this.defaultModel = MODELS.SONNET;
    this.maxRetries = 2;
    this.client = null;
    this.parallelBatchSize = 40; // Nombre de requêtes parallèles

    if (!this.apiKey) {
      console.warn(
        "⚠️ ANTHROPIC_API_KEY non définie dans les variables d'environnement",
      );
    } else {
      this.client = new Anthropic({
        apiKey: this.apiKey,
      });
    }
  }

  /**
   * Vérifie si le service est disponible
   */
  isAvailable() {
    return !!this.apiKey && !!this.client;
  }

  /**
   * Génère un hash SHA256 pour le cache
   */
  generateHash(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /**
   * Détecte le type MIME depuis l'URL
   */
  detectMimeType(url) {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith(".pdf")) return "application/pdf";
    if (lowerUrl.endsWith(".png")) return "image/png";
    if (lowerUrl.endsWith(".jpg") || lowerUrl.endsWith(".jpeg"))
      return "image/jpeg";
    if (lowerUrl.endsWith(".webp")) return "image/webp";
    return "application/pdf"; // Default
  }

  /**
   * Détecte la complexité d'une facture basée sur la taille
   * @returns 'simple' | 'complex'
   */
  detectInvoiceComplexity(base64Data) {
    const sizeKB = (base64Data.length * 0.75) / 1024;
    return sizeKB < COMPLEXITY_THRESHOLD_KB ? "simple" : "complex";
  }

  /**
   * Télécharge un document depuis une URL et le convertit en base64
   */
  async downloadAndConvertToBase64(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Échec du téléchargement: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");
    const hash = this.generateHash(buffer);
    const contentType =
      response.headers.get("content-type") || this.detectMimeType(url);

    return { base64, mediaType: contentType, hash, sizeBytes: buffer.length };
  }

  /**
   * NOUVELLE MÉTHODE: Pré-téléchargement en masse
   * Télécharge tous les documents en parallèle avant le traitement OCR
   * @param {Array<{url: string, fileName: string}>} documents - Liste des documents
   * @returns {Promise<Array>} - Documents téléchargés avec base64
   */
  async batchDownload(documents) {
    console.log(
      `📥 Téléchargement en masse de ${documents.length} documents...`,
    );
    const startTime = Date.now();

    const downloadPromises = documents.map(async (doc, index) => {
      try {
        const { base64, mediaType, hash, sizeBytes } =
          await this.downloadAndConvertToBase64(doc.url);
        return {
          index,
          url: doc.url,
          fileName: doc.fileName,
          base64,
          mediaType,
          hash,
          sizeBytes,
          success: true,
        };
      } catch (error) {
        console.warn(
          `⚠️ Échec téléchargement ${doc.fileName}: ${error.message}`,
        );
        return {
          index,
          url: doc.url,
          fileName: doc.fileName,
          error: error.message,
          success: false,
        };
      }
    });

    const results = await Promise.all(downloadPromises);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = results.filter((r) => r.success).length;

    console.log(
      `✅ Téléchargement terminé: ${successCount}/${documents.length} en ${elapsed}s`,
    );

    return results;
  }

  /**
   * NOUVELLE MÉTHODE: Traitement batch complet optimisé
   * @param {Array<{url: string, fileName: string, mimeType?: string}>} documents
   * @param {Object} cacheService - Service de cache optionnel
   * @returns {Promise<Array>} - Résultats d'extraction
   */
  async batchProcessDocuments(documents, cacheService = null) {
    if (!this.isAvailable()) {
      throw new Error(
        "Claude Vision OCR non configuré (ANTHROPIC_API_KEY manquante)",
      );
    }

    const startTime = Date.now();
    console.log(`🚀 Traitement batch de ${documents.length} factures...`);

    // Phase 1: Téléchargement en masse
    const downloads = await this.batchDownload(documents);
    const successfulDownloads = downloads.filter((d) => d.success);
    const failedDownloads = downloads.filter((d) => !d.success);

    console.log(
      `📊 Téléchargements: ${successfulDownloads.length} réussis, ${failedDownloads.length} échoués`,
    );

    // Phase 2: Vérification cache (si disponible)
    const toProcess = [];
    const cachedResults = [];

    for (const doc of successfulDownloads) {
      if (cacheService) {
        try {
          const cached = await cacheService.get(doc.hash);
          if (cached && cached.extractedData) {
            console.log(`💾 Cache HIT: ${doc.fileName}`);
            cachedResults.push({
              index: doc.index,
              url: doc.url,
              fileName: doc.fileName,
              result: cached.extractedData,
              fromCache: true,
              success: true,
            });
            continue;
          }
        } catch (e) {
          // Cache miss ou erreur, on continue
        }
      }
      toProcess.push(doc);
    }

    console.log(
      `📊 À traiter: ${toProcess.length} (${cachedResults.length} depuis cache)`,
    );

    // Phase 3: Traitement OCR par batch de 40
    const ocrResults = [];
    const batchSize = this.parallelBatchSize;

    for (let i = 0; i < toProcess.length; i += batchSize) {
      const batch = toProcess.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(toProcess.length / batchSize);

      console.log(
        `🔄 Batch ${batchNumber}/${totalBatches}: ${batch.length} factures...`,
      );

      const batchResults = await Promise.all(
        batch.map(async (doc) => {
          try {
            const result = await this.processFromBase64(
              doc.base64,
              doc.mediaType,
              doc.url,
              doc.hash,
              { useBatchModel: true },
            );

            // Sauvegarder en cache si disponible
            if (cacheService && doc.hash) {
              try {
                await cacheService.set(doc.hash, {
                  base64: doc.base64,
                  extractedData: result,
                  timestamp: Date.now(),
                });
              } catch (e) {
                // Erreur cache non bloquante
              }
            }

            return {
              index: doc.index,
              url: doc.url,
              fileName: doc.fileName,
              result,
              fromCache: false,
              success: true,
            };
          } catch (error) {
            console.warn(`⚠️ Erreur OCR ${doc.fileName}: ${error.message}`);
            return {
              index: doc.index,
              url: doc.url,
              fileName: doc.fileName,
              error: error.message,
              success: false,
            };
          }
        }),
      );

      ocrResults.push(...batchResults);

      // Rate limiting léger entre les batches
      if (i + batchSize < toProcess.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // Combiner tous les résultats
    const allResults = [
      ...cachedResults,
      ...ocrResults,
      ...failedDownloads.map((d) => ({
        index: d.index,
        url: d.url,
        fileName: d.fileName,
        error: `Téléchargement échoué: ${d.error}`,
        success: false,
      })),
    ].sort((a, b) => a.index - b.index);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = allResults.filter((r) => r.success).length;

    console.log(
      `✅ Batch terminé: ${successCount}/${documents.length} en ${elapsed}s`,
    );
    console.log(`   - Depuis cache: ${cachedResults.length}`);
    console.log(
      `   - OCR traités: ${ocrResults.filter((r) => r.success).length}`,
    );
    console.log(`   - Échecs: ${allResults.filter((r) => !r.success).length}`);

    return allResults;
  }

  /**
   * NOUVELLE MÉTHODE: Traitement depuis base64 déjà téléchargé
   * Avec modèle adaptatif (Haiku/Sonnet)
   */
  async processFromBase64(
    base64Data,
    mimeType,
    originalUrl,
    hash = null,
    { useBatchModel = false } = {},
  ) {
    if (!this.isAvailable()) {
      throw new Error(
        "Claude Vision OCR non configuré (ANTHROPIC_API_KEY manquante)",
      );
    }

    // Détecter la complexité
    const complexity = this.detectInvoiceComplexity(base64Data);
    // En mode batch, on utilise Haiku pour les documents simples ; sinon toujours Sonnet pour la qualité
    const model =
      useBatchModel && complexity === "simple" ? MODELS.HAIKU : MODELS.SONNET;
    const maxTokens = 4096;

    console.log(
      `   📄 ${model.includes("haiku") ? "🐇" : "🎵"} ${originalUrl.split("/").pop()?.substring(0, 30)}... (${model.includes("haiku") ? "Haiku" : "Sonnet"})`,
    );

    // Construire le message
    const claudeMediaType =
      mimeType === "application/pdf" ? "application/pdf" : mimeType;
    const messageContent = [
      {
        type: claudeMediaType === "application/pdf" ? "document" : "image",
        source: {
          type: "base64",
          media_type: claudeMediaType,
          data: base64Data,
        },
      },
      {
        type: "text",
        text: `Analyse ce document financier avec une EXTRÊME ATTENTION. Lis chaque ligne, chaque zone, chaque coin du document.

ÉTAPES OBLIGATOIRES:
1. IDENTIFIE le type de document (facture, reçu, ticket de caisse, note de frais)
2. LIS le haut du document → le nom/logo = vendor.name
3. LIS la date → convertis en YYYY-MM-DD (attention: format français JJ/MM/AAAA)
4. LIS chaque ligne d'article avec description, quantité, prix unitaire, total
5. LIS le bas du document → "TOTAL", "A PAYER", "NET A PAYER" = total_ttc
6. CHERCHE les montants HT, TVA, TTC séparément
7. CHERCHE le moyen de paiement (CB, carte, espèces, virement, chèque)
8. CHERCHE un numéro de facture/ticket

EXTRAIS OBLIGATOIREMENT:
- vendor.name: le nom du commerce/entreprise (TOUJOURS présent sur un document)
- totals.total_ttc: le montant total TTC (TOUJOURS présent - cherche "TOTAL", "A PAYER", le dernier montant)
- totals.total_ht: le montant hors taxes si indiqué
- totals.total_vat: le montant de TVA si indiqué
- invoice_date: la date au format YYYY-MM-DD (TOUJOURS présente)
- items: TOUTES les lignes d'articles/services avec descriptions et prix
- payment_details.method: CB/CARD/CASH/TRANSFER/CHECK
- category: la catégorie parmi RENT, SUBSCRIPTIONS, OFFICE_SUPPLIES, SERVICES, TRANSPORT, MEALS, TELECOMMUNICATIONS, INSURANCE, ENERGY, SOFTWARE, HARDWARE, MARKETING, TRAINING, MAINTENANCE, TAXES, UTILITIES, OTHER

Si c'est un ticket de caisse: le nom en GROS en haut = vendor.name, le montant "TOTAL" en bas = total_ttc.
Ne retourne QUE le JSON, rien d'autre.`,
      },
    ];

    // Appel API avec retry
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          system: INVOICE_EXTRACTION_PROMPT,
          messages: [{ role: "user", content: messageContent }],
        });

        const textContent = response.content.find(
          (block) => block.type === "text",
        );
        if (!textContent) {
          throw new Error("Pas de contenu texte dans la réponse Claude");
        }

        const extractedData = this.parseJsonResponse(textContent.text);

        // Validation: vérifier que les champs critiques sont extraits
        const hasAmount =
          extractedData.totals?.total_ttc || extractedData.totals?.total_ht;
        const hasDate = extractedData.invoice_date;
        const hasVendor = extractedData.vendor?.name;

        if (!hasAmount || !hasDate) {
          console.warn(
            `⚠️ OCR extraction incomplète: amount=${!!hasAmount}, date=${!!hasDate}, vendor=${!!hasVendor}`,
          );
          // Si on a seulement le vendor et rien d'autre, retenter avec un prompt plus insistant
          if (
            hasVendor &&
            !hasAmount &&
            !hasDate &&
            attempt < this.maxRetries
          ) {
            console.log(
              `🔄 Relance OCR car données insuffisantes (seulement vendor: ${extractedData.vendor?.name})`,
            );
            lastError = new Error("Extraction incomplète - retry");
            const delay = 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        return {
          success: true,
          provider: "claude-vision",
          model,
          complexity,
          extractedText: textContent.text,
          data: extractedData,
          usage: {
            inputTokens: response.usage?.input_tokens || 0,
            outputTokens: response.usage?.output_tokens || 0,
          },
        };
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  /**
   * Traite un document (méthode legacy compatible)
   */
  async processDocument(documentUrl, mimeType) {
    if (!this.isAvailable()) {
      throw new Error(
        "Claude Vision OCR non configuré (ANTHROPIC_API_KEY manquante)",
      );
    }

    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(
          `📄 Claude Vision: Tentative ${attempt + 1}/${this.maxRetries + 1}...`,
        );

        const { base64, mediaType, hash } =
          await this.downloadAndConvertToBase64(documentUrl);
        const result = await this.processFromBase64(
          base64,
          mediaType,
          documentUrl,
          hash,
        );

        console.log(
          `✅ Claude Vision: Extraction réussie (confiance: ${result.data?.confidence || "N/A"})`,
        );

        return result;
      } catch (error) {
        lastError = error;
        console.warn(
          `⚠️ Claude Vision tentative ${attempt + 1} échouée: ${error.message}`,
        );

        if (attempt === this.maxRetries) break;

        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    console.error(
      `❌ Claude Vision: Échec après ${this.maxRetries + 1} tentatives`,
    );
    throw lastError;
  }

  /**
   * Parse la réponse JSON de Claude
   */
  parseJsonResponse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e2) {
          console.warn("⚠️ Impossible de parser le JSON, retour du texte brut");
        }
      }
      return {
        raw_text: text,
        confidence: 0.3,
        parse_error: true,
      };
    }
  }

  /**
   * Convertit les données extraites au format attendu par le système
   */
  toInvoiceFormat(result) {
    const data = result.data || {};

    return {
      success: true,
      provider: "claude-vision",
      model: result.model,
      complexity: result.complexity,
      extractedText: result.extractedText || "",
      text: result.extractedText || "",

      transaction_data: {
        document_number: data.invoice_number,
        transaction_date: data.invoice_date,
        due_date: data.due_date,
        payment_date: data.payment_date,
        vendor_name: data.vendor?.name,
        client_name: data.client?.name,
        client_number: data.client?.client_number,
        amount: data.totals?.total_ttc || data.totals?.total_ht || 0,
        amount_ht: data.totals?.total_ht,
        tax_amount: data.totals?.total_vat || 0,
        tax_rate:
          data.tax_details?.[0]?.rate ||
          (data.totals?.total_vat && data.totals?.total_ht
            ? Math.round((data.totals.total_vat / data.totals.total_ht) * 100)
            : null),
        currency: data.currency || "EUR",
        category: data.category || "OTHER",
        payment_method: data.payment_details?.method?.toLowerCase() || "card",
        description:
          data.items?.[0]?.description ||
          data.notes ||
          (data.vendor?.name
            ? `Achat chez ${data.vendor.name}`
            : "Document importé via OCR"),
      },

      extracted_fields: {
        vendor_address: data.vendor?.address,
        vendor_city: data.vendor?.city,
        vendor_postal_code: data.vendor?.postal_code,
        vendor_country: data.vendor?.country || "France",
        vendor_siret: data.vendor?.siret,
        vendor_vat_number: data.vendor?.vat_number,
        vendor_email: data.vendor?.email,
        vendor_phone: data.vendor?.phone,
        vendor_website: data.vendor?.website,
        vendor_rcs: data.vendor?.rcs,
        vendor_ape: data.vendor?.ape_code,
        vendor_capital: data.vendor?.capital,

        client_name: data.client?.name,
        client_address: data.client?.address,
        client_city: data.client?.city,
        client_postal_code: data.client?.postal_code,
        client_country: data.client?.country,
        client_siret: data.client?.siret,
        client_vat_number: data.client?.vat_number,
        client_email: data.client?.email,
        client_phone: data.client?.phone,
        client_number: data.client?.client_number,

        items: (data.items || []).map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_price_ht: item.unit_price_ht,
          unit_price_ttc: item.unit_price_ht
            ? item.unit_price_ht * (1 + (item.vat_rate ?? 20) / 100)
            : null,
          vat_rate: item.vat_rate,
          total_ht: item.total_ht,
          total_ttc: item.total_ttc,
          code: item.product_code,
        })),

        totals: {
          total_ht: data.totals?.total_ht,
          total_tax: data.totals?.total_vat,
          total_ttc: data.totals?.total_ttc,
        },

        tax_details: data.tax_details || [],

        payment_details: {
          iban: data.payment_details?.iban,
          bic: data.payment_details?.bic,
          bank_name: data.payment_details?.bank_name,
        },
      },

      document_analysis: {
        document_type: data.document_type || "FACTURE",
        confidence: data.confidence || 0.8,
      },

      usage: result.usage,
    };
  }
}

// Instance singleton
const claudeVisionOcrService = new ClaudeVisionOcrService();

export default claudeVisionOcrService;
