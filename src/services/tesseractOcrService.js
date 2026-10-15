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
 * - PDF : couche texte lue directement via pdfjs (gratuit, exact). Une page
 *   scannée (sans couche texte) est rendue en image à 300 dpi par pdfjs
 *   (@napi-rs/canvas) puis lue par Tesseract comme une image.
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
import { Worker } from "worker_threads";
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
const MIN_PAGE_TEXT_CHARS = 40; // en dessous : page scannée, lue par OCR
const MAX_PDF_PAGES = 10;
// Pages scannées lues par OCR (5 à 15 s chacune) : une facture tient sur 1 à
// 3 pages, la limite évite d'immobiliser le worker sur un gros scan.
const MAX_SCANNED_PAGES = 3;
const SCAN_SCALE = 300 / 72; // 300 dpi, la résolution attendue par Tesseract
const MAX_RENDER_SIDE = 7000; // garde-fou mémoire pour les pages hors format
const RENDER_TIMEOUT_MS = 60 * 1000;
const RENDER_WORKER_URL = new URL("./pdfPageRenderWorker.js", import.meta.url);

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

/**
 * Rendu des pages d'un PDF dans un worker thread (voir pdfPageRenderWorker) :
 * render(n) renvoie { width, height, rgba }, une page à la fois.
 */
function openPageRenderer(data) {
  const worker = new Worker(RENDER_WORKER_URL, {
    workerData: { data, standardFontDataUrl: STANDARD_FONTS_URL },
  });
  let failure = null;
  let pending = null;
  const fail = (error) => {
    failure = error;
    pending?.reject(error);
    pending = null;
  };
  worker.on("error", fail);
  worker.on("exit", (code) =>
    fail(new Error(`Rendu PDF interrompu (code ${code})`)),
  );
  worker.on("message", (message) => {
    const request = pending;
    pending = null;
    if (!request) return;
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message);
  });
  return {
    render(pageNumber) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.postMessage({
          pageNumber,
          scale: SCAN_SCALE,
          maxSide: MAX_RENDER_SIDE,
        });
      });
    },
    close: () => worker.terminate(),
  };
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

  /**
   * Niveaux de gris + agrandissement : Tesseract lit bien mieux. Pas de
   * normalize() : sur un scan ou une photo de page peu remplie, l'étirement
   * du contraste transforme le grain du papier en taches (lecture illisible,
   * confiance ~20 %), alors que le seuillage de Tesseract gère seul un fond
   * clair, délavé ou sombre.
   */
  async preprocessImage(buffer) {
    const image = sharp(buffer, { failOn: "none" }).rotate();
    const meta = await image.metadata();
    const width = meta.width || 0;
    let pipeline = image.grayscale();
    if (width > 0 && width < MIN_WIDTH) {
      pipeline = pipeline.resize({
        width: MIN_WIDTH,
        withoutEnlargement: false,
      });
    }
    return pipeline.png().toBuffer();
  }

  async recognizeImage(buffer) {
    return this.recognize(await this.preprocessImage(buffer));
  }

  async recognize(prepared) {
    const worker = await this.getWorker();
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

  /** Couche texte d'une page (factures générées par logiciel) : gratuit et exact. */
  async readPageText(page) {
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
    return lines.join("\n").trim();
  }

  /** Page rendue par le worker (RGBA) : niveaux de gris puis reconnaissance. */
  async recognizeRenderedPage({ width, height, rgba }) {
    // Pas de normalize(), comme pour les images (voir preprocessImage)
    const prepared = await sharp(Buffer.from(rgba), {
      raw: { width, height, channels: 4 },
    })
      .removeAlpha()
      .grayscale()
      .withMetadata({ density: 300 })
      .png()
      .toBuffer();
    return this.recognize(prepared);
  }

  /**
   * Texte d'un PDF page par page : la couche texte quand elle existe, sinon
   * la page est rendue à 300 dpi et lue par OCR (PDF scanné ou mixte).
   */
  async readPdf(buffer) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: STANDARD_FONTS_URL,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const pages = [];
    const scannedPages = [];
    let pageCount;
    try {
      const doc = await loadingTask.promise;
      pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
      for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        pages.push(await this.readPageText(page));
        page.cleanup();
        if (
          pages[i - 1].length < MIN_PAGE_TEXT_CHARS &&
          scannedPages.length < MAX_SCANNED_PAGES
        ) {
          scannedPages.push(i);
        }
      }
    } finally {
      await loadingTask.destroy();
    }

    const confidences = [];
    if (scannedPages.length) {
      const renderer = openPageRenderer(new Uint8Array(buffer));
      try {
        for (const pageNumber of scannedPages) {
          const rendered = await withTimeout(
            renderer.render(pageNumber),
            RENDER_TIMEOUT_MS,
            "Rendu PDF",
          );
          const ocr = await this.recognizeRenderedPage(rendered);
          confidences.push(ocr.confidence);
          if (ocr.extractedText.length > pages[pageNumber - 1].length) {
            pages[pageNumber - 1] = ocr.extractedText;
          }
        }
      } finally {
        await renderer.close();
      }
    }

    let method = "pdf-text";
    if (confidences.length) {
      method = confidences.length === pageCount ? "pdf-ocr" : "pdf-mixed";
    }
    return {
      extractedText: pages.filter(Boolean).join("\n\n").trim(),
      pagesProcessed: pageCount,
      confidence: confidences.length
        ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
        : undefined,
      method,
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
      extracted = await this.readPdf(buffer);
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
