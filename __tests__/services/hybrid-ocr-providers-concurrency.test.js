/**
 * Moteurs OCR et analyses simultanées : pendant qu'une requête reconstruit la
 * liste des moteurs (vérification asynchrone du quota Mindee), une analyse
 * lancée en même temps ne parcourt jamais une liste vidée ou à moitié
 * construite. L'ordre des moteurs ne change pas.
 */
import { describe, it, expect, vi } from "vitest";

const gate = vi.hoisted(() => ({ blocked: false, waiters: [] }));

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/services/claudeVisionOcrService.js", () => ({
  default: {
    isAvailable: () => true,
    processDocument: async () => {
      throw new Error("lecture impossible");
    },
    toInvoiceFormat: (r) => r,
  },
}));
vi.mock("../../src/services/mindeeOcrService.js", () => ({
  default: {
    isAvailable: () => true,
    processDocument: async () => {
      throw new Error("Mindee indisponible");
    },
    toInvoiceFormat: (r) => r,
  },
}));
vi.mock("../../src/services/googleDocumentAIService.js", () => ({
  default: { isAvailable: () => false },
}));
vi.mock("../../src/services/mistralOcrService.js", () => ({
  default: {
    processDocumentFromUrl: async () => {
      throw new Error("Mistral indisponible");
    },
  },
}));
vi.mock("../../src/services/tesseractOcrService.js", () => ({
  default: {
    isAvailable: () => true,
    processDocumentFromUrl: async () => ({ extractedText: "FACTURE TESSERACT" }),
  },
}));
vi.mock("../../src/models/OcrUsage.js", () => ({
  default: {
    incrementUsage: async () => {},
    // Quota Mindee : lecture suspendue tant que le test le demande
    getCurrentUsage: () =>
      gate.blocked
        ? new Promise((resolve) => gate.waiters.push(() => resolve(0)))
        : Promise.resolve(0),
  },
}));
vi.mock("../../src/utils/ssrfGuard.js", () => ({
  assertSafeDownloadUrl: () => {},
}));

import hybridOcrService from "../../src/services/hybridOcrService.js";

describe("hybridOcrService : analyses simultanées", () => {
  it("une analyse lancée pendant la reconstruction des moteurs les a tous", async () => {
    await hybridOcrService.initProviders("espace-x");

    gate.blocked = true;
    const rebuilding = hybridOcrService.initProviders("espace-a");
    const analysis = hybridOcrService.processDocumentFromUrl(
      "https://r2.example/a.pdf",
      "a.pdf",
      "application/pdf",
      "espace-a",
    );
    await new Promise((r) => setTimeout(r, 20));
    gate.blocked = false;
    gate.waiters.splice(0).forEach((release) => release());
    await rebuilding;

    const result = await analysis;
    expect(result.success).toBe(true);
    expect(result.provider).toBe("tesseract");
    const order = hybridOcrService.providers.map((p) => p.name);
    expect(order[0]).toBe("claude-vision");
    expect(order).toContain("mindee");
    expect(order.at(-1)).toBe("tesseract");
  });
});
