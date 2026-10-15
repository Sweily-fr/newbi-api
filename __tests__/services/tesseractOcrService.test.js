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

async function addTextPage(pdf, lines) {
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) =>
    page.drawText(l, { x: 40, y: 780 - i * 24, size: 14, font }),
  );
}

async function buildTextPdf(lines) {
  const pdf = await PDFDocument.create();
  await addTextPage(pdf, lines);
  return Buffer.from(await pdf.save());
}

/** Page scannée : une image pleine page, sans couche texte. */
async function addScannedPage(pdf, imageBuffer) {
  const page = pdf.addPage([595, 842]);
  const image = await pdf.embedJpg(imageBuffer);
  const width = 595;
  const height = (image.height / image.width) * width;
  page.drawImage(image, { x: 0, y: 842 - height, width, height });
}

/**
 * Page A4 à 200 dpi, quelques lignes en haut et du papier partout ailleurs :
 * c'est le cas où l'ancien normalize() transformait le grain en taches.
 */
async function renderA4Page(lines) {
  const text = lines
    .map(
      (l, i) =>
        `<text x="150" y="${300 + i * 70}" font-family="Times New Roman" font-size="34" fill="#222">${l}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1654" height="2339"><rect width="100%" height="100%" fill="#f4f2ec"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Grain de papier reproductible (générateur pseudo-aléatoire à graine fixe). */
async function addPaperGrain(png) {
  const { width, height } = await sharp(png).metadata();
  const noise = Buffer.alloc(width * height);
  let seed = 42;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    noise[i] = 128 + Math.round(((seed / 2147483648) * 2 - 1) * 50);
  }
  const grain = await sharp(noise, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return sharp(png)
    .flatten({ background: "#f4f2ec" })
    .composite([{ input: grain, blend: "soft-light" }])
    .jpeg({ quality: 60 })
    .toBuffer();
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

  it("lit une photo de facture sur papier granuleux", async () => {
    const png = await renderA4Page([
      "FACTURE N° FA-2026-0177   Date : 12/08/2026",
      "TOTAL TTC 120,00 €",
    ]);
    const result = await tesseractOcrService.processBuffer(
      await addPaperGrain(png),
      "photo.jpg",
      "image/jpeg",
    );
    expect(result.extractedText).toContain("FA-2026-0177");
    expect(result.extractedText).toContain("120,00");
  }, 120000);

  it("lit un PDF scanné (sans couche texte) en rendant la page", async () => {
    const png = await renderA4Page([
      "NOTE D'HONORAIRES N° NH-2026-0418",
      "Date : 03/10/2026",
      "Total TTC 1 500,00 €",
    ]);
    const pdf = await PDFDocument.create();
    await addScannedPage(pdf, await addPaperGrain(png));
    const result = await tesseractOcrService.processBuffer(
      Buffer.from(await pdf.save()),
      "scan.pdf",
      "application/pdf",
    );
    expect(result.success).toBe(true);
    expect(result.metadata.method).toBe("pdf-ocr");
    expect(result.extractedText).toContain("NH-2026-0418");
    expect(result.extractedText).toContain("1 500,00");
    expect(result.confidence).toBeGreaterThan(60);
  }, 120000);

  it("combine couche texte et OCR dans un PDF mixte", async () => {
    const pdf = await PDFDocument.create();
    await addTextPage(pdf, [
      "Bordereau d'envoi des pièces justificatives",
      "Dossier comptable octobre 2026",
    ]);
    const png = await renderInvoiceImage(["Invoice INV-2026-0042"]);
    await addScannedPage(pdf, await sharp(png).jpeg().toBuffer());
    const result = await tesseractOcrService.processBuffer(
      Buffer.from(await pdf.save()),
      "pieces.pdf",
      "application/pdf",
    );
    expect(result.metadata.method).toBe("pdf-mixed");
    expect(result.metadata.pagesProcessed).toBe(2);
    expect(result.extractedText).toContain("Bordereau d'envoi");
    expect(result.extractedText).toContain("INV-2026-0042");
  }, 120000);

  it("signale un PDF sans aucun texte lisible", async () => {
    const pdf = await buildTextPdf([]);
    await expect(
      tesseractOcrService.processBuffer(pdf, "vide.pdf", "application/pdf"),
    ).rejects.toThrow(/Aucun texte reconnu/);
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
