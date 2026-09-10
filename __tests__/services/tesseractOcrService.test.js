import { describe, it, expect, afterAll } from "vitest";
import sharp from "sharp";
import { PDFDocument, StandardFonts } from "pdf-lib";
import tesseractOcrService from "../../src/services/tesseractOcrService.js";

// Reconnaissance réelle (les fichiers de langue sont téléchargés au premier
// passage puis mis en cache dans .cache/tesseract). SKIP_TESSERACT_TESTS=true
// pour l'ignorer sur une machine sans réseau.
const skip = process.env.SKIP_TESSERACT_TESTS === "true";

async function renderInvoiceImage(lines) {
  const text = lines
    .map(
      (l, i) =>
        `<text x="30" y="${70 + i * 60}" font-family="Arial" font-size="32" fill="black">${l}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${100 + lines.length * 60}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function buildTextPdf(lines) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) =>
    page.drawText(l, { x: 40, y: 780 - i * 24, size: 14, font }),
  );
  return Buffer.from(await pdf.save());
}

afterAll(async () => {
  await tesseractOcrService.terminate();
});

describe.skipIf(skip)("tesseractOcrService", () => {
  it("lit une image de facture (fra+eng) et renvoie le format commun", async () => {
    const png = await renderInvoiceImage([
      "FACTURE N° FA-2026-0177   Date : 12/08/2026",
      "Total HT 100,00 €   TVA 20 % 20,00 €",
      "TOTAL TTC 120,00 €",
    ]);
    const result = await tesseractOcrService.processBuffer(
      png,
      "facture.png",
      "image/png",
    );
    expect(result.success).toBe(true);
    expect(result.metadata.provider).toBe("tesseract");
    expect(result.metadata.method).toBe("tesseract");
    expect(result.extractedText).toContain("FA-2026-0177");
    expect(result.extractedText).toContain("120,00");
    expect(result.confidence).toBeGreaterThan(60);
  }, 120000);

  it("extrait la couche texte d'un PDF sans OCR", async () => {
    const pdf = await buildTextPdf([
      "ACME SAS",
      "Invoice INV-2026-0042",
      "Total due 3,577.78 USD",
    ]);
    const result = await tesseractOcrService.processBuffer(
      pdf,
      "invoice.pdf",
      "application/pdf",
    );
    expect(result.success).toBe(true);
    expect(result.metadata.method).toBe("pdf-text");
    expect(result.extractedText).toContain("INV-2026-0042");
    expect(result.extractedText).toContain("3,577.78");
  }, 60000);

  it("refuse un PDF scanné (sans couche texte) avec une erreur explicite", async () => {
    const pdf = await buildTextPdf([]);
    await expect(
      tesseractOcrService.processBuffer(pdf, "scan.pdf", "application/pdf"),
    ).rejects.toThrow(/sans couche texte/);
  }, 60000);

  it("peut être désactivé par OCR_DISABLE_TESSERACT", () => {
    const before = process.env.OCR_DISABLE_TESSERACT;
    process.env.OCR_DISABLE_TESSERACT = "true";
    expect(tesseractOcrService.isAvailable()).toBe(false);
    if (before === undefined) delete process.env.OCR_DISABLE_TESSERACT;
    else process.env.OCR_DISABLE_TESSERACT = before;
    expect(tesseractOcrService.isAvailable()).toBe(true);
  });
});
