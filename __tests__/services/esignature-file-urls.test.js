/**
 * Adresse d'un document de signature : URL présignée courte pour un document
 * rangé dans le bucket privé, adresse d'origine inchangée pour une demande
 * plus ancienne (lisible sans migration).
 */
import { describe, it, expect, vi } from "vitest";

const signed = vi.hoisted(() => []);
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client, command, options) => {
    signed.push({ ...command.input, expiresIn: options.expiresIn });
    return `https://r2.example/${command.input.Bucket}/${command.input.Key}?X-Amz-Signature=abc`;
  }),
}));

import {
  signedFileUrl,
  SIGNED_FILE_URL_TTL_SECONDS,
} from "../../src/services/esignatureFileUrls.js";

describe("signedFileUrl", () => {
  it("document du bucket privé : URL présignée d'une heure, sur le bucket enregistré", async () => {
    const url = await signedFileUrl(
      { documentsBucket: "devis-prives", signedDocumentKey: "esignature/o/r/signed-1.pdf" },
      "signedDocument",
    );
    expect(url).toContain("X-Amz-Signature");
    expect(signed.at(-1)).toMatchObject({
      Bucket: "devis-prives",
      Key: "esignature/o/r/signed-1.pdf",
      expiresIn: SIGNED_FILE_URL_TTL_SECONDS,
    });
    expect(SIGNED_FILE_URL_TTL_SECONDS).toBeLessThanOrEqual(3600);
  });

  it("demande plus ancienne : son adresse est rendue telle quelle", async () => {
    const before = signed.length;
    const legacy = {
      signedDocumentUrl: "https://pub-ocr.r2.dev/esignature/o/r/signed-1.pdf",
      auditTrailUrl: "https://pub-ocr.r2.dev/esignature/o/r/certificat-signature.pdf",
    };
    expect(await signedFileUrl(legacy, "signedDocument")).toBe(legacy.signedDocumentUrl);
    expect(await signedFileUrl(legacy, "auditTrail")).toBe(legacy.auditTrailUrl);
    expect(signed.length).toBe(before);
  });

  it("aucune demande ou aucun document : null", async () => {
    expect(await signedFileUrl(null, "signedDocument")).toBeNull();
    expect(await signedFileUrl({}, "auditTrail")).toBeNull();
  });
});
