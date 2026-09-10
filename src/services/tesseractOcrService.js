import logger from "../utils/logger.js";
/**
 * Tesseract.js OCR Service : dernier maillon de la chaîne OCR, 100 % gratuit
 * et local (pas d'API externe, pas de quota). Utilisé quand Claude Vision,
 * Google Document AI et Mistral OCR sont indisponibles (clés absentes, quotas
 * dépassés, panne).
 *
 * - Images (PNG, JPEG, WebP...) : prétraitement sharp (niveaux de gris,
 *   agrandissement, normalisation du contraste) puis reconnaissance
 *   Tesseract en français + anglais.
 * - PDF : extraction directe de la couche texte via pdfjs (gratuit, exact).
 *   Un PDF scanné (sans couche texte) n'est pas rasterisé : le service
 *   renvoie une erreur explicite et la chaîne s'arrête proprement.
 *
 * Le worker Tesseract est créé à la demande et réutilisé. Les fichiers de
 * langue (~15 Mo) sont téléchargés une fois puis mis en cache dans
 * .cache/tesseract (TESSERACT_CACHE_PATH pour changer l'emplacement).
 *
 * Variables : OCR_DISABLE_TESSERACT="true" pour retirer ce maillon.
 */
import path from "path";
import fs from "fs";
import { createRequire } from "module";
import Tesseract from "tesseract.js";
import sharp from "sharp";
import { assertSafeDownloadUrl } from "../utils/ssrfGuard.js";

const LANGUAGES = "fra+eng";
// Polices standard de pdfjs (évite un avertissement et des glyphes manquants)
const PDFJS_DIR = path.dirname(
  createRequire(import.meta.url).resolve("pdfjs-dist/package.json"),
);
const STANDARD_FONTS_URL = `${path.join(PDFJS_DIR, "standard_fonts")}/`;
const MIN_WIDTH = 2000; // largeur mini pour une reconnaissance correcte
const RECOGNIZE_TIMEOUT_MS = 90 * 1000;
const MIN_PDF_TEXT_CHARS = 40; // en dessous : PDF scanné, pas de couche texte
const MAX_PDF_PAGES = 10;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} : délai dépassé (${ms} ms)`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class TesseractOcrService {
  constructor() {
    this.worker = null;
    this.workerPromise = null;
    this.cachePath =
      process.env.TESSERACT_CACHE_PATH ||
      path.join(process.cwd(), ".cache", "tesseract");
  }

  isAvailable() {
    return process.env.OCR_DISABLE_TESSERACT !== "true";
  }

  async getWorker() {
    if (this.worker) return this.worker;
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        fs.mkdirSync(this.cachePath, { recursive: true });
        const worker = await Tesseract.createWorker(LANGUAGES, 1, {
          cachePath: this.cachePath,
        });
        logger.debug(
          `✅ Tesseract worker initialisé (${LANGUAGES}, cache ${this.cachePath})`,
        );
        this.worker = worker;
        return worker;
      })().catch((error) => {
        this.workerPromise = null;
        throw error;
      });
    }
    return this.workerPromise;
  }

  async downloadBuffer(documentUrl) {
    assertSafeDownloadUrl(documentUrl);
    const response = await fetch(documentUrl);
    if (!response.ok) {
      throw new Error(`Téléchargement échoué (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** Niveaux de gris + agrandissement + contraste : Tesseract lit bien mieux. */
  async preprocessImage(buffer) {
    const image = sharp(buffer, { failOn: "none" }).rotate();
    const meta = await image.metadata();
    const width = meta.width || 0;
    let pipeline = image.grayscale().normalize();
    if (width > 0 && width < MIN_WIDTH) {
      pipeline = pipeline.resize({
        width: MIN_WIDTH,
        withoutEnlargement: false,
      });
    }
    return pipeline.png().toBuffer();
  }

  async recognizeImage(buffer) {
    const worker = await this.getWorker();
    const prepared = await this.preprocessImage(buffer);
    const result = await withTimeout(
      worker.recognize(prepared),
      RECOGNIZE_TIMEOUT_MS,
      "Tesseract",
    );
    return {
      extractedText: (result.data.text || "").trim(),
      confidence: result.data.confidence,
      method: "tesseract",
    };
  }

  /** Couche texte d'un PDF (factures générées par logiciel) : gratuit et exact. */
  async extractPdfText(buffer) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: STANDARD_FONTS_URL,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const doc = await loadingTask.promise;
    const pages = [];
    const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let lastY = null;
      let line = [];
      const lines = [];
      for (const item of content.items) {
        if (!item.str) continue;
        const y = Math.round(item.transform?.[5] ?? 0);
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          lines.push(line.join(" "));
          line = [];
        }
        line.push(item.str);
        lastY = y;
      }
      if (line.length) lines.push(line.join(" "));
      pages.push(lines.join("\n"));
    }
    await loadingTask.destroy();
    return {
      extractedText: pages.join("\n\n").trim(),
      pagesProcessed: pageCount,
    };
  }

  /**
   * Interface commune aux providers OCR.
   * @returns {{ success: boolean, extractedText: string, text: string, confidence?: number, metadata: Object }}
   */
  async processDocumentFromUrl(documentUrl, fileName, mimeType) {
    const buffer = await this.downloadBuffer(documentUrl);
    return this.processBuffer(buffer, fileName, mimeType);
  }

  async processBuffer(buffer, fileName, mimeType = "") {
    const isPdf =
      mimeType === "application/pdf" || /\.pdf$/i.test(fileName || "");
    let extracted;
    if (isPdf) {
      extracted = await this.extractPdfText(buffer);
      if (extracted.extractedText.length < MIN_PDF_TEXT_CHARS) {
        throw new Error(
          "PDF sans couche texte (scan) : rasterisation non disponible en OCR gratuit",
        );
      }
      extracted.method = "pdf-text";
    } else {
      extracted = await this.recognizeImage(buffer);
    }

    if (!extracted.extractedText) {
      throw new Error("Aucun texte reconnu");
    }

    return {
      success: true,
      extractedText: extracted.extractedText,
      text: extracted.extractedText,
      confidence: extracted.confidence,
      metadata: {
        provider: "tesseract",
        method: extracted.method,
        fileName,
        mimeType,
        pagesProcessed: extracted.pagesProcessed || 1,
        language: LANGUAGES,
        processedAt: new Date().toISOString(),
      },
    };
  }

  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this.workerPromise = null;
    }
  }
}

export default new TesseractOcrService();
