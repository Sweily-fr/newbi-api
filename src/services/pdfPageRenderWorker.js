/**
 * Worker de rendu des pages PDF scannées (voir tesseractOcrService) : pdfjs
 * décode les images d'un scan en JavaScript, ce qui bloque plusieurs secondes
 * par page. Dans ce thread, le blocage ne fige pas la boucle d'événements de
 * l'API, qui continue de servir les autres requêtes.
 *
 * workerData : { data: Uint8Array (le PDF), standardFontDataUrl }
 * Message reçu : { pageNumber, scale, maxSide }
 * Réponse : { width, height, rgba } (ArrayBuffer transféré) ou { error }
 */
import { parentPort, workerData } from "worker_threads";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const docPromise = pdfjs.getDocument({
  data: workerData.data,
  standardFontDataUrl: workerData.standardFontDataUrl,
  disableFontFace: true,
  isEvalSupported: false,
  useSystemFonts: false,
}).promise;
// L'échec de chargement est renvoyé à la première demande de page
docPromise.catch(() => {});

parentPort.on("message", async ({ pageNumber, scale, maxSide }) => {
  try {
    const doc = await docPromise;
    const page = await doc.getPage(pageNumber);
    const { width: baseWidth, height: baseHeight } = page.getViewport({
      scale: 1,
    });
    const viewport = page.getViewport({
      scale: Math.min(scale, maxSide / Math.max(baseWidth, baseHeight)),
    });
    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);
    const entry = doc.canvasFactory.create(width, height);
    try {
      await page.render({ canvasContext: entry.context, viewport }).promise;
      // Copie dans un ArrayBuffer propre au thread : transférable sans copie
      const rgba = new Uint8Array(
        entry.context.getImageData(0, 0, width, height).data,
      );
      parentPort.postMessage({ width, height, rgba: rgba.buffer }, [
        rgba.buffer,
      ]);
    } finally {
      doc.canvasFactory.destroy(entry);
      page.cleanup();
    }
  } catch (error) {
    parentPort.postMessage({ error: error?.message || String(error) });
  }
});
