import { describe, it, expect, afterEach } from "vitest";
import sharp from "sharp";

import {
  isAllowedProductImageUrl,
  processProductImage,
} from "../../src/utils/productImage.js";

describe("isAllowedProductImageUrl", () => {
  const original = process.env.COMPANY_IMAGE_URL;
  afterEach(() => {
    process.env.COMPANY_IMAGE_URL = original;
  });

  it("accepts product images on R2 public domains", () => {
    expect(
      isAllowedProductImageUrl("https://pub-abc.r2.dev/org1/products/x.webp"),
    ).toBe(true);
  });

  it("accepts the configured custom domain", () => {
    process.env.COMPANY_IMAGE_URL = "https://images.newbi.fr";
    expect(
      isAllowedProductImageUrl("https://images.newbi.fr/org1/products/x.webp"),
    ).toBe(true);
  });

  it("rejects other hosts, http, logos and nested paths", () => {
    expect(isAllowedProductImageUrl("https://evil.com/org1/products/x.webp")).toBe(false);
    expect(isAllowedProductImageUrl("http://pub-abc.r2.dev/org1/products/x.webp")).toBe(false);
    expect(isAllowedProductImageUrl("https://pub-abc.r2.dev/org1/logo.png")).toBe(false);
    expect(isAllowedProductImageUrl("https://pub-abc.r2.dev/a/b/products/x.webp")).toBe(false);
    expect(isAllowedProductImageUrl(null)).toBe(false);
  });
});

describe("processProductImage", () => {
  it("shrinks large images to 800px and converts them to WebP", async () => {
    const input = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: "#c00" },
    })
      .png()
      .toBuffer();

    const output = await processProductImage(input, {
      filename: "photo.png",
      mimetype: "image/png",
    });
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(400);
  });
});
